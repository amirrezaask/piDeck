# Plan 021: Wrap libghostty-vt in a thread-confined safe Rust API

> **Executor instructions**: Follow each step in order and run its verification.
> Preserve existing changes. Confirm Plan 020 is `DONE` and use only its checked
> public bindings. Stop when a sound lifetime or callback contract cannot be
> expressed instead of widening `unsafe`. Mark this plan and its README row
> `DONE` after all tests pass.
>
> **Drift check (run first)**:
>
> ```bash
> git status --short
> git diff --stat 8bbcd017..HEAD -- \
>   crates/ghostty-vt-sys crates/ghostty-vt \
>   packages/ghostty-core/src/vendor/VERSION docs/architecture
> git diff --stat -- \
>   crates/ghostty-vt-sys crates/ghostty-vt \
>   packages/ghostty-core/src/vendor/VERSION docs/architecture
> ```
>
> Confirm the sys crate reports the exact live VERSION and passes its C/Rust ABI
> suite. Do not edit generated bindings to make wrapper code easier.

## Status

- **Status**: DONE
- **Priority**: P2
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: Plan 020
- **Category**: ffi / API design / correctness
- **Planned at**: commit `8bbcd017`, 2026-08-30
- **Source finding**: SolPro P1-7 safe ownership layer

## Why this matters

Raw libghostty-vt handles have allocator, callback, borrowing, sized-struct, and
thread-affinity rules. Repeating those rules in server actors would spread
unsafe code through lifecycle and replay paths. A small safe crate can own these
constraints and present terminal operations in Rust terms.

This plan creates that crate and tests its safety contract. It does not integrate
with `apps/server`; Plan 023 owns the migration.

## Current state

Plan 020 provides `crates/ghostty-vt-sys` with opaque C handles and checked
bindings. No Rust type currently owns a Ghostty terminal, render state, grid
reference, formatter, callback userdata, or allocator lifecycle.

The pinned API invokes terminal effects synchronously from
`ghostty_terminal_vt_write`. Callbacks must not block, re-enter the terminal, or
retain borrowed pointers. Some render/grid strings remain valid only until a
later mutation or explicit release.

## Target API

```rust
let mut terminal = Terminal::new(TerminalOptions { cols, rows, scrollback, effects })?;
let outcome = terminal.write(bytes)?;
for response in outcome.pty_responses() { /* drain after write returns */ }
let state = terminal.state()?;
terminal.with_render_state(|render| { /* borrowed traversal */ })?;
terminal.resize(cols, rows, cell_width, cell_height)?;
```

`Terminal` owns and frees all C handles. It is intentionally `!Send + !Sync`, so
Plan 023 must create/use it on the Plan 019 terminal owner thread. The wrapper
exposes no raw pointers, integer option IDs, or unbounded callback side effects.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Wrapper tests | `cargo test --manifest-path crates/ghostty-vt/Cargo.toml` | ownership/effect/render tests pass |
| Release tests | `cargo test --release --manifest-path crates/ghostty-vt/Cargo.toml` | optimized lifecycle passes |
| Lint | `cargo clippy --manifest-path crates/ghostty-vt/Cargo.toml --all-targets -- -D warnings` | exit 0 |
| Docs | `cargo doc --no-deps --manifest-path crates/ghostty-vt/Cargo.toml` | no warnings |
| Sanitizers | crate commands documented by Step 5 | no C/Rust memory failure |

## Scope

**In scope**

- `crates/ghostty-vt/**` (new standalone Cargo package)
- Narrow additions to `ghostty-vt-sys` only when a required public declaration
  was omitted; regenerate and revalidate rather than hand-edit
- RAII terminal/render/grid/formatter wrappers
- Typed terminal options, errors, state, modes, colors, cursor, title, and cwd
- Pinned callback userdata and bounded effect collection
- Borrowed render traversal with mutation-safe lifetimes
- Unit, property/fuzz, compile-fail, sanitizer, and leak tests
- Wrapper API documentation and `plans/README.md`

**Out of scope**

- Native/WASM parity fixtures: Plan 022.
- Server actor, `vt100`, query-scanner, or checkpoint changes: Plans 023–024.
- `Send`, shared terminal handles, async methods, or internal mutexes.
- Persisting Ghostty memory or exposing private structs.
- Renderer/GPU behavior.

## Steps

### Step 1: Define ownership and error contracts before implementation

Write API-level tests and documentation for:

- one allocator/build-info initialization per process as required by the ABI;
- terminal creation with validated dimensions and scrollback limits;
- deterministic Drop order for render/grid/formatter/terminal resources;
- errors for allocation failure, invalid values, out-of-space, callback overflow,
  stale borrow attempts, and ABI/revision mismatch;
- no panic for arbitrary PTY bytes or external callback values;
- no public raw handle escape.

Use a private `PhantomData<Rc<()>>` or another stable mechanism to make terminal
and borrowed views `!Send + !Sync`. Add compile-fail tests that attempt to move a
terminal to another thread or retain render data across a mutation.

**Verify**:

```bash
cargo test --doc --manifest-path crates/ghostty-vt/Cargo.toml
cargo test --manifest-path crates/ghostty-vt/Cargo.toml
```

Expected during this step: ownership/error contract tests exist; implementation
may follow in the next steps without changing their public intent.

### Step 2: Implement RAII terminal construction and mutation

Wrap terminal create/free, write, resize, reset, and mode/data access. Validate
all Rust integers before narrowing to C types. Initialize sized structs through
one private helper that sets the ABI size field and zeros only fields whose
header contract allows zero.

Every unsafe block must state:

- pointer provenance and non-null requirement;
- handle lifetime and exclusive access;
- callback/userdata stability;
- borrowed output validity window;
- C function mutation behavior.

