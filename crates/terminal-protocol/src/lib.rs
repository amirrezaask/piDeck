#![doc = r#"Transport-independent binary protocol for replicated terminal sessions.

A frame's `sequence` is an inclusive PTY byte offset for data frames. The first
byte in an epoch is offset one, so a non-empty payload ending at `N` covers
`(N - payload.len() + 1)..=N`. Epochs are incomparable. Control frame sequence
values are monotonic operation identifiers in their stream.

The codec validates the complete header before allocating or retaining a
payload. [`EncodedFrame`] keeps the immutable payload separate from its small
header so vectored transports can fan one shared `Bytes` allocation to many
clients. A WebSocket adapter may call [`EncodedFrame::coalesce`] at the final
transport seam when its library requires one contiguous message.
"#]

use bytes::{Buf, BufMut, Bytes, BytesMut};
use thiserror::Error;

/// Current protocol version.
pub const VERSION: u8 = 4;
/// Fixed encoded header length.
pub const HEADER_LEN: usize = 36;
/// Default defensive payload limit.
pub const DEFAULT_MAX_PAYLOAD: usize = 8 * 1024 * 1024;
const MAGIC: [u8; 2] = *b"PD";

/// Terminal frame category.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum FrameType {
    /// Version/capability negotiation.
    Hello = 1,
    /// Attach or reattach request.
    Attach = 2,
    /// Accepted attach and stream metadata.
    AttachAck = 3,
    /// Opaque restorable VT state.
    Snapshot = 4,
    /// Interaction barrier at the snapshot cut.
    Ready = 5,
    /// Raw process output bytes.
    PtyData = 6,
    /// Raw client/agent input bytes.
    Input = 7,
    /// Authoritative PTY grid resize.
    Resize = 8,
    /// History range prelude.
    ScrollbackBegin = 9,
    /// Bounded history bytes.
    ScrollbackChunk = 10,
    /// History range completion.
    ScrollbackEnd = 11,
    /// Replica reset request.
    ResyncRequest = 12,
    /// Replica reset acknowledgement.
    ResyncBegin = 13,
    /// Process exit notification.
    SessionExit = 14,
    /// Structured protocol error.
    Error = 15,
    /// Liveness probe.
    Ping = 16,
    /// Liveness response.
    Pong = 17,
}

impl TryFrom<u8> for FrameType {
    type Error = ProtocolError;

    fn try_from(value: u8) -> Result<Self, ProtocolError> {
        Ok(match value {
            1 => Self::Hello,
            2 => Self::Attach,
            3 => Self::AttachAck,
            4 => Self::Snapshot,
            5 => Self::Ready,
            6 => Self::PtyData,
            7 => Self::Input,
            8 => Self::Resize,
            9 => Self::ScrollbackBegin,
            10 => Self::ScrollbackChunk,
            11 => Self::ScrollbackEnd,
            12 => Self::ResyncRequest,
            13 => Self::ResyncBegin,
            14 => Self::SessionExit,
            15 => Self::Error,
            16 => Self::Ping,
            17 => Self::Pong,
            other => return Err(ProtocolError::UnknownType(other)),
        })
    }
}

/// Exact ordered location in a logical PTY stream.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StreamPosition {
    /// Changes when the logical PTY byte stream is replaced.
    pub epoch: u64,
    /// Inclusive byte offset of the final observed output byte.
    pub sequence: u64,
}

/// Validated protocol frame with an immutable, cheaply cloned payload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Frame {
    /// Message category.
    pub kind: FrameType,
    /// Type-specific flags; unknown bits are rejected by the current version.
    pub flags: u16,
    /// Connection-local stream identifier.
    pub stream_id: u64,
    /// Epoch and sequence ordering position.
    pub position: StreamPosition,
    /// Opaque message payload.
    pub payload: Bytes,
}

