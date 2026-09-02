# ghostty-vt-sys

Checked native bindings for YAADE's pinned `libghostty-vt` revision.

## Build

Prepare the exact Ghostty source and Zig toolchain before invoking Cargo:

```bash
vp run prepare:ghostty
vp run check:ghostty-source
cargo test --manifest-path crates/ghostty-vt-sys/Cargo.toml
```

`build.rs` runs Zig in `--system` mode and performs no network access. The
preparation command fetches the pinned, content-hashed Zig dependency tree. The
build rejects a missing, dirty, or wrong Ghostty checkout, an unprepared package
cache, and a Zig version other than 0.15.2. Native builds link the static archive. SIMD remains disabled until Plan 028 validates the shipped
artifact and its performance on all supported platforms.

Set `GHOSTTY_SOURCE_DIR`, `GHOSTTY_ZIG`, and
`GHOSTTY_ZIG_GLOBAL_CACHE_DIR` to use explicit prepared paths.
`YAADE_GHOSTTY_CACHE_DIR` changes the content-addressed cache root.

## Bindings

Bindings are generated from the pinned public `ghostty/vt.h` headers and are
checked in, so normal builds do not need libclang. Maintainers can regenerate
or verify them with:

```bash
GHOSTTY_SOURCE_DIR=/path/to/pinned/ghostty \
  cargo run --manifest-path crates/ghostty-vt-sys/Cargo.toml \
  --features bindgen-tool --bin gen-bindings
```

The binding implementation derives from `libghostty-vt-sys` 0.2.1 at commit
`46a9d2ac941ed600cf43c5e6299c8dfd1d3a1ef0`, used under the included MIT
license. YAADE owns the source preparation, native build, and ABI validation.
