# Plan 049: Save and apply named Window layout templates

> **Executor instructions**: Complete Plans 032 and 035 first. Preserve existing
> working-tree changes. Templates configure pane geometry only; they must never
> kill, restart, or silently launch a terminal. Read `packages/yaade-ui/AGENTS.md`
> for visible UI work, run every gate, and update this plan and
> `plans/README.md` when complete.
>
> **Drift check (run first)**:
>
> ```bash
> git diff --stat 0739eacf..HEAD -- \
>   apps/server/src/{model,store,runtime}.rs \
>   packages/yaade-rpc/src packages/yaade-host-client/src \
>   packages/yaade-panels/src packages/yaade-app/src/{commands,mux} \
>   packages/yaade-ui/src tests/web/e2e
> git diff --stat -- \
>   apps/server/src/{model,store,runtime}.rs \
>   packages/yaade-rpc/src packages/yaade-host-client/src \
>   packages/yaade-panels/src packages/yaade-app/src/{commands,mux} \
>   packages/yaade-ui/src tests/web/e2e
> ```

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: Plans 032 and 035
- **Category**: terminal UX / workspace persistence
- **Planned at**: commit `0739eacf`, 2026-08-31
- **Source finding**: heavy-terminal workflow review: useful pane arrangements must be rebuilt manually

## Why this matters

YAADE already persists each Window's exact split tree, but that state is tied to
one Window and terminal IDs. Heavy users repeatedly recreate familiar
arrangements such as editor/build/log or three-host operations layouts. Named
geometry templates should make those arrangements reusable without becoming a
process launcher or storing sensitive terminal commands.

## Current state

- `packages/yaade-rpc/src/mux-session.ts` stores versioned `SessionTab.layoutJson`
  with a 65,536-byte bound and revision fence.
- `packages/yaade-app/src/mux/terminal-tiling.ts` validates, restores, and
  serializes a `PanelTree`; `MAX_TERMINAL_TILES` is six.
- Persisted Window layouts embed `MuxTerminalId`, focus, and temporary zoom.
  Templates must use neutral slots instead.
- `apps/server/src/store.rs::save_tab_layout` persists exact Window state but has
  no named reusable template entity.
- Resident surface placement means pane movement can avoid PTY/runtime reattach;
  E2E lifecycle counters already prove this invariant.
- Any new `@yaade/app` unit test file must be listed in
  `packages/yaade-app/package.json`, per repository convention.

## Target module and interface

Add a server-owned `WindowLayoutTemplate` with stable ID, title, versioned
geometry, slot count, revision, and timestamps. Version 1 geometry contains only
row/column structure, normalized ratios, neutral slot IDs, and an optional
preferred slot. It contains no terminal IDs, titles, CWDs, commands, environment,
server credentials, focus history, or zoom state.

A pure app module provides:

```ts
captureTemplate(workspace): TemplateGeometry
applyTemplate(workspace, geometry, assignment): TerminalWorkspace
```

It owns validation and deterministic terminal-to-slot assignment. Applying a
template changes placement only; host terminals continue running.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Server/protocol | `vp run test:server && vp run test:terminal:protocol` | CRUD/validation/revision tests pass |
| App/UI | `vp test packages/yaade-panels packages/yaade-app packages/yaade-ui` | capture/apply/palette tests pass |
| Type/lint | `vp run typecheck && vp run lint` | exit 0 |
| E2E | `vp exec playwright test --project=web-e2e tests/web/e2e/window-layout-templates.web.spec.ts` | save/apply/restart/residency pass |

## Scope

**In scope**

- Typed, bounded, server-persisted named geometry templates
- Capture, list, rename, delete, and apply commands
- Deterministic assignment of current Window terminals to neutral slots
- Palette/Settings management UI and unit/server/Playwright tests

**Out of scope**

- Launch commands, shell arguments, CWD, environment, or agent presets
- Killing/restarting/closing terminals when applying a template
- Moving terminals between Sessions or hosts
- More than six visible panes
- A general workspace/file/project template system

## Steps

### Step 1: Define the neutral template schema

Add Effect Schema and matching Rust model types for template ID/title/version,
geometry tree, slot IDs, ratios, revision, and timestamps. Enforce depth, node,
slot, title, and encoded-byte limits. Ratios normalize to finite positive values;
leaf count is 1–6; slot IDs are unique; zoom is excluded.