impl Frame {
    /// Construct a frame after validating data-plane invariants.
    pub fn new(
        kind: FrameType,
        flags: u16,
        stream_id: u64,
        position: StreamPosition,
        payload: Bytes,
    ) -> Result<Self, ProtocolError> {
        if flags != 0 {
            return Err(ProtocolError::UnknownFlags(flags));
        }
        if matches!(kind, FrameType::PtyData | FrameType::Input) && payload.is_empty() {
            return Err(ProtocolError::EmptyData);
        }
        if kind == FrameType::PtyData && position.sequence < payload.len() as u64 {
            return Err(ProtocolError::InvalidPosition);
        }
        Ok(Self {
            kind,
            flags,
            stream_id,
            position,
            payload,
        })
    }

    /// Inclusive byte range covered by PTY data, or `None` for other frames.
    #[must_use]
    pub fn byte_range(&self) -> Option<std::ops::RangeInclusive<u64>> {
        if self.kind != FrameType::PtyData || self.payload.is_empty() {
            return None;
        }
        Some((self.position.sequence - self.payload.len() as u64 + 1)..=self.position.sequence)
    }
}

/// Header and payload kept separate for vectored/low-copy transport writes.
#[derive(Clone, Debug)]
pub struct EncodedFrame {
    /// Fixed-size encoded header.
    pub header: Bytes,
    /// Shared immutable payload.
    pub payload: Bytes,
}

impl EncodedFrame {
    /// Coalesce only when a transport requires a contiguous message.
    #[must_use]
    pub fn coalesce(self) -> Bytes {
        let mut output = BytesMut::with_capacity(self.header.len() + self.payload.len());
        output.extend_from_slice(&self.header);
        output.extend_from_slice(&self.payload);
        output.freeze()
    }
}

/// Bounded incremental frame codec.
#[derive(Clone, Debug)]
pub struct Codec {
    max_payload: usize,
}

impl Codec {
    /// Build a codec with a strict payload bound.
    #[must_use]
    pub fn new(max_payload: usize) -> Self {
        Self {
            max_payload: max_payload.max(1),
        }
    }

    /// Encode without copying the payload.
    pub fn encode(&self, frame: Frame) -> Result<EncodedFrame, ProtocolError> {
        if frame.payload.len() > self.max_payload {
            return Err(ProtocolError::PayloadTooLarge {
                size: frame.payload.len(),
                max: self.max_payload,
            });
        }
        Frame::new(
            frame.kind,
            frame.flags,
            frame.stream_id,
            frame.position,
            frame.payload.clone(),
        )?;
        let mut header = BytesMut::with_capacity(HEADER_LEN);
        header.extend_from_slice(&MAGIC);
        header.put_u8(VERSION);
        header.put_u8(frame.kind as u8);
        header.put_u16(frame.flags);
        header.put_u16(HEADER_LEN as u16);
        header.put_u64(frame.stream_id);
        header.put_u64(frame.position.epoch);
        header.put_u64(frame.position.sequence);
        header.put_u32(frame.payload.len() as u32);
        Ok(EncodedFrame {
            header: header.freeze(),
            payload: frame.payload,
        })
    }

    /// Decode one frame. Incomplete input is retained and returns `Ok(None)`.
    pub fn decode(&self, input: &mut BytesMut) -> Result<Option<Frame>, ProtocolError> {
        if input.len() < HEADER_LEN {
            return Ok(None);
        }
        if input[..2] != MAGIC {
            return Err(ProtocolError::BadMagic);
        }
        let version = input[2];
        if version != VERSION {
            return Err(ProtocolError::UnsupportedVersion(version));
        }
        let kind = FrameType::try_from(input[3])?;
        let flags = u16::from_be_bytes([input[4], input[5]]);
        if flags != 0 {
            return Err(ProtocolError::UnknownFlags(flags));
        }
        let header_len = u16::from_be_bytes([input[6], input[7]]) as usize;
        if header_len != HEADER_LEN {
            return Err(ProtocolError::InvalidHeaderLength(header_len));
        }
        let stream_id = u64::from_be_bytes(input[8..16].try_into().expect("fixed header"));
        let epoch = u64::from_be_bytes(input[16..24].try_into().expect("fixed header"));
        let sequence = u64::from_be_bytes(input[24..32].try_into().expect("fixed header"));
        let payload_len =
            u32::from_be_bytes(input[32..36].try_into().expect("fixed header")) as usize;
        if payload_len > self.max_payload {
            return Err(ProtocolError::PayloadTooLarge {
                size: payload_len,
                max: self.max_payload,
            });
        }
        let total = HEADER_LEN
            .checked_add(payload_len)
            .ok_or(ProtocolError::LengthOverflow)?;
        if input.len() < total {
            return Ok(None);
        }
        input.advance(HEADER_LEN);
        let payload = input.split_to(payload_len).freeze();
        Frame::new(
            kind,
            flags,
            stream_id,
            StreamPosition { epoch, sequence },
            payload,
        )
        .map(Some)
    }
}

