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
use ghostty_vt::{
    ColorScheme, DeviceAttributes, EffectOptions, Mode, Rgb, Terminal as GhosttyTerminal,
    TerminalOptions as GhosttyTerminalOptions, TerminalSize, build_revision,
};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
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
const HOT_SCROLLBACK_ROWS: usize = 10_000;
const EXITED_REPLAY_BYTES: usize = 256 * 1024;
const MAX_WRITE_BYTES: usize = 1024 * 1024;
const OWNER_COMMAND_BATCH_MESSAGES: usize = 64;
const OWNER_WRITE_BATCH_BYTES: usize = 256 * 1024;
const CLEANUP_QUEUE_CAPACITY: usize = 256;
const CHECKPOINT_BYTES: usize = 512 * 1024;
// Base64 checkpoint plus a 256 KiB replay tail must fit the 1 MiB WS frame.
const MAX_CHECKPOINT_BYTES: usize = 384 * 1024;
const CHECKPOINT_MAGIC: &str = "YAADECP2";
const CHECKPOINT_VERSION: u8 = 2;
const GHOSTTY_SNAPSHOT_FORMAT_VERSION: u16 = 1;
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
    pub magic: &'static str,
    #[serde(rename = "checkpointVersion")]
    pub checkpoint_version: u8,
    #[serde(rename = "terminalEpoch")]
    pub terminal_epoch: String,
    pub sequence: u64,
    pub cols: u16,
    pub rows: u16,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    pub engine: &'static str,
    #[serde(rename = "engineRevision")]
    pub engine_revision: &'static str,
    #[serde(rename = "snapshotFormatVersion")]
    pub snapshot_format_version: u16,
    pub codec: &'static str,
    #[serde(rename = "payloadBytes")]
    pub payload_bytes: usize,
    #[serde(rename = "payloadSha256")]
    pub payload_sha256: String,
    #[serde(rename = "snapshotBytes")]
    pub snapshot_bytes: Base64Bytes,
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
    title: Option<String>,
    terminal_theme: TerminalTheme,
    live_cwd: Option<PathBuf>,
    checkpoints: bool,
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
            title: title.clone(),
            terminal_theme,
            live_cwd: None,
            checkpoints: self.checkpoints,
            checkpoint: None,
            bytes_since_checkpoint: 0,
            last_checkpoint_at: Instant::now(),
        };
        let weak = Arc::downgrade(self);
        let owner_entry = Arc::clone(&entry);
        let (init_tx, init_rx) = bounded(1);
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
                    init_tx,
                );
            })
            .map_err(|error| TerminalError::Runtime(error.to_string()))?;
        init_rx
            .recv_timeout(std::time::Duration::from_secs(30))
            .map_err(|_| {
                TerminalError::Runtime("terminal owner initialization timed out".to_owned())
            })??;
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id.clone(), Arc::clone(&entry));
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

fn ghostty_error(error: ghostty_vt::GhosttyError) -> TerminalError {
    TerminalError::Runtime(format!("native Ghostty terminal failure: {error}"))
}

fn ghostty_rgb(color: TerminalColor) -> Rgb {
    Rgb {
        r: color.r,
        g: color.g,
        b: color.b,
    }
}

fn ghostty_color_scheme(theme: TerminalTheme) -> ColorScheme {
    if terminal_theme_preference(theme) == 2 {
        ColorScheme::Light
    } else {
        ColorScheme::Dark
    }
}

