# Plan 039: Harden terminal clipboard, paste, links, and screen-reader behavior

> **Executor instructions**: Complete Plans 023, 034, 035, and 037. Preserve all
> pre-existing working-tree changes. Read
> `packages/yaade-ui/AGENTS.md`; use the accessibility and web verification
> workflows if available. Do not weaken terminal conformance, answer PTY queries
> in the browser, or mirror unbounded output into DOM/React. Clipboard access is a
> security boundary: default deny remote reads and require user intent for writes.
> Update this plan and `plans/README.md` to `DONE` after security, accessibility,
> compatibility, and Playwright gates pass.
>
> **Drift check (run first)**:
>
> ```bash
> git status --short
> git diff --stat a0bb3fc9..HEAD -- \
>   apps/server/src/{terminal,runtime,wire}.rs crates/ghostty-vt \
>   packages/ghostty-core/src packages/ghostty-react/src \
>   packages/yaade-rpc/src packages/yaade-host-client/src \
>   packages/yaade-ui/src/panels packages/yaade-app/src/{mux,commands} \
>   tests/{security,web/e2e}
> git diff --stat -- \
>   apps/server/src/{terminal,runtime,wire}.rs crates/ghostty-vt \
>   packages/ghostty-core/src packages/ghostty-react/src \
>   packages/yaade-rpc/src packages/yaade-host-client/src \
>   packages/yaade-ui/src/panels packages/yaade-app/src/{mux,commands} \
>   tests/{security,web/e2e}
> ```

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 023, 034, 035, and 037
- **Category**: security / accessibility / terminal UX
- **Planned at**: commit `a0bb3fc9`, 2026-08-30
- **Source finding**: Superlogical terminal safety, clipboard, search, and accessibility quality

## Why this matters

The terminal has bracketed paste and a labeled hidden textarea, but there is no
explicit OSC 52 clipboard policy, risky-paste confirmation, or useful
screen-reader representation of terminal rows. A malicious remote program must
not silently read or overwrite a user's clipboard. At the same time, users who
rely on assistive technology need bounded navigation and announcements rather
than a canvas plus an invisible input labeled only "Terminal input".

Plan 034 owns terminal search. This plan owns secure clipboard/paste/link
interaction and an opt-in accessible terminal mode that shares the same terminal
state without creating an unbounded DOM renderer.

## Current state

- `terminal-input-writer.ts` and terminal keybindings already support bracketed
  paste and send bytes through the typed terminal API.
- Ghostty parsing remains host-authoritative after Plan 023; browser cores use
  `responsePolicy: "render-only"` and must not answer OSC/CSI queries.
- The active surface includes a hidden labeled textarea and semantic scrollbar,
  but no bounded screen-reader row model or live-output announcement policy.
- `SemanticTerminalView.tsx` renders visible row text but is not the active
  process terminal and omits full semantics/accessibility.
- OSC 8 hyperlinks and clipboard sequences are untrusted terminal-originated
  content. Device trust does not make a remote process trusted.

## Safety and accessibility contract

- OSC 52 **read/query** is denied by default and receives a terminal-compatible
  empty/denied response from the host authority only when required. It never
  causes browser clipboard read.
- OSC 52 **write** becomes a bounded clipboard request control event. Default is
  prompt/deny; allow-once requires a user gesture. Persistent policy is scoped to
  verified host identity and direction, never command/process.
- Payload size, encoding, target, frequency, timeout, and concurrent-prompt limits
  are strict. Clipboard bytes never enter logs, errors, audit, or React state.
- Multiline/control-character paste prompts before sending unless the user has a
  deliberate scoped setting. The preview is bounded and escaped; confirmation
  sends the exact original through normal bracketed-paste framing once.
- Accessible mode exposes only a bounded viewport/page window, supports row
  navigation and selection, and announces typed status/events without announcing every paint.

