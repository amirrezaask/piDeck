use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, MutexGuard, mpsc},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use bytes::Bytes;
use flate2::{Compression, read::GzDecoder, write::GzEncoder};
use serde::{Deserialize, Serialize, Serializer};
use thiserror::Error;

const DEFAULT_BLOCK_BYTES: usize = 512 * 1024;
const DEFAULT_PAGE_BYTES: usize = 256 * 1024;
const MAX_TERMINAL_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const CLOSED_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const ARCHIVE_VERSION: u8 = 2;
const BLOCK_MAGIC: &[u8; 8] = b"YAADEH02";
const ACTIVE_MAGIC: &[u8; 8] = b"YAADEA02";
const ACTIVE_FILE: &str = "active.bin";
const BLOCK_HEADER_BYTES: usize = 16;
const RECORD_HEADER_BYTES: usize = 12;
const ACTIVE_RECORD_HEADER_BYTES: usize = 16;
const MAX_RECORD_BYTES: usize = 64 * 1024;
const MAX_BLOCK_RECORDS: usize = 1_000_000;
const INGEST_MAX_MESSAGES: usize = 1024;
const INGEST_MAX_BYTES: usize = 32 * 1024 * 1024;
const FINALIZE_MAX_MESSAGES: usize = 1024;
const HISTORY_MAINTENANCE_INTERVAL: Duration = Duration::from_secs(10);
const HISTORY_STAGING_IDLE: Duration = Duration::from_secs(30);
const HISTORY_STAGING_COOLDOWN: Duration = Duration::from_secs(60);
const HISTORY_STAGING_MIN_BYTES: usize = 64 * 1024;
const HISTORY_STAGING_MIN_RECLAIM_BYTES: usize = 256 * 1024;
const HISTORY_STAGING_SHRINK_RATIO: usize = 4;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Base64Bytes(pub Bytes);

impl Serialize for Base64Bytes {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&STANDARD.encode(&self.0))
    }
}

