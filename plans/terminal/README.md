# YAADE Implementation Plans

Generated on 2026-08-30 at commit `717ed49f`, extended after the resize/TUI
audit at commit `f21fcdf4`, extended with close-latency Plan 013 against
`4341fd51`, incremental-submission Plan 014 at `7276f526`, Ghostty hot-path
Plans 015–019 at `7276f526`, the twelve-plan Ghostty split (020–031) at
`8bbcd017`, the Superlogical capability/quality review (032–044) at
`a0bb3fc9`, and the heavy-terminal UX extension (045–050) at `0739eacf`.
The roadmap modernizes the shared browser/Tauri terminal, host
lifecycle, secure multi-host product, native shells, and release quality without
creating a browser-owned agent runtime or desktop-only implementation. Execute
plans in dependency order. Every executor must read its plan fully, preserve
pre-existing working-tree changes, honor STOP conditions, and update its status.

## Execution order and status

| Plan | Title | Maps to proposal item | Priority | Effort | Depends on | Status |
|---|---|---:|---|---|---|---|
| [001](001-terminal-render-frame-seam.md) | Introduce a packed render-frame seam | 3 | P1 | L | — | DONE |
| [002](002-webgl2-terminal-renderer.md) | Add WebGL2 as the preferred renderer | 1 | P1 | L | 001 | DONE |
| [003](003-terminal-renderer-recovery.md) | Make renderer failure and recovery explicit | 6 | P1 | M | 002 | DONE |
| [004](004-worker-terminal-runtime.md) | Move Ghostty parsing off the main thread | 2 | P2 | L | 001, 003 | DONE |
| [005](005-terminal-frame-scheduler.md) | Unify scheduling and end-to-end backpressure | 5 | P2 | L | 004 | DONE |
| [006](006-webgpu-terminal-experiment.md) | Add a gated experimental WebGPU adapter | 4 | P3 | L | 002, 003, 005 | REJECTED (removed after blank WKWebView output) |
| [007](007-terminal-present-latency-benchmarks.md) | Measure resize, zoom, TUI, and presented-frame latency | — | P1 | M | 004, 005 | DONE |
| [008](008-resident-terminal-surfaces.md) | Keep terminal runtimes resident across layout changes | — | P1 | L | 004, 005, 007 | DONE |
| [009](009-complex-tui-renderer-conformance.md) | Enforce complex-TUI renderer conformance | — | P1 | L | 003 | DONE |
| [010](010-retained-gpu-scene-and-glyph-cache.md) | Add a retained GPU scene and stable glyph cache | — | P1 | L | 007, 009 | DONE |
| [011](011-packed-viewport-hot-path.md) | Keep viewport data packed through rendering | — | P2 | L | 004, 005, 010 | DONE |
| [012](012-transactional-terminal-resize.md) | Make resize and DPR changes transactional | — | P1 | L | 007, 008, 010, 011 | DONE |
| [013](013-immediate-terminal-window-close.md) | Make terminal and Window close feedback immediate and bounded | — | P1 | L | 007, 008 | DONE |
| [014](014-incremental-webgl-scene-submission.md) | Make retained WebGL scene submission incremental | — | P1 | L | 007, 009, 010, 011 | DONE |
| [015](015-byte-native-terminal-stream.md) | Keep terminal output byte-native from PTY read to Ghostty WASM | SolPro P0-1 | P1 | L | — | DONE |
| [016](016-recyclable-render-buffer-ring.md) | Recycle a bounded three-slot render-update buffer ring | SolPro P0-2 | P1 | M | 015 | DONE |
| [017](017-isolated-socket-writer-and-terminal-fanout.md) | Isolate socket writing and fan out output only to attached clients | SolPro P0-4/5 | P1 | L | 015 | DONE |
| [018](018-asynchronous-binary-terminal-history.md) | Move terminal history behind a bounded asynchronous binary pipeline | SolPro P0-6 | P1 | L | 013, 015 | DONE |
| [019](019-owned-terminal-runtime-mailboxes.md) | Give each terminal one state/control owner with bounded mailboxes | SolPro P0-3 | P1 | L | 012, 015, 017, 018 | DONE |
| [020](020-native-ghostty-source-and-abi.md) | Pin, build, and validate native libghostty-vt | SolPro P1-7 prerequisite | P2 | L | — | DONE |
| [021](021-safe-rust-libghostty-vt-wrapper.md) | Wrap libghostty-vt in a thread-confined safe Rust API | SolPro P1-7 wrapper | P2 | M | 020 | DONE |
| [022](022-native-wasm-ghostty-differential-corpus.md) | Run one terminal corpus through native and WASM Ghostty | SolPro P1-7 parity | P2 | M | 015, 020, 021 | DONE |
| [023](023-migrate-server-terminal-state-to-ghostty.md) | Replace server vt100 and custom scanners with native Ghostty | SolPro P1-7/8 migration | P2 | L | 019, 021, 022 | DONE |
| [024](024-terminal-checkpoint-restore-contract.md) | Integrate the proven Ghostty checkpoint restore contract | SolPro P1-8 checkpoint | P2 | M | 018, 022, 023, 027 | DONE |
| [025](025-worker-presentation-suppression.md) | Suppress hidden and synchronized worker frame preparation | SolPro P1-9/10 | P2 | M | 014, 015, 016 | DONE |
| [026](026-focused-terminal-worker-fairness.md) | Bound shared-worker queues and prioritize focused terminals fairly | SolPro worker priority | P2 | M | 015, 025, 027 | DONE |
| [027](027-browser-terminal-subsystem-benchmarks.md) | Build a browser terminal subsystem benchmark harness | SolPro benchmark discipline | P2 | M | 014, 015, 016, 025 | DONE |
| [028](028-ghostty-wasm-optimization-and-simd.md) | Select Ghostty WASM optimization mode and verify SIMD/features | SolPro build optimization | P2 | M | 020, 022, 027 | TODO |
| [029](blocked/029-rust-release-profile-and-packaging.md) | Measure Rust release profiles and package native Ghostty portably | SolPro release/platform | P3 | M | 020, 023, 027 | BLOCKED (023) |
| [030](030-idle-high-water-buffer-reclamation.md) | Reclaim oversized terminal buffers after measured idle periods | SolPro idle reclamation | P3 | M | 016, 018, 019, 025, 027 | DONE |
| [031](031-conditional-shaped-run-cache.md) | Add a shaped-run cache only when profiling or conformance requires it | SolPro conditional shaping | P3 | M | 009, 014, 022, 027 | TODO |
| [032](032-restart-safe-workspace-catalog.md) | Preserve the workspace catalog and terminal history across host restart | SL continuity/history | P1 | L | 018, 019 | DONE |
| [033](033-authoritative-semantic-terminal-stream.md) | Complete authoritative semantic snapshot/patch/resync streaming | SL exact reattach/observation | P1 | L | 017, 019, 022, 023 | REJECTED (wrong data plane) |
| [034](034-progressive-scrollback-search.md) | Deliver current-screen-first reattach, million-line scrollback, and search | SL history/search/perf | P1 | L | 018, 023, 024, 027 | TODO |
| [035](035-command-registry-and-palette.md) | Centralize commands and ship command/session palettes | SL command discovery | P1 | M | — | DONE |
| [036](036-session-activity-history-notifications.md) | Surface truthful activity, lifecycle history, archives, and notifications | SL session intelligence | P2 | L | 024, 032, 035 | TODO |
| [037](037-secure-host-onboarding-and-device-trust.md) | Turn device auth into secure remote-host onboarding and trust management | SL pairing/remote trust | P1 | L | — | TODO |
| [038](038-device-scoped-collaboration-and-control.md) | Add device-scoped collaboration, presence, roles, and control transfer | SL collaboration | P2 | L | 024, 035, 036, 037 | TODO |
| [039](039-terminal-safety-and-accessibility.md) | Harden clipboard, paste, links, and screen-reader behavior | SL safety/accessibility | P1 | L | 023, 034, 035, 037 | TODO |
| [040](040-protocol-conformance-fuzz-compatibility.md) | Gate releases on conformance, fuzzing, and version compatibility | SL correctness/security | P1 | L | 015, 017, 018, 022–024, 037–039 | TODO |
| [041](041-chaos-soak-and-durability-gates.md) | Prove reconnect, restart, multi-host, and resource durability | SL reliability/soak | P1 | L | 018, 019, 024, 032, 037, 040 | TODO |
| [042](042-operational-telemetry-diagnostics-slos.md) | Establish content-safe diagnostics, telemetry, and enforced SLOs | SL operations/quality | P1 | L | 027, 032–034, 040, 041 | TODO |
| [043](043-shared-native-desktop-ios-shells.md) | Harden Tauri desktop and validate an iOS/iPadOS remote shell | SL native platforms | P2 | L | 029, 035, 037, 039, 041 | TODO |
| [044](044-signed-release-and-safe-updates.md) | Ship signed releases and non-surprising updates | SL distribution/lifecycle | P3 | L | 029, 032, 040, 042, 043 decision | TODO |
| [045](045-scroll-lock-unseen-output.md) | Keep inspected scrollback anchored and surface unseen output | Heavy UX scroll inspection | P1 | M | 035 | DONE |
| [046](046-keyboard-copy-mode-shell-marks.md) | Add keyboard copy mode and shell-mark navigation | Heavy UX copy/marks | P2 | L | 034, 035, 036 | TODO |
| [047](047-user-configurable-keymaps.md) | Add validated user-configurable keymaps and leader keys | Heavy UX keymaps | P2 | M | 035 | DONE |
| [048](048-explicit-input-broadcast-groups.md) | Broadcast input safely to an explicit terminal group | Heavy UX synchronized input | P3 | M | 035, 038, 039 | TODO |
| [049](049-named-window-layout-templates.md) | Save and apply named Window layout templates | Heavy UX reusable layouts | P2 | L | 032, 035 | TODO |
| [050](050-mru-terminal-switching.md) | Make terminal switching MRU-first with truthful status previews | Heavy UX navigation | P1 | M | 035 | DONE |

