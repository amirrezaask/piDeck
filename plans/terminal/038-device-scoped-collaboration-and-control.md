# Plan 038: Add device-scoped collaboration, presence, roles, and audited control transfer

> **Executor instructions**: Complete Plans 033, 035, 036, and 037. Preserve all
> pre-existing working-tree changes. Reuse the
> server's current writer/observer lease and request/transfer routes; do not add
> browser peer-to-peer terminal transport or shared write by default. Terminal
> output remains visible only through authorized terminal attach and never enters
> presence/audit payloads. Update this plan and `plans/README.md` to `DONE` only
> after authorization and multi-context E2E tests pass.
>
> **Drift check (run first)**:
>
> ```bash
> git status --short
> git diff --stat a0bb3fc9..HEAD -- \
>   apps/server/src/{device_auth,runtime,server,store,terminal,terminal_control,wire}.rs \
>   packages/yaade-rpc/src packages/yaade-host-client/src \
>   packages/yaade-app/src/{mux,commands} packages/yaade-ui/src \
>   tests/{runtime,security,web/e2e}
> git diff --stat -- \
>   apps/server/src/{device_auth,runtime,server,store,terminal,terminal_control,wire}.rs \
>   packages/yaade-rpc/src packages/yaade-host-client/src \
>   packages/yaade-app/src/{mux,commands} packages/yaade-ui/src \
>   tests/{runtime,security,web/e2e}
> ```

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 033, 035, 036, and 037
- **Category**: collaboration / authorization / UX
- **Planned at**: commit `a0bb3fc9`, 2026-08-30
- **Source finding**: Superlogical observer sharing, role, and input-control parity

## Why this matters

The terminal protocol already distinguishes writer and observer leases, exposes
presence, and supports request/transfer/reclaim control. What is missing is an
end-to-end collaboration contract: who may discover a Session, who may observe a
specific terminal, how access expires, how control requests are presented, and
which device performed a mutation. Building those semantics on device identity
turns the existing low-level mechanism into safe pair work without allowing two
people to type accidentally.

## Current state

- Terminal attach accepts writer/observer roles and terminal control reports the
  writer plus observers.
- RPC routes include request, transfer, and reclaim control and use mutation
  fences/lease epochs.
- Device auth has named devices, scopes, sessions, revocation, and audit records,
  but no Session/terminal grants or invitation flow.
- Multi-server client state already qualifies identity by server. Collaboration
  must remain host-local; a client connected to two hosts is not a federation.
- There is no broad presence UI, invitation UX, request queue, or collaboration
  audit view.

## Authorization model

- A paired device has host-level scopes. A collaboration grant further limits it
  to named Session(s), role (`viewer` or `controller`), capabilities, and expiry.
  Effective authority is the intersection.
- A viewer can read authorized snapshots/history and presence but cannot send
  input, resize canonical PTY state, answer terminal queries, mutate layout, or
  request wider data.
- A controller may request the single writer lease. The current writer explicitly
  transfers it; lease expiry/disconnect follows existing reclaim semantics.
- Invitations are random, one-use, short-lived capabilities exchanged only after
  Plan 037's secure host verification. Their stored form is hashed.
- Presence is ephemeral, bounded, coarse, and content-free. Audit is durable,
  bounded, device-attributed, and content-free.

Any new `@yaade/app` unit test file must also be listed in
`packages/yaade-app/package.json`, per repository convention.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Server | `vp run test:server && vp run test:terminal:integration` | grant/lease/presence tests pass |
| Security | `vp exec playwright test --project=platform-e2e tests/security/collaboration.security.spec.ts` | authorization abuse cases pass |
| UI | `vp exec playwright test --project=web-e2e tests/web/e2e/collaboration.web.spec.ts` | two-context flows pass |
| Full | `vp run typecheck && vp run lint && vp run build:web && vp run build:server` | exit 0 |

## Scope

**In scope**

- Device-scoped Session grants, viewer/controller roles, invitation lifecycle
- Presence and request/transfer/reclaim UX
- Device-attributed mutation/audit events and revocation propagation
- Shared browser/Tauri UI and multi-context Playwright tests

- Test manifests/scripts required by this plan, including
  `packages/yaade-app/package.json`

**Out of scope**

- Multi-writer terminals, CRDT terminal input, or keystroke merging
- Peer-to-peer/browser-relayed output or a cloud collaboration service
- Chat, comments, cursors over terminal cells, or provider-specific agent UX
- Cross-host federation
- Recording terminal input/output in presence or audit logs

## Steps

### Step 1: Specify the authorization matrix and race semantics

Write a matrix for unauthenticated, paired-no-grant, viewer, controller-no-lease,
writer, revoked, expired, archived, and interrupted states across list/snapshot,
raw/semantic history, attach, input, resize, query response, control request,
transfer, reclaim, layout mutation, archive, and invitation management.

Specify races: two requesters, writer disconnect during transfer, terminal
restart generation, server restart, grant expiry, device revocation, and stale
mutation fence. The sole acceptable write winner is the server's current lease.

**Verify**:

```bash
vp run test:terminal:protocol
vp run test:server
```

Expected: table-driven authorization tests cover every cell and deny-by-default.

### Step 2: Add persistent grants and single-use invitations

Extend the store/device-auth owner with grant IDs, server-qualified target IDs,
role, capability set, creator device, created/expires/revoked timestamps, and
revision. Store invitation secrets only as salted hashes. Apply strict TTL,
attempt, count, and rate limits and consume invitations atomically.

Invitations may point only to resources the creator can administer. Accepting an
invitation binds the grant to the already verified device; the URL/QR contains
no reusable host session and is useless on a different/unverified host identity.

