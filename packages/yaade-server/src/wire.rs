use std::sync::Arc;

use bytes::{BufMut, Bytes, BytesMut};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

pub const PROTOCOL_VERSION: u8 = 2;
pub const TERMINAL_DATA_FRAME_TYPE: u8 = 0x02;
pub const MAX_WS_PAYLOAD_BYTES: usize = 1024 * 1024;
pub const MAX_TERMINAL_REPLAY_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_TERMINALS: usize = 64;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerIdentity {
    pub server_id: String,
    pub server_epoch: String,
    pub protocol_version: u8,
    pub runtime_version: String,
    pub started_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerCapabilities {
    pub server_id: String,
    pub server_epoch: String,
    pub protocol_versions: Vec<u8>,
    pub preferred_protocol_version: u8,
    pub runtime_version: String,
    pub platform: Platform,
    pub features: CapabilityFeatures,
    pub limits: CapabilityLimits,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Linux,
    Darwin,
    Windows,
}

impl Platform {
    #[must_use]
    pub const fn current() -> Self {
        #[cfg(target_os = "windows")]
        return Self::Windows;
        #[cfg(target_os = "macos")]
        return Self::Darwin;
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        return Self::Linux;
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityFeatures {
    pub runtime_snapshot: bool,
    pub terminal_checkpoints: bool,
    pub writer_leases: bool,
    pub device_authentication: bool,
    pub persisted_terminal_history: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityLimits {
    pub max_terminals: usize,
    pub max_replay_bytes: usize,
    pub max_ws_payload_bytes: usize,
}

impl ServerCapabilities {
    #[must_use]
    pub fn parity(identity: &ServerIdentity, terminal_checkpoints: bool) -> Self {
        Self {
            server_id: identity.server_id.clone(),
            server_epoch: identity.server_epoch.clone(),
            protocol_versions: vec![1, 2],
            preferred_protocol_version: 2,
            runtime_version: identity.runtime_version.clone(),
            platform: Platform::current(),
            features: CapabilityFeatures {
                runtime_snapshot: true,
                terminal_checkpoints,
                writer_leases: true,
                device_authentication: true,
                persisted_terminal_history: false,
            },
            limits: CapabilityLimits {
                max_terminals: MAX_TERMINALS,
                max_replay_bytes: MAX_TERMINAL_REPLAY_BYTES,
                max_ws_payload_bytes: MAX_WS_PAYLOAD_BYTES,
            },
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRpcRequest {
    pub channel: String,
    #[serde(default)]
    pub args: Vec<Value>,
    #[serde(default = "default_client_id")]
    pub client_id: String,
}

fn default_client_id() -> String {
    "browser".to_owned()
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum HostRpcResponse {
    Success { value: Value },
    Failure { error: HostWireError },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HostWireError {
    pub code: String,
    pub message: String,
    pub details: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostEvent {
    pub protocol_version: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_id: Option<Arc<str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_epoch: Option<Arc<str>>,
    pub sequence: u64,
    pub channel: Arc<str>,
    pub args: Arc<[Value]>,
}

impl HostEvent {
    #[must_use]
    pub fn modern(
        identity: &ServerIdentity,
        sequence: u64,
        channel: impl Into<Arc<str>>,
        args: impl Into<Arc<[Value]>>,
    ) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            server_id: Some(Arc::from(identity.server_id.as_str())),
            server_epoch: Some(Arc::from(identity.server_epoch.as_str())),
            sequence,
            channel: channel.into(),
            args: args.into(),
        }
    }

    #[must_use]
    pub fn legacy(&self) -> Self {
        Self {
            protocol_version: 1,
            server_id: None,
            server_epoch: None,
            sequence: self.sequence,
            channel: Arc::clone(&self.channel),
            args: Arc::clone(&self.args),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalMutationFence {
    pub terminal_id: String,
    pub terminal_epoch: String,
    pub lease_id: String,
    pub lease_generation: u64,
    pub principal_id: String,
    pub connection_id: String,
    pub command_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalLeaseMode {
    Writer,
    Observer,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalLease {
    pub terminal_id: String,
    pub terminal_epoch: String,
    pub lease_id: String,
    pub client_id: String,
    pub mode: TerminalLeaseMode,
    pub acquired_at: String,
    pub expires_at: String,
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_generation: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub principal_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalWsCommand {
    pub request_id: String,
    pub op: String,
    pub args: Vec<Value>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalWsAck {
    #[serde(rename = "type")]
    pub kind: String,
    pub terminal_id: String,
    pub sequence: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalChunk {
    pub sequence: u64,
    pub data: Bytes,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalFrame {
    pub event_sequence: u64,
    pub terminal_id: Arc<str>,
    pub chunk: TerminalChunk,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TerminalFrameError {
    #[error("terminal id is too long for a binary frame")]
    TerminalIdTooLong,
}

/// Encode protocol-v2 terminal output without creating an intermediate JSON or
/// contiguous `String`. Callers can pass the returned reference-counted bytes
/// straight to the WebSocket sink.
pub fn encode_terminal_data_frame(
    event_sequence: u64,
    terminal_sequence: u64,
    terminal_id: &str,
    data: &[u8],
) -> Result<Bytes, TerminalFrameError> {
    let id = terminal_id.as_bytes();
    let id_len = u16::try_from(id.len()).map_err(|_| TerminalFrameError::TerminalIdTooLong)?;
    let mut frame = BytesMut::with_capacity(19 + id.len() + data.len());
    frame.put_u8(TERMINAL_DATA_FRAME_TYPE);
    frame.put_u64(event_sequence);
    frame.put_u64(terminal_sequence);
    frame.put_u16(id_len);
    frame.extend_from_slice(id);
    frame.extend_from_slice(data);
    Ok(frame.freeze())
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

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
    fn terminal_frame_preserves_every_payload_byte() {
        let payload = (0_u8..=u8::MAX).collect::<Vec<_>>();
        let frame = encode_terminal_data_frame(7, 11, "term-1", &payload).expect("frame");
        assert_eq!(&frame[25..], payload);
    }

    #[test]
    fn terminal_frame_matches_the_typescript_layout() {
        let frame = encode_terminal_data_frame(7, 11, "term-1", b"hello").expect("frame");

        assert_eq!(frame[0], 0x02);
        assert_eq!(
            u64::from_be_bytes(frame[1..9].try_into().expect("event sequence")),
            7
        );
        assert_eq!(
            u64::from_be_bytes(frame[9..17].try_into().expect("terminal sequence")),
            11
        );
        assert_eq!(
            u16::from_be_bytes(frame[17..19].try_into().expect("id length")),
            6
        );
        assert_eq!(&frame[19..25], b"term-1");
        assert_eq!(&frame[25..], b"hello");
    }

    #[test]
    fn modern_event_serializes_with_wire_field_names() {
        let event = HostEvent::modern(
            &identity(),
            9,
            "mux:event",
            vec![serde_json::json!({ "_tag": "SessionUpdated" })],
        );

        assert_eq!(
            serde_json::to_value(event).expect("json"),
            serde_json::json!({
                "protocolVersion": 2,
                "serverId": "server-1",
                "serverEpoch": "epoch-1",
                "sequence": 9,
                "channel": "mux:event",
                "args": [{ "_tag": "SessionUpdated" }]
            })
        );
    }

    #[test]
    fn rpc_request_defaults_match_effect_schema() {
        let request: HostRpcRequest = serde_json::from_value(serde_json::json!({
            "channel": "mux:listSessions"
        }))
        .expect("request");

        assert!(request.args.is_empty());
        assert_eq!(request.client_id, "browser");
    }

    #[test]
    fn parity_capabilities_match_the_current_server() {
        let capabilities = ServerCapabilities::parity(&identity(), true);

        assert_eq!(capabilities.protocol_versions, vec![1, 2]);
        assert_eq!(capabilities.preferred_protocol_version, 2);
        assert_eq!(capabilities.limits.max_terminals, 64);
        assert_eq!(capabilities.limits.max_replay_bytes, 2 * 1024 * 1024);
        assert!(capabilities.features.writer_leases);
        assert!(!capabilities.features.persisted_terminal_history);
    }
}
