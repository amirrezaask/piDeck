use std::{
    cmp::Reverse,
    collections::{BinaryHeap, HashMap, HashSet, VecDeque},
    env,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command as ProcessCommand,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use base64::Engine as _;
use bytes::Bytes;
use crossbeam_channel::{Receiver, Sender, TryRecvError, TrySendError, bounded};
use ghostty_vt::{
    ColorScheme, CompressionMode, DeviceAttributes, EffectOptions, Mode, Rgb,
    Terminal as GhosttyTerminal, TerminalOptions as GhosttyTerminalOptions, TerminalSize,
    build_revision,
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

const MAX_ENTRIES: usize = 1_000;
const MAX_REPLAY_BYTES: usize = 2 * 1024 * 1024;
const HOT_SCROLLBACK_ROWS: usize = 10_000;
const EXITED_REPLAY_BYTES: usize = 256 * 1024;
const MAX_WRITE_BYTES: usize = 1024 * 1024;
const OWNER_COMMAND_BATCH_MESSAGES: usize = 64;
const OWNER_WRITE_BATCH_BYTES: usize = 256 * 1024;
const REACTOR_COMMAND_CAPACITY: usize = 4_096;
const REACTOR_READ_BUFFER_BYTES: usize = 64 * 1024;
const REACTOR_READY_EVENTS_PER_TURN: usize = 64;
const MAX_PENDING_INPUT_BYTES_PER_TERMINAL: usize = 2 * 1024 * 1024;
const REACTOR_WRITE_BUDGET_PER_TURN: usize = 64 * 1024;
const REACTOR_MAX_SHARDS: usize = 8;
const CLEANUP_QUEUE_CAPACITY: usize = 256;
const CHECKPOINT_BYTES: usize = 512 * 1024;
// Snapshot payloads use their own bounded binary frame and never base64-expand.
const MAX_CHECKPOINT_BYTES: usize = 8 * 1024 * 1024;
const CHECKPOINT_MAGIC: &str = "YAADECP2";
const CHECKPOINT_VERSION: u8 = 2;
const GHOSTTY_SNAPSHOT_FORMAT_VERSION: u16 = 1;
const CHECKPOINT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);
const EXITED_DISPOSE_TTL: std::time::Duration = std::time::Duration::from_secs(90);
const WARM_AFTER: std::time::Duration = std::time::Duration::from_secs(5);
const PARK_AFTER: std::time::Duration = std::time::Duration::from_secs(30);
const THERMAL_TICK: Duration = Duration::from_millis(250);
const PARKED_THERMAL_TICK: Duration = Duration::from_secs(5);
const EXIT_POLL_TICK: Duration = Duration::from_millis(10);

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
    pub output_position: u64,
    pub thermal_state: ThermalState,
    pub attached_clients: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalProcessStatus {
    Running,
    Exited,
}

/// Independent memory/readiness lifecycle for a durable PTY session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ThermalState {
    Hot,
    Warm,
    Parked,
}

/// Exact position in one logical PTY output stream. `sequence` is the
/// inclusive byte offset of the final published byte; the first byte is 1.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamPosition {
    pub epoch: u64,
    pub sequence: u64,
}

#[derive(Debug, Default)]
struct TerminalMetrics {
    sessions_total: AtomicU64,
    pty_bytes_read_total: AtomicU64,
    pty_bytes_written_total: AtomicU64,
    snapshots_total: AtomicU64,
    snapshot_bytes_total: AtomicU64,
    snapshot_duration_ns_total: AtomicU64,
    snapshot_duration_ns_max: AtomicU64,
    compression_runs_total: AtomicU64,
    compression_duration_ns_total: AtomicU64,
    compression_duration_ns_max: AtomicU64,
    hot_to_parked_total: AtomicU64,
    parked_to_hot_total: AtomicU64,
    parked_wake_duration_ns_total: AtomicU64,
    parked_wake_duration_ns_max: AtomicU64,
}

/// Content-free terminal runtime metrics and current resource classes.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRuntimeDiagnostics {
    pub terminal_sessions_total: u64,
    pub terminal_sessions_active: usize,
    pub terminal_sessions_parked: usize,
    pub terminal_clients_attached: usize,
    pub terminal_reactor_shards: usize,
    pub terminal_owner_threads: usize,
    pub pty_bytes_read_total: u64,
    pub pty_bytes_written_total: u64,
    pub terminal_snapshots_total: u64,
    pub terminal_snapshot_bytes: u64,
    pub terminal_snapshot_duration_ns_total: u64,
    pub terminal_snapshot_duration_ns_max: u64,
    pub terminal_compression_runs_total: u64,
    pub terminal_compression_duration_ns_total: u64,
    pub terminal_compression_duration_ns_max: u64,
    pub terminal_hot_to_parked_total: u64,
    pub terminal_parked_to_hot_total: u64,
    pub terminal_wake_duration_ns_total: u64,
    pub terminal_wake_duration_ns_max: u64,
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
    pub stream_id: u64,
    pub stream_epoch: u64,
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
    #[error("too many terminals (max 1000); close a terminal before creating another")]
    Limit,
    #[error("terminal client is synchronizing; input is disabled until READY")]
    NotReady,
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
            Self::NotReady => "TERMINAL_NOT_READY",
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
    thermal_state: ThermalState,
    last_activity_at: Instant,
    attached_clients: HashSet<String>,
    compression_activity: u64,
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
        )
    }
}

#[derive(Clone)]
struct ReactorHandle {
    urgent: Sender<ReactorCommand>,
    normal: Sender<ReactorCommand>,
    wake: Arc<polling::Poller>,
}

impl ReactorHandle {
    fn send(&self, command: ReactorCommand, urgent: bool) -> Result<(), TerminalError> {
        let sender = if urgent { &self.urgent } else { &self.normal };
        sender.try_send(command).map_err(|error| match error {
            TrySendError::Full(_) => {
                TerminalError::Runtime("terminal reactor mailbox is full".to_owned())
            }
            TrySendError::Disconnected(_) => {
                TerminalError::Runtime("terminal reactor stopped".to_owned())
            }
        })?;
        // The bounded poll timeout is a fallback if a platform wake fails. The
        // command is already owned by the reactor and must not be reported as
        // rejected after enqueue.
        let _ = self.wake.notify();
        Ok(())
    }
}

struct TerminalEntry {
    id: String,
    title: Option<String>,
    terminal_epoch: String,
    spawn_command: Option<String>,
    spawn_cwd: PathBuf,
    os_pid: Option<u32>,
    process_identity: Option<ProcessIdentity>,
    reactor: ReactorHandle,
}

struct CreateRuntime {
    entry: Arc<TerminalEntry>,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    #[cfg(unix)]
    reader: Box<dyn Read + Send>,
    #[cfg(unix)]
    raw_fd: std::os::fd::RawFd,
    state: EntryState,
    initialized: Sender<Result<(), TerminalError>>,
}

enum ReactorCommand {
    Create(Box<CreateRuntime>),
    Session {
        terminal_id: String,
        command: Box<TerminalCommand>,
    },
    ReleaseConnection {
        connection_id: String,
    },
    Diagnostics {
        reply: Sender<ReactorDiagnostics>,
    },
    #[cfg(not(unix))]
    Output {
        terminal_id: String,
        output: ReactorOutput,
    },
    Shutdown,
}

#[cfg(not(unix))]
enum ReactorOutput {
    Bytes(Bytes),
    Eof,
    ReadFailed(std::io::ErrorKind),
}

#[derive(Clone, Copy, Debug, Default)]
struct ReactorDiagnostics {
    sessions: usize,
    parked: usize,
    attached_clients: usize,
}

#[cfg(unix)]
#[derive(Clone, Copy)]
struct BorrowedPty(std::os::fd::RawFd);

#[cfg(unix)]
impl std::os::fd::AsRawFd for BorrowedPty {
    fn as_raw_fd(&self) -> std::os::fd::RawFd {
        self.0
    }
}

