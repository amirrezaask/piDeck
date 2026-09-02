use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex, Weak},
};

use serde_json::Value;
use tokio::sync::broadcast;

use crate::wire::{HostEvent, ServerIdentity, TerminalChunk, TerminalFrame};

const DEFAULT_EVENT_CAPACITY: usize = 1024;
const DEFAULT_EVENT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug)]
struct RetainedEvent {
    event: Arc<HostEvent>,
    bytes: usize,
}

#[derive(Debug)]
struct EventState {
    sequence: u64,
    history: VecDeque<RetainedEvent>,
    history_bytes: usize,
    history_dropped_through: u64,
}

pub trait TerminalSubscriber: Send + Sync {
    fn enqueue_terminal(&self, frame: Arc<TerminalFrame>);
}

#[derive(Clone, Debug)]
pub enum HubMessage {
    Event(Arc<HostEvent>),
    Terminal(Arc<TerminalFrame>),
}

/// Result of taking a reconnect replay snapshot.
#[derive(Clone, Debug)]
pub struct ReplayWindow {
    pub events: Vec<Arc<HostEvent>>,
    pub replay_floor: u64,
    pub last_sequence: u64,
    pub history_evicted: bool,
}

/// Sequenced fan-out plus a bounded replay ring for low-rate host events.
///
/// The hub retains each event in one `Arc`; WebSocket clients clone the pointer
/// instead of cloning event payload strings. PTY paint and semantic frames skip
/// this history because terminals own their replay state.
type TerminalSubscribers = HashMap<String, HashMap<String, Weak<dyn TerminalSubscriber>>>;

pub struct EventHub {
    identity: ServerIdentity,
    capacity: usize,
    max_history_bytes: usize,
    state: Mutex<EventState>,
    sender: broadcast::Sender<Arc<HubMessage>>,
    terminal_subscribers: Mutex<TerminalSubscribers>,
}

impl EventHub {
    #[must_use]
    pub fn new(identity: ServerIdentity) -> Self {
        Self::with_limits(identity, DEFAULT_EVENT_CAPACITY, DEFAULT_EVENT_BYTES)
    }

    #[must_use]
    pub fn with_limits(
        identity: ServerIdentity,
        capacity: usize,
        max_history_bytes: usize,
    ) -> Self {
        let (sender, _) = broadcast::channel(capacity.max(1));
        Self {
            identity,
            capacity,
            max_history_bytes,
            state: Mutex::new(EventState {
                sequence: 0,
                history: VecDeque::with_capacity(capacity.min(DEFAULT_EVENT_CAPACITY)),
                history_bytes: 0,
                history_dropped_through: 0,
            }),
            sender,
            terminal_subscribers: Mutex::new(HashMap::new()),
        }
    }

    pub fn emit(
        &self,
        channel: impl Into<Arc<str>>,
        args: impl Into<Arc<[Value]>>,
    ) -> Arc<HostEvent> {
        let channel = channel.into();
        let args = args.into();
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.sequence = state.sequence.saturating_add(1);
        let event = Arc::new(HostEvent::modern(
            &self.identity,
            state.sequence,
            Arc::clone(&channel),
            args,
        ));
        if !is_ephemeral(&channel) {
            let bytes = estimate_event_bytes(&event);
            state.history.push_back(RetainedEvent {
                event: Arc::clone(&event),
                bytes,
            });
            state.history_bytes = state.history_bytes.saturating_add(bytes);
            while !state.history.is_empty()
                && (state.history.len() > self.capacity
                    || state.history_bytes > self.max_history_bytes)
            {
                if let Some(dropped) = state.history.pop_front() {
                    state.history_bytes = state.history_bytes.saturating_sub(dropped.bytes);
                    state.history_dropped_through =
                        state.history_dropped_through.max(dropped.event.sequence);
                }
            }
        }
        // Send while the sequence lock is held. Concurrent producers cannot
        // publish sequence N+1 before sequence N.
        let _ = self
            .sender
            .send(Arc::new(HubMessage::Event(Arc::clone(&event))));
        event
    }

