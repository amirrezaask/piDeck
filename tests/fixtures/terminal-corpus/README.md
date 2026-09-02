# Ghostty differential corpus

`manifest.json` schedules exact slices of the committed `.bin` files. Native Rust and Node/WASM runners apply each write, resize, reset, theme, and viewport event in order. They record public libghostty-vt rows, cells, styles, cursor state, modes, colors, metadata, scroll state, and PTY response bytes.

Run the full comparison with:

```bash
vp run test:ghostty:parity
```

## Editing fixtures

Edit `scripts/generate-ghostty-corpus.mjs`, then run it to regenerate binary files and manifest hashes. The generator does not write `assertions/*.json`; maintain those files by hand. Each critical behavior needs a focused assertion so equal bugs in both runners still fail.

Keep write parts small enough to expose relevant parser boundaries. Do not merge adjacent chunks for convenience. Fixture paths must stay below this directory, and committed input must not contain recordings, credentials, host paths, timestamps, or network output.

## Ghostty upgrades

Before changing `packages/ghostty-core/src/vendor/VERSION`:

1. regenerate native bindings and rebuild native and WASM artifacts from the same revision;
2. run the sys ABI suite and safe-wrapper tests;
3. run `vp run test:ghostty:parity` on Linux, macOS, and Windows;
4. explain any field-level mismatch before changing a fixture or assertion.

The observation JSON belongs to tests. Do not use it for RPC, persistence, terminal replay, or checkpoints.