#[derive(Clone, Debug)]
struct HistoryRecord {
    sequence: u64,
    data: Bytes,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveBlock {
    file: String,
    first_sequence: u64,
    last_sequence: u64,
    uncompressed_bytes: u64,
    stored_bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveManifest {
    version: u8,
    terminal_id: String,
    created_at: u64,
    updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    closed_at: Option<u64>,
    blocks: Vec<ArchiveBlock>,
}

struct ArchiveState {
    dir: PathBuf,
    manifest: ArchiveManifest,
    active: File,
    pending: Vec<HistoryRecord>,
    pending_bytes: usize,
    encoded_staging: Vec<u8>,
    compressed_staging: Vec<u8>,
    last_activity_at: Instant,
    last_capacity_change_at: Instant,
    idle_trims: u64,
    idle_bytes_reclaimed: u64,
    idle_regrows: u64,
    trimmed_since_growth: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalHistoryCapacityDiagnostics {
    pub owner: &'static str,
    pub memory_class: &'static str,
    pub states: usize,
    pub used_bytes: u64,
    pub allocated_bytes: u64,
    pub durable_pending_bytes: u64,
    pub idle_trims: u64,
    pub idle_bytes_reclaimed: u64,
    pub idle_regrows: u64,
}

impl ArchiveState {
    fn staging_used_bytes(&self) -> usize {
        self.encoded_staging
            .len()
            .saturating_add(self.compressed_staging.len())
    }

    fn staging_allocated_bytes(&self) -> usize {
        self.encoded_staging
            .capacity()
            .saturating_add(self.compressed_staging.capacity())
    }

    fn record_staging_growth(&mut self, before: usize, now: Instant) {
        if self.staging_allocated_bytes() <= before {
            return;
        }
        if self.trimmed_since_growth {
            self.idle_regrows = self.idle_regrows.saturating_add(1);
            self.trimmed_since_growth = false;
        }
        self.last_capacity_change_at = now;
    }

    fn trim_idle_staging(&mut self, now: Instant) -> bool {
        let allocated = self.staging_allocated_bytes();
        let target = HISTORY_STAGING_MIN_BYTES.saturating_mul(2);
        if !self.pending.is_empty()
            || self.staging_used_bytes() > 0
            || now.saturating_duration_since(self.last_activity_at) < HISTORY_STAGING_IDLE
            || now.saturating_duration_since(self.last_capacity_change_at)
                < HISTORY_STAGING_COOLDOWN
            || allocated < target.saturating_mul(HISTORY_STAGING_SHRINK_RATIO)
            || allocated.saturating_sub(target) < HISTORY_STAGING_MIN_RECLAIM_BYTES
        {
            return false;
        }
        self.encoded_staging = Vec::with_capacity(HISTORY_STAGING_MIN_BYTES);
        self.compressed_staging = Vec::with_capacity(HISTORY_STAGING_MIN_BYTES);
        let reclaimed = allocated.saturating_sub(self.staging_allocated_bytes());
        if reclaimed == 0 {
            return false;
        }
        self.last_capacity_change_at = now;
        self.idle_trims = self.idle_trims.saturating_add(1);
        self.idle_bytes_reclaimed = self.idle_bytes_reclaimed.saturating_add(reclaimed as u64);
        self.trimmed_since_growth = true;
        true
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalHistoryMetadata {
    pub last_sequence: u64,
    pub closed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalHistoryPage {
    pub chunks: Vec<Base64Bytes>,
    pub first_sequence: u64,
    pub last_sequence: u64,
    pub next_sequence: u64,
    pub complete: bool,
}

struct HistoryReadSnapshot {
    dir: PathBuf,
    blocks: Vec<ArchiveBlock>,
    pending: Vec<HistoryRecord>,
    newest: u64,
}

#[derive(Debug, Error)]
pub enum HistoryError {
    #[error("terminal history failure: {0}")]
    Io(#[from] std::io::Error),
    #[error("terminal history failure: {0}")]
    Json(#[from] serde_json::Error),
    #[error("terminal history is corrupt: {0}")]
    Corrupt(String),
}

struct AppendCommand {
    terminal_id: String,
    sequence: u64,
    data: Bytes,
}

enum IngestCommand {
    Append(AppendCommand),
    Snapshot(mpsc::Sender<Result<(), String>>),
    Barrier(mpsc::Sender<Result<(), String>>),
    Shutdown(mpsc::Sender<Result<(), String>>),
}

enum FinalizeCommand {
    Close {
        terminal_id: String,
        through_sequence: u64,
    },
}

struct IngestBudget {
    bytes: Mutex<usize>,
    available: Condvar,
}

struct HistoryShared {
    root: PathBuf,
    block_bytes: usize,
    page_bytes: usize,
    states: Mutex<HashMap<String, Arc<Mutex<ArchiveState>>>>,
    pending_closes: Mutex<HashSet<String>>,
    background_errors: Mutex<Vec<String>>,
    accepted_sequences: Mutex<HashMap<String, u64>>,
    budget: IngestBudget,
}

/// Durable block-compressed PTY history. Live appends enter a count- and
/// byte-bounded ingest mailbox. Compression, manifests, and quota maintenance
/// run on the dedicated history owner, never on a PTY reader thread.
pub struct TerminalHistoryArchive {
    shared: Arc<HistoryShared>,
    ingest_tx: mpsc::SyncSender<IngestCommand>,
    finalize_tx: mpsc::SyncSender<FinalizeCommand>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}

impl TerminalHistoryArchive {
    pub fn open(root: &Path) -> Result<Self, HistoryError> {
        Self::open_with_limits(root, DEFAULT_BLOCK_BYTES, DEFAULT_PAGE_BYTES, true)
    }

    #[cfg(test)]
    pub fn with_limits(
        root: &Path,
        block_bytes: usize,
        page_bytes: usize,
    ) -> Result<Self, HistoryError> {
        Self::open_with_limits(root, block_bytes.max(1), page_bytes.max(1), false)
    }

    fn open_with_limits(
        root: &Path,
        block_bytes: usize,
        page_bytes: usize,
        cleanup: bool,
    ) -> Result<Self, HistoryError> {
        fs::create_dir_all(root)?;
        let shared = Arc::new(HistoryShared {
            root: root.to_owned(),
            block_bytes,
            page_bytes,
            states: Mutex::new(HashMap::new()),
            pending_closes: Mutex::new(HashSet::new()),
            background_errors: Mutex::new(Vec::new()),
            accepted_sequences: Mutex::new(HashMap::new()),
            budget: IngestBudget {
                bytes: Mutex::new(0),
                available: Condvar::new(),
            },
        });
        if cleanup {
            shared.cleanup_expired()?;
        }
        let (ingest_tx, ingest_rx) = mpsc::sync_channel(INGEST_MAX_MESSAGES);
        let (finalize_tx, finalize_rx) = mpsc::sync_channel(FINALIZE_MAX_MESSAGES);
        let worker_shared = Arc::clone(&shared);
        let worker = thread::Builder::new()
            .name("yaade-history-owner".to_owned())
            .spawn(move || run_history_owner(&worker_shared, ingest_rx, finalize_rx))
            .map_err(HistoryError::Io)?;
        Ok(Self {
            shared,
            ingest_tx,
            finalize_tx,
            worker: Mutex::new(Some(worker)),
        })
    }

    pub fn append(
        &self,
        terminal_id: &str,
        sequence: u64,
        data: Bytes,
    ) -> Result<(), HistoryError> {
        if sequence == 0 || data.is_empty() {
            return Ok(());
        }
        if data.len() > MAX_RECORD_BYTES {
            return Err(HistoryError::Corrupt(format!(
                "history record exceeds {MAX_RECORD_BYTES} bytes"
            )));
        }
        {
            let mut accepted = self
                .shared
                .accepted_sequences
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if self.shared.pending_closes().contains(terminal_id) {
                return Err(HistoryError::Corrupt(format!(
                    "append after close for {terminal_id}"
                )));
            }
            let previous = accepted.get(terminal_id).copied().unwrap_or(0);
            if sequence <= previous {
                return Err(HistoryError::Corrupt(format!(
                    "history sequence {sequence} does not follow {previous}"
                )));
            }
            accepted.insert(terminal_id.to_owned(), sequence);
        }
        self.shared.reserve_ingest_bytes(data.len());
        let bytes = data.len();
        if self
            .ingest_tx
            .send(IngestCommand::Append(AppendCommand {
                terminal_id: terminal_id.to_owned(),
                sequence,
                data,
            }))
            .is_err()
        {
            self.shared.release_ingest_bytes(bytes);
            return Err(HistoryError::Corrupt("history owner stopped".to_owned()));
        }
        Ok(())
    }

    pub fn inspect(
        &self,
        terminal_id: &str,
    ) -> Result<Option<TerminalHistoryMetadata>, HistoryError> {
        self.snapshot()?;
        let dir = self.shared.terminal_dir(terminal_id);
        if !dir.exists() && !self.shared.states().contains_key(terminal_id) {
            return Ok(None);
        }
        let state = self.shared.state_for(terminal_id)?;
        let state = state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for block in &state.manifest.blocks {
            if !state.dir.join(&block.file).is_file() {
                return Err(HistoryError::Corrupt(format!(
                    "history block {} is missing for {terminal_id}",
                    block.file
                )));
            }
        }
        let last_sequence = state
            .pending
            .last()
            .map(|record| record.sequence)
            .or_else(|| {
                state
                    .manifest
                    .blocks
                    .last()
                    .map(|block| block.last_sequence)
            })
            .unwrap_or(0);
        Ok(Some(TerminalHistoryMetadata {
            last_sequence,
            closed: state.manifest.closed_at.is_some(),
        }))
    }

    pub fn read_page(
        &self,
        terminal_id: &str,
        after_sequence: u64,
        max_bytes: Option<usize>,
    ) -> Result<Option<TerminalHistoryPage>, HistoryError> {
        let Some(snapshot) = self.read_snapshot(terminal_id, after_sequence)? else {
            return Ok(None);
        };
        let limit = self.page_limit(max_bytes);
        let mut chunks = Vec::new();
        let mut bytes = 0_usize;
        let mut first_sequence = 0_u64;
        let mut last_sequence = after_sequence;
        let mut selected = Vec::new();
        for block in &snapshot.blocks {
            if block.last_sequence > after_sequence {
                selected.extend(read_block(&snapshot.dir.join(&block.file))?);
            }
        }
        selected.extend(snapshot.pending);
        for record in selected {
            if record.sequence <= after_sequence {
                continue;
            }
            let size = record.data.len();
            if !chunks.is_empty() && bytes.saturating_add(size) > limit {
                return Ok(Some(TerminalHistoryPage {
                    chunks,
                    first_sequence,
                    last_sequence,
                    next_sequence: last_sequence,
                    complete: false,
                }));
            }
            if first_sequence == 0 {
                first_sequence = record.sequence;
            }
            bytes = bytes.saturating_add(size);
            last_sequence = record.sequence;
            chunks.push(Base64Bytes(record.data));
        }
        Ok(Some(TerminalHistoryPage {
            chunks,
            first_sequence,
            last_sequence,
            next_sequence: last_sequence,
            complete: last_sequence >= snapshot.newest,
        }))
    }

    /// Read the newest bounded page before a sequence cursor. Records inside
    /// the page stay chronological so callers can feed the page to a terminal
    /// parser; successive page requests move from the newest page to older ones.
    pub fn read_page_reverse(
        &self,
        terminal_id: &str,
        before_sequence: u64,
        max_bytes: Option<usize>,
    ) -> Result<Option<TerminalHistoryPage>, HistoryError> {
        let Some(snapshot) = self.read_snapshot(terminal_id, 0)? else {
            return Ok(None);
        };
        let ceiling = if before_sequence == 0 {
            snapshot.newest
        } else {
            before_sequence.saturating_sub(1).min(snapshot.newest)
        };
        let limit = self.page_limit(max_bytes);
        let mut selected = Vec::new();
        let mut bytes = 0_usize;
        let mut complete = true;

        'records: {
            for record in snapshot.pending.iter().rev() {
                if record.sequence > ceiling {
                    continue;
                }
                let size = record.data.len();
                if !selected.is_empty() && bytes.saturating_add(size) > limit {
                    complete = false;
                    break 'records;
                }
                bytes = bytes.saturating_add(size);
                selected.push(record.clone());
            }
            for block in snapshot.blocks.iter().rev() {
                if block.first_sequence > ceiling {
                    continue;
                }
                for record in read_block(&snapshot.dir.join(&block.file))?
                    .into_iter()
                    .rev()
                {
                    if record.sequence > ceiling {
                        continue;
                    }
                    let size = record.data.len();
                    if !selected.is_empty() && bytes.saturating_add(size) > limit {
                        complete = false;
                        break 'records;
                    }
                    bytes = bytes.saturating_add(size);
                    selected.push(record);
                }
            }
        }

        selected.reverse();
        let first_sequence = selected.first().map_or(0, |record| record.sequence);
        let last_sequence = selected.last().map_or(0, |record| record.sequence);
        let chunks = selected
            .into_iter()
            .map(|record| Base64Bytes(record.data))
            .collect();
        Ok(Some(TerminalHistoryPage {
            chunks,
            first_sequence,
            last_sequence,
            next_sequence: first_sequence,
            complete,
        }))
    }

    fn read_snapshot(
        &self,
        terminal_id: &str,
        fallback_sequence: u64,
    ) -> Result<Option<HistoryReadSnapshot>, HistoryError> {
        self.snapshot()?;
        let dir = self.shared.terminal_dir(terminal_id);
        if !dir.exists() && !self.shared.states().contains_key(terminal_id) {
            return Ok(None);
        }
        let state = self.shared.state_for(terminal_id)?;
        let state = state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let newest = state
            .pending
            .last()
            .map(|record| record.sequence)
            .or_else(|| {
                state
                    .manifest
                    .blocks
                    .last()
                    .map(|block| block.last_sequence)
            })
            .unwrap_or(fallback_sequence);
        Ok(Some(HistoryReadSnapshot {
            dir: state.dir.clone(),
            blocks: state.manifest.blocks.clone(),
            pending: state.pending.clone(),
            newest,
        }))
    }

    fn page_limit(&self, max_bytes: Option<usize>) -> usize {
        max_bytes
            .unwrap_or(self.shared.page_bytes)
            .clamp(1, self.shared.page_bytes)
    }

    /// Enqueue idempotent finalization. The PTY termination path never waits on
    /// compression, manifest IO, or archive-wide quota scans.
    pub fn close_terminal(&self, terminal_id: &str) -> Result<(), HistoryError> {
        {
            let mut pending = self.shared.pending_closes();
            if !pending.insert(terminal_id.to_owned()) {
                return Ok(());
            }
        }
        let through_sequence = self
            .shared
            .accepted_sequences
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(terminal_id)
            .copied()
            .unwrap_or(0);
        if let Err(error) = self.finalize_tx.try_send(FinalizeCommand::Close {
            terminal_id: terminal_id.to_owned(),
            through_sequence,
        }) {
            self.shared.pending_closes().remove(terminal_id);
            let reason = match error {
                mpsc::TrySendError::Full(_) => "history finalizer mailbox is full",
                mpsc::TrySendError::Disconnected(_) => "history finalizer stopped",
            };
            return Err(HistoryError::Corrupt(reason.to_owned()));
        }
        Ok(())
    }

    pub fn delete_terminal(&self, terminal_id: &str) -> Result<(), HistoryError> {
        self.shared.pending_closes().remove(terminal_id);
        self.shared.states().remove(terminal_id);
        let dir = self.shared.terminal_dir(terminal_id);
        if dir.exists() {
            fs::remove_dir_all(dir)?;
        }
        Ok(())
    }

    /// Drain accepted close work, then flush live archives. Background failures
    /// are reported at this explicit shutdown/test barrier.
    pub fn flush_all(&self) -> Result<(), HistoryError> {
        let (tx, rx) = mpsc::channel();
        self.ingest_tx
            .send(IngestCommand::Barrier(tx))
            .map_err(|_| HistoryError::Corrupt("history owner stopped".to_owned()))?;
        match rx.recv() {
            Ok(Ok(())) => {}
            Ok(Err(error)) => return Err(HistoryError::Corrupt(error)),
            Err(_) => {
                return Err(HistoryError::Corrupt(
                    "history finalizer stopped".to_owned(),
                ));
            }
        }
        self.shared.flush_live()
    }

    #[must_use]
    pub fn available(&self, terminal_id: &str) -> bool {
        self.inspect(terminal_id)
            .ok()
            .flatten()
            .is_some_and(|metadata| metadata.last_sequence > 0)
    }

    #[must_use]
    pub fn capacity_diagnostics(&self) -> TerminalHistoryCapacityDiagnostics {
        self.shared.capacity_diagnostics()
    }

    fn snapshot(&self) -> Result<(), HistoryError> {
        let (snapshot_tx, snapshot_rx) = mpsc::channel();
        self.ingest_tx
            .send(IngestCommand::Snapshot(snapshot_tx))
            .map_err(|_| HistoryError::Corrupt("history owner stopped".to_owned()))?;
        match snapshot_rx.recv() {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(HistoryError::Corrupt(error)),
            Err(_) => Err(HistoryError::Corrupt("history owner stopped".to_owned())),
        }
    }
}

impl Drop for TerminalHistoryArchive {
    fn drop(&mut self) {
        let Some(worker) = self
            .worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        else {
            return;
        };
        let (tx, rx) = mpsc::channel();
        let _ = self.ingest_tx.send(IngestCommand::Shutdown(tx));
        let _ = rx.recv();
        let _ = worker.join();
    }
}

impl HistoryShared {
    fn capacity_diagnostics(&self) -> TerminalHistoryCapacityDiagnostics {
        let states = self.states().values().cloned().collect::<Vec<_>>();
        let mut diagnostics = TerminalHistoryCapacityDiagnostics {
            owner: "history-owner",
            memory_class: "transient-staging",
            states: states.len(),
            ..TerminalHistoryCapacityDiagnostics::default()
        };
        for state in states {
            let state = state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            diagnostics.used_bytes = diagnostics
                .used_bytes
                .saturating_add(state.staging_used_bytes() as u64);
            diagnostics.allocated_bytes = diagnostics
                .allocated_bytes
                .saturating_add(state.staging_allocated_bytes() as u64);
            diagnostics.durable_pending_bytes = diagnostics
                .durable_pending_bytes
                .saturating_add(state.pending_bytes as u64);
            diagnostics.idle_trims = diagnostics.idle_trims.saturating_add(state.idle_trims);
            diagnostics.idle_bytes_reclaimed = diagnostics
                .idle_bytes_reclaimed
                .saturating_add(state.idle_bytes_reclaimed);
            diagnostics.idle_regrows = diagnostics.idle_regrows.saturating_add(state.idle_regrows);
        }
        diagnostics
    }

    fn maintain_idle_staging(&self, now: Instant) {
        let states = self.states().values().cloned().collect::<Vec<_>>();
        for state in states {
            state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .trim_idle_staging(now);
        }
    }

    fn reserve_ingest_bytes(&self, bytes: usize) {
        let mut used = self
            .budget
            .bytes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while used.saturating_add(bytes) > INGEST_MAX_BYTES {
            used = self
                .budget
                .available
                .wait(used)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        *used = used.saturating_add(bytes);
    }

    fn release_ingest_bytes(&self, bytes: usize) {
        let mut used = self
            .budget
            .bytes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *used = used.saturating_sub(bytes);
        drop(used);
        self.budget.available.notify_all();
    }

    fn append_owned(&self, command: AppendCommand) -> Result<(), HistoryError> {
        let state = self.state_for(&command.terminal_id)?;
        let mut state = state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.manifest.closed_at.is_some() {
            return Err(HistoryError::Corrupt(format!(
                "append after completed close for {}",
                command.terminal_id
            )));
        }
        let last_sequence = state
            .pending
            .last()
            .map(|record| record.sequence)
            .or_else(|| {
                state
                    .manifest
                    .blocks
                    .last()
                    .map(|block| block.last_sequence)
            })
            .unwrap_or(0);
        if command.sequence <= last_sequence {
            return Err(HistoryError::Corrupt(format!(
                "history sequence {} does not follow {last_sequence}",
                command.sequence
            )));
        }
        state.last_activity_at = Instant::now();
        append_active_record(&mut state.active, command.sequence, &command.data)?;
        state.pending_bytes = state.pending_bytes.saturating_add(command.data.len());
        state.pending.push(HistoryRecord {
            sequence: command.sequence,
            data: command.data,
        });
        state.manifest.updated_at = now_millis();
        if state.pending_bytes >= self.block_bytes {
            flush_state(&mut state)?;
            enforce_terminal_quota(&mut state)?;
        }
        Ok(())
    }

    fn written_sequence(&self, terminal_id: &str) -> u64 {
        let state = self.states().get(terminal_id).cloned();
        state.map_or(0, |state| {
            let state = state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state
                .pending
                .last()
                .map(|record| record.sequence)
                .or_else(|| {
                    state
                        .manifest
                        .blocks
                        .last()
                        .map(|block| block.last_sequence)
                })
                .unwrap_or(0)
        })
    }

    fn states(&self) -> MutexGuard<'_, HashMap<String, Arc<Mutex<ArchiveState>>>> {
        self.states
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn pending_closes(&self) -> MutexGuard<'_, HashSet<String>> {
        self.pending_closes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn state_for(&self, terminal_id: &str) -> Result<Arc<Mutex<ArchiveState>>, HistoryError> {
        if let Some(state) = self.states().get(terminal_id).cloned() {
            return Ok(state);
        }
        // Build cold state without holding the global index lock. A concurrent
        // creator wins insertion; the losing candidate is simply dropped.
        let dir = self.terminal_dir(terminal_id);
        fs::create_dir_all(&dir)?;
        let manifest = match read_manifest(&dir)? {
            Some(manifest) if manifest.version == ARCHIVE_VERSION => manifest,
            Some(manifest) => {
                return Err(HistoryError::Corrupt(format!(
                    "unsupported history version {} for {terminal_id}",
                    manifest.version
                )));
            }
            None => {
                let manifest = new_manifest(terminal_id);
                write_manifest_value(&dir, &manifest)?;
                manifest
            }
        };
        if manifest.terminal_id != terminal_id {
            return Err(HistoryError::Corrupt(terminal_id.to_owned()));
        }
        let block_sequence = manifest
            .blocks
            .last()
            .map_or(0, |block| block.last_sequence);
        let (active, pending) = open_active_segment(&dir, block_sequence)?;
        let pending_bytes = pending.iter().map(|record| record.data.len()).sum();
        let now = Instant::now();
        let candidate = Arc::new(Mutex::new(ArchiveState {
            dir,
            manifest,
            active,
            pending,
            pending_bytes,
            encoded_staging: Vec::new(),
            compressed_staging: Vec::new(),
            last_activity_at: now,
            last_capacity_change_at: now,
            idle_trims: 0,
            idle_bytes_reclaimed: 0,
            idle_regrows: 0,
            trimmed_since_growth: false,
        }));
        let state = self
            .states()
            .entry(terminal_id.to_owned())
            .or_insert_with(|| Arc::clone(&candidate))
            .clone();
        let last_sequence = {
            let state = state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state
                .pending
                .last()
                .map(|record| record.sequence)
                .or_else(|| {
                    state
                        .manifest
                        .blocks
                        .last()
                        .map(|block| block.last_sequence)
                })
                .unwrap_or(0)
        };
        if last_sequence > 0 {
            let mut accepted = self
                .accepted_sequences
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            accepted
                .entry(terminal_id.to_owned())
                .and_modify(|sequence| *sequence = (*sequence).max(last_sequence))
                .or_insert(last_sequence);
        }
        Ok(state)
    }

    fn finalize_terminal(&self, terminal_id: &str) -> Result<(), HistoryError> {
        let state = self.states().remove(terminal_id);
        if let Some(state) = state {
            let mut state = state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            flush_state(&mut state)?;
            enforce_terminal_quota(&mut state)?;
            if state.manifest.closed_at.is_none() {
                state.manifest.closed_at = Some(now_millis());
                write_manifest(&state)?;
            }
            return Ok(());
        }
        let dir = self.terminal_dir(terminal_id);
        if let Some(mut manifest) = read_manifest(&dir)?
            && manifest.closed_at.is_none()
        {
            manifest.closed_at = Some(now_millis());
            write_manifest_value(&dir, &manifest)?;
        }
        Ok(())
    }

    fn flush_live(&self) -> Result<(), HistoryError> {
        let states = self.states().values().cloned().collect::<Vec<_>>();
        for state in states {
            let mut state = state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            flush_state(&mut state)?;
            enforce_terminal_quota(&mut state)?;
        }
        self.enforce_total_quota()
    }

    fn terminal_dir(&self, terminal_id: &str) -> PathBuf {
        self.root
            .join(URL_SAFE_NO_PAD.encode(terminal_id.as_bytes()))
    }

    fn cleanup_expired(&self) -> Result<(), HistoryError> {
        let now = now_millis();
        for item in fs::read_dir(&self.root)? {
            let item = item?;
            if !item.file_type()?.is_dir() {
                continue;
            }
            let dir = item.path();
            let manifest = match read_manifest(&dir) {
                Ok(Some(manifest)) if manifest.version == ARCHIVE_VERSION => manifest,
                Ok(Some(_)) | Err(_) => {
                    quarantine_archive(&dir, now)?;
                    continue;
                }
                Ok(None) => {
                    fs::remove_dir_all(dir)?;
                    continue;
                }
            };
            let mut manifest = manifest;
            match manifest.closed_at {
                None => {
                    manifest.closed_at = Some(now);
                    write_manifest_value(&dir, &manifest)?;
                }
                Some(closed)
                    if now.saturating_sub(closed) > CLOSED_RETENTION.as_millis() as u64 =>
                {
                    fs::remove_dir_all(dir)?;
                }
                Some(_) => {}
            }
        }
        self.enforce_total_quota()
    }

    fn enforce_total_quota(&self) -> Result<(), HistoryError> {
        let mut archives = Vec::new();
        let mut total = 0_u64;
        for item in fs::read_dir(&self.root)? {
            let item = item?;
            if !item.file_type()?.is_dir() {
                continue;
            }
            let dir = item.path();
            let Some(manifest) = read_manifest(&dir)? else {
                continue;
            };
            let bytes = manifest
                .blocks
                .iter()
                .map(|block| block.stored_bytes)
                .sum::<u64>();
            total = total.saturating_add(bytes);
            archives.push((manifest.updated_at, bytes, dir));
        }
        archives.sort_by_key(|(updated, _, _)| *updated);
        let active = self
            .states()
            .values()
            .cloned()
            .collect::<Vec<_>>()
            .into_iter()
            .map(|state| {
                state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .dir
                    .clone()
            })
            .collect::<HashSet<_>>();
        for (_, bytes, dir) in archives {
            if total <= MAX_TOTAL_BYTES {
                break;
            }
            if !active.contains(&dir) {
                fs::remove_dir_all(dir)?;
                total = total.saturating_sub(bytes);
            }
        }
        Ok(())
    }

    fn record_error(&self, error: &HistoryError) {
        eprintln!("{error}");
        self.background_errors
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(error.to_string());
    }

    fn take_errors(&self) -> Result<(), String> {
        let mut errors = self
            .background_errors
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if errors.is_empty() {
            Ok(())
        } else {
            Err(std::mem::take(&mut *errors).join("; "))
        }
    }
}

fn run_history_owner(
    shared: &HistoryShared,
    ingest: mpsc::Receiver<IngestCommand>,
    finalize: mpsc::Receiver<FinalizeCommand>,
) {
    let mut closes = Vec::<(String, u64)>::new();
    let mut next_maintenance = Instant::now() + HISTORY_MAINTENANCE_INTERVAL;
    loop {
        while let Ok(FinalizeCommand::Close {
            terminal_id,
            through_sequence,
        }) = finalize.try_recv()
        {
            closes.push((terminal_id, through_sequence));
        }
        finalize_ready(shared, &mut closes);

        let command = match ingest.recv_timeout(Duration::from_millis(5)) {
            Ok(command) => command,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let now = Instant::now();
                if now >= next_maintenance {
                    shared.maintain_idle_staging(now);
                    next_maintenance = now + HISTORY_MAINTENANCE_INTERVAL;
                }
                continue;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        match command {
            IngestCommand::Append(command) => {
                let bytes = command.data.len();
                if let Err(error) = shared.append_owned(command) {
                    shared.record_error(&error);
                }
                shared.release_ingest_bytes(bytes);
            }
            IngestCommand::Snapshot(sender) => {
                let _ = sender.send(shared.take_errors());
            }
            IngestCommand::Barrier(sender) => {
                while let Ok(FinalizeCommand::Close {
                    terminal_id,
                    through_sequence,
                }) = finalize.try_recv()
                {
                    closes.push((terminal_id, through_sequence));
                }
                finalize_ready(shared, &mut closes);
                if let Err(error) = shared.flush_live() {
                    shared.record_error(&error);
                }
                if let Err(error) = shared.enforce_total_quota() {
                    shared.record_error(&error);
                }
                let _ = sender.send(shared.take_errors());
            }
            IngestCommand::Shutdown(sender) => {
                while let Ok(FinalizeCommand::Close {
                    terminal_id,
                    through_sequence,
                }) = finalize.try_recv()
                {
                    closes.push((terminal_id, through_sequence));
                }
                finalize_ready(shared, &mut closes);
                if let Err(error) = shared.flush_live() {
                    shared.record_error(&error);
                }
                if let Err(error) = shared.enforce_total_quota() {
                    shared.record_error(&error);
                }
                let _ = sender.send(shared.take_errors());
                break;
            }
        }
    }
}

fn finalize_ready(shared: &HistoryShared, closes: &mut Vec<(String, u64)>) {
    let mut waiting = Vec::new();
    for (terminal_id, through_sequence) in closes.drain(..) {
        if shared.written_sequence(&terminal_id) < through_sequence {
            waiting.push((terminal_id, through_sequence));
            continue;
        }
        if let Err(error) = shared.finalize_terminal(&terminal_id) {
            shared.record_error(&error);
        }
        shared.pending_closes().remove(&terminal_id);
    }
    *closes = waiting;
}

fn flush_state(state: &mut ArchiveState) -> Result<(), HistoryError> {
    if state.pending.is_empty() {
        return Ok(());
    }
    let staging_before = state.staging_allocated_bytes();
    let records = state.pending.clone();
    let uncompressed_bytes = state.pending_bytes as u64;
    let first_sequence = records.first().map_or(0, |record| record.sequence);
    let last_sequence = records
        .last()
        .map_or(first_sequence, |record| record.sequence);
    let file = format!("{first_sequence:012}-{last_sequence:012}.bin.gz");
    encode_records_into(&records, &mut state.encoded_staging)?;
    state.compressed_staging.clear();
    let compressed_buffer = std::mem::take(&mut state.compressed_staging);
    let mut encoder = GzEncoder::new(compressed_buffer, Compression::new(6));
    encoder.write_all(&state.encoded_staging)?;
    let compressed = encoder.finish()?;
    let stored_bytes = compressed.len() as u64;
    let temporary = state.dir.join(format!("{file}.tmp"));
    fs::write(&temporary, &compressed)?;
    fs::rename(temporary, state.dir.join(&file))?;
    state.compressed_staging = compressed;
    state.manifest.blocks.push(ArchiveBlock {
        file,
        first_sequence,
        last_sequence,
        uncompressed_bytes,
        stored_bytes,
    });
    state.manifest.updated_at = now_millis();
    if let Err(error) = write_manifest(state) {
        state.manifest.blocks.pop();
        return Err(error);
    }
    state.pending.clear();
    state.pending_bytes = 0;
    reset_active_segment(&mut state.active)?;
    state.encoded_staging.clear();
    state.compressed_staging.clear();
    state.record_staging_growth(staging_before, Instant::now());
    Ok(())
}

fn enforce_terminal_quota(state: &mut ArchiveState) -> Result<(), HistoryError> {
    let mut bytes = state
        .manifest
        .blocks
        .iter()
        .map(|block| block.stored_bytes)
        .sum::<u64>();
    while bytes > MAX_TERMINAL_BYTES && state.manifest.blocks.len() > 1 {
        let block = state.manifest.blocks.remove(0);
        bytes = bytes.saturating_sub(block.stored_bytes);
        let path = state.dir.join(block.file);
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    write_manifest(state)
}

fn active_checksum(sequence: u64, data: &[u8]) -> u32 {
    let mut hash = 2_166_136_261_u32;
    for byte in sequence.to_be_bytes().iter().chain(data) {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(16_777_619);
    }
    hash
}

fn append_active_record(file: &mut File, sequence: u64, data: &[u8]) -> Result<(), HistoryError> {
    let length = u32::try_from(data.len())
        .map_err(|_| HistoryError::Corrupt("active history payload overflow".to_owned()))?;
    file.write_all(&sequence.to_be_bytes())?;
    file.write_all(&length.to_be_bytes())?;
    file.write_all(&active_checksum(sequence, data).to_be_bytes())?;
    file.write_all(data)?;
    Ok(())
}

fn reset_active_segment(file: &mut File) -> Result<(), HistoryError> {
    file.set_len(0)?;
    file.write_all(ACTIVE_MAGIC)?;
    file.sync_data()?;
    Ok(())
}

fn open_active_segment(
    dir: &Path,
    block_sequence: u64,
) -> Result<(File, Vec<HistoryRecord>), HistoryError> {
    let path = dir.join(ACTIVE_FILE);
    let mut file = OpenOptions::new()
        .create(true)
        .read(true)
        .append(true)
        .open(&path)?;
    if file.metadata()?.len() == 0 {
        file.write_all(ACTIVE_MAGIC)?;
        file.sync_data()?;
        return Ok((file, Vec::new()));
    }
    let encoded = fs::read(&path)?;
    if encoded.len() < ACTIVE_MAGIC.len() || &encoded[..ACTIVE_MAGIC.len()] != ACTIVE_MAGIC {
        return Err(HistoryError::Corrupt(
            "invalid active history header".to_owned(),
        ));
    }
    let mut cursor = ACTIVE_MAGIC.len();
    let mut valid_end = cursor;
    let mut previous = 0_u64;
    let mut pending = Vec::new();
    while cursor < encoded.len() {
        let header_end = cursor.saturating_add(ACTIVE_RECORD_HEADER_BYTES);
        if header_end > encoded.len() {
            break;
        }
        let sequence =
            u64::from_be_bytes(encoded[cursor..cursor + 8].try_into().map_err(|_| {
                HistoryError::Corrupt("truncated active history sequence".to_owned())
            })?);
        let length = u32::from_be_bytes(
            encoded[cursor + 8..cursor + 12]
                .try_into()
                .map_err(|_| HistoryError::Corrupt("truncated active history length".to_owned()))?,
        ) as usize;
        let checksum =
            u32::from_be_bytes(encoded[cursor + 12..header_end].try_into().map_err(|_| {
                HistoryError::Corrupt("truncated active history checksum".to_owned())
            })?);
        let payload_end = header_end.saturating_add(length);
        if sequence == 0
            || sequence <= previous
            || length == 0
            || length > MAX_RECORD_BYTES
            || payload_end > encoded.len()
            || active_checksum(sequence, &encoded[header_end..payload_end]) != checksum
        {
            break;
        }
        if sequence > block_sequence {
            pending.push(HistoryRecord {
                sequence,
                data: Bytes::copy_from_slice(&encoded[header_end..payload_end]),
            });
        }
        previous = sequence;
        cursor = payload_end;
        valid_end = cursor;
    }
    if valid_end != encoded.len() {
        file.set_len(valid_end as u64)?;
        file.sync_data()?;
    }
    Ok((file, pending))
}

#[cfg(test)]
fn encode_records(records: &[HistoryRecord]) -> Result<Vec<u8>, HistoryError> {
    let mut encoded = Vec::new();
    encode_records_into(records, &mut encoded)?;
    Ok(encoded)
}

fn encode_records_into(
    records: &[HistoryRecord],
    encoded: &mut Vec<u8>,
) -> Result<(), HistoryError> {
    if records.is_empty() || records.len() > MAX_BLOCK_RECORDS {
        return Err(HistoryError::Corrupt(
            "invalid history block record count".to_owned(),
        ));
    }
    let count = u32::try_from(records.len())
        .map_err(|_| HistoryError::Corrupt("history block record count overflow".to_owned()))?;
    let capacity = BLOCK_HEADER_BYTES.saturating_add(
        records
            .iter()
            .map(|record| RECORD_HEADER_BYTES.saturating_add(record.data.len()))
            .sum::<usize>(),
    );
    encoded.clear();
    encoded.reserve(capacity);
    encoded.extend_from_slice(BLOCK_MAGIC);
    encoded.push(ARCHIVE_VERSION);
    encoded.extend_from_slice(&[0_u8; 3]);
    encoded.extend_from_slice(&count.to_be_bytes());
    let mut previous = 0_u64;
    for record in records {
        if record.sequence == 0 || record.sequence <= previous {
            return Err(HistoryError::Corrupt(
                "non-increasing history sequence".to_owned(),
            ));
        }
        if record.data.is_empty() || record.data.len() > MAX_RECORD_BYTES {
            return Err(HistoryError::Corrupt(
                "invalid history payload length".to_owned(),
            ));
        }
        let length = u32::try_from(record.data.len())
            .map_err(|_| HistoryError::Corrupt("history payload length overflow".to_owned()))?;
        encoded.extend_from_slice(&record.sequence.to_be_bytes());
        encoded.extend_from_slice(&length.to_be_bytes());
        encoded.extend_from_slice(&record.data);
        previous = record.sequence;
    }
    Ok(())
}

fn decode_records(encoded: &[u8]) -> Result<Vec<HistoryRecord>, HistoryError> {
    if encoded.len() < BLOCK_HEADER_BYTES || &encoded[..8] != BLOCK_MAGIC {
        return Err(HistoryError::Corrupt(
            "invalid history block header".to_owned(),
        ));
    }
    if encoded[8] != ARCHIVE_VERSION || encoded[9..12] != [0_u8; 3] {
        return Err(HistoryError::Corrupt(
            "unsupported history block version".to_owned(),
        ));
    }
    let count = u32::from_be_bytes(
        encoded[12..16]
            .try_into()
            .map_err(|_| HistoryError::Corrupt("truncated history count".to_owned()))?,
    ) as usize;
    if count == 0 || count > MAX_BLOCK_RECORDS {
        return Err(HistoryError::Corrupt(
            "invalid history block record count".to_owned(),
        ));
    }
    let mut cursor = BLOCK_HEADER_BYTES;
    let mut previous = 0_u64;
    let mut records = Vec::with_capacity(count);
    for _ in 0..count {
        let header_end = cursor.saturating_add(RECORD_HEADER_BYTES);
        if header_end > encoded.len() {
            return Err(HistoryError::Corrupt(
                "truncated history record header".to_owned(),
            ));
        }
        let sequence = u64::from_be_bytes(
            encoded[cursor..cursor + 8]
                .try_into()
                .map_err(|_| HistoryError::Corrupt("truncated history sequence".to_owned()))?,
        );
        let length = u32::from_be_bytes(
            encoded[cursor + 8..header_end]
                .try_into()
                .map_err(|_| HistoryError::Corrupt("truncated history length".to_owned()))?,
        ) as usize;
        if sequence == 0 || sequence <= previous || length == 0 || length > MAX_RECORD_BYTES {
            return Err(HistoryError::Corrupt("invalid history record".to_owned()));
        }
        cursor = header_end;
        let payload_end = cursor.saturating_add(length);
        if payload_end > encoded.len() {
            return Err(HistoryError::Corrupt(
                "truncated history payload".to_owned(),
            ));
        }
        records.push(HistoryRecord {
            sequence,
            data: Bytes::copy_from_slice(&encoded[cursor..payload_end]),
        });
        cursor = payload_end;
        previous = sequence;
    }
    if cursor != encoded.len() {
        return Err(HistoryError::Corrupt(
            "trailing history block bytes".to_owned(),
        ));
    }
    Ok(records)
}

fn read_block(path: &Path) -> Result<Vec<HistoryRecord>, HistoryError> {
    let mut decoder = GzDecoder::new(File::open(path)?);
    let mut encoded = Vec::new();
    decoder.read_to_end(&mut encoded)?;
    decode_records(&encoded)
}

fn new_manifest(terminal_id: &str) -> ArchiveManifest {
    ArchiveManifest {
        version: ARCHIVE_VERSION,
        terminal_id: terminal_id.to_owned(),
        created_at: now_millis(),
        updated_at: now_millis(),
        closed_at: None,
        blocks: Vec::new(),
    }
}

fn quarantine_archive(dir: &Path, now: u64) -> Result<(), HistoryError> {
    let Some(root) = dir.parent() else {
        return Err(HistoryError::Corrupt(
            "history archive has no parent directory".to_owned(),
        ));
    };
    let quarantine = root.with_extension("corrupt");
    fs::create_dir_all(&quarantine)?;
    let name = dir
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("archive");
    fs::rename(dir, quarantine.join(format!("{name}-{now}")))?;
    Ok(())
}

fn read_manifest(dir: &Path) -> Result<Option<ArchiveManifest>, HistoryError> {
    let path = dir.join("index.json");
    if !path.is_file() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_slice::<ArchiveManifest>(&fs::read(
        path,
    )?)?))
}

fn write_manifest(state: &ArchiveState) -> Result<(), HistoryError> {
    write_manifest_value(&state.dir, &state.manifest)
}

fn write_manifest_value(dir: &Path, manifest: &ArchiveManifest) -> Result<(), HistoryError> {
    let target = dir.join("index.json");
    let temporary = dir.join("index.json.tmp");
    fs::write(&temporary, serde_json::to_vec(manifest)?)?;
    fs::rename(temporary, target)?;
    Ok(())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let path = std::env::temp_dir().join(format!("yaade-history-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).expect("temp dir");
        path
    }

    #[test]
    fn durable_history_is_paged_by_sequence() {
        let root = temp_dir();
        let archive = TerminalHistoryArchive::with_limits(&root, 4, 5).expect("archive");
        archive
            .append("term-1", 1, Bytes::from_static(b"one"))
            .expect("append");
        archive
            .append("term-1", 2, Bytes::from_static(b"two"))
            .expect("append");
        archive
            .append("term-1", 3, Bytes::from_static(b"three"))
            .expect("append");
        let first = archive
            .read_page("term-1", 0, None)
            .expect("read")
            .expect("page");
        assert_eq!(first.chunks, vec![Base64Bytes(Bytes::from_static(b"one"))]);
        assert!(!first.complete);
        let second = archive
            .read_page("term-1", first.next_sequence, None)
            .expect("read")
            .expect("page");
        assert_eq!(second.chunks, vec![Base64Bytes(Bytes::from_static(b"two"))]);
        drop(archive);

        let reopened = TerminalHistoryArchive::with_limits(&root, 4, 5).expect("reopen");
        let final_page = reopened
            .read_page("term-1", second.next_sequence, None)
            .expect("read")
            .expect("page");
        assert_eq!(
            final_page.chunks,
            vec![Base64Bytes(Bytes::from_static(b"three"))]
        );
        assert!(final_page.complete);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn idle_reclaim_trims_history_staging_and_resume_regrows_once() {
        let root = temp_dir();
        let archive =
            TerminalHistoryArchive::with_limits(&root, 256 * 1024, 1024 * 1024).expect("archive");
        let state = archive.shared.state_for("term-idle").expect("state");
        let now = Instant::now();
        {
            let mut state = state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.encoded_staging = Vec::with_capacity(2 * 1024 * 1024);
            state.compressed_staging = Vec::with_capacity(2 * 1024 * 1024);
            state.last_activity_at = now - Duration::from_secs(120);
            state.last_capacity_change_at = now - Duration::from_secs(120);
            assert!(state.trim_idle_staging(now));
            assert_eq!(state.staging_used_bytes(), 0);
            assert_eq!(
                state.staging_allocated_bytes(),
                HISTORY_STAGING_MIN_BYTES * 2
            );
        }
        let trimmed = archive.capacity_diagnostics();
        assert_eq!(trimmed.memory_class, "transient-staging");
        assert_eq!(trimmed.durable_pending_bytes, 0);
        assert_eq!(trimmed.idle_trims, 1);
        assert!(trimmed.idle_bytes_reclaimed >= 3 * 1024 * 1024);

        for sequence in 1..=4 {
            archive
                .append(
                    "term-idle",
                    sequence,
                    Bytes::from(vec![sequence as u8; 64 * 1024]),
                )
                .expect("append after trim");
        }
        archive.flush_all().expect("flush after trim");
        let resumed = archive.capacity_diagnostics();
        assert_eq!(resumed.idle_regrows, 1);
        let page = archive
            .read_page("term-idle", 0, None)
            .expect("read after trim")
            .expect("history page");
        assert_eq!(page.chunks.len(), 4);
        assert_eq!(page.chunks[0].0[0], 1);
        assert_eq!(page.chunks[3].0[0], 4);

        let state = state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(!state.trimmed_since_growth);
        assert_eq!(state.staging_used_bytes(), 0);
        drop(state);
        drop(archive);
        fs::remove_dir_all(root).expect("remove temp dir");
    }

    #[test]
    fn reverse_pages_start_at_the_newest_records_and_keep_each_page_chronological() {
        let root = temp_dir();
        let archive = TerminalHistoryArchive::with_limits(&root, 4, 6).expect("archive");
        archive
            .append("term-reverse", 1, Bytes::from_static(b"one"))
            .expect("append");
        archive
            .append("term-reverse", 2, Bytes::from_static(b"two"))
            .expect("append");
        archive
            .append("term-reverse", 3, Bytes::from_static(b"three"))
            .expect("append");

        let newest = archive
            .read_page_reverse("term-reverse", 0, None)
            .expect("read newest")
            .expect("newest page");
        assert_eq!(
            newest.chunks,
            vec![Base64Bytes(Bytes::from_static(b"three"))]
        );
        assert_eq!(newest.first_sequence, 3);
        assert!(!newest.complete);

        let older = archive
            .read_page_reverse("term-reverse", newest.next_sequence, None)
            .expect("read older")
            .expect("older page");
        assert_eq!(
            older.chunks,
            vec![
                Base64Bytes(Bytes::from_static(b"one")),
                Base64Bytes(Bytes::from_static(b"two")),
            ]
        );
        assert_eq!(older.first_sequence, 1);
        assert_eq!(older.last_sequence, 2);
        assert!(older.complete);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn close_is_enqueued_and_barrier_drains_it() {
        let root = temp_dir();
        let archive = TerminalHistoryArchive::with_limits(&root, 1024, 1024).expect("archive");
        archive
            .append("term-1", 1, Bytes::from_static(b"pending"))
            .expect("append");
        archive.close_terminal("term-1").expect("enqueue close");
        assert!(
            archive
                .append("term-1", 2, Bytes::from_static(b"late"))
                .is_err()
        );
        archive.flush_all().expect("drain");
        let manifest = read_manifest(&archive.shared.terminal_dir("term-1"))
            .expect("manifest")
            .expect("closed manifest");
        assert!(manifest.closed_at.is_some());
        archive.close_terminal("term-1").expect("idempotent close");
        archive.flush_all().expect("second drain");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn active_segment_recovers_complete_records_and_truncates_a_torn_tail() {
        let root = temp_dir();
        let dir = root.join(URL_SAFE_NO_PAD.encode(b"term-crash"));
        fs::create_dir_all(&dir).expect("terminal dir");
        write_manifest_value(&dir, &new_manifest("term-crash")).expect("manifest");
        let (mut active, pending) = open_active_segment(&dir, 0).expect("active segment");
        assert!(pending.is_empty());
        append_active_record(&mut active, 1, b"one").expect("first record");
        append_active_record(&mut active, 2, &[0xff, 0x80]).expect("second record");
        active
            .write_all(&3_u64.to_be_bytes())
            .expect("torn sequence");
        active.write_all(&4_u32.to_be_bytes()).expect("torn length");
        active.sync_data().expect("sync torn tail");
        drop(active);

        let archive = TerminalHistoryArchive::open(&root).expect("reopen");
        let page = archive
            .read_page("term-crash", 0, None)
            .expect("read")
            .expect("page");
        assert_eq!(
            page.chunks,
            vec![
                Base64Bytes(Bytes::from_static(b"one")),
                Base64Bytes(Bytes::from_static(&[0xff, 0x80])),
            ]
        );
        assert_eq!(
            fs::metadata(dir.join(ACTIVE_FILE)).expect("metadata").len(),
            45
        );
        drop(archive);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn binary_codec_preserves_invalid_bytes_and_rejects_corruption() {
        let records = vec![
            HistoryRecord {
                sequence: 1,
                data: Bytes::from_static(b"ok\xff"),
            },
            HistoryRecord {
                sequence: 2,
                data: Bytes::from_static(b"\xe2"),
            },
        ];
        let encoded = encode_records(&records).expect("encode");
        assert_eq!(
            decode_records(&encoded).expect("decode")[0].data.as_ref(),
            b"ok\xff"
        );
        assert!(decode_records(&encoded[..encoded.len() - 1]).is_err());
        let mut trailing = encoded.clone();
        trailing.push(0);
        assert!(decode_records(&trailing).is_err());
        let duplicate = vec![
            HistoryRecord {
                sequence: 1,
                data: Bytes::from_static(b"a"),
            },
            HistoryRecord {
                sequence: 1,
                data: Bytes::from_static(b"b"),
            },
        ];
        assert!(encode_records(&duplicate).is_err());
    }

    #[test]
    fn corrupt_manifest_is_quarantined_without_preventing_startup() {
        let root = temp_dir();
        let dir = root.join(URL_SAFE_NO_PAD.encode(b"term-corrupt"));
        fs::create_dir_all(&dir).expect("terminal dir");
        fs::write(dir.join("index.json"), b"{not-json").expect("corrupt manifest");

        let archive = TerminalHistoryArchive::open(&root).expect("archive opens");
        assert!(!archive.available("term-corrupt"));
        assert!(!dir.exists());
        let quarantine = root.with_extension("corrupt");
        assert_eq!(fs::read_dir(&quarantine).expect("quarantine").count(), 1);
        drop(archive);
        fs::remove_dir_all(root).expect("cleanup root");
        fs::remove_dir_all(quarantine).expect("cleanup quarantine");
    }

    #[test]
    fn missing_block_is_reported_as_degraded_history() {
        let root = temp_dir();
        let dir = root.join(URL_SAFE_NO_PAD.encode(b"term-missing-block"));
        fs::create_dir_all(&dir).expect("terminal dir");
        let mut manifest = new_manifest("term-missing-block");
        manifest.blocks.push(ArchiveBlock {
            file: "block-1-1.bin.gz".to_owned(),
            first_sequence: 1,
            last_sequence: 1,
            uncompressed_bytes: 3,
            stored_bytes: 3,
        });
        write_manifest_value(&dir, &manifest).expect("manifest");

        let archive = TerminalHistoryArchive::open(&root).expect("archive opens");
        assert!(matches!(
            archive.inspect("term-missing-block"),
            Err(HistoryError::Corrupt(_))
        ));
        drop(archive);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn missing_history_returns_null() {
        let root = temp_dir();
        let archive = TerminalHistoryArchive::with_limits(&root, 4, 5).expect("archive");
        assert!(
            archive
                .read_page("missing", 0, None)
                .expect("read")
                .is_none()
        );
        fs::remove_dir_all(root).expect("cleanup");
    }
}
