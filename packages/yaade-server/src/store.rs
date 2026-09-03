#[cfg(test)]
use std::sync::atomic::{AtomicUsize, Ordering};
use std::{
    collections::HashSet,
    fs,
    path::Path,
    sync::{Mutex, MutexGuard},
};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::{
    database_owner::{DatabaseError, DatabaseOwner},
    model::{
        ActivityState, AppSession, MuxTerminal, ProcessIdentity, ProcessState, SessionSnapshot,
        SessionTab, TerminalInput, TerminalOutput, TerminalStatus, now_iso,
    },
};

const STATE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("invalid command: {0}")]
    Invalid(String),
    #[error("storage failure: {0}")]
    Storage(String),
}

impl StoreError {
    #[must_use]
    pub const fn wire_code(&self) -> &'static str {
        match self {
            Self::NotFound(_) => "NOT_FOUND",
            Self::Conflict(_) => "CONFLICT",
            Self::Invalid(_) => "OPERATION_FAILED",
            Self::Storage(_) => "OPERATION_FAILED",
        }
    }
}

impl From<DatabaseError> for StoreError {
    fn from(error: DatabaseError) -> Self {
        Self::Storage(error.to_string())
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Storage(error.to_string())
    }
}

impl From<serde_json::Error> for StoreError {
    fn from(error: serde_json::Error) -> Self {
        Self::Storage(error.to_string())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedState {
    schema_version: u32,
    machine: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_server_epoch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_restart: Option<HostRestartMetadata>,
    sessions: Vec<AppSession>,
    tabs: Vec<SessionTab>,
    terminals: Vec<MuxTerminal>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostRestartMetadata {
    reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    previous_server_epoch: Option<String>,
    new_server_epoch: String,
    occurred_at: String,
    interrupted_terminal_ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StartupTerminal {
    pub terminal_id: String,
    pub history_id: Option<String>,
    pub process_identity: Option<ProcessIdentity>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StartupReconciliation {
    pub previous_server_epoch: Option<String>,
    pub new_server_epoch: String,
    pub interrupted_terminal_ids: Vec<String>,
}

impl PersistedState {
    fn new(machine: String) -> Self {
        let mut state = Self {
            schema_version: STATE_SCHEMA_VERSION,
            machine,
            last_server_epoch: None,
            last_restart: None,
            sessions: Vec::new(),
            tabs: Vec::new(),
            terminals: Vec::new(),
        };
        state.ensure_visible_session();
        state
    }

    fn ensure_visible_session(&mut self) {
        if self
            .sessions
            .iter()
            .any(|session| session.archived_at.is_none())
        {
            return;
        }
        let timestamp = now_iso();
        let session_id = format!("ses-{}", Uuid::new_v4());
        let tab_id = format!("tab-{}", Uuid::new_v4());
        self.sessions.push(AppSession {
            id: session_id.clone(),
            title: "Session 1".to_owned(),
            position: 0,
            active_tab_id: Some(tab_id.clone()),
            active_mux_terminal_id: None,
            revision: 2,
            created_at: timestamp.clone(),
            updated_at: timestamp.clone(),
            archived_at: None,
        });
        self.tabs.push(SessionTab {
            id: tab_id,
            session_id,
            title: "Window 1".to_owned(),
            position: 0,
            active_mux_terminal_id: None,
            layout_json: None,
            revision: 1,
            created_at: timestamp.clone(),
            updated_at: timestamp,
            archived_at: None,
        });
    }
}

pub struct CloseTerminalResult {
    pub terminal: MuxTerminal,
    pub tab: Option<SessionTab>,
    pub session: AppSession,
}

pub struct CloseTabResult {
    pub terminals: Vec<MuxTerminal>,
    pub tab: SessionTab,
    pub session: AppSession,
    pub created_tabs: Vec<SessionTab>,
}

pub struct StateStore {
    database: DatabaseOwner,
    state: Mutex<PersistedState>,
    server_id: String,
    #[cfg(test)]
    commit_count: AtomicUsize,
}

impl StateStore {
    pub fn open(path: &Path, machine: String) -> Result<Self, StoreError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| StoreError::Storage(error.to_string()))?;
        }
        let database = DatabaseOwner::open(path)?;
        database.apply_migration(
            "0001-rust-runtime",
            "CREATE TABLE IF NOT EXISTS host_identity(
               singleton INTEGER PRIMARY KEY CHECK(singleton=1),
               server_id TEXT NOT NULL,
               created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS rust_runtime_state(
               singleton INTEGER PRIMARY KEY CHECK(singleton=1),
               schema_version INTEGER NOT NULL,
               state_json TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );",
        )?;
        let (server_id, persisted) = database.call(|connection| {
            let server_id = connection
                .query_row(
                    "SELECT server_id FROM host_identity WHERE singleton=1",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            connection.execute(
                "INSERT OR IGNORE INTO host_identity(singleton,server_id,created_at) VALUES(1,?,?)",
                params![server_id, now_iso()],
            )?;
            let persisted = connection
                .query_row(
                    "SELECT state_json FROM rust_runtime_state WHERE singleton=1 AND schema_version=?",
                    [STATE_SCHEMA_VERSION],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            Ok((server_id, persisted))
        })?;
        let mut state = persisted
            .as_deref()
            .and_then(|json| serde_json::from_str::<PersistedState>(json).ok())
            .filter(|state| {
                state.schema_version == STATE_SCHEMA_VERSION && state.machine == machine
            })
            .unwrap_or_else(|| PersistedState::new(machine));
        state.ensure_visible_session();
        let encoded = serde_json::to_string(&state)?;
        database.call(move |connection| {
            connection.execute(
                "INSERT INTO rust_runtime_state(singleton,schema_version,state_json,updated_at)
                 VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET
                 schema_version=excluded.schema_version,state_json=excluded.state_json,updated_at=excluded.updated_at",
                params![STATE_SCHEMA_VERSION, encoded, now_iso()],
            )
        })?;
        Ok(Self {
            database,
            state: Mutex::new(state),
            server_id,
            #[cfg(test)]
            commit_count: AtomicUsize::new(0),
        })
    }

    #[must_use]
    pub fn startup_terminals(&self) -> Vec<StartupTerminal> {
        self.state()
            .terminals
            .iter()
            .filter(|terminal| terminal.status.is_live())
            .map(|terminal| StartupTerminal {
                terminal_id: terminal.id.clone(),
                history_id: terminal
                    .output
                    .history_id
                    .clone()
                    .or_else(|| terminal.output.pty_id.clone()),
                process_identity: terminal.output.process_identity.clone(),
            })
            .collect()
    }

    pub fn reconcile_startup(
        &self,
        server_epoch: &str,
        available_history_ids: &HashSet<String>,
    ) -> Result<StartupReconciliation, StoreError> {
        let previous_server_epoch = self.state().last_server_epoch.clone();
        if previous_server_epoch.as_deref() == Some(server_epoch) {
            return Ok(StartupReconciliation {
                previous_server_epoch,
                new_server_epoch: server_epoch.to_owned(),
                interrupted_terminal_ids: Vec::new(),
            });
        }
        self.mutate(|state| {
            let timestamp = now_iso();
            let previous_server_epoch = state.last_server_epoch.clone();
            let mut interrupted_terminal_ids = Vec::new();
            for terminal in &mut state.terminals {
                if !terminal.status.is_live() {
                    continue;
                }
                let history_id = terminal
                    .output
                    .history_id
                    .clone()
                    .or_else(|| terminal.output.pty_id.clone());
                terminal.status = TerminalStatus::Disconnected;
                terminal.output.process_state = ProcessState::Interrupted;
                terminal.output.activity_state = ActivityState::Idle;
                terminal.output.pty_id = None;
                terminal.output.history_id = history_id.clone();
                terminal.output.process_identity = None;
                terminal.output.replay_available = history_id
                    .as_ref()
                    .is_some_and(|id| available_history_ids.contains(id));
                terminal.revision = terminal.revision.saturating_add(1);
                terminal.updated_at.clone_from(&timestamp);
                interrupted_terminal_ids.push(terminal.id.clone());
            }
            state.last_server_epoch = Some(server_epoch.to_owned());
            state.last_restart = Some(HostRestartMetadata {
                reason: "host_restart".to_owned(),
                previous_server_epoch: previous_server_epoch.clone(),
                new_server_epoch: server_epoch.to_owned(),
                occurred_at: timestamp,
                interrupted_terminal_ids: interrupted_terminal_ids.clone(),
            });
            Ok(StartupReconciliation {
                previous_server_epoch,
                new_server_epoch: server_epoch.to_owned(),
                interrupted_terminal_ids,
            })
        })
    }

    #[must_use]
    pub fn server_id(&self) -> &str {
        &self.server_id
    }

    pub(crate) fn apply_feature_migration(
        &self,
        name: &str,
        sql: &str,
    ) -> Result<bool, StoreError> {
        self.database.apply_migration(name, sql).map_err(Into::into)
    }

    pub(crate) fn with_connection<T, F>(&self, operation: F) -> Result<T, StoreError>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T, rusqlite::Error> + Send + 'static,
    {
        self.database.call(operation).map_err(Into::into)
    }

    pub fn health(&self) -> bool {
        self.database
            .call(|connection| connection.query_row("SELECT 1", [], |_| Ok(())))
            .is_ok()
    }

    fn state(&self) -> MutexGuard<'_, PersistedState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn mutate<T>(
        &self,
        operation: impl FnOnce(&mut PersistedState) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let mut current = self.state();
        let mut next = current.clone();
        let result = operation(&mut next)?;
        let encoded = serde_json::to_string(&next)?;
        self.database.call(move |connection| {
            connection.execute(
                "UPDATE rust_runtime_state SET state_json=?,updated_at=? WHERE singleton=1",
                params![encoded, now_iso()],
            )
        })?;
        *current = next;
        #[cfg(test)]
        self.commit_count.fetch_add(1, Ordering::Relaxed);
        Ok(result)
    }

    #[cfg(test)]
    fn commit_count(&self) -> usize {
        self.commit_count.load(Ordering::Relaxed)
    }

    #[must_use]
    pub fn list_snapshots(&self, include_archived: bool) -> Vec<SessionSnapshot> {
        let state = self.state();
        let mut sessions = state
            .sessions
            .iter()
            .filter(|session| include_archived || session.archived_at.is_none())
            .cloned()
            .collect::<Vec<_>>();
        sessions.sort_by_key(|session| session.position);
        sessions
            .into_iter()
            .map(|session| snapshot(&state, session, include_archived))
            .collect()
    }

    #[must_use]
    pub fn get_snapshot(&self, session_id: &str) -> Option<SessionSnapshot> {
        let state = self.state();
        state
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .cloned()
            .map(|session| snapshot(&state, session, false))
    }

    #[must_use]
    pub fn get_session(&self, session_id: &str) -> Option<AppSession> {
        self.state()
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .cloned()
    }

    #[must_use]
    pub fn get_tab(&self, tab_id: &str) -> Option<SessionTab> {
        self.state()
            .tabs
            .iter()
            .find(|tab| tab.id == tab_id)
            .cloned()
    }

    #[must_use]
    pub fn get_terminal(&self, terminal_id: &str) -> Option<MuxTerminal> {
        self.state()
            .terminals
            .iter()
            .find(|terminal| terminal.id == terminal_id)
            .cloned()
    }

    #[must_use]
    pub fn terminal_for_pty(&self, pty_id: &str) -> Option<MuxTerminal> {
        self.state()
            .terminals
            .iter()
            .find(|terminal| terminal.output.pty_id.as_deref() == Some(pty_id))
            .cloned()
    }

    #[must_use]
    pub fn terminals_for_session(
        &self,
        session_id: &str,
        include_archived: bool,
    ) -> Vec<MuxTerminal> {
        let mut terminals = self
            .state()
            .terminals
            .iter()
            .filter(|terminal| {
                terminal.session_id == session_id
                    && (include_archived || terminal.archived_at.is_none())
            })
            .cloned()
            .collect::<Vec<_>>();
        terminals.sort_by_key(|terminal| terminal.position);
        terminals
    }

    #[must_use]
    pub fn terminals_for_tab(&self, tab_id: &str, include_archived: bool) -> Vec<MuxTerminal> {
        let mut terminals = self
            .state()
            .terminals
            .iter()
            .filter(|terminal| {
                terminal.tab_id.as_deref() == Some(tab_id)
                    && (include_archived || terminal.archived_at.is_none())
            })
            .cloned()
            .collect::<Vec<_>>();
        terminals.sort_by_key(|terminal| terminal.position);
        terminals
    }

    pub fn create_session(&self, title: &str) -> Result<AppSession, StoreError> {
        self.mutate(|state| {
            let timestamp = now_iso();
            let session_id = format!("ses-{}", Uuid::new_v4());
            let tab_id = format!("tab-{}", Uuid::new_v4());
            let position = state
                .sessions
                .iter()
                .filter(|session| session.archived_at.is_none())
                .count();
            let session = AppSession {
                id: session_id.clone(),
                title: nonempty(title, "New session"),
                position,
                active_tab_id: Some(tab_id.clone()),
                active_mux_terminal_id: None,
                revision: 2,
                created_at: timestamp.clone(),
                updated_at: timestamp.clone(),
                archived_at: None,
            };
            state.sessions.push(session.clone());
            state.tabs.push(SessionTab {
                id: tab_id,
                session_id,
                title: "Window 1".to_owned(),
                position: 0,
                active_mux_terminal_id: None,
                layout_json: None,
                revision: 1,
                created_at: timestamp.clone(),
                updated_at: timestamp,
                archived_at: None,
            });
            Ok(session)
        })
    }

    pub fn rename_session(&self, session_id: &str, title: &str) -> Result<AppSession, StoreError> {
        self.mutate(|state| {
            let session = find_session_mut(state, session_id)?;
            session.title = nonempty(title, &session.title);
            touch_session(session);
            Ok(session.clone())
        })
    }

    pub fn reorder_sessions(&self, ids: &[String]) -> Result<Vec<AppSession>, StoreError> {
        self.mutate(|state| {
            let current = state
                .sessions
                .iter()
                .filter(|session| session.archived_at.is_none())
                .map(|session| session.id.clone())
                .collect::<Vec<_>>();
            assert_permutation(ids, &current, "sessions")?;
            let timestamp = now_iso();
            for (position, id) in ids.iter().enumerate() {
                let session = find_session_mut(state, id)?;
                session.position = position;
                session.updated_at = timestamp.clone();
                session.revision += 1;
            }
            Ok(ordered_sessions(state, false))
        })
    }

    pub fn create_tab(&self, session_id: &str, title: &str) -> Result<SessionTab, StoreError> {
        self.mutate(|state| {
            if !state
                .sessions
                .iter()
                .any(|session| session.id == session_id && session.archived_at.is_none())
            {
                return Err(StoreError::NotFound(format!("session {session_id}")));
            }
            let timestamp = now_iso();
            let tab = SessionTab {
                id: format!("tab-{}", Uuid::new_v4()),
                session_id: session_id.to_owned(),
                title: nonempty(title, "New tab"),
                position: state
                    .tabs
                    .iter()
                    .filter(|tab| tab.session_id == session_id && tab.archived_at.is_none())
                    .count(),
                active_mux_terminal_id: None,
                layout_json: None,
                revision: 1,
                created_at: timestamp.clone(),
                updated_at: timestamp.clone(),
                archived_at: None,
            };
            state.tabs.push(tab.clone());
            let session = find_session_mut(state, session_id)?;
            if session.active_tab_id.is_none() {
                session.active_tab_id = Some(tab.id.clone());
                touch_session(session);
            }
            Ok(tab)
        })
    }

    pub fn rename_tab(&self, tab_id: &str, title: &str) -> Result<SessionTab, StoreError> {
        self.mutate(|state| {
            let tab = find_tab_mut(state, tab_id)?;
            tab.title = nonempty(title, &tab.title).chars().take(160).collect();
            touch_tab(tab);
            Ok(tab.clone())
        })
    }

    pub fn save_tab_layout(
        &self,
        tab_id: &str,
        layout_json: &str,
        expected_revision: Option<u64>,
    ) -> Result<SessionTab, StoreError> {
        if layout_json.len() > 65_536 {
            return Err(StoreError::Invalid("layout exceeds 65536 bytes".to_owned()));
        }
        self.mutate(|state| {
            let tab = find_tab_mut(state, tab_id)?;
            if tab.archived_at.is_some() {
                return Err(StoreError::NotFound(format!("tab {tab_id}")));
            }
            if expected_revision.is_some_and(|revision| revision != tab.revision) {
                return Err(StoreError::Conflict(format!("tab revision {tab_id}")));
            }
            tab.layout_json = Some(layout_json.to_owned());
            touch_tab(tab);
            Ok(tab.clone())
        })
    }

    pub fn reorder_tabs(
        &self,
        session_id: &str,
        ids: &[String],
    ) -> Result<Vec<SessionTab>, StoreError> {
        self.mutate(|state| {
            let current = ordered_tabs(state, session_id, false)
                .into_iter()
                .map(|tab| tab.id)
                .collect::<Vec<_>>();
            assert_permutation(ids, &current, "tabs")?;
            let timestamp = now_iso();
            for (position, id) in ids.iter().enumerate() {
                let tab = find_tab_mut(state, id)?;
                tab.position = position;
                tab.updated_at = timestamp.clone();
                tab.revision += 1;
            }
            Ok(ordered_tabs(state, session_id, false))
        })
    }

    pub fn select_tab(
        &self,
        session_id: &str,
        tab_id: Option<&str>,
    ) -> Result<AppSession, StoreError> {
        self.mutate(|state| {
            let selected = match tab_id {
                Some(tab_id) => {
                    let tab = state
                        .tabs
                        .iter()
                        .find(|tab| {
                            tab.id == tab_id
                                && tab.session_id == session_id
                                && tab.archived_at.is_none()
                        })
                        .ok_or_else(|| {
                            StoreError::Invalid("active tab does not belong to session".to_owned())
                        })?;
                    Some((tab.id.clone(), tab.active_mux_terminal_id.clone()))
                }
                None => None,
            };
            let session = find_session_mut(state, session_id)?;
            session.active_tab_id = selected.as_ref().map(|(id, _)| id.clone());
            session.active_mux_terminal_id = selected.and_then(|(_, terminal)| terminal);
            touch_session(session);
            Ok(session.clone())
        })
    }

    pub fn archive_tab(&self, tab_id: &str) -> Result<SessionTab, StoreError> {
        self.mutate(|state| {
            let current = state
                .tabs
                .iter()
                .find(|tab| tab.id == tab_id)
                .cloned()
                .ok_or_else(|| StoreError::NotFound(format!("tab {tab_id}")))?;
            if current.archived_at.is_some() {
                return Ok(current);
            }
            let timestamp = now_iso();
            let tab = find_tab_mut(state, tab_id)?;
            tab.archived_at = Some(timestamp.clone());
            touch_tab(tab);
            let archived = tab.clone();
            if !state
                .tabs
                .iter()
                .any(|tab| tab.session_id == current.session_id && tab.archived_at.is_none())
            {
                let replacement = SessionTab {
                    id: format!("tab-{}", Uuid::new_v4()),
                    session_id: current.session_id.clone(),
                    title: "Window 1".to_owned(),
                    position: 0,
                    active_mux_terminal_id: None,
                    layout_json: None,
                    revision: 1,
                    created_at: timestamp.clone(),
                    updated_at: timestamp.clone(),
                    archived_at: None,
                };
                state.tabs.push(replacement);
            }
            let next = ordered_tabs(state, &current.session_id, false)
                .into_iter()
                .next();
            let session = find_session_mut(state, &current.session_id)?;
            if session.active_tab_id.as_deref() == Some(tab_id) {
                session.active_tab_id = next.as_ref().map(|tab| tab.id.clone());
                session.active_mux_terminal_id = next.and_then(|tab| tab.active_mux_terminal_id);
                touch_session(session);
            }
            Ok(archived)
        })
    }

    pub fn archive_session(&self, session_id: &str) -> Result<AppSession, StoreError> {
        self.mutate(|state| {
            let session = find_session_mut(state, session_id)?;
            if session.archived_at.is_none() {
                let timestamp = now_iso();
                session.archived_at = Some(timestamp);
                touch_session(session);
            }
            let archived = session.clone();
            state.ensure_visible_session();
            Ok(archived)
        })
    }

    pub fn restore_session(&self, session_id: &str) -> Result<AppSession, StoreError> {
        self.mutate(|state| {
            let session = find_session_mut(state, session_id)?;
            session.archived_at = None;
            touch_session(session);
            Ok(session.clone())
        })
    }

    pub fn create_terminal(
        &self,
        session_id: &str,
        tab_id: Option<&str>,
        title: &str,
        input: TerminalInput,
    ) -> Result<MuxTerminal, StoreError> {
        self.mutate(|state| {
            if !state
                .sessions
                .iter()
                .any(|session| session.id == session_id && session.archived_at.is_none())
            {
                return Err(StoreError::NotFound(format!("session {session_id}")));
            }
            let selected_tab = tab_id
                .map(str::to_owned)
                .or_else(|| {
                    state
                        .sessions
                        .iter()
                        .find(|session| session.id == session_id)
                        .and_then(|session| session.active_tab_id.clone())
                })
                .ok_or_else(|| StoreError::NotFound(format!("tab for {session_id}")))?;
            if !state.tabs.iter().any(|tab| {
                tab.id == selected_tab && tab.session_id == session_id && tab.archived_at.is_none()
            }) {
                return Err(StoreError::Invalid(
                    "terminal tab does not belong to session".to_owned(),
                ));
            }
            let timestamp = now_iso();
            let terminal = MuxTerminal {
                id: format!("term-{}", Uuid::new_v4()),
                session_id: session_id.to_owned(),
                tab_id: Some(selected_tab.clone()),
                kind: "terminal".to_owned(),
                title: nonempty(title, "Terminal"),
                position: state
                    .terminals
                    .iter()
                    .filter(|terminal| {
                        terminal.tab_id.as_deref() == Some(&selected_tab)
                            && terminal.archived_at.is_none()
                    })
                    .count(),
                status: TerminalStatus::Created,
                input,
                input_revision: 1,
                output: TerminalOutput::pending(),
                error: None,
                revision: 1,
                created_at: timestamp.clone(),
                updated_at: timestamp,
                started_at: None,
                finished_at: None,
                archived_at: None,
            };
            state.terminals.push(terminal.clone());
            select_terminal_in_state(state, session_id, Some(&terminal.id))?;
            Ok(terminal)
        })
    }

    pub fn update_terminal(
        &self,
        terminal_id: &str,
        expected_revision: Option<u64>,
        update: impl FnOnce(&mut MuxTerminal),
    ) -> Result<MuxTerminal, StoreError> {
        self.mutate(|state| {
            let terminal = find_terminal_mut(state, terminal_id)?;
            if expected_revision.is_some_and(|revision| terminal.revision != revision) {
                return Err(StoreError::Conflict(format!(
                    "terminal revision {terminal_id}"
                )));
            }
            update(terminal);
            terminal.revision += 1;
            terminal.updated_at = now_iso();
            if matches!(
                terminal.status,
                TerminalStatus::Starting | TerminalStatus::Running | TerminalStatus::Waiting
            ) && terminal.started_at.is_none()
            {
                terminal.started_at = Some(terminal.updated_at.clone());
            }
            if matches!(
                terminal.status,
                TerminalStatus::Succeeded
                    | TerminalStatus::Failed
                    | TerminalStatus::Cancelled
                    | TerminalStatus::Disconnected
            ) && terminal.finished_at.is_none()
            {
                terminal.finished_at = Some(terminal.updated_at.clone());
            }
            Ok(terminal.clone())
        })
    }

    pub fn rename_terminal(
        &self,
        terminal_id: &str,
        title: &str,
    ) -> Result<MuxTerminal, StoreError> {
        self.update_terminal(terminal_id, None, |terminal| {
            terminal.title = nonempty(title, &terminal.title).chars().take(160).collect();
        })
    }

    pub fn select_terminal(
        &self,
        session_id: &str,
        terminal_id: Option<&str>,
    ) -> Result<AppSession, StoreError> {
        self.mutate(|state| select_terminal_in_state(state, session_id, terminal_id))
    }

    pub fn reorder_terminals(
        &self,
        session_id: &str,
        tab_id: Option<&str>,
        ids: &[String],
    ) -> Result<Vec<MuxTerminal>, StoreError> {
        self.mutate(|state| {
            let selected_tab = tab_id
                .map(str::to_owned)
                .or_else(|| {
                    state
                        .sessions
                        .iter()
                        .find(|session| session.id == session_id)
                        .and_then(|session| session.active_tab_id.clone())
                })
                .ok_or_else(|| StoreError::NotFound("active tab".to_owned()))?;
            if !state.tabs.iter().any(|tab| {
                tab.id == selected_tab && tab.session_id == session_id && tab.archived_at.is_none()
            }) {
                return Err(StoreError::Invalid(
                    "terminal tab does not belong to session".to_owned(),
                ));
            }
            let current = ordered_terminals(state, &selected_tab, false)
                .into_iter()
                .map(|terminal| terminal.id)
                .collect::<Vec<_>>();
            assert_permutation(ids, &current, "terminals")?;
            let timestamp = now_iso();
            for (position, id) in ids.iter().enumerate() {
                let terminal = find_terminal_mut(state, id)?;
                terminal.position = position;
                terminal.revision += 1;
                terminal.updated_at = timestamp.clone();
            }
            Ok(ordered_terminals(state, &selected_tab, false))
        })
    }

    pub fn move_terminal(
        &self,
        terminal_id: &str,
        target_tab_id: &str,
    ) -> Result<MuxTerminal, StoreError> {
        self.mutate(|state| {
            let current = state
                .terminals
                .iter()
                .find(|terminal| terminal.id == terminal_id && terminal.archived_at.is_none())
                .cloned()
                .ok_or_else(|| StoreError::NotFound(format!("terminal {terminal_id}")))?;
            if !state.tabs.iter().any(|tab| {
                tab.id == target_tab_id
                    && tab.session_id == current.session_id
                    && tab.archived_at.is_none()
            }) {
                return Err(StoreError::Invalid(
                    "target tab does not belong to session".to_owned(),
                ));
            }
            if current.tab_id.as_deref() == Some(target_tab_id) {
                return Ok(current);
            }
            let position = state
                .terminals
                .iter()
                .filter(|terminal| {
                    terminal.tab_id.as_deref() == Some(target_tab_id)
                        && terminal.archived_at.is_none()
                })
                .count();
            let source_replacement = current.tab_id.as_deref().and_then(|source_tab_id| {
                ordered_terminals(state, source_tab_id, false)
                    .into_iter()
                    .find(|terminal| terminal.id != terminal_id)
                    .map(|terminal| terminal.id)
            });
            let timestamp = now_iso();
            let terminal = find_terminal_mut(state, terminal_id)?;
            terminal.tab_id = Some(target_tab_id.to_owned());
            terminal.position = position;
            terminal.revision += 1;
            terminal.updated_at = timestamp;
            let moved = terminal.clone();
            if let Some(source_tab_id) = current.tab_id.as_deref() {
                let source = find_tab_mut(state, source_tab_id)?;
                if source.active_mux_terminal_id.as_deref() == Some(terminal_id) {
                    source.active_mux_terminal_id = source_replacement;
                }
                touch_tab(source);
            }
            select_terminal_in_state(state, &current.session_id, Some(terminal_id))?;
            Ok(moved)
        })
    }

    pub fn close_terminal(
        &self,
        terminal_id: &str,
        stop: bool,
    ) -> Result<CloseTerminalResult, StoreError> {
        self.mutate(|state| {
            let current = state
                .terminals
                .iter()
                .find(|terminal| terminal.id == terminal_id)
                .cloned()
                .ok_or_else(|| StoreError::NotFound(format!("terminal {terminal_id}")))?;
            if current.archived_at.is_some() {
                let session = state
                    .sessions
                    .iter()
                    .find(|value| value.id == current.session_id)
                    .cloned()
                    .ok_or_else(|| {
                        StoreError::NotFound(format!("session {}", current.session_id))
                    })?;
                let tab = current
                    .tab_id
                    .as_deref()
                    .and_then(|id| state.tabs.iter().find(|value| value.id == id))
                    .cloned();
                return Ok(CloseTerminalResult {
                    terminal: current,
                    tab,
                    session,
                });
            }
            let timestamp = now_iso();
            let next_terminal = current.tab_id.as_deref().and_then(|tab_id| {
                state
                    .terminals
                    .iter()
                    .filter(|terminal| {
                        terminal.tab_id.as_deref() == Some(tab_id)
                            && terminal.id != terminal_id
                            && terminal.archived_at.is_none()
                    })
                    .min_by_key(|terminal| terminal.position)
                    .map(|terminal| terminal.id.clone())
            });
            let terminal = find_terminal_mut(state, terminal_id)?;
            if stop && terminal.status.is_live() {
                terminal.status = TerminalStatus::Cancelled;
                terminal.output.process_state = crate::model::ProcessState::Exited;
                terminal.output.activity_state = crate::model::ActivityState::Idle;
                terminal.output.replay_available = false;
                terminal.finished_at = Some(timestamp.clone());
            }
            terminal.archived_at = Some(timestamp.clone());
            terminal.updated_at = timestamp.clone();
            terminal.revision += 1;
            let archived = terminal.clone();

            let tab = if let Some(tab_id) = current.tab_id.as_deref() {
                let tab = find_tab_mut(state, tab_id)?;
                if tab.active_mux_terminal_id.as_deref() == Some(terminal_id) {
                    tab.active_mux_terminal_id = next_terminal.clone();
                    tab.updated_at = timestamp.clone();
                    tab.revision += 1;
                }
                Some(tab.clone())
            } else {
                None
            };
            let session = find_session_mut(state, &current.session_id)?;
            if session.active_mux_terminal_id.as_deref() == Some(terminal_id) {
                session.active_mux_terminal_id = next_terminal;
                session.updated_at = timestamp;
                session.revision += 1;
            }
            Ok(CloseTerminalResult {
                terminal: archived,
                tab,
                session: session.clone(),
            })
        })
    }

    pub fn close_tab(&self, tab_id: &str, stop: bool) -> Result<CloseTabResult, StoreError> {
        self.mutate(|state| {
            let current = state
                .tabs
                .iter()
                .find(|tab| tab.id == tab_id)
                .cloned()
                .ok_or_else(|| StoreError::NotFound(format!("tab {tab_id}")))?;
            let timestamp = now_iso();
            let mut terminals = Vec::new();
            for terminal in state.terminals.iter_mut().filter(|terminal| {
                terminal.tab_id.as_deref() == Some(tab_id) && terminal.archived_at.is_none()
            }) {
                if stop && terminal.status.is_live() {
                    terminal.status = TerminalStatus::Cancelled;
                    terminal.output.process_state = crate::model::ProcessState::Exited;
                    terminal.output.activity_state = crate::model::ActivityState::Idle;
                    terminal.output.replay_available = false;
                    terminal.finished_at = Some(timestamp.clone());
                }
                terminal.archived_at = Some(timestamp.clone());
                terminal.updated_at = timestamp.clone();
                terminal.revision += 1;
                terminals.push(terminal.clone());
            }
            let tab = find_tab_mut(state, tab_id)?;
            if tab.archived_at.is_none() {
                tab.archived_at = Some(timestamp.clone());
                tab.updated_at = timestamp.clone();
                tab.revision += 1;
            }
            let archived_tab = tab.clone();
            let mut created_tabs = Vec::new();
            if !state
                .tabs
                .iter()
                .any(|tab| tab.session_id == current.session_id && tab.archived_at.is_none())
            {
                let replacement = SessionTab {
                    id: format!("tab-{}", Uuid::new_v4()),
                    session_id: current.session_id.clone(),
                    title: "Window 1".to_owned(),
                    position: 0,
                    active_mux_terminal_id: None,
                    layout_json: None,
                    revision: 1,
                    created_at: timestamp.clone(),
                    updated_at: timestamp.clone(),
                    archived_at: None,
                };
                state.tabs.push(replacement.clone());
                created_tabs.push(replacement);
            }
            let next = state
                .tabs
                .iter()
                .filter(|tab| tab.session_id == current.session_id && tab.archived_at.is_none())
                .min_by_key(|tab| tab.position)
                .cloned();
            let session = find_session_mut(state, &current.session_id)?;
            if session.active_tab_id.as_deref() == Some(tab_id) {
                session.active_tab_id = next.as_ref().map(|tab| tab.id.clone());
                session.active_mux_terminal_id = next.and_then(|tab| tab.active_mux_terminal_id);
                session.updated_at = timestamp;
                session.revision += 1;
            }
            Ok(CloseTabResult {
                terminals,
                tab: archived_tab,
                session: session.clone(),
                created_tabs,
            })
        })
    }

    pub fn archive_terminal(&self, terminal_id: &str) -> Result<MuxTerminal, StoreError> {
        self.mutate(|state| {
            let current = state
                .terminals
                .iter()
                .find(|terminal| terminal.id == terminal_id)
                .cloned()
                .ok_or_else(|| StoreError::NotFound(format!("terminal {terminal_id}")))?;
            if current.archived_at.is_some() {
                return Ok(current);
            }
            let terminal = find_terminal_mut(state, terminal_id)?;
            terminal.archived_at = Some(now_iso());
            terminal.revision += 1;
            terminal.updated_at = now_iso();
            let archived = terminal.clone();
            let next = current.tab_id.as_deref().and_then(|tab_id| {
                ordered_terminals(state, tab_id, false)
                    .into_iter()
                    .next()
                    .map(|terminal| terminal.id)
            });
            if let Some(tab_id) = current.tab_id.as_deref()
                && let Ok(tab) = find_tab_mut(state, tab_id)
                && tab.active_mux_terminal_id.as_deref() == Some(terminal_id)
            {
                tab.active_mux_terminal_id = next.clone();
                touch_tab(tab);
            }
            let session = find_session_mut(state, &current.session_id)?;
            if session.active_mux_terminal_id.as_deref() == Some(terminal_id) {
                session.active_mux_terminal_id = next;
                touch_session(session);
            }
            Ok(archived)
        })
    }
}

fn snapshot(
    state: &PersistedState,
    session: AppSession,
    include_archived: bool,
) -> SessionSnapshot {
    let mut tabs = state
        .tabs
        .iter()
        .filter(|tab| {
            tab.session_id == session.id && (include_archived || tab.archived_at.is_none())
        })
        .cloned()
        .collect::<Vec<_>>();
    tabs.sort_by_key(|tab| tab.position);
    let mut terminals = state
        .terminals
        .iter()
        .filter(|terminal| {
            terminal.session_id == session.id
                && (include_archived || terminal.archived_at.is_none())
        })
        .cloned()
        .collect::<Vec<_>>();
    terminals.sort_by_key(|terminal| terminal.position);
    SessionSnapshot {
        session,
        tabs,
        mux_terminals: terminals,
    }
}

fn find_session_mut<'a>(
    state: &'a mut PersistedState,
    id: &str,
) -> Result<&'a mut AppSession, StoreError> {
    state
        .sessions
        .iter_mut()
        .find(|session| session.id == id)
        .ok_or_else(|| StoreError::NotFound(format!("session {id}")))
}

fn find_tab_mut<'a>(
    state: &'a mut PersistedState,
    id: &str,
) -> Result<&'a mut SessionTab, StoreError> {
    state
        .tabs
        .iter_mut()
        .find(|tab| tab.id == id)
        .ok_or_else(|| StoreError::NotFound(format!("tab {id}")))
}