fn create_ghostty_terminal(state: &EntryState) -> Result<GhosttyTerminal, TerminalError> {
    let mut terminal = GhosttyTerminal::new(GhosttyTerminalOptions {
        cols: usize::from(state.cols),
        rows: usize::from(state.rows),
        // Durable history remains the complete byte source. This bounded hot
        // window makes checkpoints useful without making Ghostty the archive.
        scrollback: HOT_SCROLLBACK_ROWS,
        effects: EffectOptions {
            size: Some(TerminalSize {
                rows: state.rows,
                columns: state.cols,
                cell_width: 1,
                cell_height: 1,
            }),
            color_scheme: Some(ghostty_color_scheme(state.terminal_theme)),
            device_attributes: Some(DeviceAttributes::default()),
            enquiry_response: b"YAADE".to_vec(),
            xtversion: format!("YAADE {}", env!("CARGO_PKG_VERSION")).into_bytes(),
            ..EffectOptions::default()
        },
    })
    .map_err(ghostty_error)?;
    terminal
        .set_default_colors(
            Some(ghostty_rgb(state.terminal_theme.foreground)),
            Some(ghostty_rgb(state.terminal_theme.background)),
            Some(ghostty_rgb(state.terminal_theme.cursor)),
        )
        .map_err(ghostty_error)?;
    Ok(terminal)
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
    initialized: Sender<Result<(), TerminalError>>,
) {
    let mut terminal = match create_ghostty_terminal(&state) {
        Ok(terminal) => terminal,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = initialized.send(Err(error));
            return;
        }
    };
    let mut control = TerminalControlRegistry::new();
    if let Err(error) = control.register_terminal(&entry.id, &entry.terminal_epoch) {
        let _ = child.kill();
        let _ = child.wait();
        let _ = initialized.send(Err(error.into()));
        return;
    }
    if initialized.send(Ok(())).is_err() {
        let _ = child.kill();
        let _ = child.wait();
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
                &mut terminal,
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
                &mut terminal,
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
                    process_terminal_output(
                        &host,
                        &entry,
                        &mut writer,
                        &mut state,
                        &mut terminal,
                        data,
                    );
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
            observe_terminal_exit(&host, &entry, &mut child, &mut state, &mut terminal);
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
                    process_terminal_output(
                        &host,
                        &entry,
                        &mut writer,
                        &mut state,
                        &mut terminal,
                        data,
                    );
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
    terminal: &mut GhosttyTerminal,
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
                .and_then(|(cols, rows)| {
                    resize_terminal(host, master, entry, writer, state, terminal, cols, rows).err()
                })
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

        if !handle_terminal_command(
            host, entry, master, writer, child, state, terminal, control, command,
        ) {
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
    host: &Weak<TerminalHost>,
    master: &dyn MasterPty,
    entry: &TerminalEntry,
    writer: &mut Box<dyn Write + Send>,
    state: &mut EntryState,
    terminal: &mut GhosttyTerminal,
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
    let responses = terminal
        .resize(usize::from(cols), usize::from(rows), 1, 1)
        .map_err(ghostty_error)?
        .pty_responses()
        .map(<[u8]>::to_vec)
        .collect::<Vec<_>>();
    for response in responses {
        writer
            .write_all(&response)
            .map_err(|error| TerminalError::Runtime(error.to_string()))?;
    }
    writer
        .flush()
        .map_err(|error| TerminalError::Runtime(error.to_string()))?;
    state.cols = cols;
    state.rows = rows;
    if state.checkpoints {
        store_checkpoint(host, &entry.id, &entry.terminal_epoch, state, terminal);
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
    terminal: &mut GhosttyTerminal,
    control: &mut TerminalControlRegistry,
    command: TerminalCommand,
) -> bool {
    match command {
        TerminalCommand::Inspect { reply } => {
            let _ = reply.send(Ok(TerminalInspect {
                id: entry.id.clone(),
                title: state.title.clone(),
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
            let result = if state.terminal_theme == theme {
                Ok(())
            } else {
                terminal
                    .set_default_colors(
                        Some(ghostty_rgb(theme.foreground)),
                        Some(ghostty_rgb(theme.background)),
                        Some(ghostty_rgb(theme.cursor)),
                    )
                    .map_err(ghostty_error)
                    .and_then(|()| {
                        terminal.set_color_scheme(Some(ghostty_color_scheme(theme)));
                        if terminal
                            .mode(Mode::COLOR_SCHEME_UPDATES)
                            .map_err(ghostty_error)?
                        {
                            write_terminal_theme_preference(&mut **writer, theme)
                                .and_then(|()| writer.flush())
                                .map_err(|error| TerminalError::Runtime(error.to_string()))?;
                        }
                        state.terminal_theme = theme;
                        Ok(())
                    })
            };
            let _ = reply.send(result);
        }
        TerminalCommand::Resize { cols, rows, reply } => {
            let _ = reply.send(resize_terminal(
                host, master, entry, writer, state, terminal, cols, rows,
            ));
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
                    resize_terminal(host, master, entry, writer, state, terminal, cols, rows)
                        .map(|()| lease)
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
                title: state.title.clone(),
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
    terminal: &mut GhosttyTerminal,
    data: Bytes,
) {
    if state.disposed {
        return;
    }
    let (responses, title, working_directory, bells) = match terminal.write(&data) {
        Ok(effects) => (
            effects
                .pty_responses()
                .map(<[u8]>::to_vec)
                .collect::<Vec<_>>(),
            effects.title().map(<[u8]>::to_vec),
            effects.working_directory().map(<[u8]>::to_vec),
            effects.bells(),
        ),
        Err(error) => {
            eprintln!("[terminal-ghostty] {}: {error}", entry.id);
            (Vec::new(), None, None, 0)
        }
    };
    let mut response_failed = false;
    for response in responses {
        if let Err(error) = writer.write_all(&response) {
            eprintln!("[terminal-pty-response] {}: {error}", entry.id);
            response_failed = true;
            break;
        }
    }
    if !response_failed && let Err(error) = writer.flush() {
        eprintln!("[terminal-pty-response] {}: {error}", entry.id);
    }
    if let Some(title) = title {
        state.title = Some(String::from_utf8_lossy(&title).into_owned());
    }
    if let Some(value) = working_directory {
        state.live_cwd = decode_terminal_working_directory(&value);
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
    if state.checkpoints {
        state.bytes_since_checkpoint = state.bytes_since_checkpoint.saturating_add(data.len());
        if state.bytes_since_checkpoint >= CHECKPOINT_BYTES
            || state.last_checkpoint_at.elapsed() >= CHECKPOINT_INTERVAL
        {
            store_checkpoint(host, &entry.id, &entry.terminal_epoch, state, terminal);
        }
    }
    let Some(host) = host.upgrade() else { return };
    if let Err(error) = host.history.append(&entry.id, sequence, data.clone()) {
        eprintln!("[terminal-history] {error}");
    }
    host.events
        .emit_terminal(Arc::<str>::from(entry.id.as_str()), sequence, data);
    for _ in 0..bells {
        host.events.emit("terminal:bell", vec![json!(entry.id)]);
    }
}

fn observe_terminal_exit(
    host: &Weak<TerminalHost>,
    entry: &TerminalEntry,
    child: &mut Box<dyn Child + Send + Sync>,
    state: &mut EntryState,
    terminal: &mut GhosttyTerminal,
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
    if state.checkpoints {
        store_checkpoint(host, &entry.id, &entry.terminal_epoch, state, terminal);
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

fn store_checkpoint(
    host: &Weak<TerminalHost>,
    terminal_id: &str,
    terminal_epoch: &str,
    state: &mut EntryState,
    terminal: &GhosttyTerminal,
) {
    let checkpoint = match encode_checkpoint(
        terminal_epoch,
        state.sequence,
        state.cols,
        state.rows,
        terminal,
    ) {
        Ok(checkpoint) => checkpoint,
        Err(error) => {
            eprintln!("[terminal-checkpoint] {error}");
            // A terminal whose complete snapshot exceeds the transport budget
            // remains on exact raw replay. Back off before retrying so an
            // oversized history cannot turn every PTY chunk into another
            // snapshot traversal.
            state.bytes_since_checkpoint = 0;
            state.last_checkpoint_at = Instant::now();
            return;
        }
    };
    if let Some(host) = host.upgrade()
        && let Ok(encoded) = serde_json::to_vec(&checkpoint)
        && let Err(error) = host
            .history
            .persist_checkpoint(terminal_id, Bytes::from(encoded))
    {
        eprintln!("[terminal-checkpoint] {error}");
    }
    state.checkpoint = Some(checkpoint);
    state.bytes_since_checkpoint = 0;
    state.last_checkpoint_at = Instant::now();
}

fn encode_checkpoint(
    terminal_epoch: &str,
    sequence: u64,
    cols: u16,
    rows: u16,
    terminal: &GhosttyTerminal,
) -> Result<TerminalCheckpoint, TerminalError> {
    let snapshot = terminal
        .snapshot(MAX_CHECKPOINT_BYTES)
        .map_err(ghostty_error)?;
    if snapshot.len() < 10
        || &snapshot[..8] != b"GHOSTSNP"
        || u16::from_le_bytes([snapshot[8], snapshot[9]]) != GHOSTTY_SNAPSHOT_FORMAT_VERSION
    {
        return Err(TerminalError::Runtime(
            "unsupported Ghostty snapshot envelope".to_owned(),
        ));
    }
    let engine_revision = build_revision().map_err(ghostty_error)?;
    Ok(TerminalCheckpoint {
        magic: CHECKPOINT_MAGIC,
        checkpoint_version: CHECKPOINT_VERSION,
        terminal_epoch: terminal_epoch.to_owned(),
        sequence,
        cols,
        rows,
        created_at: crate::model::now_iso(),
        engine: "ghostty-vt",
        engine_revision,
        snapshot_format_version: GHOSTTY_SNAPSHOT_FORMAT_VERSION,
        codec: "none",
        payload_bytes: snapshot.len(),
        payload_sha256: format!("{:x}", Sha256::digest(&snapshot)),
        snapshot_bytes: Base64Bytes(Bytes::from(snapshot)),
    })
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

fn decode_terminal_working_directory(value: &[u8]) -> Option<PathBuf> {
    let value = std::str::from_utf8(value).ok()?.trim();
    if value.starts_with("file://") {
        osc7_path(value)
    } else {
        (!value.is_empty()).then(|| PathBuf::from(value))
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
    fn native_terminal_handles_split_queries_and_cwd_effects() {
        let mut terminal = GhosttyTerminal::new(GhosttyTerminalOptions {
            cols: 80,
            rows: 24,
            scrollback: 128,
            effects: EffectOptions {
                size: Some(TerminalSize {
                    rows: 24,
                    columns: 80,
                    cell_width: 1,
                    cell_height: 1,
                }),
                color_scheme: Some(ColorScheme::Dark),
                device_attributes: Some(DeviceAttributes::default()),
                ..EffectOptions::default()
            },
        })
        .expect("terminal");
        terminal
            .set_default_colors(
                Some(Rgb { r: 1, g: 2, b: 3 }),
                Some(Rgb {
                    r: 16,
                    g: 32,
                    b: 48,
                }),
                None,
            )
            .expect("colors");
        assert_eq!(
            terminal
                .write(b"before\x1b]11;")
                .expect("partial query")
                .pty_responses()
                .count(),
            0
        );
        let effects = terminal
            .write(b"?\x07\x1b[5n\x1b[?2031$p\x1b[?996n")
            .expect("completed queries");
        let response = effects
            .pty_responses()
            .flatten()
            .copied()
            .collect::<Vec<_>>();
        assert_eq!(
            response,
            b"\x1b]11;rgb:1010/2020/3030\x07\x1b[0n\x1b[?2031;2$y\x1b[?997;1n"
        );

        assert!(
            terminal
                .write(b"\x1b]7;file:///tmp/last%20")
                .expect("partial cwd")
                .working_directory()
                .is_none()
        );
        let cwd = terminal
            .write(b"dir\x1b\\")
            .expect("completed cwd")
            .working_directory()
            .and_then(decode_terminal_working_directory);
        assert_eq!(cwd, Some(PathBuf::from("/tmp/last dir")));
    }

    #[test]
    fn checkpoint_envelope_restores_exact_parser_continuation() {
        let effects = EffectOptions::default();
        let mut terminal = GhosttyTerminal::new(GhosttyTerminalOptions {
            cols: 80,
            rows: 24,
            scrollback: 128,
            effects: effects.clone(),
        })
        .expect("terminal");
        terminal.write(b"before\x1b[31").expect("partial CSI");
        let checkpoint =
            encode_checkpoint("epoch-1", 7, 80, 24, &terminal).expect("checkpoint envelope");
        assert_eq!(checkpoint.magic, CHECKPOINT_MAGIC);
        assert_eq!(checkpoint.checkpoint_version, CHECKPOINT_VERSION);
        assert_eq!(checkpoint.sequence, 7);
        assert_eq!(checkpoint.payload_bytes, checkpoint.snapshot_bytes.0.len());
        assert_eq!(
            checkpoint.payload_sha256,
            format!("{:x}", Sha256::digest(&checkpoint.snapshot_bytes.0))
        );

        let mut restored = GhosttyTerminal::from_snapshot(&checkpoint.snapshot_bytes.0, effects)
            .expect("restore checkpoint");
        terminal.write(b"mred\x1b[0m").expect("continue original");
        restored.write(b"mred\x1b[0m").expect("continue restored");
        assert_eq!(
            restored.state().expect("restored state"),
            terminal.state().expect("state")
        );
    }

    #[test]
    fn terminal_bytes_are_not_decoded_or_joined_at_read_boundaries() {
        let first = Bytes::copy_from_slice(b"ok\xffdone\xe2");
        let second = Bytes::copy_from_slice(b"\x94\x80");
        assert_eq!(first.as_ref(), b"ok\xffdone\xe2");
        assert_eq!(second.as_ref(), b"\x94\x80");
    }
}