Any new `@yaade/app` unit test file must also be listed in
`packages/yaade-app/package.json`, per repository convention.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Parser/server | `vp run test:server && vp run test:ghostty:parity` | OSC/control behavior passes |
| UI units | `vp test packages/ghostty-core packages/ghostty-react packages/yaade-ui packages/yaade-app` | a11y/clipboard/paste tests pass |
| Security | `vp exec playwright test --project=platform-e2e tests/security/terminal-clipboard.security.spec.ts` | abuse cases pass |
| E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/terminal-accessibility.web.spec.ts tests/web/e2e/terminal-compatibility.web.spec.ts` | accessible mode and PTY output pass |

## Scope

**In scope**

- Host-authoritative OSC 52 policy and typed clipboard-request events
- Browser clipboard adapter, permissions/preferences, and security tests
- Multiline/control paste confirmation and exact bracketed-paste behavior
- OSC 8 link validation/open confirmation
- Bounded accessible terminal row/navigation/announcement mode
- High-contrast/reduced-motion/mobile/keyboard Playwright verification

- Test manifests/scripts required by this plan, including
  `packages/yaade-app/package.json`

**Out of scope**

- Terminal scrollback search; Plan 034
- Browser-side PTY query responses
- An unbounded DOM mirror or terminal transcript in React state
- Automatic URL fetch/preview or opening non-web/custom schemes
- Native platform accessibility rewrite; Plan 043 supplies platform evidence

## Steps

### Step 1: Freeze clipboard, paste, link, and accessibility threat models

Define untrusted sources, requested operations, default decision, size/rate/time
limits, response behavior, preference scope, and audit metadata for OSC 52 read,
OSC 52 write, ordinary copy, paste, drag/drop, and OSC 8 link open. Include
malicious base64, huge payloads, repeated requests, hidden terminals, observer
clients, unverified hosts, and clipboard permission races.

Define accessible mode semantics: focused row, active/current screen, bounded
history page, live status announcement, output batching, alternate screen, wide
cells, sensitive-screen pause, and what is deliberately not announced.

**Verify**:

```bash
vp run test:terminal:protocol
```

Expected: tables/constants have exhaustive unit fixtures before side effects are added.

### Step 2: Expose host-authoritative clipboard requests without content leaks

Use the Plan 023 native parser owner to classify OSC 52 target/query/write.
Decode with strict base64 and decoded-byte limits before publishing a reliable,
replaceable-or-expiring control request bound to terminal/server epoch and
sequence. Do not include payload in generic EventHub broadcasts or diagnostics;
use a targeted authorized writer channel with one in-flight request.

Only the host writes a protocol reply if Ghostty/app semantics require one.
Observer clients cannot receive/approve requests. On timeout, disconnect, host
identity mismatch, or oversized payload, deny and clear bytes.

**Verify**:

```bash
vp run test:server
vp run test:ghostty:parity
```

Expected: known OSC fixtures preserve terminal state, write requests are bounded,
reads never invoke a client clipboard, and logs contain no payload.

### Step 3: Add an explicit clipboard permission adapter and prompt

Define a narrow app port for clipboard write/read used only after policy/user
action. Map verified host identity plus direction to `ask`, `deny`, or reviewed
`allow`; default remote write is `ask` and read is `deny`. Browser APIs execute
inside the click/keyboard confirmation gesture and report typed unavailable/
denied errors.

Show origin host, terminal title only if privacy settings allow it, operation,
byte count, and escaped bounded preview. Provide **Copy once** and **Deny**;
persistent allow must be a separate settings action with strong warning. Clear
request bytes on every terminal transition.

**Verify**:

```bash
vp exec playwright test --project=platform-e2e tests/security/terminal-clipboard.security.spec.ts
```

Expected: prompt, deny, allow-once, timeout, hidden/observer, revoked-host,
permission-denied, and flood cases pass without content artifacts.

### Step 4: Add risky-paste confirmation without breaking bracketed paste

Classify paste as risky when it contains newline, NUL/control characters,
terminal escape sequences, exceeds the visible safe preview, or targets an
unverified/disconnected terminal. Intercept browser paste before encoding; show a
compact modal/drawer with line/byte count and escaped start/end preview. Never
interpret ANSI/HTML in the preview.

Confirmation sends the exact original value once through
`createTerminalInputWriter`, retaining bracketed-paste markers and writer lease
checks. Cancel sends zero bytes and restores focus. Single-line ordinary paste
remains one gesture. Add an explicit per-host/session preference if product
review approves bypass; never default bypass for remote hosts.

**Verify**:

```bash
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-accessibility.web.spec.ts
```

Expected: PTY output proves exact confirmed bytes and zero cancelled bytes for
plain, multiline, Unicode, controls, huge values, reconnect, and mobile paste.

### Step 5: Validate terminal-originated hyperlinks

Render OSC 8 links as styled interactive overlays using existing renderer hit
maps. Accept only bounded `http`/`https` by default; normalize URL and reject
credentials, controls, dangerous schemes, and oversized values. Opening is an
explicit user gesture with destination shown; external navigation uses
`noopener,noreferrer` and the Tauri adapter from Plan 043.

Link focus/navigation must not send keys to the PTY. Copy-link uses the ordinary
user-initiated clipboard path, not OSC policy.

**Verify**:

```bash
vp test packages/ghostty-core packages/ghostty-react packages/yaade-ui
vp exec playwright test --project=platform-e2e tests/security/terminal-clipboard.security.spec.ts
```

Expected: safe links activate; javascript/file/custom/credential/control/huge
URLs fail without navigation.

### Step 6: Add bounded accessible terminal mode

Create a renderer-neutral accessibility projection from Plan 033/034 row models,
outside React state: current visible rows plus a small navigated page, stable row
IDs, text, wrap relation, cursor/selection, and concise style/link semantics.
Expose a roving row/list/grid structure only while accessible mode is enabled.
Use requestAnimationFrame/idle batching and cap DOM nodes regardless of history.

Provide commands to toggle mode, move/read row, next/previous page, copy
selection, jump live, and find. Keep the hidden input correctly labeled with
status and view-only reason. Use `aria-live` only for explicit lifecycle events,
control requests, paste/clipboard outcomes, and user-enabled batched new-line
announcements; never announce every cell patch.

**Verify**:

```bash
vp test packages/ghostty-core packages/ghostty-react packages/yaade-ui packages/yaade-app
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-accessibility.web.spec.ts
```

Expected: accessibility tree has bounded meaningful rows, navigation follows
exact terminal content, output flood does not create DOM/memory growth, and PTY
keyboard behavior remains correct.

### Step 7: Run full compatibility, security, and visual gates

Cover Canvas/WebGL, raw/semantic attach, alternate screen, IME, bracketed paste,
mouse mode, six panes, observer mode, narrow mobile, high contrast, reduced
motion, 200% zoom, and screen-reader mode under flood. Assert real PTY output,
not only browser events.

**Verify**:

```bash
vp run typecheck
vp run lint
vp run test:server
vp run test:web
vp run test:ghostty:parity
vp exec playwright test --project=platform-e2e tests/security/terminal-clipboard.security.spec.ts
vp exec playwright test --project=web-e2e \
  tests/web/e2e/terminal-accessibility.web.spec.ts \
  tests/web/e2e/terminal-compatibility.web.spec.ts
