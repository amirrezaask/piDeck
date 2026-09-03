# Terminal checkpoint restore decision

- **Status:** Accepted — Outcome A
- **Ghostty revision:** `07bccf7a311acdfa6afc77f2016160d49b1f1982`
- **Ghostty snapshot format:** 1
- **YAADE checkpoint envelope:** 2

## Decision

YAADE restores terminal replicas from Ghostty's public binary snapshot format, then applies ordered raw PTY bytes after the snapshot sequence. Render rows and formatter-generated ANSI are not restore formats.

The public interface used by native and WASM builds is:

- `ghostty_snapshot_encode_buf`
- `ghostty_snapshot_decoder_new_buf`
- `ghostty_snapshot_decoder_set`
- `ghostty_snapshot_decoder_decode`
- `ghostty_snapshot_decoder_free`

The upstream format starts with `GHOSTSNP` and a little-endian format version. Its records are CRC32C-protected and contain a READY-delimited renderable prefix, unfinished VT/UTF-8 continuation, scrollback pages, and a FINISH marker. Format 1 has no cross-revision compatibility guarantee, so YAADE requires the exact engine revision.

## Envelope and bounds

The JSON attach contract carries:

- `magic = YAADECP2`
- envelope version 2
- terminal epoch and included output sequence
- columns and rows
- engine name and exact revision
- Ghostty snapshot format version
- codec (`none`)
- payload length and SHA-256
- opaque base64 snapshot bytes

The payload is limited to 384 KiB. Together with the existing 256 KiB bounded replay tail, base64 expansion remains below the 1 MiB WebSocket message limit. A snapshot that exceeds the limit is skipped; exact durable raw replay remains available.

## Ownership and persistence

The terminal owner exports at a sequence fence after applying that output to its Ghostty authority. Snapshot generation is bounded and remains owner-confined. The immutable envelope then crosses to the history owner, which writes a temporary file, flushes it, and renames it over the previous checkpoint. PTY output never performs checkpoint filesystem I/O.

The server keeps the prior in-memory checkpoint until a complete replacement has been encoded. The history owner preserves the prior durable file if temporary-file writing fails.

## Browser restore

The host client validates terminal epoch, engine revision, snapshot format, payload length, Ghostty magic/version, and SHA-256 before invoking the renderer. The terminal surface restores into a fresh Ghostty terminal inside the worker. Ghostty validates the complete record stream before the old terminal is released. Corruption therefore cannot expose partially restored state.

After restore, replay begins at the checkpoint sequence. Live bytes remain in the existing bounded attach bridge and are released after replay. Input remains queued until replay parsing completes and the client sends its replay-ready acknowledgement.

A failed envelope check or Ghostty import discards the candidate and replays exact retained history from the prior cursor. A missing history prefix remains explicitly degraded; no render projection is substituted.

## Evidence

Reproducible checks:

```bash
cargo test --manifest-path crates/ghostty-vt-sys/Cargo.toml checkpoint_capability
cargo test --manifest-path crates/ghostty-vt/Cargo.toml checkpoint_capability
vp run test:ghostty:parity
vp run test:server
pnpm --filter @yaade/rpc test
pnpm --filter @yaade/host-client test
pnpm --filter @yaade/ghostty-core test
pnpm --filter @yaade/ghostty-react test
pnpm --filter @yaade/ui test
vp exec playwright test --project=bench
```

Native and WASM continuation tests cut every Plan 022 corpus fixture in half, restore a fresh terminal, apply the suffix, and compare public state, rendered rows/cells, modes, and PTY response effects with uninterrupted parsing. Dedicated tests also cut partial UTF-8, CSI, OSC, DCS, and APC input.

Plan 027 retains deterministic 512 KiB parser corpora and a 16 MiB replay corpus. Raw replay remains the compatibility and failure fallback, but it was not selected as the primary attach path; Outcome A does not depend on product approval of maximum-history replay latency.

## Compatibility policy

Unknown envelope versions, engine revisions, snapshot versions, codecs, oversized lengths, checksum failures, stale epochs, and decoder failures fall back to raw replay. Development state may be reset across incompatible revisions. YAADE does not migrate or inspect private Ghostty state.