impl Default for Codec {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_PAYLOAD)
    }
}

/// Bounded protocol failure.
#[derive(Debug, Error, Eq, PartialEq)]
pub enum ProtocolError {
    /// Magic bytes do not identify this protocol.
    #[error("invalid terminal protocol magic")]
    BadMagic,
    /// Peer selected an unsupported version.
    #[error("unsupported terminal protocol version {0}")]
    UnsupportedVersion(u8),
    /// Frame type is unknown.
    #[error("unknown terminal frame type {0}")]
    UnknownType(u8),
    /// Current version defines no flags.
    #[error("unknown terminal frame flags {0:#x}")]
    UnknownFlags(u16),
    /// Header extension is not valid for this version.
    #[error("invalid terminal frame header length {0}")]
    InvalidHeaderLength(usize),
    /// Advertised payload exceeds the configured bound.
    #[error("terminal frame payload {size} exceeds {max}")]
    PayloadTooLarge {
        /// Advertised or actual bytes.
        size: usize,
        /// Configured maximum.
        max: usize,
    },
    /// Header and payload arithmetic overflowed.
    #[error("terminal frame length overflow")]
    LengthOverflow,
    /// Raw data messages may not be empty.
    #[error("terminal data frame payload is empty")]
    EmptyData,
    /// PTY byte offset cannot cover the payload.
    #[error("terminal stream position does not cover payload")]
    InvalidPosition,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fragmented_round_trip_preserves_opaque_bytes_and_position() {
        let codec = Codec::default();
        let payload = Bytes::from_static(b"\xff\x1b[31partial");
        let frame = Frame::new(
            FrameType::PtyData,
            0,
            7,
            StreamPosition {
                epoch: 3,
                sequence: payload.len() as u64,
            },
            payload.clone(),
        )
        .unwrap();
        let encoded = codec.encode(frame.clone()).unwrap().coalesce();
        let mut input = BytesMut::new();
        for byte in encoded {
            input.put_u8(byte);
            if input.len() < HEADER_LEN + payload.len() {
                assert!(codec.decode(&mut input).unwrap().is_none());
            }
        }
        assert_eq!(codec.decode(&mut input).unwrap(), Some(frame));
        assert!(input.is_empty());
    }

    #[test]
    fn shared_payload_is_not_copied_by_encoding() {
        let payload = Bytes::from(vec![42; 4096]);
        let pointer = payload.as_ptr();
        let encoded = Codec::default()
            .encode(
                Frame::new(
                    FrameType::Snapshot,
                    0,
                    1,
                    StreamPosition {
                        epoch: 9,
                        sequence: 0,
                    },
                    payload,
                )
                .unwrap(),
            )
            .unwrap();
        assert_eq!(encoded.payload.as_ptr(), pointer);
    }

    #[test]
    fn byte_range_detects_exact_attach_boundary() {
        let frame = Frame::new(
            FrameType::PtyData,
            0,
            1,
            StreamPosition {
                epoch: 2,
                sequence: 104,
            },
            Bytes::from_static(b"hello"),
        )
        .unwrap();
        assert_eq!(frame.byte_range(), Some(100..=104));
    }

    #[test]
    fn rejects_oversized_payload_before_waiting_for_body() {
        let mut input = BytesMut::from(&b"PD\x04\x04\x00\x00\x00\x24\x00\x00\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x10\x00"[..]);
        assert!(matches!(
            Codec::new(1024).decode(&mut input),
            Err(ProtocolError::PayloadTooLarge { .. })
        ));
    }
}
