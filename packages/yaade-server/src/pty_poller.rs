//! Shared Unix PTY readiness owner.
//!
//! One poller thread owns every readable PTY handle. A terminal therefore does
//! not pay for a permanent reader thread while idle. Output is handed to the
//! terminal authority through a bounded, non-blocking mailbox; a saturated
//! authority pauses only that PTY at the kernel boundary and never stalls the
//! poller or another session.

use std::{
    collections::{HashMap, VecDeque},
    io::Read,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    thread,
    time::Duration,
};

use bytes::Bytes;
use crossbeam_channel::{Receiver, Sender, TrySendError, bounded};

/// Output observed from one PTY descriptor.
#[derive(Debug)]
pub(crate) enum PtyOutput {
    Bytes(Bytes),
    Eof,
    ReadFailed(std::io::ErrorKind),
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) struct Registration(u64);

enum Command {
    #[cfg(unix)]
    Register {
        registration: Registration,
        raw_fd: std::os::fd::RawFd,
        reader: Box<dyn Read + Send>,
        output: Sender<PtyOutput>,
        acknowledged: Sender<Result<(), String>>,
    },
    Shutdown,
}

/// Deep module around epoll/kqueue registration, descriptor generations, and
/// bounded output delivery.
pub(crate) struct PtyPoller {
    commands: Sender<Command>,
    next_registration: AtomicU64,
    wake: Arc<polling::Poller>,
    worker: std::sync::Mutex<Option<thread::JoinHandle<()>>>,
}

impl PtyPoller {
    pub(crate) fn new() -> Result<Arc<Self>, String> {
        let wake = Arc::new(polling::Poller::new().map_err(|error| error.to_string())?);
        let (commands, receiver) = bounded(1_024);
        let worker_wake = Arc::clone(&wake);
        let worker = thread::Builder::new()
            .name("yaade-pty-poller".to_owned())
            .stack_size(512 * 1024)
            .spawn(move || run_poller(worker_wake, receiver))
            .map_err(|error| error.to_string())?;
        Ok(Arc::new(Self {
            commands,
            next_registration: AtomicU64::new(1),
            wake,
            worker: std::sync::Mutex::new(Some(worker)),
        }))
    }

    #[cfg(unix)]
    pub(crate) fn register(
        &self,
        raw_fd: std::os::fd::RawFd,
        reader: Box<dyn Read + Send>,
        output: Sender<PtyOutput>,
    ) -> Result<Registration, String> {
        let registration = Registration(self.next_registration.fetch_add(1, Ordering::Relaxed));
        let (acknowledged, result) = bounded(1);
        self.commands
            .send(Command::Register {
                registration,
                raw_fd,
                reader,
                output,
                acknowledged,
            })
            .map_err(|_| "PTY poller stopped".to_owned())?;
        self.wake.notify().map_err(|error| error.to_string())?;
        result
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "PTY poller registration timed out".to_owned())??;
        Ok(registration)
    }

    #[cfg(not(unix))]
    pub(crate) fn register(
        &self,
        _raw_fd: i32,
        mut reader: Box<dyn Read + Send>,
        output: Sender<PtyOutput>,
    ) -> Result<Registration, String> {
        let registration = Registration(self.next_registration.fetch_add(1, Ordering::Relaxed));
        thread::Builder::new()
            .name(format!("yaade-pty-reader-{}", registration.0))
            .stack_size(256 * 1024)
            .spawn(move || {
                let mut buffer = vec![0; 64 * 1024];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => {
                            let _ = output.send(PtyOutput::Eof);
                            break;
                        }
                        Ok(count) => {
                            if output
                                .send(PtyOutput::Bytes(Bytes::copy_from_slice(&buffer[..count])))
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                        Err(error) => {
                            let _ = output.send(PtyOutput::ReadFailed(error.kind()));
                            break;
                        }
                    }
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(registration)
    }
}

impl Drop for PtyPoller {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Shutdown);
        let _ = self.wake.notify();
        if let Some(worker) = self.worker.lock().unwrap_or_else(|p| p.into_inner()).take() {
            let _ = worker.join();
        }
    }
}

#[cfg(unix)]
#[derive(Clone, Copy)]
struct BorrowedSource(std::os::fd::RawFd);

#[cfg(unix)]
impl std::os::fd::AsRawFd for BorrowedSource {
    fn as_raw_fd(&self) -> std::os::fd::RawFd {
        self.0
    }
}

#[cfg(unix)]
impl std::os::fd::AsFd for BorrowedSource {
    fn as_fd(&self) -> std::os::fd::BorrowedFd<'_> {
        // SAFETY: `BorrowedSource` is stored only while the master and reader
        // handles keep this descriptor alive; registration is deleted first.
        unsafe { std::os::fd::BorrowedFd::borrow_raw(self.0) }
    }
}

#[cfg(unix)]
struct Source {
    raw: BorrowedSource,
    reader: Box<dyn Read + Send>,
    output: Sender<PtyOutput>,
}

