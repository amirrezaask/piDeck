#![no_main]

use bytes::BytesMut;
use libfuzzer_sys::fuzz_target;
use terminal_protocol::{Codec, DEFAULT_MAX_PAYLOAD};

fuzz_target!(|data: &[u8]| {
    if data.len() > DEFAULT_MAX_PAYLOAD + 4096 {
        return;
    }
    let codec = Codec::default();
    let mut input = BytesMut::from(data);
    let before = input.len();
    let result = codec.decode(&mut input);
    if let Ok(Some(frame)) = result {
        assert!(frame.payload.len() <= DEFAULT_MAX_PAYLOAD);
        assert!(input.len() < before);
        if let Ok(encoded) = codec.encode(frame) {
            assert!(encoded.header.len() + encoded.payload.len() <= DEFAULT_MAX_PAYLOAD + 36);
        }
    }
});