#[cfg(unix)]
impl std::os::fd::AsFd for BorrowedPty {
    fn as_fd(&self) -> std::os::fd::BorrowedFd<'_> {
        // SAFETY: the reactor deletes this registration before dropping the
        // runtime-owned PTY master and reader handles.
        unsafe { std::os::fd::BorrowedFd::borrow_raw(self.0) }
    }
}

struct TerminalRuntime {
    entry: Arc<TerminalEntry>,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    #[cfg(unix)]
    reader: Box<dyn Read + Send>,
    #[cfg(unix)]
    source: BorrowedPty,
    state: EntryState,
    terminal: GhosttyTerminal,
    control: TerminalControlRegistry,
    write_scratch: Vec<u8>,
    pending_input: VecDeque<(Bytes, usize)>,
    pending_input_bytes: usize,
    poll_key: usize,
    output_open: bool,
    #[cfg(unix)]
    registration_active: bool,
    exit_observed: bool,
}

pub struct TerminalHost {
    entries: Mutex<HashMap<String, Arc<TerminalEntry>>>,
    events: Arc<EventHub>,
    next_id: AtomicU64,
    cleanup_tx: tokio::sync::mpsc::Sender<(String, String)>,
    history: TerminalHistoryArchive,
    checkpoints: bool,
    reactors: Vec<ReactorHandle>,
    reactor_workers: Mutex<Vec<thread::JoinHandle<()>>>,
    metrics: TerminalMetrics,
}

impl TerminalHost {
    pub fn new(
        events: Arc<EventHub>,
        history_root: &Path,
        _checkpoints: bool,
    ) -> Result<Arc<Self>, TerminalError> {
        let (cleanup_tx, cleanup_rx) = tokio::sync::mpsc::channel(CLEANUP_QUEUE_CAPACITY);
        let shard_count = terminal_reactor_shard_count();
        let mut reactor_receivers = Vec::with_capacity(shard_count);
        let mut reactors = Vec::with_capacity(shard_count);
        for _ in 0..shard_count {
            let wake = Arc::new(
                polling::Poller::new()
                    .map_err(|error| TerminalError::Runtime(error.to_string()))?,
            );
            let (urgent, urgent_rx) = bounded(REACTOR_COMMAND_CAPACITY);
            let (normal, normal_rx) = bounded(REACTOR_COMMAND_CAPACITY);
            reactors.push(ReactorHandle {
                urgent,
                normal,
                wake: Arc::clone(&wake),
            });
            reactor_receivers.push((wake, urgent_rx, normal_rx));
        }
        let host = Arc::new(Self {
            entries: Mutex::new(HashMap::new()),
            events,
            next_id: AtomicU64::new(0),
            cleanup_tx,
            history: TerminalHistoryArchive::open(history_root)?,
            checkpoints: true,
            reactors,
            reactor_workers: Mutex::new(Vec::with_capacity(shard_count)),
            metrics: TerminalMetrics::default(),
        });

        let weak = Arc::downgrade(&host);
        let mut workers: Vec<thread::JoinHandle<()>> = Vec::with_capacity(shard_count);
        for (index, (poller, urgent, normal)) in reactor_receivers.into_iter().enumerate() {
            let owner = weak.clone();
            let worker = match thread::Builder::new()
                .name(format!("yaade-terminal-reactor-{index}"))
                .stack_size(512 * 1024)
                .spawn(move || run_terminal_reactor(owner, poller, urgent, normal))
            {
                Ok(worker) => worker,
                Err(error) => {
                    for reactor in &host.reactors {
                        let _ = reactor.urgent.send(ReactorCommand::Shutdown);
                        let _ = reactor.wake.notify();
                    }
                    for worker in workers {
                        let _ = worker.join();
                    }
                    return Err(TerminalError::Runtime(error.to_string()));
                }
            };
            workers.push(worker);
        }
        *host
            .reactor_workers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = workers;

        tokio::spawn(run_terminal_cleanup(weak, cleanup_rx));
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
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| TerminalError::Runtime(error.to_string()))?;
        #[cfg(unix)]
        let raw_fd = pair.master.as_raw_fd().ok_or_else(|| {
            TerminalError::Runtime(
                "PTY master does not expose a pollable Unix descriptor".to_owned(),
            )
        })?;
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
        let reactor_index = terminal_stream_id(&id) as usize % self.reactors.len();
        let reactor = self.reactors[reactor_index].clone();
        let entry = Arc::new(TerminalEntry {
            id: id.clone(),
            title: title.clone(),
            terminal_epoch: terminal_epoch.clone(),
            spawn_command: launch.command,
            spawn_cwd: cwd,
            os_pid,
            process_identity: process_identity.clone(),
            reactor: reactor.clone(),
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
            thermal_state: ThermalState::Hot,
            last_activity_at: Instant::now(),
            attached_clients: HashSet::new(),
            compression_activity: 0,
        };
        let (init_tx, init_rx) = bounded(1);
        reactor.send(
            ReactorCommand::Create(Box::new(CreateRuntime {
                entry: Arc::clone(&entry),
                master: pair.master,
                writer,
                child,
                #[cfg(unix)]
                reader,
                #[cfg(unix)]
                raw_fd,
                state,
                initialized: init_tx,
            })),
            false,
        )?;
        init_rx
            .recv_timeout(Duration::from_secs(30))
            .map_err(|_| {
                TerminalError::Runtime("terminal reactor initialization timed out".to_owned())
            })??;
        #[cfg(not(unix))]
        spawn_fallback_pty_reader(id.clone(), reader, reactor.clone())?;
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id.clone(), Arc::clone(&entry));

        self.metrics.sessions_total.fetch_add(1, Ordering::Relaxed);
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
        let urgent = command.is_urgent();
        entry.reactor.send(
            ReactorCommand::Session {
                terminal_id: entry.id.clone(),
                command: Box::new(command),
            },
            urgent,
        )?;
        result
            .recv_timeout(Duration::from_secs(30))
            .map_err(|_| TerminalError::Runtime("terminal reactor reply timed out".to_owned()))?
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
                    stream_id: terminal_stream_id(id),
                    stream_epoch: terminal_stream_epoch(id),
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

