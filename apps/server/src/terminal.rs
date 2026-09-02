use std::{
    collections::{HashMap, HashSet, VecDeque},
    env,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command as ProcessCommand,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU64, Ordering},
    },
    thread,
    time::Instant,
};

use base64::Engine as _;
use bytes::Bytes;
use crossbeam_channel::{Receiver, Sender, TryRecvError, bounded, select_biased};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use serde_json::json;
use thiserror::Error;
use uuid::Uuid;

use crate::{
    event_hub::EventHub,
    model::ProcessIdentity,
    terminal_control::{
        RuntimeTerminalLease, TerminalControlError, TerminalControlRegistry, TerminalLeaseRequest,
    },
    terminal_history::{
        Base64Bytes, HistoryError, TerminalHistoryArchive, TerminalHistoryCapacityDiagnostics,
        TerminalHistoryPage,
    },
    wire::{TerminalLeaseMode, TerminalMutationFence},
};

const MAX_ENTRIES: usize = 64;
const MAX_REPLAY_BYTES: usize = 2 * 1024 * 1024;
const EXITED_REPLAY_BYTES: usize = 256 * 1024;
const MAX_WRITE_BYTES: usize = 1024 * 1024;
const OWNER_COMMAND_BATCH_MESSAGES: usize = 64;
const OWNER_WRITE_BATCH_BYTES: usize = 256 * 1024;
const CLEANUP_QUEUE_CAPACITY: usize = 256;
const CHECKPOINT_BYTES: usize = 512 * 1024;
const CHECKPOINT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);
const EXITED_DISPOSE_TTL: std::time::Duration = std::time::Duration::from_secs(90);

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalColor {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTheme {
    pub foreground: TerminalColor,
    pub background: TerminalColor,
    pub cursor: TerminalColor,
}

impl Default for TerminalTheme {
    fn default() -> Self {
        Self {
            foreground: TerminalColor {
                r: 238,
                g: 242,
                b: 247,
            },
            background: TerminalColor {
                r: 14,
                g: 21,
                b: 27,
            },
            cursor: TerminalColor {
                r: 0,
                g: 106,
                b: 222,
            },
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalLaunch {
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub theme: Option<TerminalTheme>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCreateResult {
    pub id: String,
    pub title: Option<String>,
    pub os_pid: Option<u32>,
    pub process_identity: Option<ProcessIdentity>,
    pub terminal_epoch: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInspect {
    pub id: String,
    pub title: Option<String>,
    pub status: TerminalProcessStatus,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub spawn_command: Option<String>,
    pub spawn_cwd: String,
    pub os_pid: Option<u32>,
    pub process_identity: Option<ProcessIdentity>,
    pub terminal_epoch: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalProcessStatus {
    Running,
    Exited,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCheckpoint {
    #[serde(rename = "checkpointVersion")]
    pub checkpoint_version: u8,
    #[serde(rename = "terminalEpoch")]
    pub terminal_epoch: String,
    pub sequence: u64,
    pub cols: u16,
    pub rows: u16,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "syntheticBytes")]
    pub synthetic_bytes: Base64Bytes,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttach {
    pub id: String,
    pub title: Option<String>,
    pub terminal_epoch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<TerminalCheckpoint>,
    pub replay_quality: &'static str,
    pub output_chunks: Vec<Base64Bytes>,
    pub output: Base64Bytes,
    pub replay_truncated: bool,
    pub replay_needs_query_responses: bool,
    pub archive_available: bool,
    pub last_sequence: u64,
    pub cols: u16,
    pub rows: u16,
    pub status: TerminalProcessStatus,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
}

#[derive(Debug, Error)]
pub enum TerminalError {
    #[error("terminal not found: {0}")]
    NotFound(String),
    #[error("too many terminals (max 64); close a terminal before creating another")]
    Limit,
    #[error("invalid terminal input: {0}")]
    Invalid(String),
    #[error("terminal runtime failure: {0}")]
    Runtime(String),
    #[error(transparent)]
    Control(#[from] TerminalControlError),
    #[error(transparent)]
    History(#[from] HistoryError),
}

impl TerminalError {
    #[must_use]
    pub const fn wire_code(&self) -> &'static str {
        match self {
            Self::NotFound(_) => "NOT_FOUND",
            Self::Limit | Self::Invalid(_) | Self::Runtime(_) | Self::History(_) => {
                "OPERATION_FAILED"
            }
            Self::Control(error) => error.code.as_wire_code(),
        }
    }
}

#[derive(Clone)]
struct ReplayChunk {
    sequence: u64,
    data: Bytes,
}

struct EntryState {
    status: TerminalProcessStatus,
    exit_code: Option<i32>,
    signal: Option<i32>,
    sequence: u64,
    replay: VecDeque<ReplayChunk>,
    replay_bytes: usize,
    replay_truncated: bool,
    cols: u16,
    rows: u16,
    disposed: bool,
    replay_ready_clients: HashSet<String>,
    query_leftover: Vec<u8>,
    osc7_scanner: Osc7Scanner,
    terminal_theme: TerminalTheme,
    theme_updates_enabled: bool,
    live_cwd: Option<PathBuf>,
    recorder: Option<vt100::Parser>,
    checkpoint: Option<TerminalCheckpoint>,
    bytes_since_checkpoint: usize,
    last_checkpoint_at: Instant,
}

type Reply<T> = Sender<Result<T, TerminalError>>;

enum TerminalCommand {
    Inspect {
        reply: Reply<TerminalInspect>,
    },
    Write {
        data: Bytes,
        reply: Reply<()>,
    },
    Authorize {
        principal_id: String,
        connection_id: String,
        fence: Option<TerminalMutationFence>,
        reply: Reply<RuntimeTerminalLease>,
    },
    AuthorizeAndWrite {
        principal_id: String,
        connection_id: String,
        fence: Option<TerminalMutationFence>,
        data: Bytes,
        reply: Reply<RuntimeTerminalLease>,
    },
    SetTheme {
        theme: TerminalTheme,
        reply: Reply<()>,
    },
    Resize {
        cols: u16,
        rows: u16,
        reply: Reply<()>,
    },
    AuthorizeAndResize {
        principal_id: String,
        connection_id: String,
        fence: Option<TerminalMutationFence>,
        cols: u16,
        rows: u16,
        reply: Reply<RuntimeTerminalLease>,
    },
    Attach {
        client_id: String,
        after_sequence: u64,
        reply: Reply<TerminalAttach>,
    },
    MarkReplayReady {
        client_id: String,
        reply: Reply<()>,
    },
    Detach {
        client_id: String,
        reply: Reply<()>,
    },
    Dispose {
        reply: Reply<()>,
    },
    AuthorizeAndDispose {
        principal_id: String,
        connection_id: String,
        fence: Option<TerminalMutationFence>,
        reply: Reply<RuntimeTerminalLease>,
    },
    GetLiveCwd {
        reply: Reply<Option<PathBuf>>,
    },
    AcquireLease {
        request: TerminalLeaseRequest,
        reply: Reply<RuntimeTerminalLease>,
    },
    RenewLease {
        lease_id: String,
        principal_id: String,
        connection_id: String,
        reply: Reply<RuntimeTerminalLease>,
    },
    ReleaseLease {
        lease_id: String,
        principal_id: String,
        connection_id: String,
        reply: Reply<()>,
    },
    Takeover {
        principal_id: String,
        connection_id: String,
        reply: Reply<RuntimeTerminalLease>,
    },
    Transfer {
        lease_id: String,
        principal_id: String,
        connection_id: String,
        target_connection_id: String,
        reply: Reply<RuntimeTerminalLease>,
    },
    ListLeases {
        reply: Reply<Vec<RuntimeTerminalLease>>,
    },
    ReleaseConnection {
        connection_id: String,
    },
}

impl TerminalCommand {
    const fn is_urgent(&self) -> bool {
        matches!(
            self,
            Self::Write { .. }
                | Self::Authorize { .. }
                | Self::AuthorizeAndWrite { .. }
                | Self::Resize { .. }
                | Self::AuthorizeAndResize { .. }
                | Self::Attach { .. }
                | Self::Dispose { .. }
                | Self::AuthorizeAndDispose { .. }
                | Self::AcquireLease { .. }
                | Self::RenewLease { .. }
                | Self::ReleaseLease { .. }
                | Self::Takeover { .. }
                | Self::Transfer { .. }
                | Self::ReleaseConnection { .. }
        )
    }
}

enum OutputMessage {
    Bytes(Bytes),
    Eof,
    ReadFailed(std::io::ErrorKind),
}

struct TerminalEntry {
    id: String,
    title: Option<String>,
    terminal_epoch: String,
    spawn_command: Option<String>,
    spawn_cwd: PathBuf,
    os_pid: Option<u32>,
    process_identity: Option<ProcessIdentity>,
    urgent_commands: Sender<TerminalCommand>,
    normal_commands: Sender<TerminalCommand>,
}

pub struct TerminalHost {
    entries: Mutex<HashMap<String, Arc<TerminalEntry>>>,
    events: Arc<EventHub>,
    next_id: AtomicU64,
    cleanup_tx: tokio::sync::mpsc::Sender<(String, String)>,
    history: TerminalHistoryArchive,
    checkpoints: bool,
}

impl TerminalHost {
    pub fn new(
        events: Arc<EventHub>,
        history_root: &Path,
        checkpoints: bool,
    ) -> Result<Arc<Self>, TerminalError> {
        let (cleanup_tx, mut cleanup_rx) = tokio::sync::mpsc::channel(CLEANUP_QUEUE_CAPACITY);
        let host = Arc::new(Self {
            entries: Mutex::new(HashMap::new()),
            events,
            next_id: AtomicU64::new(0),
            cleanup_tx,
            history: TerminalHistoryArchive::open(history_root)?,
            checkpoints,
        });
        let weak = Arc::downgrade(&host);
        tokio::spawn(async move {
            while let Some((id, terminal_epoch)) = cleanup_rx.recv().await {
                let weak = weak.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(EXITED_DISPOSE_TTL).await;
                    let Some(host) = weak.upgrade() else { return };
                    let current_epoch = host.inspect(&id).map(|entry| entry.terminal_epoch);
                    if current_epoch.as_deref() == Some(&terminal_epoch) {
                        let _ = host.dispose(&id);
                    }
                });
            }
        });
        Ok(host)
    }

    pub fn create(
        self: &Arc<Self>,
        cwd: &Path,
        launch: Option<TerminalLaunch>,
    ) -> Result<TerminalCreateResult, TerminalError> {
        let cwd = cwd
            .canonicalize()
            .map_err(|error| TerminalError::Invalid(error.to_string()))?;
        if !cwd.is_dir() {
            return Err(TerminalError::Invalid("cwd is not a directory".to_owned()));
        }
        let at_capacity = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
            >= MAX_ENTRIES;
        if at_capacity {
            let ids = self
                .entries
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .keys()
                .cloned()
                .collect::<Vec<_>>();
            let exited = ids.into_iter().find(|id| {
                self.inspect(id)
                    .is_some_and(|entry| entry.status == TerminalProcessStatus::Exited)
            });
            if let Some(id) = exited {
                let _ = self.dispose(&id);
            } else {
                return Err(TerminalError::Limit);
            }
        }
        let launch = launch.unwrap_or_default();
        let terminal_theme = launch.theme.unwrap_or_default();
        let cols = launch.cols.unwrap_or(80).clamp(1, 1000);
        let rows = launch.rows.unwrap_or(24).clamp(1, 1000);
        let command = launch.command.clone().unwrap_or_else(default_shell);
        let args = if launch.command.is_some() || !launch.args.is_empty() {
            launch.args.clone()
        } else {
            default_shell_args(&command)
        };
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| TerminalError::Runtime(error.to_string()))?;
        let mut builder = CommandBuilder::new(&command);
        builder.args(args);
        builder.cwd(&cwd);
        const SANITIZED_ENV: &[&str] = &[
            "TMUX",
            "TMUX_PANE",
            "STY",
            "WINDOW",
            "WINDOWID",
            "TERMCAP",
            "COLUMNS",
            "LINES",
            "NODE_OPTIONS",
            "NODE_PATH",
        ];
        for (key, value) in env::vars() {
            if !SANITIZED_ENV.contains(&key.as_str()) {
                builder.env(key, value);
            }
        }
        builder.env("TERM", "xterm-256color");
        builder.env("COLORTERM", "truecolor");
        for (key, value) in launch.env {
            builder.env(key, value);
        }
        let child = pair
            .slave
            .spawn_command(builder)
            .map_err(|error| TerminalError::Runtime(error.to_string()))?;
        drop(pair.slave);
        let os_pid = child.process_id();
        let process_identity = os_pid.and_then(capture_process_identity);
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| TerminalError::Runtime(error.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| TerminalError::Runtime(error.to_string()))?;
        let id = format!(
            "term-{}-{}",
            jiff::Timestamp::now().as_millisecond(),
            self.next_id.fetch_add(1, Ordering::Relaxed) + 1
        );
        let terminal_epoch = Uuid::new_v4().to_string();
        let title = launch
            .command
            .is_none()
            .then(|| Path::new(&command).file_name()?.to_str().map(str::to_owned))
            .flatten();
        let (urgent_command_tx, urgent_command_rx) = bounded(64);
        let (normal_command_tx, normal_command_rx) = bounded(64);
        let (output_tx, output_rx) = bounded(64);
        let entry = Arc::new(TerminalEntry {
            id: id.clone(),
            title: title.clone(),
            terminal_epoch: terminal_epoch.clone(),
            spawn_command: launch.command,
            spawn_cwd: cwd,
            os_pid,
            process_identity: process_identity.clone(),
            urgent_commands: urgent_command_tx,
            normal_commands: normal_command_tx,
        });
        let state = EntryState {
            status: TerminalProcessStatus::Running,
            exit_code: None,
            signal: None,
            sequence: 0,
            replay: VecDeque::new(),
            replay_bytes: 0,
            replay_truncated: false,
            cols,
            rows,
            disposed: false,
            replay_ready_clients: HashSet::new(),
            query_leftover: Vec::new(),
            osc7_scanner: Osc7Scanner::default(),
            terminal_theme,
            theme_updates_enabled: false,
            live_cwd: None,
            recorder: self.checkpoints.then(|| vt100::Parser::new(rows, cols, 0)),
            checkpoint: None,
            bytes_since_checkpoint: 0,
            last_checkpoint_at: Instant::now(),
        };
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id.clone(), Arc::clone(&entry));

        let weak = Arc::downgrade(self);
        let owner_entry = Arc::clone(&entry);
        thread::Builder::new()
            .name(format!("yaade-terminal-owner-{id}"))
            .stack_size(1024 * 1024)
            .spawn(move || {
                terminal_owner_loop(
                    weak,
                    owner_entry,
                    pair.master,
                    writer,
                    child,
                    state,
                    urgent_command_rx,
                    normal_command_rx,
                    output_rx,
                );
            })
            .map_err(|error| TerminalError::Runtime(error.to_string()))?;
        thread::Builder::new()
            .name(format!("yaade-pty-reader-{id}"))
            .stack_size(256 * 1024)
            .spawn(move || pty_reader_loop(output_tx, &mut reader))
            .map_err(|error| TerminalError::Runtime(error.to_string()))?;

        Ok(TerminalCreateResult {
            id,
            title,
            os_pid,
            process_identity,
            terminal_epoch,
        })
    }

    fn entry(&self, id: &str) -> Result<Arc<TerminalEntry>, TerminalError> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(|| TerminalError::NotFound(id.to_owned()))
    }

    fn request<T>(
        &self,
        entry: &TerminalEntry,
        command: impl FnOnce(Reply<T>) -> TerminalCommand,
    ) -> Result<T, TerminalError> {
        let (reply, result) = bounded(1);
        let command = command(reply);
        let commands = if command.is_urgent() {
            &entry.urgent_commands
        } else {
            &entry.normal_commands
        };
        commands.try_send(command).map_err(|error| match error {
            crossbeam_channel::TrySendError::Full(_) => {
                TerminalError::Runtime("terminal control mailbox is full".to_owned())
            }
            crossbeam_channel::TrySendError::Disconnected(_) => {
                TerminalError::Runtime("terminal owner stopped".to_owned())
            }
        })?;
        result
            .recv_timeout(std::time::Duration::from_secs(30))
            .map_err(|_| TerminalError::Runtime("terminal owner reply timed out".to_owned()))?
    }

    #[must_use]
    pub fn is_live_terminal(&self, id: &str) -> bool {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains_key(id)
    }

    #[must_use]
    pub fn inspect(&self, id: &str) -> Option<TerminalInspect> {
        let entry = self.entry(id).ok()?;
        self.request(&entry, |reply| TerminalCommand::Inspect { reply })
            .ok()
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), TerminalError> {
        if data.len() > MAX_WRITE_BYTES {
            return Err(TerminalError::Invalid(
                "terminal write exceeds 1 MiB".to_owned(),
            ));
        }
        let entry = self.entry(id)?;
        self.request(&entry, |reply| TerminalCommand::Write {
            data: Bytes::copy_from_slice(data),
            reply,
        })
    }

    pub fn authorize_and_write(
        &self,
        id: &str,
        principal_id: &str,
        connection_id: &str,
        fence: Option<TerminalMutationFence>,
        data: Bytes,
    ) -> Result<RuntimeTerminalLease, TerminalError> {
        if data.len() > MAX_WRITE_BYTES {
            return Err(TerminalError::Invalid(
                "terminal write exceeds 1 MiB".to_owned(),
            ));
        }
        let entry = self.entry(id)?;
        self.request(&entry, |reply| TerminalCommand::AuthorizeAndWrite {
            principal_id: principal_id.to_owned(),
            connection_id: connection_id.to_owned(),
            fence,
            data,
            reply,
        })
    }

    pub fn write_base64(&self, id: &str, encoded: &str) -> Result<(), TerminalError> {
        let data = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|error| TerminalError::Invalid(error.to_string()))?;
        self.write(id, &data)
    }

    pub fn authorize_and_write_base64(
        &self,
        id: &str,
        principal_id: &str,
        connection_id: &str,
        fence: Option<TerminalMutationFence>,
        encoded: &str,
    ) -> Result<RuntimeTerminalLease, TerminalError> {
        let data = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|error| TerminalError::Invalid(error.to_string()))?;
        self.authorize_and_write(id, principal_id, connection_id, fence, Bytes::from(data))
    }

    pub fn set_theme(&self, id: &str, theme: TerminalTheme) -> Result<(), TerminalError> {
        let entry = self.entry(id)?;
        self.request(&entry, |reply| TerminalCommand::SetTheme { theme, reply })
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), TerminalError> {
        let entry = self.entry(id)?;
        self.request(&entry, |reply| TerminalCommand::Resize {
            cols,
            rows,
            reply,
        })
    }

    pub fn authorize_and_resize(
        &self,
        id: &str,
        principal_id: &str,
        connection_id: &str,
        fence: Option<TerminalMutationFence>,
        cols: u16,
        rows: u16,
    ) -> Result<RuntimeTerminalLease, TerminalError> {
        let entry = self.entry(id)?;
        self.request(&entry, |reply| TerminalCommand::AuthorizeAndResize {
            principal_id: principal_id.to_owned(),
            connection_id: connection_id.to_owned(),
            fence,
            cols,
            rows,
            reply,
        })
    }

    pub fn attach(
        &self,
        id: &str,
        client_id: &str,
        after_sequence: u64,
    ) -> Result<TerminalAttach, TerminalError> {
        match self.entry(id) {
            Ok(entry) => self.request(&entry, |reply| TerminalCommand::Attach {
                client_id: client_id.to_owned(),
                after_sequence,
                reply,
            }),
            Err(TerminalError::NotFound(_)) => {
                let metadata = self
                    .history
                    .inspect(id)?
                    .ok_or_else(|| TerminalError::NotFound(id.to_owned()))?;
                Ok(TerminalAttach {
                    id: id.to_owned(),
                    title: None,
                    terminal_epoch: id.to_owned(),
                    checkpoint: None,
                    replay_quality: "exact",
                    output_chunks: Vec::new(),
                    output: Base64Bytes(Bytes::new()),
                    replay_truncated: false,
                    replay_needs_query_responses: false,
                    archive_available: metadata.last_sequence > after_sequence,
                    last_sequence: metadata.last_sequence,
                    cols: 80,
                    rows: 24,
                    status: TerminalProcessStatus::Exited,
                    exit_code: None,
                    signal: None,
                })
            }
            Err(error) => Err(error),
        }
    }

    pub fn read_replay_page(
        &self,
        id: &str,
        cursor_sequence: u64,
        max_bytes: Option<usize>,
        reverse: bool,
    ) -> Result<Option<TerminalHistoryPage>, TerminalError> {
        if reverse {
            self.history
                .read_page_reverse(id, cursor_sequence, max_bytes)
                .map_err(Into::into)
        } else {
            self.history
                .read_page(id, cursor_sequence, max_bytes)
                .map_err(Into::into)
        }
    }

    #[must_use]
    pub fn history_available(&self, id: &str) -> bool {
        self.history.available(id)
    }

    #[must_use]
    pub fn history_capacity_diagnostics(&self) -> TerminalHistoryCapacityDiagnostics {
        self.history.capacity_diagnostics()
    }

    pub fn terminate_stale_process(
        &self,
        identity: &ProcessIdentity,
    ) -> Result<bool, TerminalError> {
        if !process_identity_matches(identity) {
            return Ok(false);
        }
        terminate_process_group(identity)?;
        Ok(true)
    }

    pub fn mark_replay_ready(&self, id: &str, client_id: &str) -> Result<(), TerminalError> {
        let entry = self.entry(id)?;
        self.request(&entry, |reply| TerminalCommand::MarkReplayReady {
            client_id: client_id.to_owned(),
            reply,
        })
    }

    pub fn detach(&self, id: &str, client_id: &str) -> Result<(), TerminalError> {
        let entry = self.entry(id)?;
        self.request(&entry, |reply| TerminalCommand::Detach {
            client_id: client_id.to_owned(),
            reply,
        })
    }

    pub fn dispose(&self, id: &str) -> Result<(), TerminalError> {
        let entry = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(|| TerminalError::NotFound(id.to_owned()))?;
        self.request(&entry, |reply| TerminalCommand::Dispose { reply })?;
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(id);
        if let Err(error) = self.history.close_terminal(id) {
            eprintln!("failed to enqueue terminal history finalization for {id}: {error}");
        }
        Ok(())
    }

    pub fn authorize_and_dispose(
        &self,
        id: &str,
        principal_id: &str,
        connection_id: &str,
        fence: Option<TerminalMutationFence>,
    ) -> Result<RuntimeTerminalLease, TerminalError> {
        let entry = self.entry(id)?;
        let lease = self.request(&entry, |reply| TerminalCommand::AuthorizeAndDispose {
            principal_id: principal_id.to_owned(),
            connection_id: connection_id.to_owned(),
            fence,
            reply,
        })?;
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(id);
        Ok(lease)
    }

    pub fn stop_all(&self) {
        let ids = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for id in ids {
            let _ = self.dispose(&id);
        }
        let _ = self.history.flush_all();
    }

    pub fn get_cwd(&self, id: &str) -> Result<String, TerminalError> {
        let entry = self.entry(id)?;
        let live_cwd = self.request(&entry, |reply| TerminalCommand::GetLiveCwd { reply })?;
        let cwd = entry
            .os_pid
            .and_then(process_cwd)
            .or(live_cwd)
            .unwrap_or_else(|| entry.spawn_cwd.clone());
        url::Url::from_file_path(cwd)
            .map(String::from)
            .map_err(|()| TerminalError::Runtime("could not encode cwd URI".to_owned()))
    }

    pub fn get_foreground_process(&self, id: &str) -> Result<Option<String>, TerminalError> {
        let entry = self.entry(id)?;
        let Some(pid) = entry.os_pid else {
            return Ok(None);
        };
        Ok(foreground_process(pid).or_else(|| {
            entry
                .spawn_command
                .as_deref()
                .or_else(|| entry.title.as_deref())
                .and_then(|command| Path::new(command).file_name()?.to_str().map(str::to_owned))
        }))
    }

    pub fn acquire_lease(
        &self,
        id: &str,
        principal_id: &str,
        connection_id: &str,
        mode: TerminalLeaseMode,
    ) -> Result<RuntimeTerminalLease, TerminalError> {
        let entry = self.entry(id)?;
        self.request(&entry, |reply| TerminalCommand::AcquireLease {
            request: TerminalLeaseRequest {
                terminal_id: id.to_owned(),
                terminal_epoch: entry.terminal_epoch.clone(),
                principal_id: principal_id.to_owned(),
                connection_id: connection_id.to_owned(),
                mode,
            },
            reply,
        })
    }

    pub fn renew_lease(
        &self,
        id: &str,
        lease_id: &str,
        principal_id: &str,
        connection_id: &str,
    ) -> Result<RuntimeTerminalLease, TerminalError> {
        let entry = self.entry(id)?;
        self.request(&entry, |reply| TerminalCommand::RenewLease {
            lease_id: lease_id.to_owned(),
            principal_id: principal_id.to_owned(),
            connection_id: connection_id.to_owned(),
            reply,
        })
    }

    pub fn release_lease(
        &self,
        id: &str,
        lease_id: &str,
        principal_id: &str,
        connection_id: &str,
    ) -> Result<(), TerminalError> {
        let entry = self.entry(id)?;
        self.request(&entry, |reply| TerminalCommand::ReleaseLease {
            lease_id: lease_id.to_owned(),
            principal_id: principal_id.to_owned(),
            connection_id: connection_id.to_owned(),
            reply,
        })
    }

    pub fn takeover(
        &self,
        id: &str,
        principal_id: &str,
        connection_id: &str,
    ) -> Result<RuntimeTerminalLease, TerminalError> {
        let entry = self.entry(id)?;
        self.request(&entry, |reply| TerminalCommand::Takeover {
            principal_id: principal_id.to_owned(),
            connection_id: connection_id.to_owned(),
            reply,
        })
    }

    pub fn transfer(
        &self,
        id: &str,
        lease_id: &str,
        principal_id: &str,
        connection_id: &str,
        target_connection_id: &str,
    ) -> Result<RuntimeTerminalLease, TerminalError> {
        let entry = self.entry(id)?;
        self.request(&entry, |reply| TerminalCommand::Transfer {
            lease_id: lease_id.to_owned(),
            principal_id: principal_id.to_owned(),
            connection_id: connection_id.to_owned(),
            target_connection_id: target_connection_id.to_owned(),
            reply,
        })
    }

    pub fn list_leases(&self, id: &str) -> Result<Vec<RuntimeTerminalLease>, TerminalError> {
        let entry = self.entry(id)?;
        self.request(&entry, |reply| TerminalCommand::ListLeases { reply })
    }

    #[must_use]
    pub fn list_all_leases(&self) -> Vec<RuntimeTerminalLease> {
        let entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .cloned()
            .collect::<Vec<_>>();
        entries
            .into_iter()
            .flat_map(|entry| {
                self.request(&entry, |reply| TerminalCommand::ListLeases { reply })
                    .unwrap_or_default()
            })
            .collect()
    }

    pub fn release_connection(&self, connection_id: &str) {
        let entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for entry in entries {
            let _ = entry
                .urgent_commands
                .try_send(TerminalCommand::ReleaseConnection {
                    connection_id: connection_id.to_owned(),
                });
        }
    }

    pub fn authorize_or_acquire(
        &self,
        id: &str,
        principal_id: &str,
        connection_id: &str,
        supplied: Option<TerminalMutationFence>,
    ) -> Result<RuntimeTerminalLease, TerminalError> {
        let entry = self.entry(id)?;
        self.request(&entry, |reply| TerminalCommand::Authorize {
            principal_id: principal_id.to_owned(),
            connection_id: connection_id.to_owned(),
            fence: supplied,
            reply,
        })
    }
}

fn pty_reader_loop(output: Sender<OutputMessage>, reader: &mut Box<dyn Read + Send>) {
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => {
                let _ = output.send(OutputMessage::Eof);
                break;
            }
            Ok(read) => {
                if output
                    .send(OutputMessage::Bytes(Bytes::copy_from_slice(
                        &buffer[..read],
                    )))
                    .is_err()
                {
                    break;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => {
                let _ = output.send(OutputMessage::ReadFailed(error.kind()));
                break;
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn terminal_owner_loop(
    host: Weak<TerminalHost>,
    entry: Arc<TerminalEntry>,
    master: Box<dyn MasterPty + Send>,
    mut writer: Box<dyn Write + Send>,
    mut child: Box<dyn Child + Send + Sync>,
    mut state: EntryState,
    urgent_commands: Receiver<TerminalCommand>,
    normal_commands: Receiver<TerminalCommand>,
    output: Receiver<OutputMessage>,
) {
    let mut control = TerminalControlRegistry::new();
    if control
        .register_terminal(&entry.id, &entry.terminal_epoch)
        .is_err()
    {
        return;
    }
    macro_rules! handle {
        ($command:expr) => {
            if !handle_terminal_command(
                &host,
                &entry,
                &*master,
                &mut writer,
                &mut child,
                &mut state,
                &mut control,
                $command,
            ) {
                return;
            }
        };
    }
    macro_rules! handle_batch {
        ($commands:expr, $scratch:expr) => {
            if !handle_terminal_command_batch(
                &host,
                &entry,
                &*master,
                &mut writer,
                &mut child,
                &mut state,
                &mut control,
                $commands,
                $scratch,
            ) {
                return;
            }
        };
    }
    let mut write_scratch = Vec::new();
    let mut output_open = true;
    let mut exit_observed = false;
    loop {
        // Bound each class per turn: input/disposal stays responsive without
        // allowing a hot producer to starve lifecycle work or PTY output.
        let mut urgent_batch = Vec::new();
        for _ in 0..OWNER_COMMAND_BATCH_MESSAGES {
            match urgent_commands.try_recv() {
                Ok(command) => urgent_batch.push(command),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return,
            }
        }
        if !urgent_batch.is_empty() {
            handle_batch!(urgent_batch, &mut write_scratch);
        }
        let mut output_bytes = 0_usize;
        while output_open && output_bytes < 1024 * 1024 {
            match output.try_recv() {
                Ok(OutputMessage::Bytes(data)) => {
                    output_bytes = output_bytes.saturating_add(data.len());
                    process_terminal_output(&host, &entry, &mut writer, &mut state, data);
                }
                Ok(OutputMessage::ReadFailed(kind)) => {
                    eprintln!("[terminal-reader] {} failed: {kind:?}", entry.id);
                    output_open = false;
                    break;
                }
                Ok(OutputMessage::Eof) | Err(TryRecvError::Disconnected) => {
                    output_open = false;
                    break;
                }
                Err(TryRecvError::Empty) => break,
            }
        }
        for _ in 0..4 {
            match normal_commands.try_recv() {
                Ok(command) => handle!(command),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return,
            }
        }
        if !output_open && !exit_observed {
            observe_terminal_exit(&host, &entry, &mut child, &mut state);
            exit_observed = true;
        }
        if !output_open {
            select_biased! {
                recv(urgent_commands) -> command => {
                    let first = match command { Ok(value) => value, Err(_) => return };
                    handle_batch!(collect_command_batch(first, &urgent_commands), &mut write_scratch);
                },
                recv(normal_commands) -> command => handle!(match command { Ok(value) => value, Err(_) => return }),
            }
            continue;
        }
        select_biased! {
            recv(urgent_commands) -> command => {
                let first = match command { Ok(value) => value, Err(_) => return };
                handle_batch!(collect_command_batch(first, &urgent_commands), &mut write_scratch);
            },
            recv(output) -> message => match message {
                Ok(OutputMessage::Bytes(data)) => {
                    process_terminal_output(&host, &entry, &mut writer, &mut state, data);
                }
                Ok(OutputMessage::ReadFailed(kind)) => {
                    eprintln!("[terminal-reader] {} failed: {kind:?}", entry.id);
                    output_open = false;
                }
                Ok(OutputMessage::Eof) | Err(_) => output_open = false,
            },
            recv(normal_commands) -> command => handle!(match command { Ok(value) => value, Err(_) => return }),
        }
    }
}

fn collect_command_batch(
    first: TerminalCommand,
    commands: &Receiver<TerminalCommand>,
) -> Vec<TerminalCommand> {
    let mut batch = Vec::with_capacity(OWNER_COMMAND_BATCH_MESSAGES);
    batch.push(first);
    for _ in 1..OWNER_COMMAND_BATCH_MESSAGES {
        match commands.try_recv() {
            Ok(command) => batch.push(command),
            Err(TryRecvError::Empty | TryRecvError::Disconnected) => break,
        }
    }
    batch
}

enum BatchedWriteReply {
    Direct(Reply<()>),
    Authorized {
        reply: Reply<RuntimeTerminalLease>,
        lease: RuntimeTerminalLease,
    },
}

enum BatchedResizeReply {
    Direct(Reply<()>),
    Authorized {
        reply: Reply<RuntimeTerminalLease>,
        lease: RuntimeTerminalLease,
    },
}

const fn command_write_bytes(command: &TerminalCommand) -> Option<usize> {
    match command {
        TerminalCommand::Write { data, .. } | TerminalCommand::AuthorizeAndWrite { data, .. } => {
            Some(data.len())
        }
        _ => None,
    }
}

const fn command_is_resize(command: &TerminalCommand) -> bool {
    matches!(
        command,
        TerminalCommand::Resize { .. } | TerminalCommand::AuthorizeAndResize { .. }
    )
}

#[allow(clippy::too_many_arguments)]
fn handle_terminal_command_batch(
    host: &Weak<TerminalHost>,
    entry: &TerminalEntry,
    master: &dyn MasterPty,
    writer: &mut Box<dyn Write + Send>,
    child: &mut Box<dyn Child + Send + Sync>,
    state: &mut EntryState,
    control: &mut TerminalControlRegistry,
    commands: Vec<TerminalCommand>,
    write_scratch: &mut Vec<u8>,
) -> bool {
    let mut commands = VecDeque::from(commands);
    while let Some(command) = commands.pop_front() {
        if command_write_bytes(&command).is_some() {
            let mut write_commands = vec![command];
            let mut batch_bytes = command_write_bytes(&write_commands[0]).unwrap_or(0);
            while write_commands.len() < OWNER_COMMAND_BATCH_MESSAGES {
                let Some(next_bytes) = commands.front().and_then(command_write_bytes) else {
                    break;
                };
                if batch_bytes > 0
                    && batch_bytes.saturating_add(next_bytes) > OWNER_WRITE_BATCH_BYTES
                {
                    break;
                }
                batch_bytes = batch_bytes.saturating_add(next_bytes);
                if let Some(next) = commands.pop_front() {
                    write_commands.push(next);
                }
            }

            write_scratch.clear();
            write_scratch.reserve(batch_bytes);
            let mut replies = Vec::with_capacity(write_commands.len());
            for command in write_commands {
                match command {
                    TerminalCommand::Write { data, reply } => {
                        write_scratch.extend_from_slice(&data);
                        replies.push(BatchedWriteReply::Direct(reply));
                    }
                    TerminalCommand::AuthorizeAndWrite {
                        principal_id,
                        connection_id,
                        fence,
                        data,
                        reply,
                    } => match authorize_terminal(
                        control,
                        entry,
                        &principal_id,
                        &connection_id,
                        fence,
                    ) {
                        Ok(lease) => {
                            write_scratch.extend_from_slice(&data);
                            replies.push(BatchedWriteReply::Authorized { reply, lease });
                        }
                        Err(error) => {
                            let _ = reply.send(Err(error));
                        }
                    },
                    _ => unreachable!("write batch contains only write commands"),
                }
            }
            let write_error = if write_scratch.is_empty() {
                None
            } else {
                writer
                    .write_all(write_scratch)
                    .and_then(|()| writer.flush())
                    .err()
                    .map(|error| error.to_string())
            };
            for reply in replies {
                match reply {
                    BatchedWriteReply::Direct(reply) => {
                        let result = write_error
                            .as_ref()
                            .map_or(Ok(()), |error| Err(TerminalError::Runtime(error.clone())));
                        let _ = reply.send(result);
                    }
                    BatchedWriteReply::Authorized { reply, lease } => {
                        let result = write_error.as_ref().map_or(Ok(lease), |error| {
                            Err(TerminalError::Runtime(error.clone()))
                        });
                        let _ = reply.send(result);
                    }
                }
            }
            continue;
        }

        if command_is_resize(&command) {
            let mut resize_commands = vec![command];
            while resize_commands.len() < OWNER_COMMAND_BATCH_MESSAGES
                && commands.front().is_some_and(command_is_resize)
            {
                if let Some(next) = commands.pop_front() {
                    resize_commands.push(next);
                }
            }
            let mut latest = None;
            let mut replies = Vec::with_capacity(resize_commands.len());
            for command in resize_commands {
                match command {
                    TerminalCommand::Resize { cols, rows, reply } => {
                        latest = Some((cols, rows));
                        replies.push(BatchedResizeReply::Direct(reply));
                    }
                    TerminalCommand::AuthorizeAndResize {
                        principal_id,
                        connection_id,
                        fence,
                        cols,
                        rows,
                        reply,
                    } => match authorize_terminal(
                        control,
                        entry,
                        &principal_id,
                        &connection_id,
                        fence,
                    ) {
                        Ok(lease) => {
                            latest = Some((cols, rows));
                            replies.push(BatchedResizeReply::Authorized { reply, lease });
                        }
                        Err(error) => {
                            let _ = reply.send(Err(error));
                        }
                    },
                    _ => unreachable!("resize batch contains only resize commands"),
                }
            }
            let resize_error = latest
                .and_then(|(cols, rows)| resize_terminal(master, entry, state, cols, rows).err())
                .map(|error| error.to_string());
            for reply in replies {
                match reply {
                    BatchedResizeReply::Direct(reply) => {
                        let result = resize_error
                            .as_ref()
                            .map_or(Ok(()), |error| Err(TerminalError::Runtime(error.clone())));
                        let _ = reply.send(result);
                    }
                    BatchedResizeReply::Authorized { reply, lease } => {
                        let result = resize_error.as_ref().map_or(Ok(lease), |error| {
                            Err(TerminalError::Runtime(error.clone()))
                        });
                        let _ = reply.send(result);
                    }
                }
            }
            continue;
        }

        if !handle_terminal_command(host, entry, master, writer, child, state, control, command) {
            return false;
        }
    }
    true
}

fn authorize_terminal(
    control: &mut TerminalControlRegistry,
    entry: &TerminalEntry,
    principal_id: &str,
    connection_id: &str,
    supplied: Option<TerminalMutationFence>,
) -> Result<RuntimeTerminalLease, TerminalError> {
    if let Some(mut fence) = supplied {
        fence.principal_id = principal_id.to_owned();
        fence.connection_id = connection_id.to_owned();
        return control.authorize_mutation(&fence).map_err(Into::into);
    }
    if let Some(existing) = control.list(&entry.id)?.into_iter().find(|lease| {
        lease.mode == TerminalLeaseMode::Writer
            && lease.principal_id == principal_id
            && lease.connection_id == connection_id
    }) {
        return Ok(existing);
    }
    control
        .acquire(TerminalLeaseRequest {
            terminal_id: entry.id.clone(),
            terminal_epoch: entry.terminal_epoch.clone(),
            principal_id: principal_id.to_owned(),
            connection_id: connection_id.to_owned(),
            mode: TerminalLeaseMode::Writer,
        })
        .map_err(Into::into)
}

fn write_terminal(writer: &mut Box<dyn Write + Send>, data: &Bytes) -> Result<(), TerminalError> {
    writer
        .write_all(data)
        .and_then(|()| writer.flush())
        .map_err(|error| TerminalError::Runtime(error.to_string()))
}

fn resize_terminal(
    master: &dyn MasterPty,
    entry: &TerminalEntry,
    state: &mut EntryState,
    cols: u16,
    rows: u16,
) -> Result<(), TerminalError> {
    let cols = cols.clamp(1, 1000);
    let rows = rows.clamp(1, 1000);
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| TerminalError::Runtime(error.to_string()))?;
    state.cols = cols;
    state.rows = rows;
    if let Some(recorder) = state.recorder.as_mut() {
        recorder.screen_mut().set_size(rows, cols);
        store_checkpoint(&entry.terminal_epoch, state);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn handle_terminal_command(
    host: &Weak<TerminalHost>,
    entry: &TerminalEntry,
    master: &dyn MasterPty,
    writer: &mut Box<dyn Write + Send>,
    child: &mut Box<dyn Child + Send + Sync>,
    state: &mut EntryState,
    control: &mut TerminalControlRegistry,
    command: TerminalCommand,
) -> bool {
    match command {
        TerminalCommand::Inspect { reply } => {
            let _ = reply.send(Ok(TerminalInspect {
                id: entry.id.clone(),
                title: entry.title.clone(),
                status: state.status,
                exit_code: state.exit_code,
                signal: state.signal,
                spawn_command: entry.spawn_command.clone(),
                spawn_cwd: entry.spawn_cwd.display().to_string(),
                os_pid: entry.os_pid,
                process_identity: entry.process_identity.clone(),
                terminal_epoch: entry.terminal_epoch.clone(),
            }));
        }
        TerminalCommand::Write { data, reply } => {
            let _ = reply.send(write_terminal(writer, &data));
        }
        TerminalCommand::Authorize {
            principal_id,
            connection_id,
            fence,
            reply,
        } => {
            let _ = reply.send(authorize_terminal(
                control,
                entry,
                &principal_id,
                &connection_id,
                fence,
            ));
        }
        TerminalCommand::AuthorizeAndWrite {
            principal_id,
            connection_id,
            fence,
            data,
            reply,
        } => {
            let result = authorize_terminal(control, entry, &principal_id, &connection_id, fence)
                .and_then(|lease| write_terminal(writer, &data).map(|()| lease));
            let _ = reply.send(result);
        }
        TerminalCommand::SetTheme { theme, reply } => {
            if state.terminal_theme != theme {
                state.terminal_theme = theme;
                if state.theme_updates_enabled {
                    let _ = write_terminal_theme_preference(&mut **writer, theme);
                    let _ = writer.flush();
                }
            }
            let _ = reply.send(Ok(()));
        }
        TerminalCommand::Resize { cols, rows, reply } => {
            let _ = reply.send(resize_terminal(master, entry, state, cols, rows));
        }
        TerminalCommand::AuthorizeAndResize {
            principal_id,
            connection_id,
            fence,
            cols,
            rows,
            reply,
        } => {
            let result = authorize_terminal(control, entry, &principal_id, &connection_id, fence)
                .and_then(|lease| {
                    resize_terminal(master, entry, state, cols, rows).map(|()| lease)
                });
            let _ = reply.send(result);
        }
        TerminalCommand::Attach {
            client_id,
            after_sequence,
            reply,
        } => {
            let archive_available = host
                .upgrade()
                .is_some_and(|host| host.history.available(&entry.id));
            let replay_floor = state
                .replay
                .front()
                .map_or(state.sequence + 1, |chunk| chunk.sequence);
            let checkpoint = state
                .checkpoint
                .as_ref()
                .filter(|checkpoint| state.replay_truncated && after_sequence < checkpoint.sequence)
                .cloned();
            let raw_after = checkpoint.as_ref().map_or(after_sequence, |checkpoint| {
                after_sequence.max(checkpoint.sequence)
            });
            let truncated =
                state.replay_truncated && checkpoint.is_none() && after_sequence + 1 < replay_floor;
            let mut output_chunks = state
                .replay
                .iter()
                .filter(|chunk| chunk.sequence > raw_after)
                .map(|chunk| Base64Bytes(chunk.data.clone()))
                .collect::<Vec<_>>();
            if archive_available && raw_after < state.sequence {
                output_chunks = bounded_replay_tail(output_chunks, EXITED_REPLAY_BYTES);
            }
            let _ = reply.send(Ok(TerminalAttach {
                id: entry.id.clone(),
                title: entry.title.clone(),
                terminal_epoch: entry.terminal_epoch.clone(),
                replay_quality: if checkpoint.is_some() {
                    "checkpoint"
                } else if truncated {
                    "degraded"
                } else {
                    "exact"
                },
                checkpoint,
                output_chunks,
                output: Base64Bytes(Bytes::new()),
                replay_truncated: state.replay_truncated && after_sequence + 1 < replay_floor,
                replay_needs_query_responses: !state.replay_ready_clients.contains(&client_id),
                archive_available,
                last_sequence: state.sequence,
                cols: state.cols,
                rows: state.rows,
                status: state.status,
                exit_code: state.exit_code,
                signal: state.signal,
            }));
        }
        TerminalCommand::MarkReplayReady { client_id, reply } => {
            state.replay_ready_clients.insert(client_id);
            let _ = reply.send(Ok(()));
        }
        TerminalCommand::Detach { client_id, reply } => {
            state.replay_ready_clients.remove(&client_id);
            let _ = reply.send(Ok(()));
        }
        TerminalCommand::GetLiveCwd { reply } => {
            let _ = reply.send(Ok(state.live_cwd.clone()));
        }
        TerminalCommand::AcquireLease { request, reply } => {
            let _ = reply.send(control.acquire(request).map_err(Into::into));
        }
        TerminalCommand::RenewLease {
            lease_id,
            principal_id,
            connection_id,
            reply,
        } => {
            let _ = reply.send(
                control
                    .renew(
                        &entry.id,
                        &entry.terminal_epoch,
                        &lease_id,
                        &principal_id,
                        &connection_id,
                    )
                    .map_err(Into::into),
            );
        }
        TerminalCommand::ReleaseLease {
            lease_id,
            principal_id,
            connection_id,
            reply,
        } => {
            let _ = reply.send(
                control
                    .release(
                        &entry.id,
                        &entry.terminal_epoch,
                        &lease_id,
                        &principal_id,
                        &connection_id,
                    )
                    .map_err(Into::into),
            );
        }
        TerminalCommand::Takeover {
            principal_id,
            connection_id,
            reply,
        } => {
            let _ = reply.send(
                control
                    .force_takeover(
                        &entry.id,
                        &entry.terminal_epoch,
                        &principal_id,
                        &connection_id,
                    )
                    .map_err(Into::into),
            );
        }
        TerminalCommand::Transfer {
            lease_id,
            principal_id,
            connection_id,
            target_connection_id,
            reply,
        } => {
            let _ = reply.send(
                control
                    .transfer(
                        &entry.id,
                        &entry.terminal_epoch,
                        &lease_id,
                        &principal_id,
                        &connection_id,
                        &principal_id,
                        &target_connection_id,
                    )
                    .map_err(Into::into),
            );
        }
        TerminalCommand::ListLeases { reply } => {
            let _ = reply.send(control.list(&entry.id).map_err(Into::into));
        }
        TerminalCommand::ReleaseConnection { connection_id } => {
            control.release_connection(&connection_id);
        }
        TerminalCommand::AuthorizeAndDispose {
            principal_id,
            connection_id,
            fence,
            reply,
        } => {
            let result = authorize_terminal(control, entry, &principal_id, &connection_id, fence)
                .and_then(|lease| {
                    state.disposed = true;
                    control.unregister_terminal(&entry.id, Some(&entry.terminal_epoch));
                    let killed = if matches!(child.try_wait(), Ok(Some(_))) {
                        Ok(())
                    } else {
                        child
                            .kill()
                            .map_err(|error| TerminalError::Runtime(error.to_string()))
                    };
                    killed.map(|()| lease)
                });
            let should_stop = result.is_ok();
            if should_stop
                && let Some(host) = host.upgrade()
                && let Err(error) = host.history.close_terminal(&entry.id)
            {
                eprintln!(
                    "failed to enqueue terminal history finalization for {}: {error}",
                    entry.id
                );
            }
            let _ = reply.send(result);
            if should_stop {
                return false;
            }
        }
        TerminalCommand::Dispose { reply } => {
            state.disposed = true;
            control.unregister_terminal(&entry.id, Some(&entry.terminal_epoch));
            let result = if matches!(child.try_wait(), Ok(Some(_))) {
                Ok(())
            } else {
                child
                    .kill()
                    .map_err(|error| TerminalError::Runtime(error.to_string()))
            };
            if let Some(host) = host.upgrade()
                && let Err(error) = host.history.close_terminal(&entry.id)
            {
                eprintln!(
                    "failed to enqueue terminal history finalization for {}: {error}",
                    entry.id
                );
            }
            let _ = reply.send(result);
            return false;
        }
    }
    true
}

fn process_terminal_output(
    host: &Weak<TerminalHost>,
    entry: &TerminalEntry,
    writer: &mut Box<dyn Write + Send>,
    state: &mut EntryState,
    data: Bytes,
) {
    if state.disposed {
        return;
    }
    state.sequence += 1;
    let sequence = state.sequence;
    state.replay.push_back(ReplayChunk {
        sequence,
        data: data.clone(),
    });
    state.replay_bytes = state.replay_bytes.saturating_add(data.len());
    while state.replay_bytes > MAX_REPLAY_BYTES && state.replay.len() > 1 {
        if let Some(dropped) = state.replay.pop_front() {
            state.replay_bytes = state.replay_bytes.saturating_sub(dropped.data.len());
            state.replay_truncated = true;
        }
    }
    let terminal_requests = feed_terminal_requests(&mut state.query_leftover, &data);
    let terminal_theme = state.terminal_theme;
    for request in terminal_requests {
        match request {
            TerminalRequest::Query(query) => {
                let _ = write_terminal_query_response(
                    &mut **writer,
                    query,
                    terminal_theme,
                    state.theme_updates_enabled,
                );
            }
            TerminalRequest::SetThemeUpdates(enabled) => state.theme_updates_enabled = enabled,
        }
    }
    let _ = writer.flush();
    if let Some(cwd) = state.osc7_scanner.feed(&data) {
        state.live_cwd = Some(cwd.canonicalize().unwrap_or(cwd));
    }
    if let Some(recorder) = state.recorder.as_mut() {
        recorder.process(&data);
        state.bytes_since_checkpoint = state.bytes_since_checkpoint.saturating_add(data.len());
        if state.bytes_since_checkpoint >= CHECKPOINT_BYTES
            || state.last_checkpoint_at.elapsed() >= CHECKPOINT_INTERVAL
        {
            store_checkpoint(&entry.terminal_epoch, state);
        }
    }
    let Some(host) = host.upgrade() else { return };
    if let Err(error) = host.history.append(&entry.id, sequence, data.clone()) {
        eprintln!("[terminal-history] {error}");
    }
    host.events
        .emit_terminal(Arc::<str>::from(entry.id.as_str()), sequence, data);
}

fn observe_terminal_exit(
    host: &Weak<TerminalHost>,
    entry: &TerminalEntry,
    child: &mut Box<dyn Child + Send + Sync>,
    state: &mut EntryState,
) {
    if state.disposed {
        return;
    }
    let exit = child.wait();
    let (exit_code, signal) = exit.map_or((1, None), |status| {
        (
            i32::try_from(status.exit_code()).unwrap_or(1),
            status.signal().and_then(signal_number),
        )
    });
    state.status = TerminalProcessStatus::Exited;
    state.exit_code = Some(exit_code);
    if state.recorder.is_some() {
        store_checkpoint(&entry.terminal_epoch, state);
    }
    state.signal = signal;
    while state.replay_bytes > EXITED_REPLAY_BYTES && state.replay.len() > 1 {
        if let Some(dropped) = state.replay.pop_front() {
            state.replay_bytes = state.replay_bytes.saturating_sub(dropped.data.len());
            state.replay_truncated = true;
        }
    }
    let Some(host) = host.upgrade() else { return };
    let mut args = vec![json!(entry.id), json!(exit_code)];
    if let Some(signal) = signal {
        args.push(json!(signal));
    }
    host.events.emit("terminal:exit", args);
    if let Err(error) = host.history.close_terminal(&entry.id) {
        eprintln!("[terminal-history] {error}");
    }
    let _ = host
        .cleanup_tx
        .blocking_send((entry.id.clone(), entry.terminal_epoch.clone()));
}

fn store_checkpoint(terminal_epoch: &str, state: &mut EntryState) {
    let Some(recorder) = state.recorder.as_ref() else {
        return;
    };
    let screen = recorder.screen();
    let (row, column) = screen.cursor_position();
    let mut ansi = Vec::with_capacity(state.cols as usize * state.rows as usize + 64);
    ansi.extend_from_slice(b"\x1b[0m\x1b[2J\x1b[H");
    if screen.alternate_screen() {
        ansi.extend_from_slice(b"\x1b[?1049h");
    } else {
        ansi.extend_from_slice(b"\x1b[?1049l");
    }
    ansi.extend_from_slice(&screen.contents_formatted());
    ansi.extend_from_slice(format!("\x1b[{};{}H", row + 1, column + 1).as_bytes());
    state.checkpoint = Some(TerminalCheckpoint {
        checkpoint_version: 1,
        terminal_epoch: terminal_epoch.to_owned(),
        sequence: state.sequence,
        cols: state.cols,
        rows: state.rows,
        created_at: crate::model::now_iso(),
        synthetic_bytes: Base64Bytes(Bytes::from(ansi)),
    });
    state.bytes_since_checkpoint = 0;
    state.last_checkpoint_at = Instant::now();
}

fn bounded_replay_tail(chunks: Vec<Base64Bytes>, max_bytes: usize) -> Vec<Base64Bytes> {
    let mut total = 0_usize;
    let mut start = chunks.len();
    for (index, chunk) in chunks.iter().enumerate().rev() {
        if start < chunks.len() && total.saturating_add(chunk.0.len()) > max_bytes {
            break;
        }
        start = index;
        total = total.saturating_add(chunk.0.len());
    }
    chunks.into_iter().skip(start).collect()
}

const OSC7_PREFIX: &[u8] = b"\x1b]7;";
const MAX_OSC7_PAYLOAD_BYTES: usize = 4096;

#[derive(Default)]
struct Osc7Scanner {
    prefix_len: usize,
    payload: Vec<u8>,
    in_payload: bool,
    saw_escape: bool,
}

impl Osc7Scanner {
    fn feed(&mut self, chunk: &[u8]) -> Option<PathBuf> {
        let mut last = None;
        for &byte in chunk {
            if !self.in_payload {
                if byte == OSC7_PREFIX[self.prefix_len] {
                    self.prefix_len += 1;
                    if self.prefix_len == OSC7_PREFIX.len() {
                        self.prefix_len = 0;
                        self.in_payload = true;
                        self.payload.clear();
                    }
                } else {
                    self.prefix_len = usize::from(byte == OSC7_PREFIX[0]);
                }
                continue;
            }
            if self.saw_escape {
                self.saw_escape = false;
                if byte == b'\\' {
                    last = self.finish().or(last);
                    continue;
                }
                if self.payload.len() < MAX_OSC7_PAYLOAD_BYTES {
                    self.payload.push(0x1b);
                }
            }
            if byte == 0x07 {
                last = self.finish().or(last);
            } else if byte == 0x1b {
                self.saw_escape = true;
            } else if self.payload.len() < MAX_OSC7_PAYLOAD_BYTES {
                self.payload.push(byte);
            } else {
                self.reset();
            }
        }
        last
    }

    fn finish(&mut self) -> Option<PathBuf> {
        let path = std::str::from_utf8(&self.payload).ok().and_then(osc7_path);
        self.reset();
        path
    }

    fn reset(&mut self) {
        self.prefix_len = 0;
        self.payload.clear();
        self.in_payload = false;
        self.saw_escape = false;
    }
}

fn osc7_path(value: &str) -> Option<PathBuf> {
    let without_scheme = value.trim().strip_prefix("file://")?;
    let pathname = if without_scheme.starts_with('/') {
        without_scheme
    } else {
        let slash = without_scheme.find('/')?;
        &without_scheme[slash..]
    };
    let decoded = percent_encoding::percent_decode_str(pathname)
        .decode_utf8()
        .ok()?;
    (!decoded.is_empty()).then(|| PathBuf::from(decoded.as_ref()))
}

fn signal_number(signal: &str) -> Option<i32> {
    match signal.trim_start_matches("SIG") {
        "HUP" => Some(1),
        "INT" => Some(2),
        "QUIT" => Some(3),
        "KILL" => Some(9),
        "TERM" => Some(15),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TerminalQuery {
    PrimaryDeviceAttributes,
    OperatingStatus,
    ForegroundColor,
    BackgroundColor,
    CursorColor,
    ThemeUpdatesMode,
    ThemePreference,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TerminalRequest {
    Query(TerminalQuery),
    SetThemeUpdates(bool),
}

const fn terminal_query(query: TerminalQuery) -> TerminalRequest {
    TerminalRequest::Query(query)
}

// Neovim enables DEC mode 2031 after DECRQM reports support, then uses the
// unsolicited 997 DSR to re-query OSC colors when the terminal palette changes.
const TERMINAL_REQUEST_SEQUENCES: [(&[u8], TerminalRequest); 13] = [
    (
        b"\x1b[?2031$p",
        terminal_query(TerminalQuery::ThemeUpdatesMode),
    ),
    (
        b"\x1b[?996n",
        terminal_query(TerminalQuery::ThemePreference),
    ),
    (b"\x1b[?2031h", TerminalRequest::SetThemeUpdates(true)),
    (b"\x1b[?2031l", TerminalRequest::SetThemeUpdates(false)),
    (
        b"\x1b[0c",
        terminal_query(TerminalQuery::PrimaryDeviceAttributes),
    ),
    (
        b"\x1b[c",
        terminal_query(TerminalQuery::PrimaryDeviceAttributes),
    ),
    (b"\x1b[5n", terminal_query(TerminalQuery::OperatingStatus)),
    (
        b"\x1b]10;?\x07",
        terminal_query(TerminalQuery::ForegroundColor),
    ),
    (
        b"\x1b]10;?\x1b\\",
        terminal_query(TerminalQuery::ForegroundColor),
    ),
    (
        b"\x1b]11;?\x07",
        terminal_query(TerminalQuery::BackgroundColor),
    ),
    (
        b"\x1b]11;?\x1b\\",
        terminal_query(TerminalQuery::BackgroundColor),
    ),
    (b"\x1b]12;?\x07", terminal_query(TerminalQuery::CursorColor)),
    (
        b"\x1b]12;?\x1b\\",
        terminal_query(TerminalQuery::CursorColor),
    ),
];

fn feed_terminal_requests(leftover: &mut Vec<u8>, chunk: &[u8]) -> Vec<TerminalRequest> {
    let mut requests = Vec::new();
    for &byte in chunk {
        if leftover.is_empty() {
            if byte == 0x1b {
                leftover.push(byte);
            }
            continue;
        }
        leftover.push(byte);
        if let Some((_, request)) = TERMINAL_REQUEST_SEQUENCES
            .iter()
            .find(|(sequence, _)| *sequence == leftover.as_slice())
        {
            requests.push(*request);
            leftover.clear();
        } else if !TERMINAL_REQUEST_SEQUENCES
            .iter()
            .any(|(sequence, _)| sequence.starts_with(leftover))
        {
            let restart = byte == 0x1b;
            leftover.clear();
            if restart {
                leftover.push(byte);
            }
        }
    }
    requests
}

fn terminal_theme_preference(theme: TerminalTheme) -> u8 {
    let background = theme.background;
    let luma = u32::from(background.r) * 299
        + u32::from(background.g) * 587
        + u32::from(background.b) * 114;
    if luma >= 128_000 { 2 } else { 1 }
}

fn write_terminal_theme_preference<W: Write + ?Sized>(
    writer: &mut W,
    theme: TerminalTheme,
) -> std::io::Result<()> {
    write!(writer, "\x1b[?997;{}n", terminal_theme_preference(theme))
}

fn write_terminal_query_response<W: Write + ?Sized>(
    writer: &mut W,
    query: TerminalQuery,
    theme: TerminalTheme,
    theme_updates_enabled: bool,
) -> std::io::Result<()> {
    match query {
        TerminalQuery::PrimaryDeviceAttributes => {
            writer.write_all(b"\x1b[?64;1;2;6;9;15;18;21;22c")
        }
        TerminalQuery::OperatingStatus => writer.write_all(b"\x1b[0n"),
        TerminalQuery::ThemeUpdatesMode => write!(
            writer,
            "\x1b[?2031;{}$y",
            if theme_updates_enabled { 1 } else { 2 },
        ),
        TerminalQuery::ThemePreference => write_terminal_theme_preference(writer, theme),
        TerminalQuery::ForegroundColor
        | TerminalQuery::BackgroundColor
        | TerminalQuery::CursorColor => {
            let (selector, color) = match query {
                TerminalQuery::ForegroundColor => (10, theme.foreground),
                TerminalQuery::BackgroundColor => (11, theme.background),
                TerminalQuery::CursorColor => (12, theme.cursor),
                TerminalQuery::PrimaryDeviceAttributes
                | TerminalQuery::OperatingStatus
                | TerminalQuery::ThemeUpdatesMode
                | TerminalQuery::ThemePreference => unreachable!(),
            };
            write!(
                writer,
                "\x1b]{selector};rgb:{:04x}/{:04x}/{:04x}\x1b\\",
                u16::from(color.r) * 0x101,
                u16::from(color.g) * 0x101,
                u16::from(color.b) * 0x101,
            )
        }
    }
}

fn command_output(command: &str, args: &[&str]) -> Option<String> {
    let output = ProcessCommand::new(command).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!value.is_empty()).then_some(value)
}

fn process_identity_matches(identity: &ProcessIdentity) -> bool {
    capture_process_identity(identity.pid).as_ref() == Some(identity)
}

fn terminate_process_group(identity: &ProcessIdentity) -> Result<(), TerminalError> {
    let pid = identity.pid;
    #[cfg(unix)]
    {
        let process_group = format!("-{pid}");
        let graceful = ProcessCommand::new("kill")
            .args(["-TERM", &process_group])
            .status();
        match graceful {
            Ok(result) if result.success() => {}
            Ok(_) if !process_identity_matches(identity) => return Ok(()),
            Ok(result) => {
                return Err(TerminalError::Runtime(format!(
                    "failed to terminate stale terminal process group {pid}: {result}"
                )));
            }
            Err(error) => return Err(TerminalError::Runtime(error.to_string())),
        }

        let deadline = Instant::now() + std::time::Duration::from_millis(100);
        while Instant::now() < deadline {
            if !process_group_exists(&process_group) {
                return Ok(());
            }
            thread::sleep(std::time::Duration::from_millis(10));
        }
        let forced = ProcessCommand::new("kill")
            .args(["-KILL", &process_group])
            .status();
        match forced {
            Ok(result) if result.success() || !process_group_exists(&process_group) => Ok(()),
            Ok(result) => Err(TerminalError::Runtime(format!(
                "failed to kill stale terminal process group {pid}: {result}"
            ))),
            Err(error) => Err(TerminalError::Runtime(error.to_string())),
        }
    }
    #[cfg(target_os = "windows")]
    {
        let pid_text = pid.to_string();
        let _ = ProcessCommand::new("taskkill.exe")
            .args(["/PID", &pid_text, "/T"])
            .status();
        let deadline = Instant::now() + std::time::Duration::from_millis(100);
        while Instant::now() < deadline {
            if !process_identity_matches(identity) {
                return Ok(());
            }
            thread::sleep(std::time::Duration::from_millis(10));
        }
        let forced = ProcessCommand::new("taskkill.exe")
            .args(["/PID", &pid_text, "/T", "/F"])
            .status();
        match forced {
            Ok(result) if result.success() || !process_identity_matches(identity) => Ok(()),
            Ok(result) => Err(TerminalError::Runtime(format!(
                "failed to terminate stale terminal process tree {pid}: {result}"
            ))),
            Err(error) => Err(TerminalError::Runtime(error.to_string())),
        }
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    Err(TerminalError::Runtime(
        "stale process cleanup is unsupported on this platform".to_owned(),
    ))
}

#[cfg(unix)]
fn process_group_exists(process_group: &str) -> bool {
    ProcessCommand::new("kill")
        .args(["-0", process_group])
        .status()
        .is_ok_and(|status| status.success())
}

pub(crate) fn capture_process_identity(pid: u32) -> Option<ProcessIdentity> {
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let delimiter = stat.rfind(") ")?;
        let fields = stat[delimiter + 2..].split_whitespace().collect::<Vec<_>>();
        let start_token = fields.get(19)?.to_string();
        let boot_id = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        let executable_path = std::fs::read_link(format!("/proc/{pid}/exe"))
            .ok()
            .map(|path| path.display().to_string());
        return Some(ProcessIdentity {
            pid,
            platform: "linux".to_owned(),
            boot_id,
            start_token,
            executable_path,
        });
    }
    #[cfg(target_os = "macos")]
    {
        let pid_text = pid.to_string();
        let start_token = command_output("ps", &["-p", &pid_text, "-o", "lstart="])?
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let executable_path = command_output("ps", &["-p", &pid_text, "-o", "comm="]);
        return Some(ProcessIdentity {
            pid,
            platform: "darwin".to_owned(),
            boot_id: None,
            start_token,
            executable_path,
        });
    }
    #[cfg(target_os = "windows")]
    {
        let start_token = command_output(
            "powershell.exe",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!("(Get-Process -Id {pid}).StartTime.ToUniversalTime().Ticks"),
            ],
        )?;
        let executable_path = command_output(
            "powershell.exe",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!("(Get-Process -Id {pid}).Path"),
            ],
        );
        return Some(ProcessIdentity {
            pid,
            platform: "windows".to_owned(),
            boot_id: None,
            start_token,
            executable_path,
        });
    }
    #[allow(unreachable_code)]
    None
}

fn foreground_pid(pid: u32) -> Option<u32> {
    #[cfg(unix)]
    {
        let pid_text = pid.to_string();
        return command_output("ps", &["-p", &pid_text, "-o", "tpgid="])?
            .trim()
            .parse::<u32>()
            .ok()
            .filter(|process_group| *process_group > 0);
    }
    #[allow(unreachable_code)]
    Some(pid)
}

fn process_cwd(pid: u32) -> Option<PathBuf> {
    let foreground = foreground_pid(pid).unwrap_or(pid);
    #[cfg(target_os = "linux")]
    {
        return std::fs::read_link(format!("/proc/{foreground}/cwd")).ok();
    }
    #[cfg(target_os = "macos")]
    {
        let pid = foreground.to_string();
        for executable in ["/usr/sbin/lsof", "/usr/bin/lsof", "lsof"] {
            if let Some(output) =
                command_output(executable, &["-a", "-d", "cwd", "-p", &pid, "-Fn"])
                && let Some(cwd) = output.lines().find_map(|line| line.strip_prefix('n'))
                && !cwd.is_empty()
            {
                return Some(PathBuf::from(cwd));
            }
        }
    }
    #[allow(unreachable_code)]
    None
}

fn foreground_process(pid: u32) -> Option<String> {
    #[cfg(unix)]
    {
        let process_group = foreground_pid(pid)?.to_string();
        let command = command_output("ps", &["-p", &process_group, "-o", "comm="])?;
        return Path::new(&command).file_name()?.to_str().map(str::to_owned);
    }
    #[allow(unreachable_code)]
    None
}

fn default_shell() -> String {
    env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(windows) {
            "powershell.exe".to_owned()
        } else {
            "/bin/zsh".to_owned()
        }
    })
}

fn default_shell_args(shell: &str) -> Vec<String> {
    let basename = Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(shell);
    if basename == "zsh" || basename == "bash" {
        vec!["-il".to_owned()]
    } else {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn stale_process_identity_does_not_match_a_live_reused_pid() {
        let mut child = ProcessCommand::new("sleep")
            .arg("5")
            .spawn()
            .expect("spawn child");
        let mut identity = capture_process_identity(child.id()).expect("process identity");
        identity.start_token.push_str("-stale");
        assert!(!process_identity_matches(&identity));
        assert!(child.try_wait().expect("child status").is_none());
        child.kill().expect("kill child");
        child.wait().expect("reap child");
    }

    #[test]
    fn terminal_query_scanner_handles_da1_queries_split_across_chunks() {
        let mut leftover = Vec::new();
        assert!(feed_terminal_requests(&mut leftover, b"before\x1b[").is_empty());
        assert_eq!(leftover, b"\x1b[");
        assert_eq!(
            feed_terminal_requests(&mut leftover, b"0cafter\x1b[c"),
            vec![
                terminal_query(TerminalQuery::PrimaryDeviceAttributes),
                terminal_query(TerminalQuery::PrimaryDeviceAttributes),
            ]
        );
        assert!(leftover.is_empty());
    }

    #[test]
    fn terminal_query_scanner_handles_color_and_status_queries() {
        let mut leftover = Vec::new();
        assert!(feed_terminal_requests(&mut leftover, b"before\x1b]11;").is_empty());
        assert_eq!(leftover, b"\x1b]11;");
        assert_eq!(
            feed_terminal_requests(&mut leftover, b"?\x07\x1b[5"),
            vec![terminal_query(TerminalQuery::BackgroundColor)]
        );
        assert_eq!(leftover, b"\x1b[5");
        assert_eq!(
            feed_terminal_requests(&mut leftover, b"n\x1b]10;?\x1b"),
            vec![terminal_query(TerminalQuery::OperatingStatus)]
        );
        assert_eq!(leftover, b"\x1b]10;?\x1b");
        assert_eq!(
            feed_terminal_requests(&mut leftover, b"\\\x1b]12;?\x07"),
            vec![
                terminal_query(TerminalQuery::ForegroundColor),
                terminal_query(TerminalQuery::CursorColor),
            ]
        );
        assert!(leftover.is_empty());
    }

    #[test]
    fn terminal_query_scanner_handles_theme_update_negotiation() {
        let mut leftover = Vec::new();
        assert!(feed_terminal_requests(&mut leftover, b"\x1b[?2031").is_empty());
        assert_eq!(leftover, b"\x1b[?2031");
        assert_eq!(
            feed_terminal_requests(&mut leftover, b"$p\x1b[?2031h\x1b[?996n\x1b[?2031l"),
            vec![
                terminal_query(TerminalQuery::ThemeUpdatesMode),
                TerminalRequest::SetThemeUpdates(true),
                terminal_query(TerminalQuery::ThemePreference),
                TerminalRequest::SetThemeUpdates(false),
            ]
        );
        assert!(leftover.is_empty());
    }

    #[test]
    fn terminal_query_responses_report_the_configured_theme() {
        let theme = TerminalTheme {
            foreground: TerminalColor { r: 1, g: 2, b: 3 },
            background: TerminalColor {
                r: 16,
                g: 32,
                b: 48,
            },
            cursor: TerminalColor {
                r: 254,
                g: 253,
                b: 252,
            },
        };
        let mut response = Vec::new();
        write_terminal_query_response(&mut response, TerminalQuery::BackgroundColor, theme, false)
            .expect("background response");
        write_terminal_query_response(&mut response, TerminalQuery::OperatingStatus, theme, false)
            .expect("status response");
        write_terminal_query_response(&mut response, TerminalQuery::ThemeUpdatesMode, theme, false)
            .expect("theme mode response");
        write_terminal_query_response(&mut response, TerminalQuery::ThemePreference, theme, false)
            .expect("theme preference response");
        assert_eq!(
            response,
            b"\x1b]11;rgb:1010/2020/3030\x1b\\\x1b[0n\x1b[?2031;2$y\x1b[?997;1n"
        );
    }

    #[test]
    fn terminal_bytes_are_not_decoded_or_joined_at_read_boundaries() {
        let first = Bytes::copy_from_slice(b"ok\xffdone\xe2");
        let second = Bytes::copy_from_slice(b"\x94\x80");
        assert_eq!(first.as_ref(), b"ok\xffdone\xe2");
        assert_eq!(second.as_ref(), b"\x94\x80");
    }

    #[test]
    fn osc7_scanner_uses_the_last_report_and_decodes_only_completed_payloads() {
        let value = b"\x1b]7;file://host/tmp/first\x07\x1b]7;file:///tmp/last%20dir\x1b\\";
        let mut scanner = Osc7Scanner::default();
        let mut last = None;
        for byte in value {
            last = scanner.feed(std::slice::from_ref(byte)).or(last);
        }
        assert_eq!(last, Some(PathBuf::from("/tmp/last dir")));
    }
}