Status values: `TODO`, `IN PROGRESS`, `DONE`, `BLOCKED (<reason>)`, or
`REJECTED (<reason>)`.

Plan 002 result: WebGL2 remains the fallback default after its self-test. After
batching same-style text into atlas runs, three Apple M4 runs measured stream
medians of 271.5/283.0/266.5 ms, flood medians of 77.6/76.4/76.6 ms, idle typing
medians of 11.7 ms, and under-flood typing medians of 8.7/8.4/11.9 ms.

Plans 004 and 005 now run by default by explicit operator direction. The worker
pool transfers packed updates, ACKs only parsed sequences, recovers through
host replay, and feeds a bounded scheduler that measures received, posted,
parsed, and presented stages. The local benchmark did not show a p95 gain, so
no performance claim or budget change accompanies the rollout.

Plan 006 was removed after a real WKWebView run produced a blank terminal despite
successful capability initialization. WebGL2 and Canvas remain the complete
renderer ladder until WebGPU has reliable cross-WebView presentation tests.
See `docs/terminal-renderers.md` for measurements and compatibility details.

Plans 007–012 now share one presented-frame clock, resident terminal placement,
backend-neutral decoration/cursor geometry, a retained WebGL row scene with
stable cluster caching, a packed lazy viewport, and one generation-aware
geometry coordinator. WebGL capture uses a test-only framebuffer while the
production context keeps `preserveDrawingBuffer` disabled. Responsive and pane
layout changes move the existing surface without PTY/runtime/renderer reattach;
local and host geometry commits are coalesced latest-wins.

