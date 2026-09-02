use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use bytes::Bytes;
use serde_json::{Value, json};
use thiserror::Error;
use uuid::Uuid;

use crate::{
    config::{HostConfig, path_allowed},
    device_auth::{DeviceAuthService, DeviceScope},
    event_hub::{EventHub, HubMessage},
    model::{
        ActivityState, AppSession, MuxTerminal, ProcessState, SessionTab, TerminalInput,
        TerminalOutput, TerminalStatus, now_iso,
    },
    store::{StateStore, StoreError},
    terminal::{TerminalError, TerminalHost, TerminalLaunch, TerminalTheme},
    wire::{ServerCapabilities, ServerIdentity, TerminalLeaseMode, TerminalMutationFence},
};

#[derive(Clone, Debug)]
pub struct Principal {
    pub principal_id: String,
    pub connection_id: String,
    pub can_observe: bool,
    pub can_control: bool,
    pub can_admin: bool,
    pub local_admin: bool,
    pub device_id: Option<String>,
}

impl Principal {
    #[must_use]
    pub fn local(connection_id: String) -> Self {
        Self {
            principal_id: "local-development".to_owned(),
            connection_id,
            can_observe: true,
            can_control: true,
            can_admin: true,
            local_admin: true,
            device_id: None,
        }
    }

    #[must_use]
    pub fn token(connection_id: String) -> Self {
        Self {
            principal_id: "host-token".to_owned(),
            connection_id,
            can_observe: true,
            can_control: true,
            can_admin: true,
            local_admin: true,
            device_id: None,
        }
    }

    #[must_use]
    pub fn paired(device_id: String, scopes: &[DeviceScope], connection_id: String) -> Self {
        Self {
            principal_id: format!("device:{device_id}"),
            connection_id,
            can_observe: scopes.iter().any(|scope| {
                matches!(
                    scope,
                    DeviceScope::Observe | DeviceScope::Control | DeviceScope::Admin
                )
            }),
            can_control: scopes
                .iter()
                .any(|scope| matches!(scope, DeviceScope::Control | DeviceScope::Admin)),
            can_admin: scopes.contains(&DeviceScope::Admin),
            local_admin: false,
            device_id: Some(device_id),
        }
    }
}

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Terminal(#[from] TerminalError),
    #[error("invalid rpc payload: {0}")]
    Invalid(String),
    #[error("invalid rpc payload: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unknown host channel: {0}")]
    Unknown(String),
    #[error("principal does not have the capability for operation {0}")]
    ScopeDenied(String),
    #[error("PATH_OUTSIDE_ALLOWED_ROOTS")]
    PathOutsideRoots,
}

impl RuntimeError {
    #[must_use]
    pub const fn wire_code(&self) -> &'static str {
        match self {
            Self::Store(error) => error.wire_code(),
            Self::Terminal(error) => error.wire_code(),
            Self::Invalid(_) | Self::Json(_) => "INVALID_RPC_PAYLOAD",
            Self::Unknown(_) => "UNKNOWN_CHANNEL",
            Self::ScopeDenied(_) => "SCOPE_DENIED",
            Self::PathOutsideRoots => "PATH_OUTSIDE_ALLOWED_ROOTS",
        }
    }

    #[must_use]
    pub const fn http_status(&self) -> u16 {
        match self {
            Self::Store(StoreError::NotFound(_)) | Self::Terminal(TerminalError::NotFound(_)) => {
                404
            }
            Self::Store(StoreError::Conflict(_)) => 409,
            Self::ScopeDenied(_) | Self::PathOutsideRoots => 403,
            Self::Unknown(_) => 404,
            _ => 400,
        }
    }
}

pub struct HostRuntime {
    pub config: Arc<HostConfig>,
    pub identity: ServerIdentity,
    pub capabilities: ServerCapabilities,
    pub events: Arc<EventHub>,
    pub store: Arc<StateStore>,
    pub terminal: Arc<TerminalHost>,
    pub devices: Arc<DeviceAuthService>,
    pub home_dir: String,
    pub machine_hostname: String,
    shutting_down: AtomicBool,
}

impl HostRuntime {
    pub fn start(config: HostConfig) -> Result<Arc<Self>, RuntimeError> {
        let machine_hostname = hostname::get().map_or_else(
            |_| "unknown".to_owned(),
            |value| value.to_string_lossy().into_owned(),
        );
        let store = Arc::new(StateStore::open(
            &config.data_dir.join("yaade.sqlite3"),
            machine_hostname.clone(),
        )?);
        let identity = ServerIdentity {
            server_id: store.server_id().to_owned(),
            server_epoch: Uuid::new_v4().to_string(),
            protocol_version: 2,
            runtime_version: env!("CARGO_PKG_VERSION").to_owned(),
            started_at: now_iso(),
        };
        let events = Arc::new(EventHub::new(identity.clone()));
        let terminal = TerminalHost::new(
            Arc::clone(&events),
            &config.data_dir.join("terminal-history"),
            config.features.terminal_checkpoints,
        )?;
        let startup_terminals = store.startup_terminals();
        let mut available_history_ids = std::collections::HashSet::new();
        for startup in &startup_terminals {
            if let Some(identity) = startup.process_identity.as_ref() {
                terminal.terminate_stale_process(identity)?;
            }
            if let Some(history_id) = startup.history_id.as_ref()
                && terminal.history_available(history_id)
            {
                available_history_ids.insert(history_id.clone());
            }
        }
        store.reconcile_startup(&identity.server_epoch, &available_history_ids)?;
        let devices = Arc::new(DeviceAuthService::new(Arc::clone(&store)).map_err(|error| {
            RuntimeError::Invalid(format!(
                "device authentication initialization failed: {error}"
            ))
        })?);
        let capabilities =
            ServerCapabilities::parity(&identity, config.features.terminal_checkpoints);
        let runtime = Arc::new(Self {
            home_dir: std::env::var("HOME").unwrap_or_default(),
            machine_hostname,
            config: Arc::new(config),
            identity,
            capabilities,
            events,
            store,
            terminal,
            devices,
            shutting_down: AtomicBool::new(false),
        });
        Self::start_lifecycle_listener(&runtime);
        Ok(runtime)
    }