Use a reset rather than backward-compatibility machinery if schema changes are
needed, per repository policy.

**Verify**: `vp run test:terminal:protocol && vp run test:server` → cross-language
valid/invalid fixtures agree.

### Step 2: Persist template CRUD behind typed routes

Add store/database-owner operations and typed RPC routes to list, create from
validated geometry, rename with revision, and delete. Bind templates to the host
catalog, not browser localStorage, so browser/Tauri clients see the same list.
Apply count/byte limits and deterministic title-conflict behavior.

No route accepts terminal IDs inside template geometry. Errors contain IDs and
codes only, never terminal content.

**Verify**: `vp run test:server` → create/list/rename/delete, restart, conflict,
corruption/reset, and bounds tests pass.

### Step 3: Build pure capture and application modules

In `terminal-tiling.ts` or a focused sibling, convert a live tree into neutral
slots while preserving structure/ratios. Applying uses an explicit ordered list:
focused terminal first, then terminals already visible in stable leaf order.
Fill remaining slots with empty panes. Terminals beyond the template's capacity
remain live and accessible through the terminal switcher but are not placed in
the applied Window.

Applying must not mutate the source workspace on decode/validation failure. Keep
`zoomedPanelId` null and choose focus deterministically.

**Verify**: `vp test packages/yaade-panels packages/yaade-app` → round-trip,
1–6 panes, fewer/more terminals, malformed tree, ratios, focus, and immutability
pass.

### Step 4: Apply transactionally without terminal reattach

Expose app commands through Plan 035. Applying updates the local placement
optimistically, then saves the Window's ordinary `layoutJson` with its revision
fence. On host conflict, fetch authoritative Window state and either retry from
that state or restore it with a clear action error; never overwrite a newer
layout silently.

Move resident `TerminalSurfacePlacement` instances. Do not call terminal create,
attach, detach, resize beyond normal final geometry, close, or restart as part of
template application.

**Verify**: app tests assert unchanged PTY IDs, surface instance IDs, attach
counts, runtime generation, and terminal generations before/after apply.

### Step 5: Add template capture and management UI

Register **Save Window layout as template**, **Apply layout template**, **Rename
layout template**, and **Delete layout template**. Use `PaletteShell` for apply
and a compact dialog for naming. Rows show title and geometry summary such as
“3 panes · 2 columns”; do not show inferred project/command content.

Applying previews a small non-terminal geometry diagram and states how many
current terminals will be placed or left unplaced. Delete is explicit but does
not affect Windows already using the geometry. Cover empty/error/many/mobile and
keyboard focus states.

**Verify**: headed Playwright captures all list/dialog states with scoped DOM and
accessibility assertions.

### Step 6: Add restart and residency E2E

Save a 3-pane template, alter the Window, apply it, and assert ratios/row content,
terminal IDs, real PTY output, and unchanged attach/runtime lifecycle counters.
Reload browser and restart host; list/apply must remain available after Plan 032
reconciliation. Test conflict, delete, fewer terminals, six-pane cap, and mobile.

**Verify**: run the E2E command three times → all pass without arbitrary sleeps.

## Test plan

- Schema/store: bounds, versions, conflicts, restart, corruption/reset, deletion.
- Pure layout: neutral capture, assignment, ratios, focus, empty/overflow slots.
- UI: list row content/count, naming, preview, conflict/error, mobile/a11y.
- E2E: real PTYs remain alive/resident through save/apply/reload/restart.

## Done criteria

- [ ] Templates contain geometry/slots only and persist on the server.
- [ ] Capture/apply is deterministic for 1–6 panes.
- [ ] Applying never starts, kills, closes, restarts, or reattaches a terminal.
- [ ] Overflow terminals remain live and discoverable.
- [ ] Revision conflicts cannot overwrite newer Window state.
- [ ] Server, protocol, unit, type, lint, visual, and E2E gates pass.

## STOP conditions

- A useful v1 template requires storing commands, CWD, environment, or transcript.
- Applying would archive/close a terminal or move it across host/session.
- Resident surfaces cannot be moved without reattach.
- Template and ordinary Window layouts would need divergent tree semantics.
- Host restart persistence is not available from Plan 032.

## Maintenance notes

Exact Window state and reusable template geometry are separate modules sharing
one validated tree codec. Future launch profiles, if ever approved, require a
separate threat model and must not expand this template interface.