    #[must_use]
    pub fn runtime_diagnostics(&self) -> TerminalRuntimeDiagnostics {
        let mut reactor_diagnostics = ReactorDiagnostics::default();
        for reactor in &self.reactors {
            let (reply, received) = bounded(1);
            if reactor
                .send(ReactorCommand::Diagnostics { reply }, false)
                .is_ok()
                && let Ok(shard) = received.recv_timeout(Duration::from_secs(1))
            {
                reactor_diagnostics.sessions += shard.sessions;
                reactor_diagnostics.parked += shard.parked;
                reactor_diagnostics.attached_clients += shard.attached_clients;
            }
        }
        TerminalRuntimeDiagnostics {
            terminal_sessions_total: self.metrics.sessions_total.load(Ordering::Relaxed),
            terminal_sessions_active: reactor_diagnostics.sessions,
            terminal_sessions_parked: reactor_diagnostics.parked,
            terminal_clients_attached: reactor_diagnostics.attached_clients,
            terminal_reactor_shards: self.reactors.len(),
            terminal_owner_threads: self
                .reactor_workers
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .len(),
            pty_bytes_read_total: self.metrics.pty_bytes_read_total.load(Ordering::Relaxed),
            pty_bytes_written_total: self.metrics.pty_bytes_written_total.load(Ordering::Relaxed),
            terminal_snapshots_total: self.metrics.snapshots_total.load(Ordering::Relaxed),
            terminal_snapshot_bytes: self.metrics.snapshot_bytes_total.load(Ordering::Relaxed),
            terminal_snapshot_duration_ns_total: self
                .metrics
                .snapshot_duration_ns_total
                .load(Ordering::Relaxed),
            terminal_snapshot_duration_ns_max: self
                .metrics
                .snapshot_duration_ns_max
                .load(Ordering::Relaxed),
            terminal_compression_runs_total: self
                .metrics
                .compression_runs_total
                .load(Ordering::Relaxed),
            terminal_compression_duration_ns_total: self
                .metrics
                .compression_duration_ns_total
                .load(Ordering::Relaxed),
            terminal_compression_duration_ns_max: self
                .metrics
                .compression_duration_ns_max
                .load(Ordering::Relaxed),
            terminal_hot_to_parked_total: self.metrics.hot_to_parked_total.load(Ordering::Relaxed),
            terminal_parked_to_hot_total: self.metrics.parked_to_hot_total.load(Ordering::Relaxed),
            terminal_wake_duration_ns_total: self
                .metrics
                .parked_wake_duration_ns_total
                .load(Ordering::Relaxed),
            terminal_wake_duration_ns_max: self
                .metrics
                .parked_wake_duration_ns_max
                .load(Ordering::Relaxed),
        }
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
        for reactor in &self.reactors {
            let _ = reactor.send(
                ReactorCommand::ReleaseConnection {
                    connection_id: connection_id.to_owned(),
                },
                true,
            );
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

impl Drop for TerminalHost {
    fn drop(&mut self) {
        for reactor in &self.reactors {
            // Shutdown is reliable and bounded; unlike session work it must not
            // be rejected merely because a shard mailbox is momentarily full.
            let _ = reactor.urgent.send(ReactorCommand::Shutdown);
            let _ = reactor.wake.notify();
        }
        for worker in self
            .reactor_workers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain(..)
        {
            let _ = worker.join();
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

fn terminal_reactor_shard_count() -> usize {
    env::var("YAADE_TERMINAL_REACTOR_SHARDS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or_else(|| {
            thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(1)
                .min(REACTOR_MAX_SHARDS)
        })
        .clamp(1, REACTOR_MAX_SHARDS)
}

async fn run_terminal_cleanup(
    host: Weak<TerminalHost>,
    mut cleanup: tokio::sync::mpsc::Receiver<(String, String)>,
) {
    let mut pending = BinaryHeap::<Reverse<(tokio::time::Instant, String, String)>>::new();
    loop {
        if let Some(Reverse((deadline, _, _))) = pending.peek() {
            tokio::select! {
                next = cleanup.recv() => match next {
                    Some((id, epoch)) => pending.push(Reverse((tokio::time::Instant::now() + EXITED_DISPOSE_TTL, id, epoch))),
                    None => break,
                },
                () = tokio::time::sleep_until(*deadline) => {
                    let now = tokio::time::Instant::now();
                    while pending.peek().is_some_and(|Reverse((deadline, _, _))| *deadline <= now) {
                        let Some(Reverse((_, id, epoch))) = pending.pop() else { break };
                        let Some(host) = host.upgrade() else { return };
                        let current_epoch = host.inspect(&id).map(|entry| entry.terminal_epoch);
                        if current_epoch.as_deref() == Some(&epoch) {
                            let _ = host.dispose(&id);
                        }
                    }
                }
            }
        } else {
            let Some((id, epoch)) = cleanup.recv().await else {
                break;
            };
            pending.push(Reverse((
                tokio::time::Instant::now() + EXITED_DISPOSE_TTL,
                id,
                epoch,
            )));
        }
    }
}

fn run_terminal_reactor(
    host: Weak<TerminalHost>,
    poller: Arc<polling::Poller>,
    urgent: Receiver<ReactorCommand>,
    normal: Receiver<ReactorCommand>,
) {
    #[cfg(unix)]
    use polling::Events;

    let mut runtimes = HashMap::<u64, TerminalRuntime>::new();
    let mut runtime_by_id = HashMap::<String, u64>::new();
    let mut maintenance = BinaryHeap::<Reverse<(Instant, u64)>>::new();
    let mut next_runtime_key = 1_u64;
    #[cfg(unix)]
    let mut events = Events::new();
    #[cfg(unix)]
    let mut read_buffer = vec![0_u8; REACTOR_READ_BUFFER_BYTES];
    let mut running = true;

    while running {
        running = process_reactor_commands(
            &host,
            &poller,
            &urgent,
            OWNER_COMMAND_BATCH_MESSAGES * 4,
            &mut runtimes,
            &mut runtime_by_id,
            &mut maintenance,
            &mut next_runtime_key,
        );
        if !running {
            break;
        }

        #[cfg(unix)]
        {
            events.clear();
            let now = Instant::now();
            let timeout = maintenance
                .peek()
                .map(|Reverse((deadline, _))| deadline.saturating_duration_since(now))
                .unwrap_or(THERMAL_TICK)
                .min(THERMAL_TICK);
            if poller.wait(&mut events, Some(timeout)).is_ok() {
                for event in events.iter().take(REACTOR_READY_EVENTS_PER_TURN) {
                    let key = event.key as u64;
                    let Some(runtime) = runtimes.get_mut(&key) else {
                        continue;
                    };
                    if !runtime.output_open {
                        continue;
                    }
                    if event.writable {
                        flush_runtime_input(runtime);
                    }
                    if event.readable {
                        drain_runtime_output(&host, runtime, &mut read_buffer);
                    }
                    if runtime.output_open
                        && let Err(error) = set_runtime_interest(&poller, runtime)
                    {
                        eprintln!(
                            "[terminal-reactor] {} poll update failed: {error}",
                            runtime.entry.id
                        );
                        let _ = runtime.child.kill();
                        runtime.output_open = false;
                    }
                    if !runtime.output_open {
                        unregister_runtime(&poller, runtime);
                    }
                }
            }
        }
        #[cfg(not(unix))]
        thread::sleep(THERMAL_TICK.min(Duration::from_millis(25)));

        running = process_reactor_commands(
            &host,
            &poller,
            &normal,
            OWNER_COMMAND_BATCH_MESSAGES,
            &mut runtimes,
            &mut runtime_by_id,
            &mut maintenance,
            &mut next_runtime_key,
        );
        if !running {
            break;
        }
        maintain_due_runtimes(&host, &mut runtimes, &mut maintenance);
    }

    for (_, mut runtime) in runtimes.drain() {
        #[cfg(unix)]
        unregister_runtime(&poller, &mut runtime);
        runtime
            .control
            .unregister_terminal(&runtime.entry.id, Some(&runtime.entry.terminal_epoch));
        let _ = runtime.child.kill();
    }
}

#[allow(clippy::too_many_arguments)]
fn process_reactor_commands(
    host: &Weak<TerminalHost>,
    poller: &Arc<polling::Poller>,
    receiver: &Receiver<ReactorCommand>,
    limit: usize,
    runtimes: &mut HashMap<u64, TerminalRuntime>,
    runtime_by_id: &mut HashMap<String, u64>,
    maintenance: &mut BinaryHeap<Reverse<(Instant, u64)>>,
    next_runtime_key: &mut u64,
) -> bool {
    let mut commands = VecDeque::with_capacity(limit.min(OWNER_COMMAND_BATCH_MESSAGES));
    for _ in 0..limit {
        match receiver.try_recv() {
            Ok(command) => commands.push_back(command),
            Err(TryRecvError::Empty) => break,
            Err(TryRecvError::Disconnected) => return false,
        }
    }
    while let Some(command) = commands.pop_front() {
        match command {
            ReactorCommand::Create(create) => initialize_runtime(
                poller,
                *create,
                runtimes,
                runtime_by_id,
                maintenance,
                next_runtime_key,
            ),
            ReactorCommand::Session {
                terminal_id,
                command,
            } => {
                let mut batch = vec![*command];
                while batch.len() < OWNER_COMMAND_BATCH_MESSAGES {
                    let same_terminal = matches!(
                        commands.front(),
                        Some(ReactorCommand::Session { terminal_id: next, .. }) if next == &terminal_id
                    );
                    if !same_terminal {
                        break;
                    }
                    let Some(ReactorCommand::Session { command, .. }) = commands.pop_front() else {
                        unreachable!()
                    };
                    batch.push(*command);
                }
                let Some(key) = runtime_by_id.get(&terminal_id).copied() else {
                    for command in batch {
                        reject_terminal_command(command, &terminal_id);
                    }
                    continue;
                };
                let mut keep = {
                    let runtime = runtimes.get_mut(&key).expect("terminal runtime index");
                    handle_terminal_command_batch(
                        host,
                        &runtime.entry,
                        &*runtime.master,
                        &mut runtime.child,
                        &mut runtime.state,
                        &mut runtime.terminal,
                        &mut runtime.control,
                        batch,
                        &mut runtime.write_scratch,
                        &mut runtime.pending_input,
                        &mut runtime.pending_input_bytes,
                    )
                };
                #[cfg(unix)]
                if keep {
                    let runtime = runtimes.get_mut(&key).expect("terminal runtime index");
                    if runtime.registration_active
                        && runtime.output_open
                        && let Err(error) = set_runtime_interest(poller, runtime)
                    {
                        eprintln!(
                            "[terminal-reactor] {} poll update failed: {error}",
                            runtime.entry.id
                        );
                        let _ = runtime.child.kill();
                        runtime.output_open = false;
                        keep = false;
                    }
                }
                #[cfg(not(unix))]
                if keep {
                    let runtime = runtimes.get_mut(&key).expect("terminal runtime index");
                    flush_runtime_input_fallback(runtime);
                }
                if !keep {
                    remove_runtime(poller, key, runtimes, runtime_by_id);
                }
            }
            ReactorCommand::ReleaseConnection { connection_id } => {
                for runtime in runtimes.values_mut() {
                    runtime.control.release_connection(&connection_id);
                    runtime.state.replay_ready_clients.remove(&connection_id);
                    runtime.state.attached_clients.remove(&connection_id);
                    runtime.state.last_activity_at = Instant::now();
                }
            }
            ReactorCommand::Diagnostics { reply } => {
                let _ = reply.send(ReactorDiagnostics {
                    sessions: runtimes.len(),
                    parked: runtimes
                        .values()
                        .filter(|runtime| runtime.state.thermal_state == ThermalState::Parked)
                        .count(),
                    attached_clients: runtimes
                        .values()
                        .map(|runtime| runtime.state.attached_clients.len())
                        .sum(),
                });
            }
            #[cfg(not(unix))]
            ReactorCommand::Output {
                terminal_id,
                output,
            } => {
                if let Some(key) = runtime_by_id.get(&terminal_id).copied()
                    && let Some(runtime) = runtimes.get_mut(&key)
                {
                    process_fallback_output(host, runtime, output);
                }
            }
            ReactorCommand::Shutdown => return false,
        }
    }
    true
}

fn initialize_runtime(
    poller: &Arc<polling::Poller>,
    mut create: CreateRuntime,
    runtimes: &mut HashMap<u64, TerminalRuntime>,
    runtime_by_id: &mut HashMap<String, u64>,
    maintenance: &mut BinaryHeap<Reverse<(Instant, u64)>>,
    next_runtime_key: &mut u64,
) {
    let terminal = match create_ghostty_terminal(&create.state) {
        Ok(terminal) => terminal,
        Err(error) => {
            let _ = create.child.kill();
            let _ = create.initialized.send(Err(error));
            return;
        }
    };
    create.state.compression_activity = terminal.compression_activity().unwrap_or(0);
    let mut control = TerminalControlRegistry::new();
    if let Err(error) = control.register_terminal(&create.entry.id, &create.entry.terminal_epoch) {
        let _ = create.child.kill();
        let _ = create.initialized.send(Err(error.into()));
        return;
    }
    let key = *next_runtime_key;
    *next_runtime_key = next_runtime_key.saturating_add(1);
    #[cfg(unix)]
    let source = BorrowedPty(create.raw_fd);
    #[cfg(unix)]
    {
        use polling::{Event, PollMode};
        // `portable-pty` clones share the master file description. Nonblocking
        // mode therefore covers both reactor reads and serialized input writes.
        // SAFETY: `raw_fd` is owned by `create.master` for this entire scope.
        let flags = unsafe { libc::fcntl(create.raw_fd, libc::F_GETFL) };
        let nonblocking = flags >= 0
            // SAFETY: the descriptor is valid and flags preserve existing mode bits.
            && unsafe { libc::fcntl(create.raw_fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == 0;
        if !nonblocking {
            control.unregister_terminal(&create.entry.id, Some(&create.entry.terminal_epoch));
            let _ = create.child.kill();
            let _ = create.initialized.send(Err(TerminalError::Runtime(
                std::io::Error::last_os_error().to_string(),
            )));
            return;
        }
        // SAFETY: the runtime retains the PTY handles and registration source;
        // `unregister_runtime` deletes the key before those handles are dropped.
        if let Err(error) =
            unsafe { poller.add_with_mode(&source, Event::readable(key as usize), PollMode::Level) }
        {
            control.unregister_terminal(&create.entry.id, Some(&create.entry.terminal_epoch));
            let _ = create.child.kill();
            let _ = create
                .initialized
                .send(Err(TerminalError::Runtime(error.to_string())));
            return;
        }
    }
    let terminal_id = create.entry.id.clone();
    runtimes.insert(
        key,
        TerminalRuntime {
            entry: create.entry,
            master: create.master,
            writer: create.writer,
            child: create.child,
            #[cfg(unix)]
            reader: create.reader,
            #[cfg(unix)]
            source,
            state: create.state,
            terminal,
            control,
            write_scratch: Vec::with_capacity(OWNER_WRITE_BATCH_BYTES),
            pending_input: VecDeque::new(),
            pending_input_bytes: 0,
            poll_key: key as usize,
            output_open: true,
            #[cfg(unix)]
            registration_active: true,
            exit_observed: false,
        },
    );
    runtime_by_id.insert(terminal_id, key);
    maintenance.push(Reverse((Instant::now() + THERMAL_TICK, key)));
    if create.initialized.send(Ok(())).is_err() {
        remove_runtime(poller, key, runtimes, runtime_by_id);
    }
}

fn remove_runtime(
    poller: &Arc<polling::Poller>,
    key: u64,
    runtimes: &mut HashMap<u64, TerminalRuntime>,
    runtime_by_id: &mut HashMap<String, u64>,
) {
    let Some(mut runtime) = runtimes.remove(&key) else {
        return;
    };
    #[cfg(unix)]
    unregister_runtime(poller, &mut runtime);
    runtime_by_id.remove(&runtime.entry.id);
}

#[cfg(unix)]
fn unregister_runtime(poller: &polling::Poller, runtime: &mut TerminalRuntime) {
    if runtime.registration_active {
        let _ = poller.delete(runtime.source);
        runtime.registration_active = false;
    }
    runtime.output_open = false;
}

#[cfg(unix)]
fn set_runtime_interest(
    poller: &polling::Poller,
    runtime: &TerminalRuntime,
) -> std::io::Result<()> {
    use polling::{Event, PollMode};
    let interest = if runtime.pending_input.is_empty() {
        Event::readable(runtime.poll_key)
    } else {
        Event::all(runtime.poll_key)
    };
    poller.modify_with_mode(runtime.source, interest, PollMode::Level)
}

#[cfg(unix)]
fn flush_runtime_input(runtime: &mut TerminalRuntime) {
    let mut budget = REACTOR_WRITE_BUDGET_PER_TURN;
    while budget > 0 {
        let Some((data, offset)) = runtime.pending_input.front_mut() else {
            break;
        };
        let remaining = data.len().saturating_sub(*offset);
        let requested = remaining.min(budget);
        match runtime.writer.write(&data[*offset..*offset + requested]) {
            Ok(0) => {
                runtime.output_open = false;
                runtime.pending_input.clear();
                runtime.pending_input_bytes = 0;
                let _ = runtime.child.kill();
                break;
            }
            Ok(written) => {
                *offset += written;
                budget -= written;
                runtime.pending_input_bytes = runtime.pending_input_bytes.saturating_sub(written);
                if *offset == data.len() {
                    runtime.pending_input.pop_front();
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
            Err(error) => {
                eprintln!("[terminal-input] {}: {error}", runtime.entry.id);
                runtime.output_open = false;
                runtime.pending_input.clear();
                runtime.pending_input_bytes = 0;
                let _ = runtime.child.kill();
                break;
            }
        }
    }
}

#[cfg(not(unix))]
fn flush_runtime_input_fallback(runtime: &mut TerminalRuntime) {
    while let Some((data, offset)) = runtime.pending_input.pop_front() {
        if let Err(error) = runtime.writer.write_all(&data[offset..]) {
            eprintln!("[terminal-input] {}: {error}", runtime.entry.id);
            runtime.output_open = false;
            let _ = runtime.child.kill();
            break;
        }
        runtime.pending_input_bytes = runtime
            .pending_input_bytes
            .saturating_sub(data.len().saturating_sub(offset));
    }
}

#[cfg(unix)]
fn drain_runtime_output(
    host: &Weak<TerminalHost>,
    runtime: &mut TerminalRuntime,
    buffer: &mut [u8],
) {
    // `portable-pty` does not guarantee O_NONBLOCK on every cloned reader.
    // Read once per level-triggered readiness event; a second speculative read
    // could block the entire shard after consuming the available bytes.
    match runtime.reader.read(buffer) {
        Ok(0) => runtime.output_open = false,
        Ok(count) => {
            let data = Bytes::copy_from_slice(&buffer[..count]);
            if !process_terminal_output(
                host,
                &runtime.entry,
                &mut runtime.state,
                &mut runtime.terminal,
                &mut runtime.pending_input,
                &mut runtime.pending_input_bytes,
                data,
            ) {
                let _ = runtime.child.kill();
                runtime.output_open = false;
            }
        }
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock
            ) => {}
        Err(error) => {
            eprintln!(
                "[terminal-reactor] {} failed: {:?}",
                runtime.entry.id,
                error.kind()
            );
            runtime.output_open = false;
        }
    }
}

fn maintain_due_runtimes(
    host: &Weak<TerminalHost>,
    runtimes: &mut HashMap<u64, TerminalRuntime>,
    maintenance: &mut BinaryHeap<Reverse<(Instant, u64)>>,
) {
    let now = Instant::now();
    while maintenance
        .peek()
        .is_some_and(|Reverse((deadline, _))| *deadline <= now)
    {
        let Some(Reverse((_, key))) = maintenance.pop() else {
            break;
        };
        let Some(runtime) = runtimes.get_mut(&key) else {
            continue;
        };
        if !runtime.output_open && !runtime.exit_observed {
            runtime.exit_observed = try_observe_terminal_exit(
                host,
                &runtime.entry,
                &mut runtime.child,
                &mut runtime.state,
                &mut runtime.terminal,
            );
        }
        maintain_terminal_thermal_state(host, &mut runtime.state, &mut runtime.terminal);
        let tick = if !runtime.output_open && !runtime.exit_observed {
            EXIT_POLL_TICK
        } else if runtime.state.thermal_state == ThermalState::Parked {
            PARKED_THERMAL_TICK
        } else {
            THERMAL_TICK
        };
        maintenance.push(Reverse((Instant::now() + tick, key)));
    }
}

fn reject_terminal_command(command: TerminalCommand, terminal_id: &str) {
    let error = || TerminalError::NotFound(terminal_id.to_owned());
    match command {
        TerminalCommand::Inspect { reply } => {
            let _ = reply.send(Err(error()));
        }
        TerminalCommand::Write { reply, .. }
        | TerminalCommand::SetTheme { reply, .. }
        | TerminalCommand::Resize { reply, .. }
        | TerminalCommand::MarkReplayReady { reply, .. }
        | TerminalCommand::Detach { reply, .. }
        | TerminalCommand::Dispose { reply }
        | TerminalCommand::ReleaseLease { reply, .. } => {
            let _ = reply.send(Err(error()));
        }
        TerminalCommand::Authorize { reply, .. }
        | TerminalCommand::AuthorizeAndWrite { reply, .. }
        | TerminalCommand::AuthorizeAndResize { reply, .. }
        | TerminalCommand::AuthorizeAndDispose { reply, .. }
        | TerminalCommand::AcquireLease { reply, .. }
        | TerminalCommand::RenewLease { reply, .. }
        | TerminalCommand::Takeover { reply, .. }
        | TerminalCommand::Transfer { reply, .. } => {
            let _ = reply.send(Err(error()));
        }
        TerminalCommand::Attach { reply, .. } => {
            let _ = reply.send(Err(error()));
        }
        TerminalCommand::GetLiveCwd { reply } => {
            let _ = reply.send(Err(error()));
        }
        TerminalCommand::ListLeases { reply } => {
            let _ = reply.send(Err(error()));
        }
    }
}

#[cfg(not(unix))]
fn spawn_fallback_pty_reader(
    terminal_id: String,
    mut reader: Box<dyn Read + Send>,
    reactor: ReactorHandle,
) -> Result<(), TerminalError> {
    thread::Builder::new()
        .name(format!("yaade-pty-reader-{terminal_id}"))
        .stack_size(256 * 1024)
        .spawn(move || {
            let mut buffer = vec![0_u8; REACTOR_READ_BUFFER_BYTES];
            loop {
                let output = match reader.read(&mut buffer) {
                    Ok(0) => ReactorOutput::Eof,
                    Ok(count) => ReactorOutput::Bytes(Bytes::copy_from_slice(&buffer[..count])),
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) => ReactorOutput::ReadFailed(error.kind()),
                };
                let terminal = matches!(output, ReactorOutput::Eof | ReactorOutput::ReadFailed(_));
                if reactor
                    .normal
                    .send(ReactorCommand::Output {
                        terminal_id: terminal_id.clone(),
                        output,
                    })
                    .is_err()
                {
                    break;
                }
                let _ = reactor.wake.notify();
                if terminal {
                    break;
                }
            }
        })
        .map(|_| ())
        .map_err(|error| TerminalError::Runtime(error.to_string()))
}

#[cfg(not(unix))]
fn process_fallback_output(
    host: &Weak<TerminalHost>,
    runtime: &mut TerminalRuntime,
    output: ReactorOutput,
) {
    match output {
        ReactorOutput::Bytes(data) => {
            if !process_terminal_output(
                host,
                &runtime.entry,
                &mut runtime.state,
                &mut runtime.terminal,
                &mut runtime.pending_input,
                &mut runtime.pending_input_bytes,
                data,
            ) {
                let _ = runtime.child.kill();
                runtime.output_open = false;
            }
        }
        ReactorOutput::Eof => runtime.output_open = false,
        ReactorOutput::ReadFailed(kind) => {
            eprintln!("[terminal-reactor] {} failed: {kind:?}", runtime.entry.id);
            runtime.output_open = false;
        }
    }
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
    child: &mut Box<dyn Child + Send + Sync>,
    state: &mut EntryState,
    terminal: &mut GhosttyTerminal,
    control: &mut TerminalControlRegistry,
    commands: Vec<TerminalCommand>,
    write_scratch: &mut Vec<u8>,
    pending_input: &mut VecDeque<(Bytes, usize)>,
    pending_input_bytes: &mut usize,
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
                    } => match require_ready(state, &connection_id).and_then(|()| {
                        authorize_terminal(control, entry, &principal_id, &connection_id, fence)
                    }) {
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
                enqueue_pending_input(
                    pending_input,
                    pending_input_bytes,
                    Bytes::copy_from_slice(write_scratch),
                    false,
                )
                .err()
                .map(|error| error.to_string())
            };
            if write_error.is_none() && !write_scratch.is_empty() {
                mark_terminal_hot(state);
                if let Some(host) = host.upgrade() {
                    host.metrics
                        .pty_bytes_written_total
                        .fetch_add(write_scratch.len() as u64, Ordering::Relaxed);
                }
            }
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
                    } => match require_ready(state, &connection_id).and_then(|()| {
                        authorize_terminal(control, entry, &principal_id, &connection_id, fence)
                    }) {
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
            if latest.is_some() {
                mark_terminal_hot(state);
            }
            let resize_error = latest
                .and_then(|(cols, rows)| {
                    resize_terminal(
                        host,
                        master,
                        entry,
                        state,
                        terminal,
                        pending_input,
                        pending_input_bytes,
                        cols,
                        rows,
                    )
                    .err()
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
            host,
            entry,
            child,
            state,
            terminal,
            control,
            pending_input,
            pending_input_bytes,
            command,
        ) {
            return false;
        }
    }
    true
}

fn require_ready(state: &EntryState, connection_id: &str) -> Result<(), TerminalError> {
    state
        .replay_ready_clients
        .contains(connection_id)
        .then_some(())
        .ok_or(TerminalError::NotReady)
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

fn enqueue_pending_input(
    pending: &mut VecDeque<(Bytes, usize)>,
    pending_bytes: &mut usize,
    data: Bytes,
    authority_response: bool,
) -> Result<(), TerminalError> {
    if pending_bytes.saturating_add(data.len()) > MAX_PENDING_INPUT_BYTES_PER_TERMINAL {
        return Err(TerminalError::Runtime(
            "terminal input queue is full".to_owned(),
        ));
    }
    *pending_bytes = pending_bytes.saturating_add(data.len());
    if authority_response {
        let insertion = usize::from(pending.front().is_some_and(|(_, offset)| *offset > 0));
        pending.insert(insertion, (data, 0));
    } else {
        pending.push_back((data, 0));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn resize_terminal(
    host: &Weak<TerminalHost>,
    master: &dyn MasterPty,
    entry: &TerminalEntry,
    state: &mut EntryState,
    terminal: &mut GhosttyTerminal,
    pending_input: &mut VecDeque<(Bytes, usize)>,
    pending_input_bytes: &mut usize,
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
        enqueue_pending_input(
            pending_input,
            pending_input_bytes,
            Bytes::from(response),
            false,
        )?;
    }
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
    child: &mut Box<dyn Child + Send + Sync>,
    state: &mut EntryState,
    terminal: &mut GhosttyTerminal,
    control: &mut TerminalControlRegistry,
    pending_input: &mut VecDeque<(Bytes, usize)>,
    pending_input_bytes: &mut usize,
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
                output_position: state.sequence,
                thermal_state: state.thermal_state,
                attached_clients: state.attached_clients.len(),
            }));
        }
        TerminalCommand::Write { .. } => {
            unreachable!("write commands are handled by the serialized batch path")
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
        TerminalCommand::AuthorizeAndWrite { .. } => {
            unreachable!("authorized writes are handled by the serialized batch path")
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
                            let mut response = Vec::new();
                            write_terminal_theme_preference(&mut response, theme)
                                .map_err(|error| TerminalError::Runtime(error.to_string()))?;
                            enqueue_pending_input(
                                pending_input,
                                pending_input_bytes,
                                Bytes::from(response),
                                false,
                            )?;
                        }
                        state.terminal_theme = theme;
                        Ok(())
                    })
            };
            let _ = reply.send(result);
        }
        TerminalCommand::Resize { .. } | TerminalCommand::AuthorizeAndResize { .. } => {
            unreachable!("resize commands are handled by the coalescing batch path")
        }
        TerminalCommand::Attach {
            client_id,
            after_sequence,
            reply,
        } => {
            state.attached_clients.insert(client_id.clone());
            mark_terminal_hot(state);
            // The owner is the sole parser mutator, so this fresh snapshot and
            // `state.sequence` form one atomic cut. PTY readiness may continue
            // filling the bounded owner mailbox but cannot mutate the authority
            // until this command completes.
            if !store_checkpoint(host, &entry.id, &entry.terminal_epoch, state, terminal) {
                let _ = reply.send(Err(TerminalError::Runtime(
                    "authoritative terminal snapshot exceeds the protocol budget".to_owned(),
                )));
                return true;
            }
            let archive_available = host
                .upgrade()
                .is_some_and(|host| host.history.available(&entry.id));
            let replay_floor = state.replay.front().map_or(state.sequence + 1, |chunk| {
                chunk
                    .sequence
                    .saturating_sub(chunk.data.len().saturating_sub(1) as u64)
            });
            let checkpoint = state.checkpoint.clone();
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
                stream_id: terminal_stream_id(&entry.id),
                stream_epoch: terminal_stream_epoch(&entry.terminal_epoch),
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
            let result = if state.attached_clients.contains(&client_id) {
                state.replay_ready_clients.insert(client_id);
                Ok(())
            } else {
                Err(TerminalError::NotReady)
            };
            let _ = reply.send(result);
        }
        TerminalCommand::Detach { client_id, reply } => {
            state.replay_ready_clients.remove(&client_id);
            state.attached_clients.remove(&client_id);
            state.last_activity_at = Instant::now();
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

fn mark_terminal_hot(state: &mut EntryState) {
    state.last_activity_at = Instant::now();
    state.thermal_state = ThermalState::Hot;
}

fn maintain_terminal_thermal_state(
    host: &Weak<TerminalHost>,
    state: &mut EntryState,
    terminal: &mut GhosttyTerminal,
) {
    if state.status != TerminalProcessStatus::Running {
        return;
    }
    let idle = state.last_activity_at.elapsed();
    let target = if !state.attached_clients.is_empty() || idle < WARM_AFTER {
        ThermalState::Hot
    } else if idle < PARK_AFTER {
        ThermalState::Warm
    } else {
        ThermalState::Parked
    };
    let activity = terminal
        .compression_activity()
        .unwrap_or(state.compression_activity);
    let previous = state.thermal_state;
    match target {
        ThermalState::Hot => {}
        ThermalState::Warm => {
            if activity != state.compression_activity || state.thermal_state == ThermalState::Hot {
                compress_terminal(host, terminal, CompressionMode::Incremental);
            }
        }
        ThermalState::Parked => {
            if state.thermal_state != ThermalState::Parked || activity != state.compression_activity
            {
                compress_terminal(host, terminal, CompressionMode::Full);
                state.replay.shrink_to_fit();
            }
        }
    }
    if let Some(host) = host.upgrade() {
        if previous != ThermalState::Parked && target == ThermalState::Parked {
            host.metrics
                .hot_to_parked_total
                .fetch_add(1, Ordering::Relaxed);
        } else if previous == ThermalState::Parked && target == ThermalState::Hot {
            host.metrics
                .parked_to_hot_total
                .fetch_add(1, Ordering::Relaxed);
        }
    }
    state.compression_activity = activity;
    state.thermal_state = target;
}

fn compress_terminal(
    host: &Weak<TerminalHost>,
    terminal: &mut GhosttyTerminal,
    mode: CompressionMode,
) {
    let started = Instant::now();
    let _ = terminal.compress(mode);
    let elapsed = duration_nanos(started.elapsed());
    if let Some(host) = host.upgrade() {
        host.metrics
            .compression_runs_total
            .fetch_add(1, Ordering::Relaxed);
        host.metrics
            .compression_duration_ns_total
            .fetch_add(elapsed, Ordering::Relaxed);
        host.metrics
            .compression_duration_ns_max
            .fetch_max(elapsed, Ordering::Relaxed);
    }
}

fn duration_nanos(duration: Duration) -> u64 {
    u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX)
}

fn process_terminal_output(
    host: &Weak<TerminalHost>,
    entry: &TerminalEntry,
    state: &mut EntryState,
    terminal: &mut GhosttyTerminal,
    pending_input: &mut VecDeque<(Bytes, usize)>,
    pending_input_bytes: &mut usize,
    data: Bytes,
) -> bool {
    if state.disposed {
        return true;
    }
    let wake_started = (state.thermal_state == ThermalState::Parked).then(Instant::now);
    let upgraded_host = host.upgrade();
    if let Some(host) = &upgraded_host {
        host.metrics
            .pty_bytes_read_total
            .fetch_add(data.len() as u64, Ordering::Relaxed);
        if wake_started.is_some() {
            host.metrics
                .parked_to_hot_total
                .fetch_add(1, Ordering::Relaxed);
        }
    }

    mark_terminal_hot(state);
    state.sequence = state.sequence.saturating_add(data.len() as u64);
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

    // Fanout is the first consumer after sequencing. Ghostty is an authority
    // sidecar over the same immutable bytes, never a rendering transform in
    // front of capable clients. Subscriber enqueue is bounded and nonblocking.
    if let Some(host) = &upgraded_host {
        host.events.emit_terminal(
            Arc::<str>::from(entry.id.as_str()),
            terminal_stream_id(&entry.id),
            terminal_stream_epoch(&entry.terminal_epoch),
            sequence,
            data.clone(),
        );
        if let Err(error) = host.history.try_append(&entry.id, sequence, data.clone()) {
            eprintln!("[terminal-history] {error}");
        }
        if let Some(started) = wake_started {
            let elapsed = duration_nanos(started.elapsed());
            host.metrics
                .parked_wake_duration_ns_total
                .fetch_add(elapsed, Ordering::Relaxed);
            host.metrics
                .parked_wake_duration_ns_max
                .fetch_max(elapsed, Ordering::Relaxed);
        }
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
            eprintln!(
                "[terminal-ghostty] {} authority quarantined after parser failure: {error}",
                entry.id
            );
            return false;
        }
    };
    for response in responses {
        if let Err(error) = enqueue_pending_input(
            pending_input,
            pending_input_bytes,
            Bytes::from(response),
            true,
        ) {
            eprintln!("[terminal-pty-response] {}: {error}", entry.id);
            return false;
        }
    }
    if let Some(title) = title {
        state.title = Some(String::from_utf8_lossy(&title).into_owned());
    }
    if let Some(value) = working_directory {
        state.live_cwd = decode_terminal_working_directory(&value);
    }

    if state.checkpoints {
        state.bytes_since_checkpoint = state.bytes_since_checkpoint.saturating_add(data.len());
        if state.bytes_since_checkpoint >= CHECKPOINT_BYTES
            || state.last_checkpoint_at.elapsed() >= CHECKPOINT_INTERVAL
        {
            store_checkpoint(host, &entry.id, &entry.terminal_epoch, state, terminal);
        }
    }
    if let Some(host) = upgraded_host {
        for _ in 0..bells {
            host.events.emit("terminal:bell", vec![json!(entry.id)]);
        }
    }
    true
}

fn try_observe_terminal_exit(
    host: &Weak<TerminalHost>,
    entry: &TerminalEntry,
    child: &mut Box<dyn Child + Send + Sync>,
    state: &mut EntryState,
    terminal: &mut GhosttyTerminal,
) -> bool {
    if state.disposed {
        return true;
    }
    let exit = match child.try_wait() {
        Ok(Some(status)) => Ok(status),
        Ok(None) => return false,
        Err(error) => Err(error),
    };
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
    let Some(host) = host.upgrade() else {
        return true;
    };
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
    true
}

fn store_checkpoint(
    host: &Weak<TerminalHost>,
    terminal_id: &str,
    terminal_epoch: &str,
    state: &mut EntryState,
    terminal: &GhosttyTerminal,
) -> bool {
    let started = Instant::now();
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
            state.checkpoint = None;
            return false;
        }
    };
    if let Some(host) = host.upgrade()
        && let Err(error) = host
            .history
            .try_persist_checkpoint(terminal_id, checkpoint.snapshot_bytes.0.clone())
    {
        eprintln!("[terminal-checkpoint] {error}");
    }
    if let Some(host) = host.upgrade() {
        let elapsed = duration_nanos(started.elapsed());
        host.metrics.snapshots_total.fetch_add(1, Ordering::Relaxed);
        host.metrics
            .snapshot_bytes_total
            .fetch_add(checkpoint.payload_bytes as u64, Ordering::Relaxed);
        host.metrics
            .snapshot_duration_ns_total
            .fetch_add(elapsed, Ordering::Relaxed);
        host.metrics
            .snapshot_duration_ns_max
            .fetch_max(elapsed, Ordering::Relaxed);
    }
    state.checkpoint = Some(checkpoint);
    state.bytes_since_checkpoint = 0;
    state.last_checkpoint_at = Instant::now();
    true
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