Plan 013 addresses the next observed interaction bottleneck outside rendering:
terminal and Window close currently wait on serial host teardown, full-state
persistence, and synchronous history finalization. It adds immediate local
feedback while preserving explicit-close process termination and authoritative
revision ordering.

Plan 014 turns the retained WebGL scene into an actually incremental submission
path. Cursor-only frames perform no terminal-scene transfer, stable-topology
row updates patch exact GPU ranges, and topology/barrier changes retain a
bounded full-compaction fallback.

Plans 015–031 turn the SolPro Ghostty comparison into executable ownership and
measurement work. Plans 015–019 cover byte transport, recyclable frame buffers,
socket/fan-out isolation, asynchronous history, and terminal actor ownership.
Plans 020–031 are twelve separate plans for native source/ABI, a safe Rust
wrapper, native/WASM parity, server migration, checkpoint feasibility, worker
presentation suppression, worker fairness, browser subsystem benchmarks, WASM
optimization/SIMD, Rust release packaging, idle buffer reclamation, and a
conditional shaped-run cache.

Plans 032–044 convert the broader Superlogical product comparison into separate,
non-overlapping execution units. They extend the existing terminal ownership,
Ghostty, checkpoint, history, and benchmark work rather than replacing it.

Plans 045–050 add the remaining heavy-terminal workflows requested on
2026-08-31. They do not duplicate the existing roadmap: Plan 034 already owns
current-screen/input readiness, cold scrollback, and find; Plan 035 owns the
command palette; Plan 036 owns attention/notifications; and Plan 039 owns risky
paste and safe links. The new plans cover inspection/unseen output, keyboard copy
mode and shell marks, keymap overrides, explicit input groups, reusable layout
templates, and MRU switching.

## Superlogical capability review disposition

The review found a strong existing base that does **not** need parity plans:
server-owned PTYs; browser disconnect survival; named Sessions and Windows;
app-level tiled panes; multi-host routing; binary raw streaming with replay and
flow control; writer/observer leases; responsive/mobile terminal controls;
Ghostty worker/WebGL rendering; loopback/off-loopback auth policy; device-auth
cryptographic primitives; and substantial browser/server tests. In particular,
split panes are not a blocker: YAADE's Window dock tree already supports tiled
terminal panes.

The demonstrated gaps and their owners are:

| Demonstrated evidence at `a0bb3fc9` | Disposition |
|---|---|
| Host startup calls `reset_runtime_state`, discarding persisted Session/Window/terminal rows | Plan 032 preserves metadata/history and marks dead PTYs interrupted; it does not promise process resurrection |
| Attach lacks a restorable snapshot/READY cut; v3 wraps JSON and semantic diffs are not exact parser state | Plan 024 integrates public Ghostty snapshots plus ordered raw bytes; Plan 033 is rejected |
| Reattach requests full history from the oldest page; browser Ghostty caps scrollback at 10,000 rows; no integrated find | Plan 034 adds current-screen-first handoff and bounded indexed cold rows/search |
| Commands are split between IDs, a component switch, empty prefix groups, and separate pickers | Plan 035 creates one registry and searchable command/session palettes |
| Low-level activity exists but no content-free lifecycle ledger, attention model, archive workflow, or notifications | Plan 036 adds truthful explicit-source session intelligence |
| Pairing/challenge/revocation primitives exist, while onboarding, fingerprint comparison, safe browser key storage, and device management are incomplete | Plan 037 productizes secure remote trust |
| Writer/observer and control-transfer routes exist, while resource grants, invitations, collaboration presence, and authorization UX are absent | Plan 038 adds device-scoped collaboration with one writer |
| Bracketed paste and a labeled hidden input exist, while OSC 52 policy, risky-paste guard, safe links, and bounded screen-reader rows do not | Plan 039 owns terminal safety/accessibility; Plan 034 owns find |
| CI is broad but lacks a unified decoder manifest, malformed-input fuzz/sanitizers, and previous/current protocol gate | Plan 040 adds conformance/fuzz/compatibility |
| Reconnect tests exist but deterministic cross-layer chaos, platform process cleanup, and long resource soaks are not release gates | Plan 041 adds failure and soak tiers |
| Diagnostics redact keys but do not provide a content-safe support bundle, metric taxonomy, phase tracing, or enforced SLO report | Plan 042 adds operational quality gates |
| Tauri is a thin single-window shell with null CSP and limited native lifecycle; no validated iPhone/iPad remote shell | Plan 043 hardens desktop and gates iOS/iPadOS without a fourth app |
| Build/package work does not yet cover signing, provenance, safe active-terminal update, promotion, and rollback | Plan 044 adds distribution lifecycle after Plan 029 |

Three comparison expectations are constrained rather than silently promised:

1. PTYs cannot survive **host process** death without a detached supervisor,
   which the project architecture explicitly rejects. Plans 032/041 preserve
   catalog/history, kill descendants safely, and represent interruption honestly.
2. iPhone/iPad is remote-only. It may embed the shared client after Plan 043's
   feasibility gate; it may not run a local server, PTY, or coding agent.
3. YAADE remains a terminal multiplexer. No plan adds standalone Git, file,
   editor, search, agent-chat, cloud account, or browser process-control surfaces.

## Dependency notes