**Verify**:

```bash
vp run test:server
vp exec playwright test --project=platform-e2e tests/security/collaboration.security.spec.ts
```

Expected: replay, race, escalation, cross-host, expired, revoked, and guessed
invitation cases fail closed.

### Step 3: Enforce grants at discovery, RPC, and stream boundaries

Filter Session snapshots/events before serialization so unauthorized IDs/titles
are not discoverable. Intersect host scope and resource grant in a central typed
authorizer used by HTTP RPC, WebSocket attach, raw history, semantic state, and
mutations. Reauthorize long-lived streams on grant/device revocation and expiry;
disconnect or downgrade promptly.

Observers receive only data required for authorized terminal rendering. Query
responses remain host-owned. Layout/session mutations require explicit grant
capability rather than following a terminal writer lease implicitly.

**Verify**:

```bash
vp run test:server
vp run test:terminal:integration
```

Expected: no unauthorized metadata leak and live revocation terminates access
without affecting the PTY or current writer.

### Step 4: Add bounded presence and control-request state

Publish device display name/ID suffix, role, connection state, viewed terminal,
and writer/request status through a coalesced, content-free presence channel.
Use heartbeat/expiry limits and remove stale viewers. A control request carries
requester device, terminal generation, lease epoch, timestamp, and optional
fixed reason enum instead of free-form text.

Queue/deduplicate requests with an explicit maximum. Transfer atomically changes
lease epoch and mutation fence, notifies both clients, and resets stale keyboard
state. Reclaim after disconnect follows one documented grace period.

**Verify**:

```bash
vp run test:terminal:integration
```

Expected: concurrent request/transfer/disconnect/restart/expiry tests produce one
writer and bounded presence/request queues.

### Step 5: Build collaboration and control UI

Add command-registry actions for **Share session**, **Copy invitation**,
**Manage access**, **Request control**, **Transfer control**, and **Reclaim
control** according to availability. The share dialog shows target, role, expiry,
and granted capabilities before creating a one-time code/QR. Do not place the
secret in browser history; auto-clear/cancel it on close/expiry.

Show compact presence near terminal chrome only when more than one device is
present or a request needs action. Clearly label view-only mode and disable input
without trapping focus. Control requests use an interruptible, accessible toast
or dialog with device identity, expiry, accept/deny, and keyboard actions.

**Verify**:

```bash
vp exec playwright test --project=web-e2e tests/web/e2e/collaboration.web.spec.ts
```

Expected: two isolated browser contexts pair, accept an invite, observe exact
output, fail to type as viewer, request/transfer control, type real PTY output,
and survive one client reload.

### Step 6: Add content-free audit and revoke workflows

Record invite create/consume/revoke, grant update/revoke, attach/detach,
control request/deny/transfer/reclaim, and authorization denial with actor device,
target IDs, role, result, timestamps, and revisions. Exclude terminal content,
keys, invitation values, URLs with queries, titles, and CWD.

Expose filtered metadata in the security/device management surface. Revoking a
grant or device updates the UI and active streams promptly but never kills the
host PTY.

**Verify**:

```bash
vp exec playwright test --project=platform-e2e tests/security/collaboration.security.spec.ts
vp exec playwright test --project=web-e2e tests/web/e2e/collaboration.web.spec.ts
```

Expected: exact actor attribution and redaction pass; revoke removes visibility
and input immediately while owner terminal output continues.

### Step 7: Run multi-context, restart, and accessibility gates

Cover writer/viewer on desktop and mobile viewport, keyboard-only control
request, reduced motion, screen-reader names, expired invites, offline clients,
server restart/interrupted terminal, and six observers under output flood.
Measure presence/semantic queue bounds without capturing content.

**Verify**:

```bash
vp run typecheck
vp run lint
vp run test:server
vp run test:terminal:integration
vp exec playwright test --project=platform-e2e tests/security/collaboration.security.spec.ts
vp exec playwright test --project=web-e2e tests/web/e2e/collaboration.web.spec.ts
vp run build:web
vp run build:server
```

Expected: all commands pass and screenshots/DOM evidence cover viewer, request,
transfer, expired, revoked, and mobile states.

## Test plan

- Authorization matrix and metadata non-disclosure.
- Invitation hashing, one-use/TTL/races/rate limits/cross-host binding.
- Six observers, one writer, slow observer, control races, reconnect/restart.
- Live grant/device revocation on HTTP and WebSocket.
- Audit completeness/redaction and retention.
- Two-browser real PTY E2E plus keyboard/mobile/a11y states.

## Done criteria

- [ ] Resource grants intersect with device scopes and are deny-by-default.
- [ ] Invitations are one-use, expiring, hashed at rest, and host-identity-bound.
- [ ] Viewers can observe authorized output but cannot mutate or answer queries.
- [ ] Exactly one writer exists through request/transfer/reclaim races.
- [ ] Presence and audit data are bounded, device-attributed, and content-free.
- [ ] Revocation promptly stops access without killing the PTY.
- [ ] Security, multi-context E2E, server, integration, type, lint, and build gates pass.

## STOP conditions

- Collaboration requires browser-to-browser terminal transport or multi-writer input.
- Authorization is enforced after unauthorized Session metadata is serialized.
- An invitation embeds a reusable session/token or is stored in plaintext.
- Revocation cannot affect a live stream.
- Presence/audit includes terminal input/output, title, CWD, or free-form reason.
- Query responses or writer state move into an observer/browser owner.

## Maintenance notes

Keep host scope, resource grant, and writer lease distinct. A writer lease is not
permission to discover or administer a Session. Future collaboration features
must extend the authorization matrix and content-redaction tests before adding
payloads or UI.