    pub fn emit_terminal(
        &self,
        terminal_id: impl Into<Arc<str>>,
        sequence: u64,
        data: bytes::Bytes,
    ) -> Arc<TerminalFrame> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.sequence = state.sequence.saturating_add(1);
        let frame = Arc::new(TerminalFrame {
            event_sequence: state.sequence,
            terminal_id: terminal_id.into(),
            chunk: TerminalChunk { sequence, data },
        });
        // Allocate and dispatch under the same sequence lock used by metadata.
        // Subscriber enqueue is nonblocking, so socket IO cannot enter this path.
        let mut subscribers = self
            .terminal_subscribers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(attached) = subscribers.get_mut(frame.terminal_id.as_ref()) {
            attached.retain(|_, subscriber| {
                let Some(subscriber) = subscriber.upgrade() else {
                    return false;
                };
                subscriber.enqueue_terminal(Arc::clone(&frame));
                true
            });
        }
        frame
    }

    pub fn attach_terminal(
        &self,
        terminal_id: &str,
        connection_id: &str,
        subscriber: &Arc<dyn TerminalSubscriber>,
    ) {
        self.terminal_subscribers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .entry(terminal_id.to_owned())
            .or_default()
            .insert(connection_id.to_owned(), Arc::downgrade(subscriber));
    }

    pub fn detach_terminal(&self, terminal_id: &str, connection_id: &str) {
        let mut subscribers = self
            .terminal_subscribers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(attached) = subscribers.get_mut(terminal_id) {
            attached.remove(connection_id);
            if attached.is_empty() {
                subscribers.remove(terminal_id);
            }
        }
    }

    pub fn detach_connection(&self, connection_id: &str) {
        let mut subscribers = self
            .terminal_subscribers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        subscribers.retain(|_, attached| {
            attached.remove(connection_id);
            !attached.is_empty()
        });
    }

    #[must_use]
    pub fn terminal_subscriber_count(&self, terminal_id: &str) -> usize {
        self.terminal_subscribers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(terminal_id)
            .map_or(0, HashMap::len)
    }

    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<HubMessage>> {
        self.sender.subscribe()
    }

    #[must_use]
    pub fn replay_window(&self, since: u64) -> ReplayWindow {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let events = state
            .history
            .iter()
            .filter(|retained| retained.event.sequence > since)
            .map(|retained| Arc::clone(&retained.event))
            .collect();
        let oldest = state
            .history
            .front()
            .map(|retained| retained.event.sequence);
        let replay_floor = oldest.unwrap_or_else(|| state.sequence.saturating_add(1));
        let history_evicted = since > 0
            && oldest.map_or(state.history_dropped_through > since, |oldest| {
                since < oldest.saturating_sub(1)
            });
        ReplayWindow {
            events,
            replay_floor,
            last_sequence: state.sequence,
            history_evicted,
        }
    }

    #[must_use]
    pub fn subscriber_count(&self) -> usize {
        self.sender.receiver_count()
    }

    #[must_use]
    pub fn last_sequence(&self) -> u64 {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .sequence
    }
}

fn is_ephemeral(channel: &str) -> bool {
    channel == "terminal:semantic" || channel == "security:device-revoked"
}