vp run build:web
```

Expected: all commands pass; runtime screenshots and accessibility snapshots
cover prompts, links, accessible rows, mobile, and high-contrast states.

## Test plan

- OSC 52 query/write targets, malformed/huge/base64, flood, hidden/observer,
  timeout/revoke, redaction.
- Paste exactness/cancel with bracketed mode, reconnect, Unicode, controls, mobile.
- Link schemes, normalization, userinfo, controls, huge values, focus behavior.
- Accessible projection bounds, wide/wrapped/alternate rows, selection, pages,
  flood memory/DOM, live announcements.
- Full PTY compatibility and renderer matrix.

## Done criteria

- [ ] OSC 52 reads are denied by default and never read browser clipboard silently.
- [ ] OSC 52 writes require bounded policy/user intent and never leak payloads.
- [ ] Risky paste prompts and sends exact bracketed content only after confirmation.
- [ ] Terminal links validate schemes/destination and open only on user gesture.
- [ ] Accessible mode exposes bounded exact rows and useful navigation/announcements.
- [ ] No unbounded DOM/React terminal content is introduced.
- [ ] Security, a11y, compatibility, real-PTY, type, lint, and build gates pass.

## STOP conditions

- Clipboard query handling requires a browser-side terminal query response.
- Clipboard/paste bytes enter generic events, React state, logs, or diagnostics.
- Accessible mode requires mirroring full scrollback into DOM or React.
- A permission is persisted without verified host identity and explicit settings action.
- Paste confirmation changes bytes, sends twice, or bypasses the writer lease.
- Link handling allows executable/local/custom schemes by default.

## Maintenance notes

Treat every terminal-originated capability request as hostile even on a paired
host; the process may be untrusted. Keep accessibility projections bounded and
renderer-neutral so Canvas, WebGL, browser, and native shells share behavior.
Run the malicious-sequence corpus on every Ghostty parser upgrade.
