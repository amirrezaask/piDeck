# Plan 036: Surface truthful session activity, lifecycle history, archives, and notifications

> **Executor instructions**: Complete Plans 032, 033, and 035 first. Preserve all
> pre-existing working-tree changes. This plan
> adds product intelligence from typed lifecycle/semantic events; it must not log
> terminal input, infer commands from arbitrary output, or put PTY output in
> React state. Read `packages/yaade-ui/AGENTS.md` before UI work and verify every
> visible state with Playwright. Update this plan and `plans/README.md` to `DONE`
> after all gates pass.
>
> **Drift check (run first)**:
>
> ```bash
> git status --short
> git diff --stat a0bb3fc9..HEAD -- \
>   apps/server/src/{model,runtime,store,terminal,diagnostics}.rs \
>   packages/yaade-rpc/src/{mux-session,routes}.ts \
>   packages/yaade-host-client/src \
>   packages/yaade-app/src/{mux,commands} \
>   packages/yaade-ui/src packages/yaade-shared/src \
>   tests/{runtime,web/e2e,web/durability}
> git diff --stat -- \
>   apps/server/src/{model,runtime,store,terminal,diagnostics}.rs \
>   packages/yaade-rpc/src/{mux-session,routes}.ts \
>   packages/yaade-host-client/src \
>   packages/yaade-app/src/{mux,commands} \
>   packages/yaade-ui/src packages/yaade-shared/src \
>   tests/{runtime,web/e2e,web/durability}
> ```

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: Plans 032, 033, and 035
- **Category**: product UX / persistence / notifications
- **Planned at**: commit `a0bb3fc9`, 2026-08-30
- **Source finding**: Superlogical session intelligence, archive, and completion visibility parity

## Why this matters

YAADE exposes low-level terminal status and output activity, but users managing
many sessions cannot quickly answer: which background terminal needs attention,
what finished while I was away, what failed, or what was archived. Archive and
restore routes exist on the host, yet the product lacks an archive/history
workflow. A bounded, content-free lifecycle ledger and attention model can make
the multiplexer useful at scale without pretending it understands every shell
command.

## Current state

- `MuxTerminal` already includes `status`, `processState`, `activityState`,
  `exitCode`, revision, output sequence, and generation.
- `runtime.rs::start_lifecycle_listener` maps PTY exit to succeeded/failed and
  emits terminal updates.
- `terminal_control.rs` tracks `last_input_at`, `last_output_at`, and writer
  lease state for active PTYs, but that data is not a durable user workflow.
- `store.rs` implements `archive_session`, `restore_session`, and
  `list_snapshots(include_archived)`. The visible Session switcher only lists the
  active client catalog and has no archive/history view.
- Session/terminal title helpers mostly derive static titles; no central
  attention-state aggregation or notification preference exists.
- A full transcript or inferred command line would be sensitive. The product
  must use explicit lifecycle and negotiated semantic markers only.

## Target contract

- One server-owned, bounded event ledger records lifecycle metadata only:
  terminal/session IDs, typed event, generation/revision, status, timestamps,
  exit code, and explicit semantic marker identifiers. It never records input or
  output text.
- Terminal attention is a finite state (`none`, `running-background`,
  `completed`, `failed`, `interrupted`, `control-request`) with deterministic
  clear/acknowledge rules.
- Session attention is a pure aggregation over visible terminals, not a separate
  mutable truth.
- Shell/agent task completion is shown only when provided by an explicit,
  validated integration marker. Quiet output is labeled "idle", not "done".
- Notifications are opt-in, deduplicated, rate limited, redacted by default, and
  never required for in-app correctness.