pub(crate) fn terminal_stream_id(value: &str) -> u64 {
    // Stable FNV-1a is shared with the browser codec. Zero is reserved for the
    // connection control stream.
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    (hash & ((1_u64 << 53) - 1)).max(1)
}

pub(crate) fn terminal_stream_epoch(value: &str) -> u64 {
    terminal_stream_id(value)
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

    fn test_identity() -> crate::wire::ServerIdentity {
        crate::wire::ServerIdentity {
            server_id: "test-server".to_owned(),
            server_epoch: "test-epoch".to_owned(),
            protocol_version: 2,
            runtime_version: "test".to_owned(),
            started_at: crate::model::now_iso(),
        }
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fixed_reactor_shards_fan_in_many_ptys_and_fence_descriptor_reuse() {
        let root = tempfile::tempdir().expect("history root");
        let host = TerminalHost::new(Arc::new(EventHub::new(test_identity())), root.path(), true)
            .expect("terminal host");
        let shard_count = host.runtime_diagnostics().terminal_reactor_shards;
        assert!((1..=REACTOR_MAX_SHARDS).contains(&shard_count));
        assert_eq!(
            host.runtime_diagnostics().terminal_owner_threads,
            shard_count
        );

        let mut ids = Vec::new();
        for index in 0..32_u8 {
            let created = host
                .create(
                    Path::new("/tmp"),
                    Some(TerminalLaunch {
                        command: Some("/bin/cat".to_owned()),
                        args: Vec::new(),
                        ..TerminalLaunch::default()
                    }),
                )
                .expect("create PTY");
            host.write(&created.id, &[b'a' + index % 26, b'\n'])
                .expect("write PTY");
            ids.push(created.id);
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline
            && ids.iter().any(|id| {
                host.inspect(id)
                    .is_none_or(|state| state.output_position == 0)
            })
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(ids.iter().all(|id| {
            host.inspect(id)
                .is_some_and(|state| state.output_position > 0)
        }));
        let diagnostics = host.runtime_diagnostics();
        assert_eq!(diagnostics.terminal_sessions_active, ids.len());
        assert_eq!(diagnostics.terminal_owner_threads, shard_count);
        for id in ids {
            host.dispose(&id).expect("dispose PTY");
        }

        // New registrations reuse OS descriptor numbers under pressure, while
        // monotonically unique poll keys prevent stale readiness delivery.
        for generation in 0..64_u8 {
            let created = host
                .create(
                    Path::new("/tmp"),
                    Some(TerminalLaunch {
                        command: Some("/usr/bin/printf".to_owned()),
                        args: vec![format!("generation-{generation}")],
                        ..TerminalLaunch::default()
                    }),
                )
                .expect("create reuse PTY");
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline
                && host
                    .inspect(&created.id)
                    .is_none_or(|state| state.output_position == 0)
            {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            assert!(
                host.inspect(&created.id)
                    .is_some_and(|state| state.output_position > 0),
                "generation {generation} produced no output"
            );
            host.dispose(&created.id).expect("dispose reuse PTY");
        }
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn blocked_pty_input_is_bounded_without_stalling_its_reactor_shard() {
        let root = tempfile::tempdir().expect("history root");
        let host = TerminalHost::new(Arc::new(EventHub::new(test_identity())), root.path(), false)
            .expect("terminal host");
        let blocked = host
            .create(
                Path::new("/tmp"),
                Some(TerminalLaunch {
                    command: Some("/bin/sleep".to_owned()),
                    args: vec!["10".to_owned()],
                    ..TerminalLaunch::default()
                }),
            )
            .expect("blocked PTY");
        let blocked_shard = terminal_stream_id(&blocked.id) as usize % host.reactors.len();
        let responsive = loop {
            let candidate = host
                .create(
                    Path::new("/tmp"),
                    Some(TerminalLaunch {
                        command: Some("/bin/cat".to_owned()),
                        args: Vec::new(),
                        ..TerminalLaunch::default()
                    }),
                )
                .expect("responsive PTY");
            if terminal_stream_id(&candidate.id) as usize % host.reactors.len() == blocked_shard {
                break candidate;
            }
            host.dispose(&candidate.id)
                .expect("dispose other shard PTY");
        };

        let chunk = vec![b'x'; 512 * 1024];
        let mut saturated = false;
        for _ in 0..8 {
            if host.write(&blocked.id, &chunk).is_err() {
                saturated = true;
                break;
            }
        }
        assert!(
            saturated,
            "blocked PTY input did not reach its explicit bound"
        );
        host.write(&responsive.id, b"ok\n")
            .expect("responsive shard peer write");
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline
            && host
                .inspect(&responsive.id)
                .is_none_or(|state| state.output_position == 0)
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(
            host.inspect(&responsive.id)
                .is_some_and(|state| state.output_position > 0),
            "blocked input stalled another PTY on the same shard"
        );
        host.dispose(&blocked.id).expect("dispose blocked PTY");
        host.dispose(&responsive.id)
            .expect("dispose responsive PTY");
    }

    /// Reproducible scale probe; intentionally ignored in the fast suite.
    /// Run with:
    /// `cargo test --release --lib benchmark_one_thousand_parkable_sessions -- --ignored --nocapture`
    #[cfg(unix)]
    #[ignore = "opens 1,000 PTYs and reports host-specific resource measurements"]
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn benchmark_one_thousand_parkable_sessions() {
        const SESSION_COUNT: usize = 1_000;
        let root = tempfile::tempdir().expect("history root");
        let baseline_rss_kib = process_rss_kib();
        let host = TerminalHost::new(Arc::new(EventHub::new(test_identity())), root.path(), false)
            .expect("terminal host");
        let create_started = Instant::now();
        let mut ids = Vec::with_capacity(SESSION_COUNT);
        for _ in 0..SESSION_COUNT {
            match host.create(
                Path::new("/tmp"),
                Some(TerminalLaunch {
                    command: Some("/bin/cat".to_owned()),
                    args: Vec::new(),
                    ..TerminalLaunch::default()
                }),
            ) {
                Ok(created) => ids.push(created.id),
                Err(error) => {
                    eprintln!(
                        "terminal_scale admission stopped at {} of {SESSION_COUNT}: {error}",
                        ids.len()
                    );
                    break;
                }
            }
        }
        assert!(ids.len() >= 256, "scale fixture admitted too few PTYs");
        let admitted = ids.len();
        let create_ms = create_started.elapsed().as_millis();
        let active_rss_kib = process_rss_kib();
        tokio::time::sleep(WARM_AFTER + THERMAL_TICK).await;
        let warm_rss_kib = process_rss_kib();
        tokio::time::sleep(PARK_AFTER - WARM_AFTER + THERMAL_TICK).await;
        let parked_rss_kib = process_rss_kib();
        let parked_diagnostics = host.runtime_diagnostics();
        assert_eq!(parked_diagnostics.terminal_sessions_parked, admitted);
        let mut started = HashMap::with_capacity(admitted);
        for id in &ids {
            started.insert(id.as_str(), Instant::now());
            host.write(id, b"x\n").expect("write scale PTY");
        }
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut observed = HashMap::with_capacity(admitted);
        while observed.len() < admitted && Instant::now() < deadline {
            for id in &ids {
                if !observed.contains_key(id.as_str())
                    && host
                        .inspect(id)
                        .is_some_and(|state| state.output_position >= 2)
                {
                    observed.insert(
                        id.as_str(),
                        started[id.as_str()].elapsed().as_micros() as u64,
                    );
                }
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        assert_eq!(observed.len(), admitted, "not every PTY echoed input");
        let mut latency_us = observed.into_values().collect::<Vec<_>>();
        latency_us.sort_unstable();
        let percentile = |numerator: usize| latency_us[numerator * (latency_us.len() - 1) / 100];
        let diagnostics = host.runtime_diagnostics();
        assert_eq!(diagnostics.terminal_sessions_active, admitted);
        assert_eq!(
            diagnostics.terminal_owner_threads,
            diagnostics.terminal_reactor_shards
        );
        let p50_us = percentile(50);
        let p95_us = percentile(95);
        let p99_us = percentile(99);
        drop(started);
        drop(ids);
        let shutdown_started = Instant::now();
        drop(host);
        let shutdown_ms = shutdown_started.elapsed().as_millis();
        eprintln!(
            "terminal_scale requested={SESSION_COUNT} admitted={admitted} create_ms={create_ms} rss_base_kib={baseline_rss_kib} rss_active_kib={active_rss_kib} rss_warm_kib={warm_rss_kib} rss_parked_kib={parked_rss_kib} rss_delta_kib={} shards={} p50_wake_us={p50_us} p95_wake_us={p95_us} p99_wake_us={p99_us} shutdown_ms={shutdown_ms}",
            active_rss_kib.saturating_sub(baseline_rss_kib),
            diagnostics.terminal_reactor_shards,
        );
    }

    #[cfg(unix)]
    fn process_rss_kib() -> u64 {
        command_output("ps", &["-o", "rss=", "-p", &std::process::id().to_string()])
            .and_then(|value| value.trim().parse().ok())
            .unwrap_or(0)
    }

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
    fn snapshot_continuation_matrix_covers_partial_utf8_and_control_strings() {
        let cases: &[(&[u8], &[u8])] = &[
            (b"utf8:\xe2", b"\x94\x80 done"),
            (b"\x1b[31", b"mred\x1b[0m"),
            (b"\x1b]2;partial", b" title\x07"),
            (b"\x1bP$q", b"m\x1b\\"),
            (b"\x1b_Gf=100;", b"payload\x1b\\"),
            (b"\x1b[?1049h\x1b7alternate", b"\x1b8\x1b[?1049lprimary"),
        ];
        for &(prefix, suffix) in cases {
            let options = || GhosttyTerminalOptions {
                cols: 80,
                rows: 24,
                scrollback: 128,
                effects: EffectOptions::default(),
            };
            let mut authority = GhosttyTerminal::new(options()).expect("authority");
            authority.write(prefix).expect("prefix");
            let snapshot = authority.snapshot(MAX_CHECKPOINT_BYTES).expect("snapshot");
            let mut replica = GhosttyTerminal::from_snapshot(&snapshot, EffectOptions::default())
                .expect("replica");
            let authority_effects = authority.write(suffix).expect("authority continuation");
            let replica_effects = replica.write(suffix).expect("replica continuation");
            assert_eq!(
                authority_effects.pty_responses().collect::<Vec<_>>(),
                replica_effects.pty_responses().collect::<Vec<_>>()
            );
            assert_eq!(
                authority.state().expect("authority state"),
                replica.state().expect("replica state")
            );
        }
    }

    #[test]
    fn randomized_snapshot_resize_continuation_matches_uninterrupted_authority() {
        let mut seed = 0x9e37_79b9_7f4a_7c15_u64;
        let mut bytes = vec![0_u8; 4_096];
        for byte in &mut bytes {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            *byte = seed as u8;
        }
        for cut in [1, 2, 3, 7, 31, 127, 511, 1023, 2047, 4095] {
            let options = GhosttyTerminalOptions {
                cols: 80,
                rows: 24,
                scrollback: 256,
                effects: EffectOptions::default(),
            };
            let mut authority = GhosttyTerminal::new(options).expect("authority");
            authority.write(&bytes[..cut]).expect("random prefix");
            let snapshot = authority.snapshot(MAX_CHECKPOINT_BYTES).expect("snapshot");
            let mut replica = GhosttyTerminal::from_snapshot(&snapshot, EffectOptions::default())
                .expect("replica");
            authority.resize(97, 31, 1, 1).expect("authority resize");
            replica.resize(97, 31, 1, 1).expect("replica resize");
            for continuation in bytes[cut..].chunks(113) {
                authority.write(continuation).expect("authority bytes");
                replica.write(continuation).expect("replica bytes");
            }
            assert_eq!(
                authority.state().expect("authority state"),
                replica.state().expect("replica state")
            );
        }
    }

    #[test]
    fn terminal_bytes_are_not_decoded_or_joined_at_read_boundaries() {
        let first = Bytes::copy_from_slice(b"ok\xffdone\xe2");
        let second = Bytes::copy_from_slice(b"\x94\x80");
        assert_eq!(first.as_ref(), b"ok\xffdone\xe2");
        assert_eq!(second.as_ref(), b"\x94\x80");
    }
}