- **001 before 002:** WebGL2 must consume a renderer-neutral packed update, not
  couple directly to `GhosttySnapshot` or duplicate Canvas traversal logic.
- **003 before 004:** context-loss and adapter replacement need to work before a
  worker introduces another failure domain.
- **004 before 005:** scheduling ownership can only be finalized after the
  parser's thread and message acknowledgement points are known.
- **006 result:** WebGPU was removed after blank WKWebView output. Plans 009 and
  010 target the shipped WebGL/Canvas ladder; any future adapter must first pass
  its own browser/Tauri compatibility gate and then join these contracts.
- **007 before performance fixes:** current benchmarks can complete before GPU
  presentation; later plans need a trustworthy presented-frame endpoint.
- **008 after 007:** terminal residency needs lifecycle IDs/counters that prove a
  layout move did not recreate, reattach, or replay the terminal.
- **009 before 010:** atlas/model changes are unsafe until decorations, cursor,
  wide/combining glyphs, and fractional-DPR geometry have differential guards.
- **010 before 011:** packed hot-path access should target the final retained
  scene interface, not force two renderer-model migrations.
- **012 after renderer/residency work:** resize coordination relies on stable
  residency, cheap full-scene composition, packed model application, and
  presented-frame measurement.
- **013 after 007/008:** close latency needs trustworthy next-paint measurement
  and the resident-session lifecycle seam so optimistic placement removal never
  becomes PTY disposal by accident.
- **014 after 010/011:** incremental GPU ranges depend on the retained row scene
  and packed lazy viewport. Plan 009 remains the semantic guard; Plan 007 owns
  presented-frame measurement.
- **015 before 016/017/018/019:** byte ownership must be explicit before worker
  transfer recycling, socket fan-out, history ownership, or terminal actors
  remove their current string-shaped seams.
- **016 after 015:** both change the worker protocol; finish byte commands first,
  then add render-buffer return without restoring string writes.
- **017 after 015:** attached-only subscribers share one immutable byte frame;
  the active socket mailbox must not encode terminal strings again.
- **018 after 013/015:** Plan 013 establishes kill-before-history close and a
  close-finalization seam; Plan 015 establishes exact binary records. Plan 018
  deepens both into the full asynchronous ingest/compression/index pipeline.
- **019 after 017/018:** a terminal actor can publish nonblocking to isolated
  subscribers and enqueue history without retaining socket or disk work.
- **020 independently:** native source/static build/ABI validation can land
  before server integration and must not acquire terminal policy.
- **021 after 020:** safe ownership/callback/render lifetimes depend on validated
  bindings but remain independent from `apps/server`.
- **022 after 015/020/021:** the differential runner needs exact byte fixtures,
  a native wrapper, and the same-revision WASM loader.
- **023 after 019/021/022:** migrate only after the terminal actor can confine the
  native handle and parity fixtures explain semantic differences.
- **024 after 018/022/023/027:** snapshot integration needs indexed history,
  server/native parity, and measured maximum-history raw replay. The pinned ABI
  now provides complete public snapshot restore.
- **025 after 014/015/016:** hidden/synchronized suppression relies on byte
  commands, recyclable slots, and stabilized retained-renderer semantics.
- **027 after 025:** subsystem metrics must include final hidden/synchronized
  presentation ownership before later scheduling/build decisions consume them.
- **026 after 027:** add worker priority only when the shared-worker contention
  fixture proves FIFO misses focused latency or fairness targets.
- **028 after 020/022/027:** compare WASM modes/features with exact source,
  semantic parity, and stable startup/throughput/memory measurements.
- **029 after 020/023/027:** release-profile and packaging candidates must contain
  the final native server dependency and use fixed benchmark workloads.
- **030 after buffer/history/actor/suppression/benchmark foundations:** reclaim
  only owner-safe transient high-water capacity with measured hysteresis.
- **031 after 009/014/022/027:** a shaped-run cache is conditional on conformance
  or profiling and must preserve Canvas as correctness oracle.
- **032 after 018/019:** restart-safe catalog reconciliation needs durable
  archive ownership and a single terminal lifecycle owner; it keeps host death
  process-destructive.
- **033 is rejected:** semantic screen diffs are not the capable-client data
  plane; Plan 024 owns snapshot plus ordered-byte replication.
- **034 after 018/023/024/027:** current-screen-first handoff and cold indexed
  rows depend on exact history, the final parser authority, snapshot integration,
  and benchmark fences.
- **035 independently:** the command registry can land early and becomes the
  source for later activity, collaboration, accessibility, and native menus.
- **036 after 024/032/035:** truthful history/activity uses durable lifecycle,
  replicated terminal markers, and stable command surfaces.
- **037 independently:** secure pairing productizes existing device-auth owners
  and is required before collaboration or remote-native credential work.
- **038 after 024/035/036/037:** collaboration needs exact observer state, stable
  commands/activity events, and verified device identity.
- **039 after 023/034/035/037:** OSC policy belongs to the native parser owner;
  accessibility consumes paged rows and commands; permissions bind verified hosts.
- **040 after protocol/security product paths settle:** one decoder manifest and
  compatibility gate must include semantic, auth, collaboration, and terminal-
  capability boundaries rather than being repeatedly rebuilt.
- **041 after 040:** chaos/soak consumes deterministic protocol reproducers and
  validates the final restart/semantic/trust owners under system faults.
- **042 after benchmark/chaos foundations:** SLOs and support diagnostics combine
  measured phase, resource, correctness, and recovery artifacts.
- **043 after 029/035/037/039/041:** native shells need portable artifacts,
  stable command IDs, trusted credentials, terminal safety, and durability.
- **044 last:** signed promotion/update consumes exact packaged artifacts,
  compatibility/conformance, restart-safe state, SLO reports, and the accepted
  Plan 043 platform set; a blocked iOS result is not bypassed or advertised.