    fn start_lifecycle_listener(runtime: &Arc<Self>) {
        let weak = Arc::downgrade(runtime);
        let mut events = runtime.events.subscribe();
        tokio::spawn(async move {
            while let Ok(message) = events.recv().await {
                let HubMessage::Event(event) = message.as_ref() else {
                    continue;
                };
                if event.channel.as_ref() != "terminal:exit" {
                    continue;
                }
                let Some(runtime) = weak.upgrade() else {
                    break;
                };
                if runtime.shutting_down.load(Ordering::Acquire) {
                    continue;
                }
                let Some(pty_id) = event.args.first().and_then(Value::as_str) else {
                    continue;
                };
                let exit_code = event
                    .args
                    .get(1)
                    .and_then(Value::as_i64)
                    .and_then(|value| i32::try_from(value).ok())
                    .unwrap_or(1);
                if let Some(terminal) = runtime.store.terminal_for_pty(pty_id) {
                    let updated = runtime.store.update_terminal(
                        &terminal.id,
                        Some(terminal.revision),
                        |value| {
                            // Shutdown races with PTY exit delivery across worker threads. Keep
                            // the catalog live for startup reconciliation if shutdown won after
                            // this listener received the event but before it acquired the store.
                            if runtime.shutting_down.load(Ordering::Acquire) {
                                return;
                            }
                            value.status = if exit_code == 0 {
                                TerminalStatus::Succeeded
                            } else {
                                TerminalStatus::Failed
                            };
                            value.output.process_state = ProcessState::Exited;
                            value.output.activity_state = ActivityState::Idle;
                            value.output.exit_code = Some(exit_code);
                            if exit_code != 0 {
                                value.error = Some(format!("process exited with {exit_code}"));
                            }
                        },
                    );
                    if let Ok(updated) = updated {
                        runtime.emit_terminal_updated(&updated);
                    }
                }
            }
        });
    }

    #[must_use]
    pub fn snapshot(&self) -> Value {
        json!({
            "type": "runtime:snapshot",
            "schemaVersion": 1,
            "identity": self.identity,
            "cursor": {
                "serverEpoch": self.identity.server_epoch,
                "sequence": self.events.last_sequence(),
            },
            "generatedAt": now_iso(),
            "sessions": self.store.list_snapshots(false),
            "leases": self.terminal.list_all_leases().into_iter().map(|lease| lease.to_wire()).collect::<Vec<_>>(),
        })
    }