#[cfg(unix)]
fn run_poller(poller: Arc<polling::Poller>, commands: Receiver<Command>) {
    use polling::{Event, Events, PollMode};

    let mut sources = HashMap::<u64, Source>::new();
    let mut pending = VecDeque::<(Sender<PtyOutput>, PtyOutput)>::new();
    let mut events = Events::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut running = true;
    while running {
        while let Ok(command) = commands.try_recv() {
            match command {
                Command::Register {
                    registration,
                    raw_fd,
                    reader,
                    output,
                    acknowledged,
                } => {
                    let key = registration.0 as usize;
                    let raw = BorrowedSource(raw_fd);
                    // SAFETY: `Source` retains the reader and the terminal owner retains
                    // the master descriptor. We delete the registration before either
                    // poller-owned handle is dropped.
                    let result = unsafe {
                        poller.add_with_mode(&raw, Event::readable(key), PollMode::Level)
                    };
                    match result {
                        Ok(()) => {
                            sources.insert(
                                registration.0,
                                Source {
                                    raw,
                                    reader,
                                    output,
                                },
                            );
                            let _ = acknowledged.send(Ok(()));
                        }
                        Err(error) => {
                            let _ = acknowledged.send(Err(error.to_string()));
                        }
                    }
                }
                Command::Shutdown => {
                    running = false;
                }
            }
        }

        let pending_count = pending.len();
        for _ in 0..pending_count {
            let Some((sender, message)) = pending.pop_front() else {
                break;
            };
            match sender.try_send(message) {
                Ok(()) | Err(TrySendError::Disconnected(_)) => {}
                Err(TrySendError::Full(message)) => pending.push_back((sender, message)),
            }
        }
        if !running {
            break;
        }

        events.clear();
        let timeout = if pending.is_empty() {
            Some(Duration::from_millis(250))
        } else {
            Some(Duration::from_millis(2))
        };
        if poller.wait(&mut events, timeout).is_err() {
            continue;
        }
        for event in events.iter() {
            let key = event.key as u64;
            let Some(source) = sources.get_mut(&key) else {
                continue;
            };
            if pending
                .iter()
                .any(|(sender, _)| sender.same_channel(&source.output))
            {
                continue;
            }
            let outcome = loop {
                match source.reader.read(&mut buffer) {
                    Ok(0) => break Some(PtyOutput::Eof),
                    Ok(count) => {
                        break Some(PtyOutput::Bytes(Bytes::copy_from_slice(&buffer[..count])));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break None,
                    Err(error) => break Some(PtyOutput::ReadFailed(error.kind())),
                }
            };
            let Some(message) = outcome else { continue };
            let terminal = matches!(message, PtyOutput::Eof | PtyOutput::ReadFailed(_));
            let sender = source.output.clone();
            // Delete before publishing EOF. The terminal owner may drop the
            // master immediately after receiving EOF, and the OS may reuse its
            // descriptor number on another thread.
            if terminal {
                if let Some(source) = sources.remove(&key) {
                    let _ = poller.delete(&source.raw);
                }
            }
            match sender.try_send(message) {
                Ok(()) | Err(TrySendError::Disconnected(_)) => {}
                Err(TrySendError::Full(message)) => pending.push_back((sender, message)),
            }
        }
    }
    for (_, source) in sources.drain() {
        let _ = poller.delete(&source.raw);
    }
}

#[cfg(not(unix))]
fn run_poller(poller: Arc<polling::Poller>, commands: Receiver<Command>) {
    while let Ok(command) = commands.recv() {
        if matches!(command, Command::Shutdown) {
            break;
        }
        let _ = poller.notify();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::{io::Write, os::fd::AsRawFd, os::unix::net::UnixStream};

    use super::*;

    #[test]
    fn one_poller_fans_in_many_idle_descriptors_without_reader_threads() {
        let poller = PtyPoller::new().expect("poller");
        let mut peers = Vec::new();
        let mut outputs = Vec::new();
        for index in 0..128_u16 {
            let (reader, mut peer) = UnixStream::pair().expect("pair");
            let raw_fd = reader.as_raw_fd();
            let poll_reader = reader.try_clone().expect("clone");
            let (output, received) = bounded(2);
            poller
                .register(raw_fd, Box::new(poll_reader), output)
                .expect("register");
            peer.write_all(&index.to_be_bytes()).expect("write");
            peers.push((reader, peer));
            outputs.push((index, received));
        }
        for (expected, output) in outputs {
            let PtyOutput::Bytes(bytes) = output
                .recv_timeout(Duration::from_secs(5))
                .expect("readiness output")
            else {
                panic!("unexpected terminal event")
            };
            assert_eq!(bytes.as_ref(), expected.to_be_bytes());
        }
        drop(peers);
    }

    #[test]
    fn descriptor_reuse_cycles_do_not_deliver_stale_bytes() {
        let poller = PtyPoller::new().expect("poller");
        for generation in 0..256_u16 {
            let (reader, mut peer) = UnixStream::pair().expect("pair");
            let raw_fd = reader.as_raw_fd();
            let poll_reader = reader.try_clone().expect("clone");
            let (output, received) = bounded(2);
            poller
                .register(raw_fd, Box::new(poll_reader), output)
                .expect("register");
            peer.write_all(&generation.to_be_bytes()).expect("write");
            let PtyOutput::Bytes(bytes) = received
                .recv_timeout(Duration::from_secs(5))
                .expect("generation")
            else {
                panic!("unexpected terminal event")
            };
            assert_eq!(bytes.as_ref(), generation.to_be_bytes());
            drop(peer);
            assert!(matches!(
                received.recv_timeout(Duration::from_secs(1)),
                Ok(PtyOutput::Eof)
            ));
            drop(reader);
        }
    }
}