Map C result codes into a closed `GhosttyError` enum. Do not use broad string
errors or panic on malformed terminal bytes.

**Verify**:

```bash
cargo test --manifest-path crates/ghostty-vt/Cargo.toml
cargo clippy --manifest-path crates/ghostty-vt/Cargo.toml --all-targets -- -D warnings
```

Expected: repeated create/write/resize/reset/drop and failure injection pass.

### Step 3: Add a bounded, nonblocking effect outbox

Pin one callback state for the terminal lifetime. Its C trampolines may only:

- copy write-PTY responses into prebounded scratch/outbox storage;
- copy bounded title/pwd changes or set dirty flags for post-write getters;
- record bell and mode/query flags;
- answer size, color scheme, device attributes, and configured values from small
  copied state;
- set an overflow/error flag.

Callbacks must not lock a host mutex, await/send on a full channel, write the
PTY, allocate without a configured bound, log payloads, call terminal methods,
or retain a Ghostty string pointer. `Terminal::write` drains/copies a typed
`TerminalEffects` value only after the C call returns.

Define overflow semantics. Query response overflow must surface as an error that
Plan 023 can treat as terminal-runtime failure; silently dropping response bytes
would corrupt protocol behavior.

**Verify**:

```bash
cargo test --manifest-path crates/ghostty-vt/Cargo.toml effects
```

Expected: reentrancy guards, exact response bytes, callback bounds, overflow,
title/pwd, bell, size/theme/device callbacks, and repeated writes pass.

### Step 4: Add safe public render and state traversal

Expose immutable Rust views for the public render-state/grid APIs:

- viewport dimensions and row iteration;
- grapheme bytes/text with explicit UTF-8 policy;
- width/style/colors/decorations;
- cursor, modes, palette, title, pwd, and alternate screen;
- scrollback metadata available from the public ABI;
- formatter output through a bounded `Write`-like sink when needed.

Tie every borrowed view to `&mut Terminal` or a closure so callers cannot write,
resize, reset, or release while a render/grid borrow exists. Copy only values
that must outlive the closure. Reuse row/grapheme scratch buffers.

Do not label a render view as serializable parser state. Plan 024 owns checkpoint
feasibility.

**Verify**:

```bash
cargo test --manifest-path crates/ghostty-vt/Cargo.toml render
```

Expected: wide/combining/empty rows, styles, cursor, scrollback, and stale-lifetime
compile failures pass.

### Step 5: Harden malformed-input and lifecycle behavior

Add deterministic property/fuzz corpora for arbitrary bytes, chunk boundaries,
zero/maximum dimensions, resize/write/reset interleaving, effect bursts, and
Drop during error handling. Where CI supports them, run AddressSanitizer,
UndefinedBehaviorSanitizer, and leak checks across the C/Rust boundary.

Track allocations in a test allocator after warm-up. Steady writes and render
traversal must reuse wrapper scratch rather than allocate per cell. Do not set a
performance claim here; Plan 027 measures subsystem throughput.

**Verify**:

```bash
cargo test --release --manifest-path crates/ghostty-vt/Cargo.toml
# Run sanitizer/fuzz smoke commands documented by the crate.
```

Expected: no panic, leak, use-after-free, callback escape, or unbounded growth.

### Step 6: Document the deep-module boundary

Document each public method's ownership, mutation, borrowing, callback, and
thread rules. Include one server-owner usage example without importing
`apps/server`. Ensure rustdoc exposes the safe crate, while generated sys details
remain clearly unsafe and separate.

**Verify**:

```bash
cargo doc --no-deps --manifest-path crates/ghostty-vt/Cargo.toml
cargo fmt --manifest-path crates/ghostty-vt/Cargo.toml -- --check
```

Expected: docs build without warnings and unsafe invariants are reviewable.

## Test plan

- Compile-fail: `Send`/`Sync`, render borrow across mutation, raw handle escape.
- Lifecycle: create/drop loops, partial initialization, C failure, panic unwind.
- Effects: exact bytes, title/pwd, host queries, overflow, reentrancy, no blocking.
- Render: rows/cells/graphemes/styles/cursor/modes and bounded formatter output.
- Robustness: arbitrary bytes/chunks, dimensions, reset/resize/write sequences.
- Tooling: Clippy, rustdoc, sanitizers, leak checks, release tests.

## Done criteria

- [x] `ghostty-vt` exposes a narrow safe API over Plan 020's sys crate.
- [x] Terminal and borrowed views are `!Send + !Sync` and cannot escape mutation lifetimes.
- [x] All C handles and partial constructions free through RAII.
- [x] Effects are bounded, synchronous, nonblocking, and non-reentrant.
- [x] Public render/state traversal exposes no private Ghostty representation.
- [x] Arbitrary input and lifecycle tests show no panic, leak, or unsafe escape.
- [x] Server code remains unchanged.
- [x] Rustfmt, Clippy, rustdoc, release tests, and supported sanitizers pass.

## STOP conditions

- A required operation needs a private Ghostty struct or undocumented lifetime.
- Sound callback userdata requires moving memory after C stores its pointer.
- Query correctness requires callback blocking or terminal reentry.
- A raw terminal handle must become `Send`, `Sync`, or mutex-shared.
- Render pointers must remain live after mutation to support the proposed API.
- The plan begins server integration, parity corpus, or checkpoint persistence.

## Maintenance notes

Keep the wrapper smaller than the C API. Add methods only for a caller-backed
requirement and pair each new declaration with ABI validation in Plan 020.
Review callback changes for bounds and reentrancy. Review borrowed data changes
against the exact pinned header before each VERSION upgrade.