    #[must_use]
    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::Acquire)
    }

    #[must_use]
    pub fn running_terminal_count(&self) -> usize {
        self.store
            .list_snapshots(false)
            .into_iter()
            .flat_map(|snapshot| snapshot.mux_terminals)
            .filter(|terminal| terminal.status == TerminalStatus::Running)
            .count()
    }

    pub fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::Release);
        self.events.emit("server:shuttingDown", Vec::<Value>::new());
        self.terminal.stop_all();
    }

    pub fn dispatch(
        &self,
        principal: &Principal,
        channel: &str,
        args: &[Value],
    ) -> Result<Value, RuntimeError> {
        self.authorize(principal, channel)?;
        validate_route_args(channel, args)?;
        if channel.starts_with("terminal:")
            && let Some(candidate) = args.first().and_then(Value::as_str)
            && candidate.starts_with("file:")
            && !path_allowed(
                &file_uri_or_path(candidate).map_err(|_| RuntimeError::PathOutsideRoots)?,
                &self.config.allowed_roots,
            )
        {
            return Err(RuntimeError::PathOutsideRoots);
        }
        if channel.starts_with("mux:") {
            return self.dispatch_mux(channel, args);
        }
        if channel.starts_with("terminal:") {
            return self.dispatch_terminal(principal, channel, args);
        }
        Err(RuntimeError::Unknown(channel.to_owned()))
    }

    fn authorize(&self, principal: &Principal, channel: &str) -> Result<(), RuntimeError> {
        let allowed = match route_capability(channel) {
            RouteCapability::Observe => principal.can_observe,
            RouteCapability::Control => principal.can_control,
            RouteCapability::Admin => principal.can_admin,
            RouteCapability::LocalAdmin => principal.local_admin,
        };
        if allowed {
            Ok(())
        } else {
            Err(RuntimeError::ScopeDenied(channel.to_owned()))
        }
    }

    fn dispatch_mux(&self, channel: &str, args: &[Value]) -> Result<Value, RuntimeError> {
        match channel {
            "mux:listSessions" => Ok(json!(
                self.store
                    .list_snapshots(args.first().and_then(Value::as_bool).unwrap_or(false))
            )),
            "mux:createSession" => {
                let session = self.store.create_session(
                    args.first()
                        .and_then(Value::as_str)
                        .unwrap_or("New session"),
                )?;
                self.emit_session("SessionCreated", &session);
                for tab in self
                    .store
                    .get_snapshot(&session.id)
                    .into_iter()
                    .flat_map(|snapshot| snapshot.tabs)
                {
                    self.emit_tab("SessionTabCreated", &tab);
                }
                Ok(json!(session))
            }
            "mux:renameSession" => {
                let session = self
                    .store
                    .rename_session(string(args, 0)?, string(args, 1)?)?;
                self.emit_session("SessionUpdated", &session);
                Ok(json!(session))
            }
            "mux:reorderSessions" => {
                let command = object(args, 0)?;
                let ids = strings(command.get("sessionIds"))?;
                let sessions = self.store.reorder_sessions(&ids)?;
                for session in &sessions {
                    self.emit_session("SessionUpdated", session);
                }
                Ok(json!(sessions))
            }
            "mux:createTab" => {
                let command = object(args, 0)?;
                let session_id = field_string(command, "sessionId")?;
                let previous_session = self.store.get_session(session_id);
                let tab = self.store.create_tab(
                    session_id,
                    command
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("New tab"),
                )?;
                self.emit_tab("SessionTabCreated", &tab);
                if let (Some(previous), Some(next)) =
                    (previous_session, self.store.get_session(session_id))
                    && previous.revision != next.revision
                {
                    self.emit_session("SessionUpdated", &next);
                }
                Ok(json!(tab))
            }
            "mux:renameTab" => {
                let command = object(args, 0)?;
                let tab = self.store.rename_tab(
                    field_string(command, "tabId")?,
                    field_string(command, "title")?,
                )?;
                self.emit_tab("SessionTabUpdated", &tab);
                Ok(json!(tab))
            }
            "mux:saveTabLayout" => {
                let command = object(args, 0)?;
                let tab = self.store.save_tab_layout(
                    field_string(command, "tabId")?,
                    field_string(command, "layoutJson")?,
                    command.get("revision").and_then(Value::as_u64),
                )?;
                self.emit_tab("SessionTabUpdated", &tab);
                Ok(json!(tab))
            }
            "mux:reorderTabs" => {
                let command = object(args, 0)?;
                let tabs = self.store.reorder_tabs(
                    field_string(command, "sessionId")?,
                    &strings(command.get("tabIds"))?,
                )?;
                for tab in &tabs {
                    self.emit_tab("SessionTabUpdated", tab);
                }
                Ok(json!(tabs))
            }
            "mux:archiveTab" => {
                let command = object(args, 0)?;
                let tab_id = field_string(command, "tabId")?;
                let stop = command.get("mode").and_then(Value::as_str) == Some("stop-terminals");
                let terminals = self.store.terminals_for_tab(tab_id, false);
                if stop {
                    for terminal in &terminals {
                        if terminal.status.is_live()
                            && let Some(pty_id) = terminal.output.pty_id.as_deref()
                        {
                            self.dispose_mux_pty(pty_id)?;
                        }
                    }
                }
                let result = self.store.close_tab(tab_id, stop)?;
                for terminal in &result.terminals {
                    self.emit_terminal_archived(terminal);
                }
                self.emit_tab("SessionTabArchived", &result.tab);
                for replacement in &result.created_tabs {
                    self.emit_tab("SessionTabCreated", replacement);
                }
                self.emit_session("SessionUpdated", &result.session);
                Ok(json!(result.tab))
            }
            "mux:selectTab" => {
                let command = object(args, 0)?;
                let session = self.store.select_tab(
                    field_string(command, "sessionId")?,
                    command.get("tabId").and_then(Value::as_str),
                )?;
                self.emit_session("SessionUpdated", &session);
                Ok(json!(session))
            }
            "mux:archiveSession" => {
                let command = object(args, 0)?;
                let session_id = field_string(command, "sessionId")?;
                let previous_session_ids = self
                    .store
                    .list_snapshots(false)
                    .into_iter()
                    .map(|snapshot| snapshot.session.id)
                    .collect::<std::collections::HashSet<_>>();
                if command.get("mode").and_then(Value::as_str) == Some("stop-terminals") {
                    for terminal in self.store.terminals_for_session(session_id, false) {
                        if terminal.status.is_live() {
                            let _ = self.cancel_mux_terminal(&terminal, terminal.revision);
                        }
                    }
                }
                let session = self.store.archive_session(session_id)?;
                self.emit_session("SessionArchived", &session);
                for replacement in self.store.list_snapshots(false) {
                    if previous_session_ids.contains(&replacement.session.id) {
                        continue;
                    }
                    self.emit_session("SessionCreated", &replacement.session);
                    for tab in replacement.tabs {
                        self.emit_tab("SessionTabCreated", &tab);
                    }
                }
                Ok(json!(session))
            }
            "mux:restoreSession" => {
                let command = object(args, 0)?;
                let session = self
                    .store
                    .restore_session(field_string(command, "sessionId")?)?;
                self.emit_session("SessionRestored", &session);
                Ok(json!(session))
            }
            "mux:getSession" => Ok(json!(self.store.get_snapshot(string(args, 0)?))),
            "mux:getTerminal" => Ok(json!(self.store.get_terminal(string(args, 0)?))),
            "mux:createTerminal" => self.create_mux_terminal(object(args, 0)?),
            "mux:reorderTerminals" => {
                let command = object(args, 0)?;
                let terminals = self.store.reorder_terminals(
                    field_string(command, "sessionId")?,
                    command.get("tabId").and_then(Value::as_str),
                    &strings(command.get("muxTerminalIds"))?,
                )?;
                for terminal in &terminals {
                    self.emit_terminal_updated(terminal);
                }
                Ok(json!(terminals))
            }
            "mux:moveTerminal" => {
                let command = object(args, 0)?;
                let terminal_id = field_string(command, "muxTerminalId")?;
                let current = self
                    .store
                    .get_terminal(terminal_id)
                    .ok_or_else(|| StoreError::NotFound(format!("terminal {terminal_id}")))?;
                let before = self.store.get_snapshot(&current.session_id);
                let terminal = self
                    .store
                    .move_terminal(terminal_id, field_string(command, "targetTabId")?)?;
                self.emit_terminal_updated(&terminal);
                if let (Some(before), Some(after)) =
                    (before, self.store.get_snapshot(&terminal.session_id))
                {
                    for tab in after.tabs {
                        if before
                            .tabs
                            .iter()
                            .find(|previous| previous.id == tab.id)
                            .is_some_and(|previous| previous.revision != tab.revision)
                        {
                            self.emit_tab("SessionTabUpdated", &tab);
                        }
                    }
                    if before.session.revision != after.session.revision {
                        self.emit_session("SessionUpdated", &after.session);
                    }
                }
                Ok(json!(terminal))
            }
            "mux:selectTerminal" => {
                let session_id = string(args, 0)?;
                let previous = self.store.get_session(session_id);
                let previous_tab = previous
                    .as_ref()
                    .and_then(|session| session.active_tab_id.as_deref())
                    .and_then(|tab_id| self.store.get_tab(tab_id));
                let session = self
                    .store
                    .select_terminal(session_id, args.get(1).and_then(Value::as_str))?;
                if let Some(tab) = session
                    .active_tab_id
                    .as_deref()
                    .and_then(|tab_id| self.store.get_tab(tab_id))
                    && previous_tab
                        .as_ref()
                        .is_none_or(|previous| previous.revision != tab.revision)
                {
                    self.emit_tab("SessionTabUpdated", &tab);
                }
                if previous.is_none_or(|previous| previous.revision != session.revision) {
                    self.emit_session("SessionUpdated", &session);
                }
                Ok(json!(session))
            }
            "mux:stopTerminal" => {
                let id = string(args, 0)?;
                let revision = number(args, 1)?;
                let terminal = self
                    .store
                    .get_terminal(id)
                    .ok_or_else(|| StoreError::NotFound(format!("terminal {id}")))?;
                Ok(json!(self.cancel_mux_terminal(&terminal, revision)?))
            }
            "mux:restartTerminal" => {
                let id = string(args, 0)?;
                let revision = number(args, 1)?;
                Ok(json!(self.restart_mux_terminal(id, revision)?))
            }
            "mux:closeTerminal" => {
                let command = object(args, 0)?;
                let id = field_string(command, "muxTerminalId")?;
                let terminal = self
                    .store
                    .get_terminal(id)
                    .ok_or_else(|| StoreError::NotFound(format!("terminal {id}")))?;
                Ok(json!(self.close_mux_terminal(&terminal, true)?))
            }
            "mux:renameTerminal" => {
                let terminal = self
                    .store
                    .rename_terminal(string(args, 0)?, string(args, 1)?)?;
                self.emit_terminal_updated(&terminal);
                Ok(json!(terminal))
            }
            _ => Err(RuntimeError::Unknown(channel.to_owned())),
        }
    }

    fn create_mux_terminal(
        &self,
        command: &serde_json::Map<String, Value>,
    ) -> Result<Value, RuntimeError> {
        if command.get("kind").and_then(Value::as_str) != Some("terminal") {
            return Err(RuntimeError::Invalid(
                "terminal kind is required".to_owned(),
            ));
        }
        let input: TerminalInput =
            serde_json::from_value(command.get("input").cloned().unwrap_or_else(|| json!({})))
                .map_err(|error| RuntimeError::Invalid(error.to_string()))?;
        let session_id = field_string(command, "sessionId")?;
        let previous_session = self.store.get_session(session_id);
        let selected_tab_id = command
            .get("tabId")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| {
                previous_session
                    .as_ref()
                    .and_then(|session| session.active_tab_id.clone())
            });
        let previous_tab = selected_tab_id
            .as_deref()
            .and_then(|tab_id| self.store.get_tab(tab_id));
        let created = self.store.create_terminal(
            session_id,
            command.get("tabId").and_then(Value::as_str),
            command
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("Terminal"),
            input,
        )?;
        self.emit_terminal("MuxTerminalCreated", &created);
        if let Some(tab) = created
            .tab_id
            .as_deref()
            .and_then(|tab_id| self.store.get_tab(tab_id))
            && previous_tab.is_none_or(|previous| previous.revision != tab.revision)
        {
            self.emit_tab("SessionTabUpdated", &tab);
        }
        if let Some(session) = self.store.get_session(session_id)
            && previous_session.is_none_or(|previous| previous.revision != session.revision)
        {
            self.emit_session("SessionUpdated", &session);
        }
        let starting =
            self.store
                .update_terminal(&created.id, Some(created.revision), |terminal| {
                    terminal.status = TerminalStatus::Starting;
                })?;
        self.emit_terminal_updated(&starting);
        match self.terminal.create(
            &self.config.launch_config.workspace_path,
            Some(TerminalLaunch {
                args: starting.input.shell_args.clone().unwrap_or_default(),
                ..TerminalLaunch::default()
            }),
        ) {
            Ok(pty) => {
                let running = self.store.update_terminal(
                    &starting.id,
                    Some(starting.revision),
                    |terminal| {
                        terminal.status = TerminalStatus::Running;
                        terminal.output = TerminalOutput::running(
                            pty.id.clone(),
                            terminal.output.generation,
                            pty.process_identity.clone(),
                        );
                    },
                )?;
                self.emit_terminal_updated(&running);
                Ok(json!(running))
            }
            Err(error) => {
                let failed = self.store.update_terminal(
                    &starting.id,
                    Some(starting.revision),
                    |terminal| {
                        terminal.status = TerminalStatus::Failed;
                        terminal.error = Some(error.to_string());
                        terminal.output.process_state = ProcessState::Failed;
                        terminal.output.activity_state = ActivityState::Failed;
                    },
                )?;
                self.emit_terminal_updated(&failed);
                Err(error.into())
            }
        }
    }

    fn cancel_mux_terminal(
        &self,
        terminal: &MuxTerminal,
        expected_revision: u64,
    ) -> Result<MuxTerminal, RuntimeError> {
        if terminal.revision != expected_revision {
            return Err(StoreError::Conflict(format!("terminal revision {}", terminal.id)).into());
        }
        if let Some(pty_id) = terminal.output.pty_id.as_deref() {
            self.dispose_mux_pty(pty_id)?;
        }
        let cancelled =
            self.store
                .update_terminal(&terminal.id, Some(expected_revision), |value| {
                    value.status = TerminalStatus::Cancelled;
                    value.output.process_state = ProcessState::Exited;
                    value.output.activity_state = ActivityState::Idle;
                    value.output.replay_available = false;
                })?;
        self.emit_terminal_updated(&cancelled);
        Ok(cancelled)
    }

    fn restart_mux_terminal(
        &self,
        id: &str,
        expected_revision: u64,
    ) -> Result<MuxTerminal, RuntimeError> {
        let current = self
            .store
            .get_terminal(id)
            .ok_or_else(|| StoreError::NotFound(format!("terminal {id}")))?;
        if current.revision != expected_revision {
            return Err(StoreError::Conflict(format!("terminal revision {id}")).into());
        }
        if let Some(pty_id) = current.output.pty_id.as_deref() {
            self.dispose_mux_pty(pty_id)?;
        }
        let starting = self
            .store
            .update_terminal(id, Some(expected_revision), |terminal| {
                terminal.status = TerminalStatus::Starting;
                terminal.error = None;
            })?;
        self.emit_terminal_updated(&starting);
        match self.terminal.create(
            &self.config.launch_config.workspace_path,
            Some(TerminalLaunch {
                args: starting.input.shell_args.clone().unwrap_or_default(),
                ..TerminalLaunch::default()
            }),
        ) {
            Ok(pty) => {
                let running =
                    self.store
                        .update_terminal(id, Some(starting.revision), |terminal| {
                            terminal.status = TerminalStatus::Running;
                            terminal.output = TerminalOutput::running(
                                pty.id.clone(),
                                terminal.output.generation + 1,
                                pty.process_identity.clone(),
                            );
                        })?;
                self.emit_terminal_updated(&running);
                Ok(running)
            }
            Err(error) => {
                let failed =
                    self.store
                        .update_terminal(id, Some(starting.revision), |terminal| {
                            terminal.status = TerminalStatus::Failed;
                            terminal.error = Some(error.to_string());
                            terminal.output.process_state = ProcessState::Failed;
                            terminal.output.activity_state = ActivityState::Failed;
                        })?;
                self.emit_terminal_updated(&failed);
                Err(error.into())
            }
        }
    }

    fn close_mux_terminal(
        &self,
        terminal: &MuxTerminal,
        stop: bool,
    ) -> Result<MuxTerminal, RuntimeError> {
        let previous_session = self.store.get_session(&terminal.session_id);
        let previous_tab = terminal
            .tab_id
            .as_deref()
            .and_then(|tab_id| self.store.get_tab(tab_id));
        if stop
            && terminal.status.is_live()
            && let Some(pty_id) = terminal.output.pty_id.as_deref()
        {
            self.dispose_mux_pty(pty_id)?;
        }
        let result = self.store.close_terminal(&terminal.id, stop)?;
        self.emit_terminal_archived(&result.terminal);
        if let Some(tab) = result.tab.as_ref()
            && previous_tab.is_some_and(|previous| previous.revision != tab.revision)
        {
            self.emit_tab("SessionTabUpdated", tab);
        }
        if previous_session.is_some_and(|previous| previous.revision != result.session.revision) {
            self.emit_session("SessionUpdated", &result.session);
        }
        Ok(result.terminal)
    }

    fn dispose_mux_pty(&self, pty_id: &str) -> Result<(), RuntimeError> {
        match self.terminal.dispose(pty_id) {
            Ok(()) | Err(TerminalError::NotFound(_)) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    fn emit_terminal_archived(&self, terminal: &MuxTerminal) {
        self.events.emit(
            "mux:event",
            vec![json!({
                "_tag": "MuxTerminalArchived",
                "eventId": format!("terminal-archived:{}:{}", terminal.id, Uuid::new_v4()),
                "muxTerminalId": terminal.id,
                "revision": terminal.revision,
                "occurredAt": terminal.updated_at,
            })],
        );
    }

    fn dispatch_terminal(
        &self,
        principal: &Principal,
        channel: &str,
        args: &[Value],
    ) -> Result<Value, RuntimeError> {
        let id = string(args, 0)?;
        match channel {
            "terminal:create" => {
                let path = file_uri_or_path(id)?;
                if !path_allowed(&path, &self.config.allowed_roots) {
                    return Err(RuntimeError::PathOutsideRoots);
                }
                let launch = args
                    .get(1)
                    .filter(|value| !value.is_null())
                    .cloned()
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|error| RuntimeError::Invalid(error.to_string()))?;
                Ok(json!(self.terminal.create(&path, launch)?))
            }
            "terminal:attach" => {
                if matches!(
                    args.get(2).and_then(Value::as_str),
                    Some("semantic" | "both")
                ) {
                    return Err(RuntimeError::Invalid(
                        "semantic terminal mode is not available on this host".to_owned(),
                    ));
                }
                if self.terminal.is_live_terminal(id) {
                    let lease = self.terminal.acquire_lease(
                        id,
                        &principal.principal_id,
                        &principal.connection_id,
                        if principal.can_control {
                            TerminalLeaseMode::Writer
                        } else {
                            TerminalLeaseMode::Observer
                        },
                    )?;
                    drop(lease);
                }
                let mut attach = serde_json::to_value(self.terminal.attach(
                    id,
                    &principal.connection_id,
                    args.get(1).and_then(Value::as_u64).unwrap_or(0),
                )?)?;
                if let Some(object) = attach.as_object_mut() {
                    object.insert("ownerId".to_owned(), json!(self.identity.server_id));
                    object.insert("ownerEpoch".to_owned(), json!(self.identity.server_epoch));
                }
                Ok(attach)
            }
            "terminal:write" => {
                self.terminal.authorize_and_write(
                    id,
                    &principal.principal_id,
                    &principal.connection_id,
                    mutation_fence(args.get(2)),
                    Bytes::copy_from_slice(string(args, 1)?.as_bytes()),
                )?;
                Ok(Value::Null)
            }
            "terminal:writeBinary" => {
                self.terminal.authorize_and_write_base64(
                    id,
                    &principal.principal_id,
                    &principal.connection_id,
                    mutation_fence(args.get(2)),
                    string(args, 1)?,
                )?;
                Ok(Value::Null)
            }
            "terminal:resize" => {
                self.terminal.authorize_and_resize(
                    id,
                    &principal.principal_id,
                    &principal.connection_id,
                    mutation_fence(args.get(3)),
                    u16::try_from(number(args, 1)?).unwrap_or(80),
                    u16::try_from(number(args, 2)?).unwrap_or(24),
                )?;
                Ok(Value::Null)
            }
            "terminal:setTheme" => {
                let theme = args
                    .get(1)
                    .cloned()
                    .map(serde_json::from_value::<TerminalTheme>)
                    .transpose()
                    .map_err(|error| RuntimeError::Invalid(error.to_string()))?
                    .ok_or_else(|| {
                        RuntimeError::Invalid("terminal theme is required".to_owned())
                    })?;
                self.terminal.set_theme(id, theme)?;
                Ok(Value::Null)
            }
            "terminal:acquireLease" => Ok(json!(
                self.terminal
                    .acquire_lease(
                        id,
                        &principal.principal_id,
                        &principal.connection_id,
                        if args.get(1).and_then(Value::as_str) == Some("observer") {
                            TerminalLeaseMode::Observer
                        } else {
                            TerminalLeaseMode::Writer
                        }
                    )?
                    .to_wire()
            )),
            "terminal:renewLease" => Ok(json!(
                self.terminal
                    .renew_lease(
                        id,
                        string(args, 1)?,
                        &principal.principal_id,
                        &principal.connection_id
                    )?
                    .to_wire()
            )),
            "terminal:releaseLease" => {
                self.terminal.release_lease(
                    id,
                    string(args, 1)?,
                    &principal.principal_id,
                    &principal.connection_id,
                )?;
                Ok(Value::Null)
            }
            "terminal:requestControl" => Ok(json!(
                self.terminal
                    .takeover(id, &principal.principal_id, &principal.connection_id)?
                    .to_wire()
            )),
            "terminal:transferControl" => Ok(json!(
                self.terminal
                    .transfer(
                        id,
                        string(args, 1)?,
                        &principal.principal_id,
                        &principal.connection_id,
                        string(args, 2)?
                    )?
                    .to_wire()
            )),
            "terminal:listViewers" => Ok(json!(
                self.terminal
                    .list_leases(id)?
                    .into_iter()
                    .map(|lease| lease.connection_id)
                    .collect::<std::collections::HashSet<_>>()
            )),
            "terminal:ready" => {
                self.terminal
                    .mark_replay_ready(id, &principal.connection_id)?;
                Ok(Value::Null)
            }
            "terminal:detach" => {
                self.terminal.detach(id, &principal.connection_id)?;
                Ok(Value::Null)
            }
            "terminal:readReplayPage" => Ok(json!(
                self.terminal.read_replay_page(
                    id,
                    number(args, 1)?,
                    args.get(2)
                        .and_then(Value::as_u64)
                        .and_then(|value| usize::try_from(value).ok()),
                    args.get(3).and_then(Value::as_str) == Some("backward"),
                )?
            )),
            "terminal:getCwd" => Ok(json!(self.terminal.get_cwd(id)?)),
            "terminal:getForegroundProcess" => Ok(json!(self.terminal.get_foreground_process(id)?)),
            "terminal:dispose" => {
                self.terminal.authorize_and_dispose(
                    id,
                    &principal.principal_id,
                    &principal.connection_id,
                    mutation_fence(args.get(1)),
                )?;
                Ok(Value::Null)
            }
            _ => Err(RuntimeError::Unknown(channel.to_owned())),
        }
    }

    fn emit_session(&self, tag: &str, session: &AppSession) {
        self.events.emit(
            "mux:event",
            vec![json!({
                "_tag": tag,
                "eventId": format!("session:{}:{}", session.id, Uuid::new_v4()),
                "revision": session.revision,
                "occurredAt": session.updated_at,
                "session": session,
            })],
        );
    }

    fn emit_tab(&self, tag: &str, tab: &SessionTab) {
        emit_tab_to(&self.events, tag, tab);
    }

    fn emit_terminal(&self, tag: &str, terminal: &MuxTerminal) {
        self.events.emit(
            "mux:event",
            vec![json!({
                "_tag": tag,
                "eventId": format!("terminal:{}:{}", terminal.id, Uuid::new_v4()),
                "muxTerminalId": terminal.id,
                "revision": terminal.revision,
                "occurredAt": terminal.updated_at,
                "muxTerminal": terminal,
            })],
        );
    }

    fn emit_terminal_updated(&self, terminal: &MuxTerminal) {
        self.emit_terminal("MuxTerminalUpdated", terminal);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RouteCapability {
    Observe,
    Control,
    Admin,
    LocalAdmin,
}

fn route_capability(channel: &str) -> RouteCapability {
    if !is_known_route(channel) {
        return RouteCapability::LocalAdmin;
    }
    if matches!(
        channel,
        "terminal:dispose"
            | "terminal:transferControl"
            | "mux:archiveTab"
            | "mux:archiveSession"
            | "mux:closeTerminal"
    ) {
        return RouteCapability::Admin;
    }
    if matches!(
        channel,
        "mux:listSessions"
            | "mux:getSession"
            | "mux:getTerminal"
            | "terminal:listViewers"
            | "terminal:attach"
            | "terminal:detach"
            | "terminal:readReplayPage"
            | "terminal:ready"
            | "terminal:getCwd"
            | "terminal:getForegroundProcess"
    ) {
        return RouteCapability::Observe;
    }
    RouteCapability::Control
}

fn validate_route_args(channel: &str, args: &[Value]) -> Result<(), RuntimeError> {
    let string_at = |index: usize| args.get(index).is_some_and(Value::is_string);
    let number_at = |index: usize| args.get(index).is_some_and(Value::is_number);
    let object_at = |index: usize| args.get(index).is_some_and(Value::is_object);
    let valid = match channel {
        "mux:listSessions" => args.len() == 1 && args[0].is_boolean(),
        "mux:createSession" => args.is_empty() || (args.len() == 1 && string_at(0)),
        "mux:renameSession" | "mux:renameTerminal" => {
            args.len() == 2 && string_at(0) && string_at(1)
        }
        "mux:getSession" | "mux:getTerminal" => args.len() == 1 && string_at(0),
        "mux:selectTerminal" => {
            (args.len() == 1 || args.len() == 2)
                && string_at(0)
                && (args.len() == 1 || string_at(1))
        }
        "mux:stopTerminal" | "mux:restartTerminal" => {
            args.len() == 2 && string_at(0) && number_at(1)
        }
        "mux:reorderSessions"
        | "mux:createTab"
        | "mux:renameTab"
        | "mux:saveTabLayout"
        | "mux:reorderTabs"
        | "mux:archiveTab"
        | "mux:selectTab"
        | "mux:archiveSession"
        | "mux:restoreSession"
        | "mux:createTerminal"
        | "mux:reorderTerminals"
        | "mux:moveTerminal"
        | "mux:closeTerminal" => args.len() == 1 && object_at(0),
        "terminal:create" => {
            (args.len() == 1 || args.len() == 2)
                && string_at(0)
                && (args.len() == 1 || args[1].is_null() || object_at(1))
        }
        "terminal:write" | "terminal:writeBinary" => {
            (args.len() == 2 || args.len() == 3)
                && string_at(0)
                && string_at(1)
                && (args.len() == 2 || object_at(2))
        }
        "terminal:resize" => {
            (args.len() == 3 || args.len() == 4)
                && string_at(0)
                && number_at(1)
                && number_at(2)
                && (args.len() == 3 || object_at(3))
        }
        "terminal:setTheme" => args.len() == 2 && string_at(0) && object_at(1),
        "terminal:acquireLease" => {
            (args.len() == 1 || args.len() == 2)
                && string_at(0)
                && (args.len() == 1 || matches!(args[1].as_str(), Some("writer" | "observer")))
        }
        "terminal:renewLease" | "terminal:releaseLease" => {
            args.len() == 2 && string_at(0) && string_at(1)
        }
        "terminal:transferControl" => {
            args.len() == 3 && string_at(0) && string_at(1) && string_at(2)
        }
        "terminal:attach" => {
            (1..=3).contains(&args.len())
                && string_at(0)
                && (args.len() < 2 || number_at(1))
                && (args.len() < 3 || matches!(args[2].as_str(), Some("raw" | "semantic" | "both")))
        }
        "terminal:readReplayPage" => {
            (2..=4).contains(&args.len())
                && string_at(0)
                && number_at(1)
                && (args.len() < 3 || number_at(2))
                && (args.len() < 4 || matches!(args[3].as_str(), Some("forward" | "backward")))
        }
        "terminal:requestControl"
        | "terminal:listViewers"
        | "terminal:ready"
        | "terminal:detach"
        | "terminal:getCwd"
        | "terminal:getForegroundProcess"
        | "terminal:dispose" => args.len() == 1 && string_at(0),
        _ => true,
    };
    if valid {
        Ok(())
    } else {
        Err(RuntimeError::Invalid(format!(
            "arguments for {channel} do not match the host route schema"
        )))
    }
}

fn is_known_route(channel: &str) -> bool {
    matches!(
        channel,
        "mux:listSessions"
            | "mux:createSession"
            | "mux:renameSession"
            | "mux:reorderSessions"
            | "mux:createTab"
            | "mux:renameTab"
            | "mux:saveTabLayout"
            | "mux:reorderTabs"
            | "mux:archiveTab"
            | "mux:selectTab"
            | "mux:archiveSession"
            | "mux:restoreSession"
            | "mux:getSession"
            | "mux:createTerminal"
            | "mux:reorderTerminals"
            | "mux:moveTerminal"
            | "mux:selectTerminal"
            | "mux:getTerminal"
            | "mux:stopTerminal"
            | "mux:restartTerminal"
            | "mux:closeTerminal"
            | "mux:renameTerminal"
            | "terminal:create"
            | "terminal:write"
            | "terminal:writeBinary"
            | "terminal:resize"
            | "terminal:setTheme"
            | "terminal:acquireLease"
            | "terminal:renewLease"
            | "terminal:releaseLease"
            | "terminal:requestControl"
            | "terminal:transferControl"
            | "terminal:listViewers"
            | "terminal:ready"
            | "terminal:detach"
            | "terminal:attach"
            | "terminal:readReplayPage"
            | "terminal:getCwd"
            | "terminal:getForegroundProcess"
            | "terminal:dispose"
    )
}

fn emit_tab_to(events: &EventHub, tag: &str, tab: &SessionTab) {
    events.emit(
        "mux:event",
        vec![json!({
            "_tag": tag,
            "eventId": format!("tab:{}:{}", tab.id, Uuid::new_v4()),
            "revision": tab.revision,
            "occurredAt": tab.updated_at,
            "tab": tab,
        })],
    );
}

fn string(args: &[Value], index: usize) -> Result<&str, RuntimeError> {
    args.get(index)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| RuntimeError::Invalid(format!("argument {index} must be a string")))
}

fn number(args: &[Value], index: usize) -> Result<u64, RuntimeError> {
    args.get(index)
        .and_then(Value::as_u64)
        .ok_or_else(|| RuntimeError::Invalid(format!("argument {index} must be a number")))
}

fn object(args: &[Value], index: usize) -> Result<&serde_json::Map<String, Value>, RuntimeError> {
    args.get(index)
        .and_then(Value::as_object)
        .ok_or_else(|| RuntimeError::Invalid(format!("argument {index} must be an object")))
}

fn field_string<'a>(
    object: &'a serde_json::Map<String, Value>,
    field: &str,
) -> Result<&'a str, RuntimeError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| RuntimeError::Invalid(format!("field {field} must be a string")))
}