- **045 after 035 for commands:** viewport anchoring can be characterized first,
  but jump-live/pause must use the shared command registry. Plan 034 later
  consumes the same viewport-activity interface for cold rows.
- **046 after 034/035/036:** keyboard copy mode needs stable paged rows/search,
  stable command IDs, and explicit content-free shell markers.
- **047 after 035:** overrides compile against the final command descriptor and
  key-risk catalog instead of creating a second dispatcher.
- **048 after 035/038/039:** broadcast groups need shared commands, final
  writer/grant semantics, and one risky-paste policy before they can send input.
- **049 after 032/035:** named templates need restart-safe host persistence and
  stable commands; they reuse ordinary Window tree persistence without owning PTYs.
- **050 after 035:** MRU ranking and previous-terminal switching consume stable
  command IDs while remaining independent from Plan 036 attention truth.

## Recommended execution waves

Plans 001–014 are complete (Plan 006 was rejected and removed). Start at the
first incomplete dependency rather than rerunning completed migrations.

1. Run Plans 015 and 020 in parallel only in isolated worktrees. They establish
   byte transport and native source/ABI without depending on each other.
2. After 015, run Plans 016 and 017. After 020, run Plan 021. Merge serially where
   they share CI/docs.
3. Run Plan 022 after 015/020/021. In parallel, run Plan 018 after 015, then Plan
   019 after 017/018.
4. Plan 035 (command registry) and Plan 037 (secure onboarding) can run in
   isolated worktrees while terminal foundations progress; both touch shared app
   shells/settings, so merge them serially.
5. Run Plan 025 after 015/016. Run Plan 023 after 019/021/022.
6. Run Plan 027 after 025. Then Plans 026, 028, and 031 may run as isolated,
   measured experiments and may correctly end `REJECTED`.
7. Run Plans 024 and 029 after 023/027. Plan 024 selected Outcome A and completed
   production snapshot integration using the pinned public Ghostty interface.
   Run Plan 030 after all of its owner/benchmark dependencies.
8. Run Plan 032 after 018/019. It can proceed before native Ghostty migration but
   must reconcile Plan 023 state if that migration already landed.
9. Do not run rejected Plan 033. Run Plan 034 after Plan 024's snapshot path and
   Plan 027 measurements.
10. Run Plan 036 after 024/032/035. Run Plan 039 after 023/034/035/037. These may
    use isolated worktrees but both touch shared Session/terminal chrome.
11. Run Plan 038 after 024/035/036/037.
12. Run Plan 040 after 038/039 so the conformance manifest covers the final auth,
    collaboration, clipboard, and accessibility protocol boundaries.
13. Run Plan 041 after 040, then Plan 042 after one valid chaos/soak campaign.
14. Run Plan 043 after its native/security/durability prerequisites. Its iOS
    portion stops at the feasibility gate if any load-bearing capability fails.
15. After Plan 035, run Plans 045, 047, and 050. Serialize their app-shell and
    Settings changes; the pure viewport/keymap/MRU modules may be developed in
    isolated worktrees first.
16. Run Plan 049 after Plans 032/035. Run Plan 046 only after Plans 034–036 have
    supplied stable cold rows, search, commands, and explicit semantic marks.
17. Treat Plan 048 as an opt-in P3 safety feature after Plans 038/039; it may be
    deferred without blocking the rest of the heavy-terminal UX wave.
18. Run Plan 044 last against exact candidate artifact digests and quality reports.

Serialize plans that touch shared CI, benchmark fixtures, app shell, docs, or
this README unless they run in isolated worktrees with an explicit merge order.

## Cross-plan invariants

1. PTY bytes never enter React state.
2. Browser and Tauri continue using the same `@yaade/app` and
   `@yaade/ghostty-react` implementation.
3. `libghostty-vt` remains the terminal-state authority.
4. Canvas 2D remains the correctness oracle and guaranteed fallback.
5. Renderer, worker, or GPU failure must not close, resize, or disconnect a PTY.
6. Existing replay acknowledgements occur only after bytes have been parsed;
   rendering may lag or recover independently.
7. IME, keyboard, selection, links, synchronized output, scrollback, wide
   graphemes, zoom, DPR changes, reduced motion, and hidden panes must retain
   existing semantics.
8. Every performance claim requires `vp run test:bench` results from a release
   web build on recorded hardware.
9. Pane zoom, responsive layout changes, and browser zoom must not recreate or
   reattach a resident terminal runtime.
10. Cache pressure is routine bounded policy; it must not be reported as GPU
    context/device failure or trigger renderer recovery.
11. Canvas and accelerated backends share tested terminal semantics for complex
    TUIs, including decorations, cursor glyphs, wide/combining cells, and DPR.
12. Resize has distinct local, runtime, host, and presented generations; stale
    completions may parse but may not replace newer visible geometry.
13. Explicit close removes local placement immediately but is complete only
    after the host has accepted PTY termination and committed authoritative mux
    state; history IO may not delay or prevent process termination.
14. WebGL dirty rows govern CPU scene rebuilding and GPU buffer transfer, while
    every present still clears and draws the complete GPU-resident scene; no
    optimization may depend on preserved default-framebuffer pixels.
15. Terminal output is opaque ordered bytes through generic transport, replay,
    history, scheduling, and worker seams; only protocol parsers decode text.
16. A transferred render buffer has exactly one owner and returns through one of
    three bounded worker slots; parsing never waits for slot return.
17. Each WebSocket has one sink owner and bounded reliable/raw/semantic lanes;
    raw output overflow uses replay recovery, never latest-wins replacement.
