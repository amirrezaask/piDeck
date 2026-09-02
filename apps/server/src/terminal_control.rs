use std::{
    collections::HashMap,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use indexmap::IndexMap;
use thiserror::Error;
use uuid::Uuid;

use crate::wire::{TerminalLease, TerminalLeaseMode, TerminalMutationFence};

const DEFAULT_LEASE_TTL_MS: i64 = 15_000;
const MAX_COMMAND_IDS: usize = 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeTerminalLease {
    pub terminal_id: String,
    pub terminal_epoch: String,
    pub lease_id: String,
    pub lease_generation: u64,
    pub principal_id: String,
    pub connection_id: String,
    pub mode: TerminalLeaseMode,
    pub acquired_at: String,
    pub expires_at: String,
    expires_at_ms: i64,
}

impl RuntimeTerminalLease {
    #[must_use]
    pub fn to_wire(&self) -> TerminalLease {
        TerminalLease {
            terminal_id: self.terminal_id.clone(),
            terminal_epoch: self.terminal_epoch.clone(),
            lease_id: self.lease_id.clone(),
            client_id: self.connection_id.clone(),
            mode: self.mode,
            acquired_at: self.acquired_at.clone(),
            expires_at: self.expires_at.clone(),
            revision: self.lease_generation,
            lease_generation: Some(self.lease_generation),
            principal_id: Some(self.principal_id.clone()),
            connection_id: Some(self.connection_id.clone()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalLeaseRequest {
    pub terminal_id: String,
    pub terminal_epoch: String,
    pub principal_id: String,
    pub connection_id: String,
    pub mode: TerminalLeaseMode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalControlErrorCode {
    TerminalNotFound,
    TerminalEpochStale,
    WriterLeaseRequired,
    WriterLeaseStale,
    LeaseNotHeld,
    CommandDuplicate,
}

impl TerminalControlErrorCode {
    #[must_use]
    pub const fn as_wire_code(self) -> &'static str {
        match self {
            Self::TerminalNotFound => "TERMINAL_NOT_FOUND",
            Self::TerminalEpochStale => "TERMINAL_EPOCH_STALE",
            Self::WriterLeaseRequired => "WRITER_LEASE_REQUIRED",
            Self::WriterLeaseStale => "WRITER_LEASE_STALE",
            Self::LeaseNotHeld => "LEASE_NOT_HELD",
            Self::CommandDuplicate => "COMMAND_DUPLICATE",
        }
    }
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
#[error("{message}")]
pub struct TerminalControlError {
    pub code: TerminalControlErrorCode,
    pub terminal_id: String,
    pub message: String,
    pub lease_id: Option<String>,
}

#[derive(Debug)]
struct TerminalControlState {
    terminal_epoch: String,
    lease_generation: u64,
    primary_writer_id: Option<String>,
    writers: IndexMap<String, RuntimeTerminalLease>,
    observers: IndexMap<String, RuntimeTerminalLease>,
    command_ids: IndexMap<String, i64>,
}

trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
}

struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        i64::try_from(millis).unwrap_or(i64::MAX)
    }
}

/// Authoritative lease and mutation-fence owner for terminal runtimes.
///
/// Callers put this module behind the terminal runtime's lock. Every PTY
/// mutation must pass `authorize_mutation` before touching a process handle.
pub struct TerminalControlRegistry {
    terminals: HashMap<String, TerminalControlState>,
    lease_ttl_ms: i64,
    clock: Arc<dyn Clock>,
    make_id: Arc<dyn Fn() -> String + Send + Sync>,
}

impl Default for TerminalControlRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminalControlRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self {
            terminals: HashMap::new(),
            lease_ttl_ms: DEFAULT_LEASE_TTL_MS,
            clock: Arc::new(SystemClock),
            make_id: Arc::new(|| Uuid::new_v4().to_string()),
        }
    }

    #[cfg(test)]
    fn with_dependencies(
        lease_ttl_ms: i64,
        clock: Arc<dyn Clock>,
        make_id: Arc<dyn Fn() -> String + Send + Sync>,
    ) -> Self {
        Self {
            terminals: HashMap::new(),
            lease_ttl_ms: lease_ttl_ms.max(1),
            clock,
            make_id,
        }
    }

    pub fn register_terminal(
        &mut self,
        terminal_id: &str,
        terminal_epoch: &str,
    ) -> Result<(), TerminalControlError> {
        if terminal_id.is_empty() || terminal_epoch.is_empty() {
            return Err(control_error(
                TerminalControlErrorCode::TerminalNotFound,
                terminal_id,
                "terminal ID and epoch are required",
                None,
            ));
        }
        if let Some(existing) = self.terminals.get(terminal_id) {
            if existing.terminal_epoch != terminal_epoch {
                return Err(control_error(
                    TerminalControlErrorCode::TerminalEpochStale,
                    terminal_id,
                    "terminal ID is already registered to another epoch",
                    None,
                ));
            }
            return Ok(());
        }
        self.terminals.insert(
            terminal_id.to_owned(),
            TerminalControlState {
                terminal_epoch: terminal_epoch.to_owned(),
                lease_generation: 0,
                primary_writer_id: None,
                writers: IndexMap::new(),
                observers: IndexMap::new(),
                command_ids: IndexMap::new(),
            },
        );
        Ok(())
    }

    pub fn unregister_terminal(&mut self, terminal_id: &str, terminal_epoch: Option<&str>) {
        if self
            .terminals
            .get(terminal_id)
            .is_some_and(|state| terminal_epoch.is_none_or(|epoch| state.terminal_epoch == epoch))
        {
            self.terminals.remove(terminal_id);
        }
    }

    pub fn acquire(
        &mut self,
        request: TerminalLeaseRequest,
    ) -> Result<RuntimeTerminalLease, TerminalControlError> {
        let now = self.clock.now_ms();
        let ttl = self.lease_ttl_ms;
        let next_id = Arc::clone(&self.make_id);
        let state = self.state_for_epoch_mut(&request.terminal_id, &request.terminal_epoch)?;
        purge(state, now);

        if request.mode == TerminalLeaseMode::Writer {
            if let Some(existing_id) = state
                .writers
                .values()
                .find(|lease| {
                    lease.principal_id == request.principal_id
                        && lease.connection_id == request.connection_id
                })
                .map(|lease| lease.lease_id.clone())
            {
                return renew_lease(state, &existing_id, now, ttl);
            }
            if let Some(observer_id) = state
                .observers
                .values()
                .find(|lease| {
                    lease.principal_id == request.principal_id
                        && lease.connection_id == request.connection_id
                })
                .map(|lease| lease.lease_id.clone())
            {
                state.observers.shift_remove(&observer_id);
            }
            if state.primary_writer_id.is_none() {
                state.lease_generation = state.lease_generation.saturating_add(1);
            }
            let lease = new_lease(
                state,
                &request,
                state.lease_generation,
                now,
                ttl,
                (next_id)(),
            );
            state.writers.insert(lease.lease_id.clone(), lease.clone());
            if state.primary_writer_id.is_none() {
                state.primary_writer_id = Some(lease.lease_id.clone());
            }
            return Ok(lease);
        }

        if let Some(existing_id) = state
            .observers
            .values()
            .find(|lease| {
                lease.principal_id == request.principal_id
                    && lease.connection_id == request.connection_id
            })
            .map(|lease| lease.lease_id.clone())
        {
            return renew_lease(state, &existing_id, now, ttl);
        }
        let lease = new_lease(
            state,
            &request,
            state.lease_generation,
            now,
            ttl,
            (next_id)(),
        );
        state
            .observers
            .insert(lease.lease_id.clone(), lease.clone());
        Ok(lease)
    }

    pub fn renew(
        &mut self,
        terminal_id: &str,
        terminal_epoch: &str,
        lease_id: &str,
        principal_id: &str,
        connection_id: &str,
    ) -> Result<RuntimeTerminalLease, TerminalControlError> {
        let now = self.clock.now_ms();
        let ttl = self.lease_ttl_ms;
        let state = self.state_for_epoch_mut(terminal_id, terminal_epoch)?;
        purge(state, now);
        let lease = find_lease(state, lease_id).ok_or_else(|| {
            control_error(
                TerminalControlErrorCode::WriterLeaseStale,
                terminal_id,
                "terminal lease is missing or expired",
                Some(lease_id),
            )
        })?;
        if lease.principal_id != principal_id || lease.connection_id != connection_id {
            return Err(control_error(
                TerminalControlErrorCode::WriterLeaseStale,
                terminal_id,
                "terminal lease belongs to another connection",
                Some(lease_id),
            ));
        }
        renew_lease(state, lease_id, now, ttl)
    }

    pub fn release(
        &mut self,
        terminal_id: &str,
        terminal_epoch: &str,
        lease_id: &str,
        principal_id: &str,
        connection_id: &str,
    ) -> Result<(), TerminalControlError> {
        let state = self.state_for_epoch_mut(terminal_id, terminal_epoch)?;
        let Some(lease) = find_lease(state, lease_id) else {
            return Ok(());
        };
        if lease.principal_id != principal_id || lease.connection_id != connection_id {
            return Err(control_error(
                TerminalControlErrorCode::LeaseNotHeld,
                terminal_id,
                "terminal lease belongs to another connection",
                Some(lease_id),
            ));
        }
        if state.writers.shift_remove(lease_id).is_some()
            && state.primary_writer_id.as_deref() == Some(lease_id)
        {
            state.primary_writer_id = state.writers.first().map(|(id, _)| id.clone());
        }
        state.observers.shift_remove(lease_id);
        Ok(())
    }

    pub fn release_connection(&mut self, connection_id: &str) {
        let now = self.clock.now_ms();
        let ttl = self.lease_ttl_ms;
        let make_id = Arc::clone(&self.make_id);
        for state in self.terminals.values_mut() {
            purge(state, now);
            let writer_ids = state
                .writers
                .iter()
                .filter(|(_, lease)| lease.connection_id == connection_id)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            let writer_disconnected = !writer_ids.is_empty();
            for lease_id in writer_ids {
                state.writers.shift_remove(&lease_id);
                if state.primary_writer_id.as_deref() == Some(&lease_id) {
                    state.primary_writer_id = None;
                }
            }
            state
                .observers
                .retain(|_, lease| lease.connection_id != connection_id);
            if state.primary_writer_id.is_none() {
                state.primary_writer_id = state.writers.first().map(|(id, _)| id.clone());
            }
            if writer_disconnected
                && state.writers.is_empty()
                && let Some((_observer_id, observer)) = state.observers.shift_remove_index(0)
            {
                state.lease_generation = state.lease_generation.saturating_add(1);
                let request = TerminalLeaseRequest {
                    terminal_id: observer.terminal_id,
                    terminal_epoch: observer.terminal_epoch,
                    principal_id: observer.principal_id,
                    connection_id: observer.connection_id,
                    mode: TerminalLeaseMode::Writer,
                };
                let promoted = new_lease(
                    state,
                    &request,
                    state.lease_generation,
                    now,
                    ttl,
                    (make_id)(),
                );
                state.primary_writer_id = Some(promoted.lease_id.clone());
                state.writers.insert(promoted.lease_id.clone(), promoted);
            }
        }
    }

    pub fn force_takeover(
        &mut self,
        terminal_id: &str,
        terminal_epoch: &str,
        principal_id: &str,
        connection_id: &str,
    ) -> Result<RuntimeTerminalLease, TerminalControlError> {
        let now = self.clock.now_ms();
        let ttl = self.lease_ttl_ms;
        let lease_id = (self.make_id)();
        let state = self.state_for_epoch_mut(terminal_id, terminal_epoch)?;
        state.primary_writer_id = None;
        state.writers.clear();
        state.observers.retain(|_, lease| {
            lease.principal_id != principal_id || lease.connection_id != connection_id
        });
        state.lease_generation = state.lease_generation.saturating_add(1);
        let request = TerminalLeaseRequest {
            terminal_id: terminal_id.to_owned(),
            terminal_epoch: terminal_epoch.to_owned(),
            principal_id: principal_id.to_owned(),
            connection_id: connection_id.to_owned(),
            mode: TerminalLeaseMode::Writer,
        };
        let lease = new_lease(state, &request, state.lease_generation, now, ttl, lease_id);
        state.primary_writer_id = Some(lease.lease_id.clone());
        state.writers.insert(lease.lease_id.clone(), lease.clone());
        Ok(lease)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn transfer(
        &mut self,
        terminal_id: &str,
        terminal_epoch: &str,
        lease_id: &str,
        principal_id: &str,
        connection_id: &str,
        target_principal_id: &str,
        target_connection_id: &str,
    ) -> Result<RuntimeTerminalLease, TerminalControlError> {
        {
            let now = self.clock.now_ms();
            let state = self.state_for_epoch_mut(terminal_id, terminal_epoch)?;
            purge(state, now);
            let writer = state.writers.get(lease_id).ok_or_else(|| {
                control_error(
                    TerminalControlErrorCode::WriterLeaseStale,
                    terminal_id,
                    "only the active writer can transfer control",
                    Some(lease_id),
                )
            })?;
            if writer.principal_id != principal_id || writer.connection_id != connection_id {
                return Err(control_error(
                    TerminalControlErrorCode::LeaseNotHeld,
                    terminal_id,
                    "terminal lease belongs to another connection",
                    Some(lease_id),
                ));
            }
        }
        self.force_takeover(
            terminal_id,
            terminal_epoch,
            target_principal_id,
            target_connection_id,
        )
    }

    pub fn authorize_mutation(
        &mut self,
        fence: &TerminalMutationFence,
    ) -> Result<RuntimeTerminalLease, TerminalControlError> {
        let now = self.clock.now_ms();
        let ttl = self.lease_ttl_ms;
        let state = self.state_for_epoch_mut(&fence.terminal_id, &fence.terminal_epoch)?;
        purge(state, now);
        let Some(writer) = state.writers.get(&fence.lease_id) else {
            let has_writer = state.primary_writer_id.is_some() || !state.writers.is_empty();
            return Err(control_error(
                if has_writer {
                    TerminalControlErrorCode::WriterLeaseStale
                } else {
                    TerminalControlErrorCode::WriterLeaseRequired
                },
                &fence.terminal_id,
                if has_writer {
                    "terminal mutation fence is stale"
                } else {
                    "an active writer lease is required"
                },
                Some(&fence.lease_id),
            ));
        };
        if writer.terminal_epoch != fence.terminal_epoch
            || writer.lease_generation != fence.lease_generation
            || writer.principal_id != fence.principal_id
            || writer.connection_id != fence.connection_id
        {
            return Err(control_error(
                TerminalControlErrorCode::WriterLeaseStale,
                &fence.terminal_id,
                "terminal mutation fence is stale",
                Some(&fence.lease_id),
            ));
        }
        if state.command_ids.contains_key(&fence.command_id) {
            return Err(control_error(
                TerminalControlErrorCode::CommandDuplicate,
                &fence.terminal_id,
                "terminal command ID was already accepted",
                Some(&fence.lease_id),
            ));
        }
        state.command_ids.insert(fence.command_id.clone(), now);
        while state.command_ids.len() > MAX_COMMAND_IDS {
            state.command_ids.shift_remove_index(0);
        }
        renew_lease(state, &fence.lease_id, now, ttl)
    }

    pub fn writer(
        &mut self,
        terminal_id: &str,
    ) -> Result<Option<RuntimeTerminalLease>, TerminalControlError> {
        let now = self.clock.now_ms();
        let state = self.state_mut(terminal_id)?;
        purge(state, now);
        Ok(state
            .primary_writer_id
            .as_ref()
            .and_then(|id| state.writers.get(id))
            .cloned())
    }

    pub fn list(
        &mut self,
        terminal_id: &str,
    ) -> Result<Vec<RuntimeTerminalLease>, TerminalControlError> {
        let now = self.clock.now_ms();
        let state = self.state_mut(terminal_id)?;
        purge(state, now);
        Ok(state
            .writers
            .values()
            .chain(state.observers.values())
            .cloned()
            .collect())
    }

    pub fn list_all(&mut self) -> Vec<RuntimeTerminalLease> {
        let ids = self.terminals.keys().cloned().collect::<Vec<_>>();
        ids.into_iter()
            .flat_map(|id| self.list(&id).unwrap_or_default())
            .collect()
    }

    fn state_mut(
        &mut self,
        terminal_id: &str,
    ) -> Result<&mut TerminalControlState, TerminalControlError> {
        self.terminals.get_mut(terminal_id).ok_or_else(|| {
            control_error(
                TerminalControlErrorCode::TerminalNotFound,
                terminal_id,
                "terminal control state is not registered",
                None,
            )
        })
    }

    fn state_for_epoch_mut(
        &mut self,
        terminal_id: &str,
        terminal_epoch: &str,
    ) -> Result<&mut TerminalControlState, TerminalControlError> {
        let state = self.state_mut(terminal_id)?;
        if state.terminal_epoch != terminal_epoch {
            return Err(control_error(
                TerminalControlErrorCode::TerminalEpochStale,
                terminal_id,
                "terminal epoch does not match the owner state",
                None,
            ));
        }
        Ok(state)
    }
}

fn purge(state: &mut TerminalControlState, now: i64) {
    state.writers.retain(|_, lease| lease.expires_at_ms > now);
    if state
        .primary_writer_id
        .as_ref()
        .is_none_or(|id| !state.writers.contains_key(id))
    {
        state.primary_writer_id = state.writers.first().map(|(id, _)| id.clone());
    }
    state.observers.retain(|_, lease| lease.expires_at_ms > now);
}

fn find_lease<'a>(
    state: &'a TerminalControlState,
    lease_id: &str,
) -> Option<&'a RuntimeTerminalLease> {
    state
        .writers
        .get(lease_id)
        .or_else(|| state.observers.get(lease_id))
}

