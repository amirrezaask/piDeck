use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSession {
    pub id: String,
    pub title: String,
    pub position: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_tab_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_mux_terminal_id: Option<String>,
    pub revision: u64,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTab {
    pub id: String,
    pub session_id: String,
    pub title: String,
    pub position: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_mux_terminal_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layout_json: Option<String>,
    pub revision: u64,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalInput {
    #[serde(rename = "_tag")]
    pub tag: String,
    pub kind: String,
    #[serde(rename = "shellArgs", skip_serializing_if = "Option::is_none")]
    pub shell_args: Option<Vec<String>>,
}

impl Default for TerminalInput {
    fn default() -> Self {
        Self {
            tag: "TerminalInput".to_owned(),
            kind: "terminal".to_owned(),
            shell_args: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessState {
    Starting,
    Running,
    Exited,
    Failed,
    Disconnected,
    Interrupted,
    Restoring,
    Orphaned,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityState {
    Starting,
    Working,
    RunningCommand,
    WaitingForInput,
    Idle,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessIdentity {
    pub pid: u32,
    pub platform: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boot_id: Option<String>,
    pub start_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable_path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutput {
    #[serde(rename = "_tag")]
    pub tag: String,
    pub kind: String,
    pub terminal_instance_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pty_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_identity: Option<ProcessIdentity>,
    pub generation: u64,
    pub process_state: ProcessState,
    pub activity_state: ActivityState,
    pub replay_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub truncated: bool,
}

impl TerminalOutput {
    #[must_use]
    pub fn pending() -> Self {
        Self {
            tag: "TerminalOutput".to_owned(),
            kind: "process".to_owned(),
            terminal_instance_id: "pending".to_owned(),
            pty_id: None,
            history_id: None,
            process_identity: None,
            generation: 1,
            process_state: ProcessState::Starting,
            activity_state: ActivityState::Starting,
            replay_available: false,
            exit_code: None,
            truncated: false,
        }
    }

    #[must_use]
    pub fn running(
        pty_id: String,
        generation: u64,
        process_identity: Option<ProcessIdentity>,
    ) -> Self {
        Self {
            tag: "TerminalOutput".to_owned(),
            kind: "process".to_owned(),
            terminal_instance_id: uuid::Uuid::new_v4().to_string(),
            history_id: Some(pty_id.clone()),
            pty_id: Some(pty_id),
            process_identity,
            generation,
            process_state: ProcessState::Running,
            activity_state: ActivityState::Working,
            replay_available: true,
            exit_code: None,
            truncated: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalStatus {
    Created,
    Starting,
    Running,
    Waiting,
    Succeeded,
    Failed,
    Cancelled,
    Disconnected,
}

impl TerminalStatus {
    #[must_use]
    pub const fn is_live(&self) -> bool {
        matches!(
            self,
            Self::Created | Self::Starting | Self::Running | Self::Waiting
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MuxTerminal {
    pub id: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub position: usize,
    pub status: TerminalStatus,
    pub input: TerminalInput,
    pub input_revision: u64,
    pub output: TerminalOutput,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub revision: u64,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub session: AppSession,
    pub tabs: Vec<SessionTab>,
    pub mux_terminals: Vec<MuxTerminal>,
}

#[must_use]
pub fn now_iso() -> String {
    jiff::Timestamp::now().to_string()
}