18. Terminal output fan-out considers only attached subscribers and shares one
    immutable payload allocation across them.
19. History queues, staging, compression, and indexes are byte-bounded and
    non-lossy; accepted work has explicit written/durable shutdown barriers.
20. The blocking PTY reader only reads and submits bytes; one terminal owner
    owns mutable PTY/parser/control state and guarantees final resize/lifecycle.
21. Native and WASM Ghostty builds use one exact revision. Private Ghostty memory
    is never a YAADE persistence or wire format.
22. The safe native Ghostty terminal is thread-confined; callbacks are bounded,
    nonblocking, non-reentrant, and drained after parser writes.
23. Native/WASM parity compares public state and effect bytes from identical
    binary corpora, options, and chunk boundaries.
24. A checkpoint can ship only when fresh-parser continuation equals uninterrupted
    parsing; render rows or formatter output alone do not restore parser state.
25. Hidden/synchronized terminals continue parsing and ACKing while frame
    extraction is suppressed; safety timeout and show emit bounded catch-up.
26. Worker priority never reorders one terminal's commands, acknowledges
    unparsed bytes, exceeds coordinated bounds, or starves hidden terminals.
27. Performance gates use release artifacts, pre-generated corpora, semantic
    completion points, exact work counters, and recorded runtime/hardware context.
28. WASM mode/SIMD/feature claims come from inspected artifacts plus parity and
    startup/throughput/replay/memory measurements.
29. Rust releases remain portable and statically package exact-revision Ghostty;
    no distributed build uses `target-cpu=native`.
30. Idle reclamation frees only owner-safe transient capacity after hysteresis;
    it never drops parser, replay, history, retained scene, or queued data.
31. A shaped-run cache ships only after conformance or profiling crosses a
    predeclared threshold and Canvas/WebGL correctness gates pass.
32. Host restart preserves workspace metadata and retained history but marks
    every formerly live PTY interrupted; it never claims process continuation.
33. Semantic state is replaceable and hash/revision/epoch-checked; raw output is
    ordered and uses replay recovery. The two lanes never share overflow policy.
34. Current-screen previews cannot restore parser modes or enable input. Cold
    history/search is bounded, paged, and kept outside React/one giant DOM.
35. Keyboard, palette, native menu, context actions, and which-key consume stable
    command IDs from one registry while terminal-reserved chords pass through.
36. Lifecycle/activity/notification state records typed metadata only; it never
    infers commands from terminal text or stores a transcript.
37. Remote credentials cross confidential transport only. Device private keys
    are non-extractable/OS-backed or explicitly session-only, never silently
    persisted in localStorage.
38. Collaboration intersects device scope, resource grant, and one writer lease.
    Viewers cannot write, resize, answer queries, or discover unauthorized rows.
39. Terminal-originated clipboard/link/capability requests are untrusted even on
    a paired host. Clipboard bytes never enter generic events, logs, or state.
40. Every untrusted decoder/version boundary has deterministic vectors, bounds,
    malformed cases, and explicit compatibility behavior.
41. Chaos/soak success uses semantic completion/invariant fences and bounded
    resources, not elapsed time or absence of thrown errors.
42. Telemetry/support artifacts are allowlisted, local-first, content-free, and
    nonblocking. Performance gates use named profiles and predeclared ceilings.
43. Desktop/iOS shells are shared-client capability adapters. They never own
    PTYs/agents, fork terminal behavior, or turn viewport close into terminal close.
44. Updates verify exact signed artifacts and never restart an active host
    without explicit acknowledgement that its PTY processes will end.
45. Scroll inspection/pause anchors presentation only; PTY, parser, replay,
    history, and ACKs continue, and unseen counters remain content-free.
46. Copy mode owns navigation keys exclusively, uses bounded row/search/mark
    interfaces, and never infers shell boundaries from terminal text.
47. User keymaps compile atomically against one command registry; invalid or
    risky mappings cannot remove the pointer-accessible reset path.
48. Input broadcast targets an explicit visible writer group, encodes per
    terminal, disarms on authority/readiness drift, and never retains input.
49. Named layout templates persist neutral geometry only and never start, stop,
    close, restart, or reattach terminals.
50. MRU is bounded client-local navigation history from successful explicit
    focus; output/activity cannot reorder it and switching preserves residency.

## Existing evidence and baseline

- `packages/ghostty-react/src/surface.ts` owns DOM input/selection/scrolling and
  presentation, while a worker-backed runtime proxy owns the default Ghostty
  parser path.
- `packages/ghostty-react/src/renderer.ts` paints dirty rows with Canvas 2D
  `fillRect`, `fillText`, and `strokeRect` calls.
- `packages/ghostty-core/src/core.ts` reads Ghostty render state into mutable JS
  row/cell objects and reuses those objects across snapshots.
- `packages/yaade-ui/src/panels/terminal-output-writer.ts` already separates
  interactive microtask flushes from flood-mode animation-frame flushes and
  preserves replay acknowledgement semantics.
- `tests/bench/terminal-throughput.bench.ts` already covers stream throughput,
  TUI-like floods, idle typing, and typing during floods.
- At plan creation, relevant renderer files had uncommitted optimization work.
  Executors must not reset or overwrite it; first run `git status --short` and
  reconcile the live implementation with each plan's current-state notes.
- The 2026-08-30 resize recording shows blank terminal intervals, title fallback
  from the running TUI to the shell, responsive mobile controls appearing,
  intermediate `102×20` and `69×11` grids, and delayed partial TUI redraws.
- `use-mobile.ts` uses a 767 px CSS media query and `TerminalMultiplexer.tsx`
  replaces the desktop tree with `MobileTerminalView`; browser zoom can cross
  that breakpoint and remount `TerminalPanel`.
