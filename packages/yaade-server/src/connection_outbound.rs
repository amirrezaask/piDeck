use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
};

use serde::Serialize;
use serde_json::json;
use tokio::sync::Notify;

use crate::{
    event_hub::TerminalSubscriber,
    outbound_mailbox::{MailboxLimits, OutboundFrame, OutboundMailbox},
    wire::{TerminalFrame, encode_terminal_data_frame},
};

#[derive(Debug)]
pub enum NextOutbound {
    Frame(OutboundFrame),
    Close { code: u16, reason: &'static str },
}

#[derive(Default)]
struct TerminalFlow {
    acknowledged: u64,
    sent: VecDeque<(u64, usize)>,
    unacknowledged_bytes: usize,
}

impl TerminalFlow {
    fn new(acknowledged: u64) -> Self {
        Self {
            acknowledged,
            ..Self::default()
        }
    }

    fn reserve(&mut self, sequence: u64, bytes: usize, limit: usize) -> bool {
        if sequence <= self.acknowledged {
            return false;
        }
        if self.unacknowledged_bytes.saturating_add(bytes) > limit {
            return false;
        }
        self.sent.push_back((sequence, bytes));
        self.unacknowledged_bytes = self.unacknowledged_bytes.saturating_add(bytes);
        true
    }

    fn acknowledge(&mut self, sequence: u64) {
        if sequence <= self.acknowledged {
            return;
        }
        self.acknowledged = sequence;
        while self.sent.front().is_some_and(|(sent, _)| *sent <= sequence) {
            if let Some((_, bytes)) = self.sent.pop_front() {
                self.unacknowledged_bytes = self.unacknowledged_bytes.saturating_sub(bytes);
            }
        }
    }
}

struct ConnectionOutboundState {
    mailbox: OutboundMailbox,
    flow: HashMap<String, TerminalFlow>,
    replay_required: HashSet<String>,
    attaching: HashSet<String>,
    close: Option<(u16, &'static str)>,
    stopped: bool,
}

/// Deep per-connection outbound module. Producers only perform bounded enqueue;
/// one socket writer owns network IO and drains this mailbox.
pub struct ConnectionOutbound {
    protocol: u8,
    flow_limit: usize,
    state: Mutex<ConnectionOutboundState>,
    notify: Notify,
}

impl ConnectionOutbound {
    #[must_use]
    pub fn new(protocol: u8, flow_limit: usize) -> Arc<Self> {
        Arc::new(Self {
            protocol,
            flow_limit,
            state: Mutex::new(ConnectionOutboundState {
                mailbox: OutboundMailbox::new(MailboxLimits::default()),
                flow: HashMap::new(),
                replay_required: HashSet::new(),
                attaching: HashSet::new(),
                close: None,
                stopped: false,
            }),
            notify: Notify::new(),
        })
    }

    pub fn enqueue_reliable<T: Serialize>(&self, value: &T) -> bool {
        let Ok(data) = serde_json::to_vec(value) else {
            self.close(1011, "outbound serialization failed");
            return false;
        };
        self.enqueue_reliable_frame(OutboundFrame::text(data))
    }

    pub fn enqueue_text(&self, text: &str) -> bool {
        self.enqueue_reliable_frame(OutboundFrame::text(text.as_bytes().to_vec()))
    }

    fn enqueue_reliable_frame(&self, frame: OutboundFrame) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.stopped || state.close.is_some() {
            return false;
        }
        if !state.mailbox.enqueue_reliable(frame).accepted {
            state.close = Some((1013, "reliable outbound mailbox overflow"));
            drop(state);
            self.notify.notify_one();
            return false;
        }
        drop(state);
        self.notify.notify_one();
        true
    }

    pub fn attach(&self, terminal_id: &str, acknowledged: u64) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state
            .flow
            .insert(terminal_id.to_owned(), TerminalFlow::new(acknowledged));
        state.replay_required.remove(terminal_id);
        state.attaching.insert(terminal_id.to_owned());
    }

    pub fn complete_attach(&self, terminal_id: &str, snapshot_sequence: u64) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state
            .mailbox
            .discard_terminal_through(terminal_id, snapshot_sequence);
        if let Some(flow) = state.flow.get_mut(terminal_id) {
            flow.acknowledge(snapshot_sequence);
        }
        state.attaching.remove(terminal_id);
        drop(state);
        self.notify.notify_one();
    }

    pub fn enqueue_attach_result<T: Serialize>(
        &self,
        terminal_id: &str,
        snapshot_sequence: Option<u64>,
        value: &T,
    ) -> bool {
        let Ok(data) = serde_json::to_vec(value) else {
            self.close(1011, "attach result serialization failed");
            return false;
        };
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !state
            .mailbox
            .enqueue_reliable_priority(OutboundFrame::text(data))
            .accepted
        {
            state.close = Some((1013, "attach result mailbox overflow"));
            drop(state);
            self.notify.notify_one();
            return false;
        }
        if let Some(sequence) = snapshot_sequence {
            state
                .mailbox
                .discard_terminal_through(terminal_id, sequence);
            if let Some(flow) = state.flow.get_mut(terminal_id) {
                flow.acknowledge(sequence);
            }
        } else {
            state.flow.remove(terminal_id);
            state.replay_required.remove(terminal_id);
        }
        state.attaching.remove(terminal_id);
        drop(state);
        self.notify.notify_one();
        true
    }

    pub fn detach(&self, terminal_id: &str) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.flow.remove(terminal_id);
        state.replay_required.remove(terminal_id);
        state.attaching.remove(terminal_id);
        drop(state);
        self.notify.notify_one();
    }

    pub fn acknowledge(&self, terminal_id: &str, sequence: u64) {
        if let Some(flow) = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .flow
            .get_mut(terminal_id)
        {
            flow.acknowledge(sequence);
        }
    }

    pub fn close(&self, code: u16, reason: &'static str) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.close.get_or_insert((code, reason));
        drop(state);
        self.notify.notify_one();
    }

    pub fn stop(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.stopped = true;
        drop(state);
        self.notify.notify_waiters();
    }

    pub async fn next(&self) -> Option<NextOutbound> {
        loop {
            let notified = self.notify.notified();
            {
                let mut state = self
                    .state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if state.attaching.is_empty()
                    && let Some(frame) = state.mailbox.pop_next()
                {
                    return Some(NextOutbound::Frame(frame));
                }
                if let Some((code, reason)) = state.close.take() {
                    state.stopped = true;
                    return Some(NextOutbound::Close { code, reason });
                }
                if state.stopped {
                    return None;
                }
            }
            notified.await;
        }
    }

    #[cfg(test)]
    pub fn pending_bytes(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .mailbox
            .pending_bytes()
    }
}