fn find_terminal_mut<'a>(
    state: &'a mut PersistedState,
    id: &str,
) -> Result<&'a mut MuxTerminal, StoreError> {
    state
        .terminals
        .iter_mut()
        .find(|terminal| terminal.id == id)
        .ok_or_else(|| StoreError::NotFound(format!("terminal {id}")))
}

fn touch_session(session: &mut AppSession) {
    session.revision += 1;
    session.updated_at = now_iso();
}

fn touch_tab(tab: &mut SessionTab) {
    tab.revision += 1;
    tab.updated_at = now_iso();
}

fn nonempty(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback.to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn assert_permutation(
    actual: &[String],
    expected: &[String],
    label: &str,
) -> Result<(), StoreError> {
    let mut actual_sorted = actual.to_vec();
    let mut expected_sorted = expected.to_vec();
    actual_sorted.sort();
    actual_sorted.dedup();
    expected_sorted.sort();
    if actual.len() != expected.len() || actual_sorted != expected_sorted {
        return Err(StoreError::Invalid(format!("invalid {label} order")));
    }
    Ok(())
}

fn ordered_sessions(state: &PersistedState, include_archived: bool) -> Vec<AppSession> {
    let mut sessions = state
        .sessions
        .iter()
        .filter(|session| include_archived || session.archived_at.is_none())
        .cloned()
        .collect::<Vec<_>>();
    sessions.sort_by_key(|session| session.position);
    sessions
}

fn ordered_tabs(
    state: &PersistedState,
    session_id: &str,
    include_archived: bool,
) -> Vec<SessionTab> {
    let mut tabs = state
        .tabs
        .iter()
        .filter(|tab| {
            tab.session_id == session_id && (include_archived || tab.archived_at.is_none())
        })
        .cloned()
        .collect::<Vec<_>>();
    tabs.sort_by_key(|tab| tab.position);
    tabs
}

fn ordered_terminals(
    state: &PersistedState,
    tab_id: &str,
    include_archived: bool,
) -> Vec<MuxTerminal> {
    let mut terminals = state
        .terminals
        .iter()
        .filter(|terminal| {
            terminal.tab_id.as_deref() == Some(tab_id)
                && (include_archived || terminal.archived_at.is_none())
        })
        .cloned()
        .collect::<Vec<_>>();
    terminals.sort_by_key(|terminal| terminal.position);
    terminals
}

fn select_terminal_in_state(
    state: &mut PersistedState,
    session_id: &str,
    terminal_id: Option<&str>,
) -> Result<AppSession, StoreError> {
    let tab_id = terminal_id
        .map(|id| {
            state
                .terminals
                .iter()
                .find(|terminal| {
                    terminal.id == id
                        && terminal.session_id == session_id
                        && terminal.archived_at.is_none()
                })
                .and_then(|terminal| terminal.tab_id.clone())
                .ok_or_else(|| {
                    StoreError::Invalid("active terminal does not belong to session".to_owned())
                })
        })
        .transpose()?;
    if let Some(tab_id) = tab_id.as_deref() {
        let tab = find_tab_mut(state, tab_id)?;
        tab.active_mux_terminal_id = terminal_id.map(str::to_owned);
        touch_tab(tab);
    }
    let session = find_session_mut(state, session_id)?;
    if tab_id.is_some() {
        session.active_tab_id = tab_id;
    }
    session.active_mux_terminal_id = terminal_id.map(str::to_owned);
    touch_session(session);
    Ok(session.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> StateStore {
        StateStore::open(Path::new(":memory:"), "test-machine".to_owned()).expect("store")
    }

    #[test]
    fn host_identity_remains_stable_across_database_reopen() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("yaade.sqlite3");
        let first = StateStore::open(&path, "machine".to_owned()).expect("first");
        let identity = first.server_id().to_owned();
        drop(first);
        let second = StateStore::open(&path, "machine".to_owned()).expect("second");
        assert_eq!(second.server_id(), identity);
    }

    #[test]
    fn corrupt_database_is_refused_without_wiping_it() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("yaade.sqlite3");
        fs::write(&path, b"not sqlite").expect("corrupt database");
        assert!(StateStore::open(&path, "machine".to_owned()).is_err());
        assert_eq!(fs::read(&path).expect("database retained"), b"not sqlite");
    }

    #[test]
    fn creates_a_default_session_and_tab() {
        let store = store();
        let snapshots = store.list_snapshots(false);
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].tabs.len(), 1);
        assert_eq!(
            snapshots[0].session.active_tab_id,
            Some(snapshots[0].tabs[0].id.clone())
        );
    }

    #[test]
    fn archived_last_session_gets_a_replacement() {
        let store = store();
        let id = store.list_snapshots(false)[0].session.id.clone();
        store.archive_session(&id).expect("archive");
        let visible = store.list_snapshots(false);
        assert_eq!(visible.len(), 1);
        assert_ne!(visible[0].session.id, id);
    }

    #[test]
    fn startup_reconciliation_preserves_catalog_and_interrupts_only_live_terminals_once() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("yaade.sqlite3");
        let store = StateStore::open(&path, "machine".to_owned()).expect("store");
        let first = store.list_snapshots(false).remove(0);
        let first_tab = first.tabs[0].clone();
        let layout = r#"{\"version\":1,\"root\":{\"kind\":\"leaf\"}}"#;
        let saved_tab = store
            .save_tab_layout(&first_tab.id, layout, Some(first_tab.revision))
            .expect("layout");
        let running = store
            .create_terminal(
                &first.session.id,
                Some(&first_tab.id),
                "Running",
                TerminalInput::default(),
            )
            .expect("running terminal");
        let running = store
            .update_terminal(&running.id, Some(running.revision), |terminal| {
                terminal.status = TerminalStatus::Running;
                terminal.output = TerminalOutput::running("pty-history".to_owned(), 7, None);
            })
            .expect("running state");
        let exited = store
            .create_terminal(
                &first.session.id,
                Some(&first_tab.id),
                "Exited",
                TerminalInput::default(),
            )
            .expect("exited terminal");
        let exited = store
            .update_terminal(&exited.id, Some(exited.revision), |terminal| {
                terminal.status = TerminalStatus::Succeeded;
                terminal.output.process_state = ProcessState::Exited;
                terminal.output.activity_state = ActivityState::Idle;
                terminal.output.exit_code = Some(0);
            })
            .expect("exited state");
        let second = store.create_session("Second").expect("second session");
        let second_snapshot = store.get_snapshot(&second.id).expect("second snapshot");
        let second_running = store
            .create_terminal(
                &second.id,
                second_snapshot.session.active_tab_id.as_deref(),
                "Second running",
                TerminalInput::default(),
            )
            .expect("second terminal");
        let second_running = store
            .update_terminal(
                &second_running.id,
                Some(second_running.revision),
                |terminal| {
                    terminal.status = TerminalStatus::Waiting;
                    terminal.output = TerminalOutput::running("pty-missing".to_owned(), 3, None);
                },
            )
            .expect("second running state");
        let session_ids = store
            .list_snapshots(false)
            .into_iter()
            .map(|snapshot| snapshot.session.id)
            .collect::<Vec<_>>();
        drop(store);

        let reopened = StateStore::open(&path, "machine".to_owned()).expect("reopen");
        assert_eq!(
            reopened
                .list_snapshots(false)
                .into_iter()
                .map(|snapshot| snapshot.session.id)
                .collect::<Vec<_>>(),
            session_ids
        );
        assert_eq!(
            reopened
                .get_tab(&saved_tab.id)
                .expect("saved tab")
                .layout_json,
            Some(layout.to_owned())
        );
        let before = reopened.commit_count();
        let report = reopened
            .reconcile_startup("epoch-2", &HashSet::from(["pty-history".to_owned()]))
            .expect("reconcile");
        assert_eq!(reopened.commit_count() - before, 1);
        assert_eq!(
            report.interrupted_terminal_ids,
            vec![running.id.clone(), second_running.id.clone()]
        );
        let interrupted = reopened.get_terminal(&running.id).expect("interrupted");
        assert_eq!(interrupted.status, TerminalStatus::Disconnected);
        assert_eq!(interrupted.output.process_state, ProcessState::Interrupted);
        assert_eq!(interrupted.output.activity_state, ActivityState::Idle);
        assert_eq!(interrupted.output.pty_id, None);
        assert_eq!(
            interrupted.output.history_id.as_deref(),
            Some("pty-history")
        );
        assert!(interrupted.output.replay_available);
        assert_eq!(interrupted.output.generation, 7);
        assert_eq!(interrupted.revision, running.revision + 1);
        let missing = reopened
            .get_terminal(&second_running.id)
            .expect("missing archive");
        assert!(!missing.output.replay_available);
        assert_eq!(reopened.get_terminal(&exited.id), Some(exited));

        let before_repeat = reopened.commit_count();
        let repeated = reopened
            .reconcile_startup("epoch-2", &HashSet::new())
            .expect("repeat");
        assert!(repeated.interrupted_terminal_ids.is_empty());
        assert_eq!(reopened.commit_count(), before_repeat);
    }

    #[test]
    fn incomplete_reorders_are_rejected_and_valid_reorders_increment_revisions() {
        let store = store();
        let first = store.list_snapshots(false)[0].session.clone();
        let second = store.create_session("Second").expect("second");
        assert!(
            store
                .reorder_sessions(std::slice::from_ref(&first.id))
                .is_err()
        );
        let reordered = store
            .reorder_sessions(&[second.id.clone(), first.id.clone()])
            .expect("reorder");
        assert_eq!(reordered[0].id, second.id);
        assert!(reordered[0].revision > second.revision);
    }

    #[test]
    fn archiving_a_focused_terminal_clears_focus_pointers() {
        let store = store();
        let snapshot = store.list_snapshots(false).remove(0);
        let terminal = store
            .create_terminal(
                &snapshot.session.id,
                snapshot.session.active_tab_id.as_deref(),
                "Terminal",
                TerminalInput::default(),
            )
            .expect("terminal");
        store.archive_terminal(&terminal.id).expect("archive");
        let session = store.get_session(&snapshot.session.id).expect("session");
        let tab = store
            .get_tab(snapshot.session.active_tab_id.as_deref().expect("tab"))
            .expect("tab");
        assert_eq!(session.active_mux_terminal_id, None);
        assert_eq!(tab.active_mux_terminal_id, None);
    }

    #[test]
    fn moving_a_terminal_preserves_its_runtime_output() {
        let store = store();
        let snapshot = store.list_snapshots(false).remove(0);
        let terminal = store
            .create_terminal(
                &snapshot.session.id,
                snapshot.session.active_tab_id.as_deref(),
                "Terminal",
                TerminalInput::default(),
            )
            .expect("terminal");
        let running = store
            .update_terminal(&terminal.id, Some(terminal.revision), |value| {
                value.status = TerminalStatus::Running;
                value.output = TerminalOutput::running("pty-1".to_owned(), 0, None);
            })
            .expect("running");
        let target = store
            .create_tab(&snapshot.session.id, "Window 2")
            .expect("tab");
        let moved = store.move_terminal(&running.id, &target.id).expect("move");
        assert_eq!(moved.output.pty_id.as_deref(), Some("pty-1"));
        assert_eq!(moved.status, TerminalStatus::Running);
    }

    #[test]
    fn active_terminal_must_belong_to_the_selected_session() {
        let store = store();
        let first = store.list_snapshots(false).remove(0);
        let second = store.create_session("Second").expect("second");
        let terminal = store
            .create_terminal(
                &first.session.id,
                first.session.active_tab_id.as_deref(),
                "Terminal",
                TerminalInput::default(),
            )
            .expect("terminal");
        assert!(
            store
                .select_terminal(&second.id, Some(&terminal.id))
                .is_err()
        );
    }

    #[test]
    fn moving_the_active_terminal_repairs_both_tab_selections() {
        let store = store();
        let snapshot = &store.list_snapshots(false)[0];
        let source_tab = &snapshot.tabs[0];
        let first = store
            .create_terminal(
                &snapshot.session.id,
                Some(&source_tab.id),
                "First",
                TerminalInput::default(),
            )
            .expect("first terminal");
        let second = store
            .create_terminal(
                &snapshot.session.id,
                Some(&source_tab.id),
                "Second",
                TerminalInput::default(),
            )
            .expect("second terminal");
        let target = store
            .create_tab(&snapshot.session.id, "Window 2")
            .expect("target tab");

        store
            .move_terminal(&second.id, &target.id)
            .expect("move terminal");

        assert_eq!(
            store
                .get_tab(&source_tab.id)
                .expect("source")
                .active_mux_terminal_id,
            Some(first.id),
        );
        assert_eq!(
            store
                .get_tab(&target.id)
                .expect("target")
                .active_mux_terminal_id,
            Some(second.id.clone()),
        );
        let session = store.get_session(&snapshot.session.id).expect("session");
        assert_eq!(session.active_tab_id, Some(target.id));
        assert_eq!(session.active_mux_terminal_id, Some(second.id));
    }

    #[test]
    fn terminal_close_commits_final_state_once() {
        let store = store();
        let snapshot = store.list_snapshots(false).remove(0);
        let terminal = store
            .create_terminal(
                &snapshot.session.id,
                snapshot.session.active_tab_id.as_deref(),
                "Terminal",
                TerminalInput::default(),
            )
            .expect("terminal");
        let running = store
            .update_terminal(&terminal.id, Some(terminal.revision), |value| {
                value.status = TerminalStatus::Running;
                value.output = TerminalOutput::running("pty-1".to_owned(), 1, None);
            })
            .expect("running");
        let before = store.commit_count();
        let result = store.close_terminal(&running.id, true).expect("close");
        assert_eq!(store.commit_count() - before, 1);
        assert_eq!(result.terminal.revision, running.revision + 1);
        assert_eq!(result.terminal.status, TerminalStatus::Cancelled);
        assert!(result.terminal.archived_at.is_some());
        assert!(!result.terminal.output.replay_available);
    }

    #[test]
    fn window_close_archives_six_terminals_in_one_commit_and_creates_one_fallback() {
        let store = store();
        let snapshot = store.list_snapshots(false).remove(0);
        let tab_id = snapshot.tabs[0].id.clone();
        for index in 0..6 {
            store
                .create_terminal(
                    &snapshot.session.id,
                    Some(&tab_id),
                    &format!("Terminal {index}"),
                    TerminalInput::default(),
                )
                .expect("terminal");
        }
        let before = store.commit_count();
        let result = store.close_tab(&tab_id, true).expect("close tab");
        assert_eq!(store.commit_count() - before, 1);
        assert_eq!(result.terminals.len(), 6);
        assert!(
            result
                .terminals
                .iter()
                .all(|terminal| terminal.archived_at.is_some())
        );
        assert_eq!(result.created_tabs.len(), 1);
        assert_eq!(
            result.session.active_tab_id,
            Some(result.created_tabs[0].id.clone())
        );
    }

    #[test]
    fn terminal_revisions_are_fenced() {
        let store = store();
        let snapshot = &store.list_snapshots(false)[0];
        let terminal = store
            .create_terminal(
                &snapshot.session.id,
                snapshot.session.active_tab_id.as_deref(),
                "Terminal",
                TerminalInput::default(),
            )
            .expect("terminal");
        store
            .update_terminal(&terminal.id, Some(terminal.revision), |terminal| {
                terminal.status = TerminalStatus::Running;
            })
            .expect("update");
        assert!(matches!(
            store.update_terminal(&terminal.id, Some(terminal.revision), |_| {}),
            Err(StoreError::Conflict(_))
        ));
    }
}