Any new `@yaade/app` unit test file must also be listed in
`packages/yaade-app/package.json`, per repository convention.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Server | `vp run test:server` | ledger/aggregation/retention tests pass |
| Client | `vp test packages/yaade-host-client packages/yaade-app packages/yaade-ui` | store and UI tests pass |
| E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/session-activity.web.spec.ts` | activity/archive/notification cases pass |
| Full | `vp run typecheck && vp run lint && vp run build:web` | exit 0 |

## Scope

**In scope**

- Typed content-free lifecycle ledger and retention
- Deterministic terminal/session attention derivation
- Activity/status indicators, archive/history UI, acknowledge behavior
- Opt-in browser notification adapter and shared notification port
- Command-registry actions and unit/Playwright tests

- Test manifests/scripts required by this plan, including
  `packages/yaade-app/package.json`

**Out of scope**

- Parsing prompts or terminal text to guess shell commands
- Storing raw command input or transcript in the lifecycle ledger
- Provider-specific agent APIs or a standalone agent-chat surface
- Desktop native notification implementation; Plan 043 provides the adapter
- Process survival across host restart

## Steps

### Step 1: Define lifecycle and attention semantics before UI

Add Effect Schema/domain types for event kind, attention state, source, and
bounded cursor page. Write a transition table for spawn, output, explicit task
start/finish marker, process exit, interruption, restart generation, archive,
restore, and control request. Define foreground/current terminal separately from
browser page visibility.

Specify clear rules: viewing a terminal acknowledges completed/failed attention
only after the current event cursor was presented; new events after that cursor
re-arm it. Idle never implies completion. Archive removes attention from active
aggregation without deleting history.

**Verify**:

```bash
vp run test:terminal:protocol
vp test packages/yaade-app
```

Expected: exhaustive transition/table tests pass and unknown events fail decode.

### Step 2: Persist a bounded, redacted lifecycle ledger

Add an append/query/ack owner alongside persisted workspace state. Use monotonic
per-server event IDs and timestamps; bind entries to terminal generation. Apply
explicit count/age/byte retention and atomic archive/session deletion behavior.
Do not serialize title, CWD, command text, PTY bytes, OSC payloads, or environment.

Extend existing startup reconciliation so interrupted events are emitted once,
not on every boot. Add cursor-based pagination and typed retention-gap responses.

**Verify**:

```bash
vp run test:server
```

Expected: transition, restart idempotence, pagination, retention, archive/restore,
and no-content serialization tests pass.

### Step 3: Accept only explicit semantic task markers

Use Plan 023/033's native Ghostty semantic owner for negotiated OSC 133-style or
other reviewed task boundary markers. Validate maximum field sizes and discard
untrusted free-form command payloads. If the public parser cannot expose markers
without text parsing, ship process-exit/idle states only and document the missing
integration; do not scrape rows.

Label sources in the model so UI can distinguish **process exited** from an
integration-provided **task completed**.

**Verify**:

```bash
vp run test:server
vp run test:ghostty:parity
```

Expected: valid boundaries produce one typed event; malformed/oversized/spoofed
text produces no task-completion claim.

### Step 4: Add activity hierarchy and archive/history UI

In Session tabs/switcher and terminal/window tabs, add compact semantic-token
status treatment with text/accessible names, not color alone. Avoid permanent
badges on every row: show indicators only for actionable background/completed/
failed/interrupted/control states. Sorting may offer attention-first, but never
move rows while the switcher is keyboard-navigated.

Add an **Archived sessions** palette/page state inside the multiplexer using
existing host routes. Show real title, host, archived time, terminal count, and
latest lifecycle status. Restore returns the same session ID and route; delete
is explicit and destructive. Empty, error, 1-row, and many-row layouts need
intentional states.

**Verify**:

```bash
vp run test:web
vp exec playwright test --project=web-e2e tests/web/e2e/session-activity.web.spec.ts
```

Expected: scoped assertions cover row count/content/visibility, attention clear,
archive/restore/delete, multi-host identity, mobile, and reduced motion.

### Step 5: Add opt-in notification policy and adapter

Create a lower-layer notification request value and browser adapter; keep Web
Notification APIs out of server/domain packages. Prompt for permission only
after an explicit settings action. Allow per-host/session policy for failures,
interruptions, explicit task completion, and control requests. Notify only for a
background/non-current terminal and deduplicate by event ID.

Default title/body must be generic (for example, "Terminal needs attention") and
exclude server/session/terminal titles unless the user explicitly enables detail.
Clicking routes to the exact server-qualified terminal and acknowledges only the
presented event. Denied/unavailable notifications fall back to in-app attention.

**Verify**:

```bash
vp exec playwright test --project=web-e2e tests/web/e2e/session-activity.web.spec.ts
```

Expected: grant/deny/unavailable/dedup/click/rate-limit/privacy tests pass with a
mock adapter; no live OS prompt is required in CI.

### Step 6: Run persistence and accessibility gates

Restart the host with active, failed, acknowledged, and archived sessions. Prove
event/ack IDs remain monotonic, interrupted is emitted once, and active
aggregation is correct. Check labels, announcements, keyboard routes, contrast,
mobile safe areas, and no noisy `aria-live` stream for ordinary output.

**Verify**:

```bash
vp run typecheck
vp run lint
vp run test:server
vp run test:web
vp exec playwright test --project=web-e2e tests/web/e2e/session-activity.web.spec.ts
vp run build:web
```

Expected: all commands pass and runtime screenshots/DOM evidence cover every
status and archive state.

## Test plan

- Transition-table property tests and session aggregation.
- Restart, retention gap, archive/restore/delete, generation reset, acknowledge.
- Marker validation and explicit no-output-scraping tests.
- Browser notification grant/deny/dedup/privacy/click/background policy.
- UI list count/content, attention clear, keyboard/mobile/reduced motion/a11y.

## Done criteria

- [ ] Attention states are deterministic, source-labeled, and not inferred from quiet output.
- [ ] The lifecycle ledger is bounded and contains no input/output/title/CWD content.
- [ ] Users can inspect, restore, and delete archived sessions in shared UI.
- [ ] Session/terminal indicators expose background completion/failure/interruption accessibly.
- [ ] Notifications are opt-in, redacted, rate-limited, and in-app behavior works without them.
- [ ] Restart, unit, server, web, accessibility, and build gates pass.

## STOP conditions

- Completion requires parsing arbitrary terminal rows or command input.
- A ledger or metric includes PTY content, titles, CWD, or credentials.
- Attention truth is duplicated as independently mutable session state.
- Notification permission is requested on load or notification delivery becomes
  required for correctness.
- Archive restore changes the session identity or forks browser/Tauri behavior.

## Maintenance notes

Treat lifecycle history as an audit-friendly state machine, not a transcript.
New task integrations must declare exact provenance and limits. When Plan 043
adds native notifications, consume the same redacted requests and event IDs so
browser and desktop deduplicate identically.