fn renew_lease(
    state: &mut TerminalControlState,
    lease_id: &str,
    now: i64,
    ttl: i64,
) -> Result<RuntimeTerminalLease, TerminalControlError> {
    let expires_at_ms = now.saturating_add(ttl);
    let terminal_id = state
        .writers
        .get(lease_id)
        .or_else(|| state.observers.get(lease_id))
        .map(|lease| lease.terminal_id.clone())
        .unwrap_or_default();
    let target = if state.writers.contains_key(lease_id) {
        state.writers.get_mut(lease_id)
    } else {
        state.observers.get_mut(lease_id)
    };
    let Some(lease) = target else {
        return Err(control_error(
            TerminalControlErrorCode::WriterLeaseStale,
            &terminal_id,
            "terminal lease is missing or expired",
            Some(lease_id),
        ));
    };
    lease.expires_at_ms = expires_at_ms;
    lease.expires_at = iso(expires_at_ms);
    Ok(lease.clone())
}

fn new_lease(
    state: &TerminalControlState,
    request: &TerminalLeaseRequest,
    lease_generation: u64,
    now: i64,
    ttl: i64,
    lease_id: String,
) -> RuntimeTerminalLease {
    let expires_at_ms = now.saturating_add(ttl);
    RuntimeTerminalLease {
        terminal_id: request.terminal_id.clone(),
        terminal_epoch: state.terminal_epoch.clone(),
        lease_id: format!("lease-{lease_id}"),
        lease_generation,
        principal_id: request.principal_id.clone(),
        connection_id: request.connection_id.clone(),
        mode: request.mode,
        acquired_at: iso(now),
        expires_at: iso(expires_at_ms),
        expires_at_ms,
    }
}

