# Plan 048: Broadcast input safely to an explicit terminal group

> **Executor instructions**: Complete Plans 035, 038, and 039 first. This is a
> high-risk input feature: preserve the single-writer lease model, never retain
> input content, and stop on any uncertainty about target authorization or key
> encoding. Read `packages/yaade-ui/AGENTS.md`, preserve working-tree changes,
> run every gate, and update this plan plus `plans/README.md` when complete.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 0739eacf..HEAD -- \
>   packages/ghostty-react/src packages/yaade-workspace/src \
>   packages/yaade-ui/src/panels packages/yaade-app/src/{commands,mux} \
>   packages/yaade-host-client/src packages/yaade-rpc/src \
>   tests/web/e2e
> git diff --stat -- \
>   packages/ghostty-react/src packages/yaade-workspace/src \
>   packages/yaade-ui/src/panels packages/yaade-app/src/{commands,mux} \
>   packages/yaade-host-client/src packages/yaade-rpc/src \
>   tests/web/e2e
> ```

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: Plans 035, 038, and 039
- **Category**: terminal UX / input safety
- **Planned at**: commit `0739eacf`, 2026-08-31
- **Source finding**: heavy-terminal workflow review: repeated operations across panes require manual re-entry

## Why this matters

Operators sometimes need to send the same interactive input to several terminals.
Doing this naively is dangerous because terminals can have different keyboard
modes, writer ownership, connectivity, and paste policy. YAADE should support it
only as a conspicuous temporary mode with explicit targets and per-terminal
encoding. Do not hide it behind a “send this string everywhere” shortcut.

## Current state

- `packages/yaade-ui/src/panels/terminal-instance-registry.ts` resolves resident
  `GhosttyTerminalSurface` instances and can send virtual keys/paste to one.
- Each surface owns current Ghostty keyboard and bracketed-paste modes; encoded
  bytes can differ between terminals.
- Host writer/observer leases and Plan 038 control grants determine who may write.
- Plan 039 owns risky-paste confirmation and exact clipboard framing.
- Plan 035 supplies stable commands and availability/disabled reasons.
- Any new `@yaade/app` unit test file must be listed in
  `packages/yaade-app/package.json`, per repository convention.

## Target module and interface

Create one input-broadcast module with a narrow operation-oriented interface:

```ts
type BroadcastTarget = { terminalId; surface; writerFence; readiness }
preflight(targets, operation): BroadcastReadiness
sendKey(targets, keyboardEvent): BroadcastReceipt
sendPaste(targets, approvedPaste): Promise<BroadcastReceipt>
disarm(reason): void
```

The module resolves/authorizes targets, asks each surface to encode its own key
or paste, sends through existing typed terminal writers, and returns content-free
per-target receipts. It never accepts pre-encoded shared PTY bytes and never
stores key, paste, or clipboard content after the operation settles.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Unit | `vp test packages/ghostty-react packages/yaade-host-client packages/yaade-ui packages/yaade-app` | encoding/preflight/mode tests pass |
| Type/lint | `vp run typecheck && vp run lint` | exit 0 |
| E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-input-broadcast.web.spec.ts` | multi-PTY exactness/safety pass |
| Compatibility | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts` | terminal behavior remains green |

## Scope

**In scope**

- Temporary explicit broadcast groups within one visible Window
- Target selection, writer/readiness preflight, per-surface key/paste encoding
- Persistent on-screen armed treatment, disarm rules, commands, and tests
- Content-free per-target failure summary

**Out of scope**

- Multiple writers for one terminal or bypassing Plan 038 grants
- Broadcasting mouse, resize, clipboard requests, query responses, or host control
- Background/global “all terminals” defaults
- Storing, replaying, scheduling, templating, or logging user input
- Sending one terminal's encoded byte sequence to another terminal

## Steps

### Step 1: Specify the threat model and finite state machine

Define `inactive`, `selecting`, `armed`, `sending`, and `faulted/disarmed` states.
List automatic disarm events: Window/session navigation, membership change,
terminal restart/epoch change, reconnect, writer/control loss, read-only target,
paste prompt cancellation, app blur if product review chooses, and any partial
send. Define what happens when a target exits between preflight and send.

The initial product supports only terminals visibly selected in the current
Window. No command may default to every server/session terminal.

**Verify**: `vp test packages/yaade-app packages/yaade-ui` → exhaustive state and
disarm table tests pass.

### Step 2: Build the preflight and dispatch module

Resolve targets by stable terminal ID and epoch. Before every operation verify
surface readiness, current writer grant/fence, connection, and process state.
Encode each keyboard event independently through each surface's current Ghostty
mode. For paste, consume the exact already-approved Plan 039 value and encode
bracketed paste independently per target.

Return receipts with terminal ID plus typed success/failure only. Clear temporary
encoded buffers immediately after transport accepts/rejects them. Do not put the
operation payload in errors, diagnostics, events, or React state.

**Verify**: unit tests cover normal/application cursor, Kitty keyboard,
bracketed/non-bracketed paste, observer, reconnect, stale fence, mixed modes, and
partial transport failure.

### Step 3: Add explicit target-selection and armed UI

Add commands to start selection, toggle a visible pane, arm, and disarm. Show a
persistent semantic warning treatment while armed with target count and a
plain-language statement that typing goes to multiple terminals. Every selected
pane gets a non-color-only marker. Provide pointer/touch disarm at all sizes.

Arming requires at least two ready writer targets and explicit confirmation.
Changing selection while armed returns to selecting; it never silently changes
the live target set.

**Verify**: headed Playwright captures selecting, armed, mixed-unavailable,
partial-failure, mobile, high-contrast, and reduced-motion states.

### Step 4: Integrate keyboard and paste without duplicate input

When armed, the group module becomes the only consumer of terminal key/paste
gestures. Prevent the focused surface's ordinary handler before dispatch so it
does not receive the input twice. Shell-level command/leader chords continue to
control YAADE and are never broadcast. IME composition remains atomic and is
broadcast only if every selected surface supports the same committed text path.

Risky paste invokes one Plan 039 confirmation that names the target count; cancel
sends zero bytes. Never show raw control/escape bytes in the preview.

**Verify**: unit tests prove one send per target, zero send to unselected targets,
zero duplicate to focused target, and zero send on cancelled paste.

### Step 5: Add real multi-PTY E2E

Create three PTYs with distinct keyboard/bracketed-paste mode fixtures. Select
two, arm, type Unicode and special keys, and assert each selected PTY receives
its own correct encoding exactly once while the third receives none. Cover one
target losing control, one exiting, reconnect, pane switch, paste cancel/confirm,
IME, and disarm. Assert no input payload appears in browser/server diagnostics.

**Verify**: run the E2E and compatibility commands three times → all pass.

## Test plan

- State/preflight: membership, epochs, leases, readiness, auto-disarm.
- Encoding: mixed terminal modes, IME, key-up, Unicode, bracketed paste.
- UI: explicit target markers, armed warning, touch/keyboard, failure summary.
- E2E: three real PTYs, exact per-target output, no unselected/duplicate input.

## Done criteria

- [ ] Broadcast can arm only for an explicit visible group with writer rights.
- [ ] Every target encodes the original gesture using its own terminal modes.
- [ ] Focused terminal receives one copy, not an ordinary plus broadcast copy.
- [ ] Any authority/readiness/membership fault disarms conspicuously.
- [ ] Input content is never persisted, logged, emitted generically, or stored in React.
- [ ] Unit, type, lint, visual, compatibility, and real-PTY E2E gates pass.

## STOP conditions

- The host cannot preflight writer rights/fences for every target.
- Atomic all-target delivery is advertised even though partial sends are possible.
- A shared encoded byte payload would be reused across terminals.
- Broadcast must intercept YAADE leader/command chords or mouse/query traffic.
- Paste content would bypass Plan 039 or enter diagnostics/state.

## Maintenance notes

Treat broadcasting as an input adapter over existing terminal writers, not a new
transport or control plane. New input kinds are denied until they define
per-target encoding, authorization, privacy, and partial-failure semantics.
