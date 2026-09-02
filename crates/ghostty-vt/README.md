# ghostty-vt

Thread-confined safe Rust wrapper for YAADE's pinned native `libghostty-vt`.
It depends only on the checked public declarations in `ghostty-vt-sys`; no
private Ghostty page, grid, or parser representation is exposed.

## Interface contract

- `Terminal`, render/row/cell views, tracked grid references, and effect views
  are `!Send + !Sync`.
- Native terminal, render state, row/cell iterators, formatter, and tracked-grid
  handles have deterministic RAII cleanup, including partial construction and
  unwind paths. Build metadata is validated through one process-wide `OnceLock`;
  every resource consistently uses Ghostty's process-default allocator.
- Callbacks are synchronous, pinned, prebounded, nonblocking, and guarded
  against reentry. They only copy bytes or copied host configuration.
- No callback invokes a terminal method, host closure, PTY write, logger, lock,
  channel, or allocator growth path.
- `Terminal::write` and `Terminal::resize` expose borrowed response bytes only
  after the native call returns. The borrow prevents another mutation until the
  caller finishes draining them.
- Native strings are copied before mutation. Render traversal uses lending
  views whose lifetimes prevent stale row, cell, and grapheme access.
- Render and formatter output are observation formats, not restorable parser
  state.

## Build and test

Prepare the exact Ghostty source and Zig toolchain first:

```bash
vp run prepare:ghostty
vp run check:ghostty-source
cargo test --manifest-path crates/ghostty-vt/Cargo.toml
cargo test --release --manifest-path crates/ghostty-vt/Cargo.toml
cargo clippy --manifest-path crates/ghostty-vt/Cargo.toml --all-targets -- -D warnings
cargo doc --no-deps --manifest-path crates/ghostty-vt/Cargo.toml
cargo fmt --manifest-path crates/ghostty-vt/Cargo.toml -- --check
```

The regular suite includes malformed/chunked byte corpora, maximum-width and
resize/reset interleavings, exact callback effects, callback overflow, render
and formatter traversal, panic unwind, repeated lifecycle, tracked references,
and `trybuild` compile-fail ownership tests.

## Sanitizers

On supported nightly Rust host targets:

```bash
crates/ghostty-vt/scripts/sanitizers.sh all
# Individual probes:
crates/ghostty-vt/scripts/sanitizers.sh address
crates/ghostty-vt/scripts/sanitizers.sh leak
crates/ghostty-vt/scripts/sanitizers.sh undefined
```

The script probes the host target before running a sanitizer and prints an
explicit `SKIP` for unsupported modes. Rust currently has no UBSan mode; native
debug/test artifacts use Ghostty's `ReleaseSafe` Zig build, while ASan covers
the Rust/native process and leak detection where the host runtime supports it.
The sanitizer suite runs library lifecycle tests rather than `trybuild`, whose
nested compiler processes are not part of the native lifetime check.