fn strings(value: Option<&Value>) -> Result<Vec<String>, RuntimeError> {
    value
        .and_then(Value::as_array)
        .ok_or_else(|| RuntimeError::Invalid("expected string array".to_owned()))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| RuntimeError::Invalid("expected string array".to_owned()))
        })
        .collect()
}

fn mutation_fence(value: Option<&Value>) -> Option<TerminalMutationFence> {
    value
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
}

fn file_uri_or_path(value: &str) -> Result<PathBuf, RuntimeError> {
    if value.starts_with("file:") {
        return url::Url::parse(value)
            .ok()
            .and_then(|url| url.to_file_path().ok())
            .ok_or_else(|| RuntimeError::Invalid("invalid file URI".to_owned()));
    }
    Ok(PathBuf::from(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_policy_separates_observation_control_admin_and_local_admin() {
        assert_eq!(
            route_capability("terminal:attach"),
            RouteCapability::Observe
        );
        assert_eq!(route_capability("terminal:write"), RouteCapability::Control);
        assert_eq!(
            route_capability("terminal:setTheme"),
            RouteCapability::Control
        );
        assert_eq!(route_capability("terminal:dispose"), RouteCapability::Admin);
        assert_eq!(
            route_capability("terminal:stopAll"),
            RouteCapability::LocalAdmin
        );
    }

    #[test]
    fn unknown_routes_fail_closed_for_paired_principals() {
        assert_eq!(
            route_capability("future:mutation"),
            RouteCapability::LocalAdmin
        );
        let principal = Principal::paired(
            "device_1234".to_owned(),
            &[DeviceScope::Admin],
            "connection".to_owned(),
        );
        assert!(!principal.local_admin);
    }

    #[test]
    fn observe_scope_allows_attach_but_not_write() {
        let principal = Principal::paired(
            "device_1234".to_owned(),
            &[DeviceScope::Observe],
            "connection".to_owned(),
        );
        assert!(principal.can_observe);
        assert!(!principal.can_control);
        assert!(!principal.can_admin);
    }

    #[test]
    fn route_argument_tuples_are_validated_before_dispatch() {
        assert!(validate_route_args("mux:listSessions", &[json!(false)]).is_ok());
        assert!(validate_route_args("mux:listSessions", &[]).is_err());
        assert!(
            validate_route_args(
                "mux:renameTerminal",
                &[json!("terminal-id"), json!("shell")]
            )
            .is_ok()
        );
        assert!(validate_route_args("mux:renameTerminal", &[json!("terminal-id")]).is_err());
        assert!(
            validate_route_args("terminal:resize", &[json!("id"), json!(80), json!(24)]).is_ok()
        );
        assert!(
            validate_route_args("terminal:resize", &[json!("id"), json!("80"), json!(24)]).is_err()
        );
        assert!(
            validate_route_args(
                "terminal:setTheme",
                &[
                    json!("id"),
                    json!({
                        "foreground": { "r": 1, "g": 2, "b": 3 },
                        "background": { "r": 4, "g": 5, "b": 6 },
                        "cursor": { "r": 7, "g": 8, "b": 9 }
                    })
                ]
            )
            .is_ok()
        );
        assert!(validate_route_args("terminal:setTheme", &[json!("id"), json!("dark")]).is_err());
        assert!(
            validate_route_args(
                "terminal:attach",
                &[json!("id"), json!(0), json!("invalid")]
            )
            .is_err()
        );
        assert!(
            validate_route_args(
                "terminal:readReplayPage",
                &[json!("id"), json!(0), json!(256 * 1024), json!("backward")]
            )
            .is_ok()
        );
        assert!(
            validate_route_args(
                "terminal:readReplayPage",
                &[json!("id"), json!(0), json!(256 * 1024), json!("sideways")]
            )
            .is_err()
        );
    }

    #[test]
    fn correlation_identity_is_server_derived_for_each_principal() {
        let local = Principal::local("local-connection".to_owned());
        let token = Principal::token("token-connection".to_owned());
        let paired = Principal::paired(
            "device_1234".to_owned(),
            &[DeviceScope::Control],
            "device-connection".to_owned(),
        );
        assert_eq!(local.principal_id, "local-development");
        assert_eq!(token.principal_id, "host-token");
        assert_eq!(paired.principal_id, "device:device_1234");
        assert_ne!(local.connection_id, token.connection_id);
    }
}