- Pane zoom in `TerminalTilingWorkspace.tsx` also replaces `PanelDockInDnd` with
  a separately rendered leaf, which remounts the terminal component.
- WebGL is a custom YAADE renderer over Ghostty terminal state, not Ghostty's
  native renderer. It now retains row batches and uses a non-preserved default
  framebuffer, but every dirty frame concatenates all retained rows into global
  batches and uploads the complete scene. Even an empty dirty-row set currently
  marks the scene for re-upload, so cursor blink/focus-only frames repeat that work.
- A 2026-08-30 method probe at commit `4341fd51` confirmed the static cost: an
  idle focused 180×44 terminal uploaded two 163,176-byte retained scenes plus a
  32-byte cursor in 1.25 seconds. Ten one-row updates coalesced into five
  presents, but each still uploaded a 170,612–171,132-byte complete scene
  (855,140 scene bytes total). Codify this probe before changing submission.
- A dirty row allocates three fresh typed-array batches. Row construction also
  creates per-cell color tuples and empty underline arrays, despite Plan 010's
  allocation target. WebGL counters do not expose scene-copy/upload bytes through
  the lifecycle/test bridge, so the existing benchmark cannot attribute this cost.
- Worker packed updates are validated once in `protocol.ts` and again in
  `GhosttyViewportModel.apply()`. Transferring the builder buffers detaches them,
  but `releaseRenderUpdate()` does not recycle them to the worker, so default
  worker frames allocate fresh transfer storage. Ghostty extraction still builds
  compatibility cells before UTF-8 repacking.
- The Rust PTY path decodes reads to `String`, clones text into replay, emits
  terminal bytes through `HostEvent.args`, and writes gzip-compressed JSON
  history under one archive-state mutex. Browser framing then decodes the raw
  payload to a string before the worker encodes it for Ghostty again.
- The active socket loop awaits outbound sends in the same `tokio::select!` that
  reads commands, even though `outbound_mailbox.rs` already models bounded
  reliable/raw/semantic lanes. Every socket subscribes to the global terminal
  broadcast and filters attachment locally.
- `TerminalEntry` shares writer, master, child, and state through mutexes while
  the reader performs replay/scanning/parsing/checkpoint/history/event work.
  The server still depends on `vt100`; browser WASM uses pinned libghostty-vt.
- Surface-level hidden and DEC 2026 suppression happens after the worker has
  already built/transferred updates. The WASM build is fixed to `ReleaseSmall`
  and CI does not assert SIMD instructions in the shipped artifact.
- Resident hidden surfaces keep their WebGL contexts and per-terminal atlases;
  there is no document-wide context/atlas budget or hidden-runtime update
  suppression. Atlas capacity pressure resets the whole atlas and retained scene.
- The current backend E2E proves equal retained text, dimensions, and coarse
  non-background pixel counts, not same-machine structural pixel parity.
- Presented-frame clocks now gate terminal benchmarks, but the dashboard case
  reports only total command duration and renderer generation. WebGL scene-copy,
  instance-upload, atlas, model-apply, and per-frame distributions are not yet
  available through the test bridge.
- `HostRuntime::start` opens the SQLite store and immediately calls
  `store.reset_runtime_state()`. The store otherwise persists full snapshots and
  already supports archive/restore, so restart data loss is demonstrated policy,
  not a missing storage primitive.
- Terminal history is bounded to 256 MiB per terminal, 2 GiB total, and seven
  days for closed terminals. Client archive reads are paged and yield between
  pages; these are foundations for Plan 032/034, not systems to replace.
- The attach contract already accepts `raw | semantic | both`, and the client v3
  store rejects revision/epoch gaps, but the host rejects semantic modes. The v3
  codec currently wraps `JSON.stringify(message)` in a binary envelope.
- `SemanticTerminalView` proves a shared semantic seam exists, but the active
  process-terminal path remains `TerminalPanel` and the semantic view currently
  loses full terminal styling/input/accessibility semantics.
- The Session switcher has no query/filter-or-create behavior. `TerminalSwitcher`
  already uses `PaletteShell`, so Plan 035 reuses that primitive.
- `GhosttyTerminalSurface` now owns content-free viewport activity and stable
  inspected scrollback, while `TerminalPanel` imperatively exposes unseen output
  and jump-to-live on desktop/mobile. Plan 045 completed that seam.
- Surface selection/copy and scrolling primitives exist, but there is no
  keyboard copy-mode controller or typed shell-mark navigation. Plan 046 composes
  Plan 034 rows/search with Plan 036 explicit markers.
- The keybinding catalog now compiles bounded, versioned client-local profiles
  into one effective snapshot with validated overrides, configurable leaders,
  exact PTY prefix literals, cross-tab persistence, and recovery paths. Plan 047
  completed the Settings and runtime seam.
- Window `layoutJson` already persists validated split trees with revisions, but
  embeds terminal IDs and has no reusable neutral template entity. Plan 049
  preserves this distinction.
- `TerminalSwitcher` currently iterates terminal map order and shows current/kind;
  it has no server-qualified focus history or typed status ranking. Plan 050 adds
  those without transcript thumbnails.
- Device auth already includes Ed25519 identities, pairing, challenge sessions,
  scopes, revocation, and audit records. The browser default identity store
  serializes private material to localStorage, and the UI does not complete the
  trust ceremony/device management workflow.
- Writer/observer leases and request/transfer/reclaim routes already exist.
  Collaboration work therefore adds authorization grants and UX rather than a
  second control protocol.
- `apps/desktop` is a thin Tauri shell over `@yaade/app`, starts the bundled host
  service, defines one window, and has `security.csp: null`. It remains the only
  allowed native application boundary for desktop and gated iOS/iPadOS work.