fn estimate_event_bytes(event: &HostEvent) -> usize {
    let mut bytes = 64 + event.channel.len();
    for argument in event.args.iter() {
        bytes = bytes.saturating_add(match argument {
            Value::String(value) => value.len(),
            value => serde_json::to_vec(value).map_or(64, |encoded| encoded.len()),
        });
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> ServerIdentity {
        ServerIdentity {
            server_id: "server-1".to_owned(),
            server_epoch: "epoch-1".to_owned(),
            protocol_version: 2,
            runtime_version: "0.0.1".to_owned(),
            started_at: "2026-01-02T03:04:05.000Z".to_owned(),
        }
    }

    #[test]
    fn retains_non_terminal_events_with_monotonic_sequences() {
        let hub = EventHub::with_limits(identity(), 4, 4096);
        let first = hub.emit("mux:event", vec![serde_json::json!(1)]);
        let second = hub.emit("server:shuttingDown", Vec::<Value>::new());

        let replay = hub.replay_window(0);
        assert_eq!(first.sequence, 1);
        assert_eq!(second.sequence, 2);
        assert_eq!(replay.events.len(), 2);
        assert_eq!(replay.last_sequence, 2);
        assert!(!replay.history_evicted);
    }

    #[test]
    fn terminal_bytes_are_live_only_and_globally_ordered() {
        let hub = EventHub::with_limits(identity(), 4, 4096);
        let frame = hub.emit_terminal("term-1", 1, bytes::Bytes::from_static(b"paint\xff"));
        hub.emit("mux:event", vec![serde_json::json!("retained")]);

        let replay = hub.replay_window(0);
        assert_eq!(frame.event_sequence, 1);
        assert_eq!(frame.chunk.data.as_ref(), b"paint\xff");
        assert_eq!(replay.events.len(), 1);
        assert_eq!(replay.events[0].channel.as_ref(), "mux:event");
        assert_eq!(replay.events[0].sequence, 2);
    }

    #[test]
    fn terminal_frames_only_visit_attached_subscribers() {
        #[derive(Default)]
        struct Subscriber(Mutex<Vec<Arc<TerminalFrame>>>);
        impl TerminalSubscriber for Subscriber {
            fn enqueue_terminal(&self, frame: Arc<TerminalFrame>) {
                self.0.lock().expect("frames").push(frame);
            }
        }

        let hub = EventHub::with_limits(identity(), 4, 4096);
        let attached_impl = Arc::new(Subscriber::default());
        let attached: Arc<dyn TerminalSubscriber> = attached_impl.clone();
        let unrelated: Arc<dyn TerminalSubscriber> = Arc::new(Subscriber::default());
        hub.attach_terminal("term-1", "connection-1", &attached);
        hub.attach_terminal("term-2", "connection-2", &unrelated);
        hub.emit_terminal("term-1", 1, bytes::Bytes::from_static(b"only attached"));

        assert_eq!(hub.terminal_subscriber_count("term-1"), 1);
        assert_eq!(attached_impl.0.lock().expect("frames").len(), 1);
        hub.detach_connection("connection-1");
        assert_eq!(hub.terminal_subscriber_count("term-1"), 0);
    }

    #[test]
    fn drops_a_single_event_that_exceeds_the_byte_budget() {
        let hub = EventHub::with_limits(identity(), 4, 32);
        hub.emit("mux:event", vec![serde_json::json!("x".repeat(256))]);
        let replay = hub.replay_window(0);
        assert!(replay.events.is_empty());
        assert_eq!(replay.last_sequence, 1);
    }

    #[test]
    fn preserves_sequence_order_after_repeated_compaction() {
        let hub = EventHub::with_limits(identity(), 8, 4096);
        for value in 1..=10_000 {
            hub.emit("mux:event", vec![serde_json::json!(value)]);
        }
        let replay = hub.replay_window(9_992);
        assert_eq!(replay.events.len(), 8);
        assert!(
            replay
                .events
                .windows(2)
                .all(|pair| pair[0].sequence < pair[1].sequence)
        );
    }

    #[test]
    fn reports_replay_gap_after_count_eviction() {
        let hub = EventHub::with_limits(identity(), 2, 4096);
        for value in 1..=4 {
            hub.emit("mux:event", vec![serde_json::json!(value)]);
        }

        let replay = hub.replay_window(1);
        assert_eq!(replay.replay_floor, 3);
        assert_eq!(replay.events.len(), 2);
        assert!(replay.history_evicted);
    }

    #[test]
    fn reports_replay_gap_when_all_history_was_dropped_by_byte_limit() {
        let hub = EventHub::with_limits(identity(), 8, 1);
        hub.emit("mux:event", vec![serde_json::json!("large-1")]);
        hub.emit("mux:event", vec![serde_json::json!("large-2")]);

        let replay = hub.replay_window(1);
        assert!(replay.events.is_empty());
        assert_eq!(replay.replay_floor, 3);
        assert!(replay.history_evicted);
    }
}