impl TerminalSubscriber for ConnectionOutbound {
    fn enqueue_terminal(&self, frame: Arc<TerminalFrame>) {
        let terminal_id = frame.terminal_id.as_ref();
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.stopped || state.close.is_some() || state.replay_required.contains(terminal_id) {
            return;
        }
        let Some(flow) = state.flow.get_mut(terminal_id) else {
            return;
        };
        let reserved = self.protocol != 2
            || flow.reserve(
                frame.chunk.sequence,
                frame.chunk.data.len(),
                self.flow_limit,
            );
        let acknowledged = flow.acknowledged;
        if !reserved {
            state.replay_required.insert(terminal_id.to_owned());
            let recovery = json!({
                "type": "terminal:replay-required",
                "terminalId": terminal_id,
                "sequence": acknowledged,
            });
            let Ok(data) = serde_json::to_vec(&recovery) else {
                state.close = Some((1011, "replay fence serialization failed"));
                drop(state);
                self.notify.notify_one();
                return;
            };
            if !state
                .mailbox
                .enqueue_reliable(OutboundFrame::text(data))
                .accepted
            {
                state.close = Some((1013, "replay fence mailbox overflow"));
            }
            drop(state);
            self.notify.notify_one();
            return;
        }
        let Ok(encoded) = encode_terminal_data_frame(
            frame.event_sequence,
            frame.chunk.sequence,
            terminal_id,
            &frame.chunk.data,
        ) else {
            return;
        };
        if !state
            .mailbox
            .enqueue_legacy(
                terminal_id,
                OutboundFrame::terminal(terminal_id, frame.chunk.sequence, encoded),
            )
            .accepted
        {
            state.replay_required.insert(terminal_id.to_owned());
            let recovery = json!({
                "type": "terminal:replay-required",
                "terminalId": terminal_id,
                "sequence": acknowledged,
            });
            if let Ok(data) = serde_json::to_vec(&recovery) {
                if !state
                    .mailbox
                    .enqueue_reliable(OutboundFrame::text(data))
                    .accepted
                {
                    state.close = Some((1013, "replay fence mailbox overflow"));
                }
            } else {
                state.close = Some((1011, "replay fence serialization failed"));
            }
        }
        drop(state);
        self.notify.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;

    use super::*;
    use crate::wire::TerminalChunk;

    #[tokio::test]
    async fn terminal_publication_is_bounded_and_acknowledged() {
        let outbound = ConnectionOutbound::new(2, 4);
        outbound.attach("term", 0);
        outbound.complete_attach("term", 0);
        outbound.enqueue_terminal(Arc::new(TerminalFrame {
            event_sequence: 1,
            terminal_id: Arc::from("term"),
            chunk: TerminalChunk {
                sequence: 1,
                data: Bytes::from_static(b"four"),
            },
        }));
        assert!(matches!(
            outbound.next().await,
            Some(NextOutbound::Frame(_))
        ));
        outbound.acknowledge("term", 1);
        assert_eq!(outbound.pending_bytes(), 0);
    }

    #[tokio::test]
    async fn attach_fence_holds_writer_and_discards_snapshot_duplicates() {
        let outbound = ConnectionOutbound::new(2, 1024);
        outbound.attach("term", 0);
        for sequence in 5..=6 {
            outbound.enqueue_terminal(Arc::new(TerminalFrame {
                event_sequence: sequence,
                terminal_id: Arc::from("term"),
                chunk: TerminalChunk {
                    sequence,
                    data: Bytes::from_static(b"live"),
                },
            }));
        }
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(5), outbound.next(),)
                .await
                .is_err()
        );
        outbound.complete_attach("term", 5);
        let Some(NextOutbound::Frame(frame)) = outbound.next().await else {
            panic!("expected post-snapshot frame")
        };
        assert_eq!(frame.terminal_sequence, Some(6));
    }

    #[tokio::test]
    async fn overflow_enqueues_one_replay_fence() {
        let outbound = ConnectionOutbound::new(2, 1);
        outbound.attach("term", 7);
        outbound.complete_attach("term", 7);
        for sequence in 8..=10 {
            outbound.enqueue_terminal(Arc::new(TerminalFrame {
                event_sequence: sequence,
                terminal_id: Arc::from("term"),
                chunk: TerminalChunk {
                    sequence,
                    data: Bytes::from_static(b"xx"),
                },
            }));
        }
        let Some(NextOutbound::Frame(frame)) = outbound.next().await else {
            panic!("expected replay fence")
        };
        assert_eq!(frame.kind, crate::outbound_mailbox::OutboundFrameKind::Text);
        let text = std::str::from_utf8(&frame.data).expect("json");
        assert!(text.contains("terminal:replay-required"));
        assert!(outbound.pending_bytes() <= MailboxLimits::default().reliable_max_bytes);
    }
}