- `diagnostics.rs` currently redacts recursively but does not define support
  bundles or operational metrics. Existing benchmark ceilings are broad and do
  not cover current-screen reattach, million-line history, leak slopes, chaos,
  or release compatibility.

## Global verification gates

These are the shared baseline. Each incomplete plan adds exact security,
recovery, native, fuzz, soak, or release commands and those plan-specific gates
are mandatory.

```bash
vp test packages/ghostty-core packages/ghostty-react packages/yaade-ui
vp run typecheck
vp run lint
vp run test:server
vp run test:terminal:integration
vp run test:web
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-compatibility.web.spec.ts tests/web/e2e/terminal-multiplexer.web.spec.ts
vp run test:bench
```

Expected: all functional commands exit 0. Benchmark results must be recorded and
must satisfy the approved SLO registry/current `tests/bench/budgets.json`;
compare medians and p95/p99 against the pre-plan baseline rather than merely
passing broad legacy ceilings.

## Explicitly rejected approaches

- **Replacing Ghostty with xterm.js:** xterm's renderer is not a clean adapter
  over Ghostty state and would replace the parser/compatibility authority.
- **Making WebGPU the only backend:** Tauri uses system WebViews, while YAADE's
  macOS minimum is 11. WebGPU availability is not universal across supported
  clients.
- **Removing Canvas after WebGL ships:** Canvas is needed for compatibility,
  recovery, tests, and differential rendering checks.
- **A desktop-only native renderer:** this would fork browser and desktop
  behavior and violate the shared-client architecture.
- **Treating WebGL/WebGPU alone as the native-Ghostty solution:** the parser/state
  authority is shared, but YAADE still owns custom CPU preparation, glyph
  rasterization, GPU batching, browser compositing, and lifecycle behavior.
- **Debouncing resize until interaction end:** this hides work by making the TUI
  stale. Plan 012 instead commits at most once per frame and guarantees the final
  host grid.
- **Using `preserveDrawingBuffer` as the capture/testing strategy:** it burdens
  every production frame. Plan 010 uses a retained scene and test-only capture.
- **Moving Canvas/WebGL to OffscreenCanvas before measurement:** deferred. Plans
  004/005 remove parser contention first; Plan 007 must show remaining renderer
  submission work before another worker/canvas failure domain is justified.
- **Persisting Ghostty page memory as a checkpoint:** rejected. Plan 024 uses the
  public versioned snapshot format, never private pages, pointers, offsets, or
  allocator state.
- **Treating a compact render snapshot as restorable terminal state:** rejected.
  The pinned libghostty-vt snapshot API restores complete parser continuation;
  render projections and the synthetic bootstrap do not.
- **Adding shared-worker priority without contention evidence:** rejected by
  default. Plan 026 implements it only when measured FIFO misses explicit latency
  or fairness bounds.
- **Choosing ReleaseFast from parser throughput alone:** rejected. Plan 028 also
  measures compressed size, cold/warm startup, replay, memory, and compatibility.
- **Shipping `target-cpu=native`:** rejected for distributed server/desktop
  binaries. Plan 029 compares portable release profiles only.
- **Adding a shaped-run cache because shaping exists:** rejected by default. Plan
  031 requires a conformance gap or material profiled cost and removes failed
  prototype code.
- **Treating app-level split panes as a Superlogical parity blocker:** rejected.
  YAADE already provides tiled terminal panes inside Windows; no duplicate pane
  product is planned.
- **Adding a detached PTY supervisor to claim host-restart process continuity:**
  rejected by current architecture. Plans 032/041 preserve catalog/history,
  terminate descendants safely, and show interrupted processes honestly.
- **Loading million-line history into React, DOM, or one Ghostty allocation:**
  rejected. Plan 034 uses stable paged cold rows and a bounded viewport cache.
- **Scraping terminal output/input to infer commands or agent status:** rejected.
  Plan 036 consumes process lifecycle and explicit validated semantic markers only.
- **Using plaintext remote HTTP or localStorage private keys for smooth onboarding:**
  rejected. Plan 037 requires confidential transport and non-extractable,
  OS-backed, or explicitly session-only credentials.
- **Allowing multiple concurrent terminal writers:** rejected. Collaboration
  builds on the single writer lease and explicit request/transfer/reclaim flow.
- **Trusting OSC clipboard/link requests because the host is paired:** rejected.
  Terminal programs remain untrusted and capability requests require policy and
  user intent.
- **Forking a fourth iOS app or running local agents/PTYS on iPhone/iPad:**
  rejected. Plan 043 gates a remote-only target inside the existing Tauri app and
  shared client.
- **Silently applying a host update while terminals run:** rejected. Host restart
  ends PTYs; Plan 044 requires explicit destructive confirmation and durable
  state/history preflight.
- **Freezing a PTY to freeze the viewport:** rejected. Plan 045 pauses presentation
  anchoring only; parsing, ACKs, history, and the process continue.
- **Inferring shell marks from prompt-looking text:** rejected. Plan 046 consumes
  only explicit validated semantic markers.
- **Component-local or executable keybindings:** rejected. Plan 047 compiles data
  overrides against Plan 035's registry and never evaluates code.
- **Broadcasting to every terminal by default:** rejected. Plan 048 requires an
  explicit visible target group, current writer rights, per-terminal encoding,
  and conspicuous armed state.
- **Storing launch commands/CWD/environment in layout templates:** rejected.
  Plan 049 stores neutral pane geometry only.
- **Transcript/canvas previews or output-ranked MRU:** rejected. Plan 050 uses
  typed process/activity metadata for labels and explicit successful focus for order.