fn iso(milliseconds: i64) -> String {
    jiff::Timestamp::from_millisecond(milliseconds).map_or_else(
        |_| "1970-01-01T00:00:00Z".to_owned(),
        |timestamp| timestamp.to_string(),
    )
}

fn control_error(
    code: TerminalControlErrorCode,
    terminal_id: &str,
    message: &str,
    lease_id: Option<&str>,
) -> TerminalControlError {
    TerminalControlError {
        code,
        terminal_id: terminal_id.to_owned(),
        message: message.to_owned(),
        lease_id: lease_id.map(str::to_owned),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

    use super::*;

    struct FakeClock(AtomicI64);

    impl FakeClock {
        fn advance(&self, milliseconds: i64) {
            self.0.fetch_add(milliseconds, Ordering::SeqCst);
        }
    }

    impl Clock for FakeClock {
        fn now_ms(&self) -> i64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    fn registry() -> (TerminalControlRegistry, Arc<FakeClock>) {
        let clock = Arc::new(FakeClock(AtomicI64::new(1_700_000_000_000)));
        let ids = Arc::new(AtomicU64::new(0));
        let make_id = {
            let ids = Arc::clone(&ids);
            Arc::new(move || ids.fetch_add(1, Ordering::SeqCst).to_string())
                as Arc<dyn Fn() -> String + Send + Sync>
        };
        (
            TerminalControlRegistry::with_dependencies(15_000, clock.clone(), make_id),
            clock,
        )
    }

    fn request(connection_id: &str, mode: TerminalLeaseMode) -> TerminalLeaseRequest {
        TerminalLeaseRequest {
            terminal_id: "term-1".to_owned(),
            terminal_epoch: "epoch-1".to_owned(),
            principal_id: "principal-1".to_owned(),
            connection_id: connection_id.to_owned(),
            mode,
        }
    }

    #[test]
    fn writers_share_a_generation_until_takeover() {
        let (mut registry, _) = registry();
        registry
            .register_terminal("term-1", "epoch-1")
            .expect("register");
        let first = registry
            .acquire(request("connection-1", TerminalLeaseMode::Writer))
            .expect("first writer");
        let second = registry
            .acquire(request("connection-2", TerminalLeaseMode::Writer))
            .expect("second writer");

        assert_eq!(first.lease_generation, 1);
        assert_eq!(second.lease_generation, 1);
        assert_ne!(first.lease_id, second.lease_id);
        assert_eq!(registry.list("term-1").expect("leases").len(), 2);
    }

    #[test]
    fn takeover_invalidates_old_writer_fences() {
        let (mut registry, _) = registry();
        registry
            .register_terminal("term-1", "epoch-1")
            .expect("register");
        let old = registry
            .acquire(request("connection-1", TerminalLeaseMode::Writer))
            .expect("writer");
        let current = registry
            .force_takeover("term-1", "epoch-1", "principal-2", "connection-2")
            .expect("takeover");
        let stale = TerminalMutationFence {
            terminal_id: old.terminal_id,
            terminal_epoch: old.terminal_epoch,
            lease_id: old.lease_id,
            lease_generation: old.lease_generation,
            principal_id: old.principal_id,
            connection_id: old.connection_id,
            command_id: "command-1".to_owned(),
        };

        let error = registry
            .authorize_mutation(&stale)
            .expect_err("old writer must be stale");
        assert_eq!(error.code, TerminalControlErrorCode::WriterLeaseStale);
        assert_eq!(current.lease_generation, 2);
    }

    #[test]
    fn duplicate_command_is_rejected_after_first_mutation() {
        let (mut registry, _) = registry();
        registry
            .register_terminal("term-1", "epoch-1")
            .expect("register");
        let writer = registry
            .acquire(request("connection-1", TerminalLeaseMode::Writer))
            .expect("writer");
        let fence = TerminalMutationFence {
            terminal_id: writer.terminal_id,
            terminal_epoch: writer.terminal_epoch,
            lease_id: writer.lease_id,
            lease_generation: writer.lease_generation,
            principal_id: writer.principal_id,
            connection_id: writer.connection_id,
            command_id: "command-1".to_owned(),
        };

        registry.authorize_mutation(&fence).expect("first mutation");
        let error = registry
            .authorize_mutation(&fence)
            .expect_err("duplicate mutation");
        assert_eq!(error.code, TerminalControlErrorCode::CommandDuplicate);
    }

    #[test]
    fn expired_writer_is_removed() {
        let (mut registry, clock) = registry();
        registry
            .register_terminal("term-1", "epoch-1")
            .expect("register");
        registry
            .acquire(request("connection-1", TerminalLeaseMode::Writer))
            .expect("writer");
        clock.advance(15_001);

        assert!(registry.writer("term-1").expect("writer lookup").is_none());
    }

    #[test]
    fn disconnect_promotes_the_oldest_observer() {
        let (mut registry, _) = registry();
        registry
            .register_terminal("term-1", "epoch-1")
            .expect("register");
        registry
            .acquire(request("writer", TerminalLeaseMode::Writer))
            .expect("writer");
        registry
            .acquire(request("observer-1", TerminalLeaseMode::Observer))
            .expect("observer 1");
        registry
            .acquire(request("observer-2", TerminalLeaseMode::Observer))
            .expect("observer 2");

        registry.release_connection("writer");

        let writer = registry
            .writer("term-1")
            .expect("writer lookup")
            .expect("promoted");
        assert_eq!(writer.connection_id, "observer-1");
        assert_eq!(writer.lease_generation, 2);
    }

    #[test]
    fn wire_lease_matches_current_rpc_shape() {
        let (mut registry, _) = registry();
        registry
            .register_terminal("term-1", "epoch-1")
            .expect("register");
        let lease = registry
            .acquire(request("connection-1", TerminalLeaseMode::Writer))
            .expect("writer")
            .to_wire();

        let json = serde_json::to_value(lease).expect("wire json");
        assert_eq!(json["clientId"], "connection-1");
        assert_eq!(json["revision"], 1);
        assert_eq!(json["leaseGeneration"], 1);
    }
}
