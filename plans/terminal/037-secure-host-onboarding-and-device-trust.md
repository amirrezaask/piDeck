# Plan 037: Turn device authentication into secure remote-host onboarding and trust management

> **Executor instructions**: Preserve all pre-existing working-tree changes.
> Keep the existing Ed25519 device-auth service and typed RPC boundary; do not
> replace them with a single long-lived bearer token.
> This is security-sensitive. Use Effect Schema at every untrusted boundary and
> stop if a browser limitation would force silent secret storage in localStorage
> or remote credentials over plaintext HTTP. Update this plan and
> `plans/README.md` to `DONE` only after the security suite passes.
>
> **Drift check (run first)**:
>
> ```bash
> git status --short
> git diff --stat a0bb3fc9..HEAD -- \
>   apps/server/src/{config,device_auth,runtime,server,wire}.rs \
>   packages/yaade-rpc/src packages/yaade-host-client/src/{device-auth,multi-server,web-transport}.ts \
>   packages/yaade-shared/src/servers.ts packages/yaade-app/src/server-connections.tsx \
>   packages/yaade-app/src packages/yaade-ui/src \
>   tests/{security,web/e2e}
> git diff --stat -- \
>   apps/server/src/{config,device_auth,runtime,server,wire}.rs \
>   packages/yaade-rpc/src packages/yaade-host-client/src/{device-auth,multi-server,web-transport}.ts \
>   packages/yaade-shared/src/servers.ts packages/yaade-app/src/server-connections.tsx \
>   packages/yaade-app/src packages/yaade-ui/src \
>   tests/{security,web/e2e}
> ```

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: none
- **Category**: security / onboarding / multi-host
- **Planned at**: commit `a0bb3fc9`, 2026-08-30
- **Source finding**: Superlogical secure device pairing and trusted remote-host parity

## Why this matters

The host already has unusually strong foundations: Ed25519 device identity,
short pairing state, challenge authentication, scoped sessions, revocation, and
audit records. The client product still feels like a connection editor. It can
manually save a server URL and token, while browser device identity persists a
base64 private key in localStorage and there is no identity comparison,
pairing wizard, device manager, or safe handling for TLS changes. Turning the
existing protocol into a complete trust ceremony closes the user-facing and
credential-storage gap without building a new auth system.

## Current state

- `apps/server/src/device_auth.rs` owns pairing, one-time challenges, Ed25519
  verification, device/session revocation, scopes, and bounded audit records.
- `packages/yaade-host-client/src/device-auth.ts` generates Ed25519 identities
  and serializes public/private material as base64; the default browser store
  writes it under `DEVICE_IDENTITY_STORAGE_KEY` in `window.localStorage`.
- `server-connections.tsx` supports URL/token connection editing and conflict
  handling, but has no pair/verify/revoke workflow.
- `apps/server/src/config.rs` requires a token when binding off loopback. This is
  access control, not transport confidentiality.
- Browsers cannot pin arbitrary TLS certificates or guarantee non-extractable
  Ed25519 persistence on every supported engine. Those limitations need explicit
  product states, not unsafe casts/fallbacks.

## Security contract

- Non-loopback credentials, pairing secrets, signatures, and sessions travel
  only over a confidential authenticated channel: HTTPS/WSS, a reviewed secure
  tunnel, or Tauri's native trusted transport. Plain `http://` is loopback-only
  unless a compile-time development mode is visibly enabled.
- Initial trust is confirmed out of band by a short authentication string and
  full fingerprint/host label. TOFU without confirmation is not called verified.
- Pairing grants a named Ed25519 device the least scope; the short code is
  single-use, expires quickly, is rate limited, and is never stored in history.
- Browser private keys use non-extractable WebCrypto `CryptoKey` in IndexedDB
  where supported. Unsupported persistence becomes explicit session-only mode;
  no silent localStorage fallback.
- Persist server ID, device public-key fingerprint, transport origin, and
  verified identity. On mismatch stop automatic reconnect and require review.
- Tokens/codes/private keys never enter URLs, logs, analytics, Redux/React dev
  tools, notification text, screenshots, or support bundles.

Any new `@yaade/app` unit test file must also be listed in
`packages/yaade-app/package.json`, per repository convention.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Server auth | `vp run test:server` | device/pair/revoke/rate-limit tests pass |
| Security | `vp exec playwright test --project=platform-e2e tests/security/pairing.security.spec.ts tests/security/remote-trust.security.spec.ts` | adversarial cases pass |
| Client | `vp test packages/yaade-host-client packages/yaade-app` | key store and state-machine tests pass |
| UI | `vp exec playwright test --project=web-e2e tests/web/e2e/server-connections.web.spec.ts` | onboarding/device management passes |
| Full | `vp run typecheck && vp run lint && vp run build:web && vp run build:server` | exit 0 |

## Scope

**In scope**

- Pairing/trust state machine and typed transport errors
- Non-extractable browser identity store with explicit session-only fallback
- Pairing wizard, identity verification, device/scope/session management
- URL/transport policy, token migration/removal, mismatch and revocation UX
- Abuse/security/Playwright tests and operator documentation

- Test manifests/scripts required by this plan, including
  `packages/yaade-app/package.json`

**Out of scope**

- Building a public CA, VPN, relay, or account cloud
- Silent certificate exceptions or browser certificate pinning claims
- OAuth/social login or provider-specific agent auth
- Desktop keychain adapter; Plan 043
- Collaboration invites/roles; Plan 038 builds on device trust

## Steps

### Step 1: Threat-model the current pairing flow and freeze states

Document actors and assets: host operator, local browser, remote browser, paired
device, stolen code, MITM, XSS, database theft, reused challenge, revoked device,
and clock skew. Define a finite onboarding state machine: draft URL, transport
blocked, reachable-unverified, fingerprint confirmation, pairing, paired,
challenge-authenticated, expired, revoked, and identity-mismatch.

Map every transition to an existing or new typed route and error. Specify exact
TTL, attempt, request-size, session lifetime, scope, and audit retention limits
as constants with tests. Preserve current stronger limits when discovered.

**Verify**:

```bash
vp run test:server
vp test packages/yaade-host-client
```

Expected: transition and bound tests cover every state; no string matching is
used for security decisions.

### Step 2: Enforce confidential transport and stable host identity

At URL validation and connect time, permit plaintext only for loopback names and
addresses. Normalize origins without credentials, query, or fragment. For remote
hosts, require HTTPS/WSS or an explicit Tauri secure-transport capability.
Advertise server ID, device-auth public identity/fingerprint, and supported
pairing protocol from a minimal unauthenticated endpoint with tight rate limits.

After verification, pin the application identity tuple. A different server ID or
public key at the same origin blocks token/device use and shows old/new
fingerprints. TLS errors are never converted into a continue-anyway button.

**Verify**:

```bash
vp exec playwright test --project=platform-e2e tests/security/remote-trust.security.spec.ts
```

Expected: userinfo/query token, mixed content, DNS/origin normalization,
redirect, identity change, and dev-mode cases fail or prompt exactly as specified.

### Step 3: Replace browser private-key localStorage persistence

Implement the `DeviceIdentityStore` interface with IndexedDB and non-extractable
WebCrypto key handles. Store only public metadata as ordinary serialized values.
Probe algorithms at runtime and decode all database records through Effect
Schema. Handle transaction abort, quota, private mode, corruption, migration,
and explicit delete.

If non-extractable Ed25519 persistence is unavailable, offer **Use for this
browser session** or **Use a supported browser**. Do not export a generated
private key to make persistence work. Remove/migrate old localStorage identities
with user confirmation and scrub the old key on success.

**Verify**:

```bash
vp test packages/yaade-host-client
vp exec playwright test --project=web-e2e tests/web/e2e/server-connections.web.spec.ts
```

Expected: reload retains a non-extractable key on supported browsers, session
mode does not, corrupt storage fails closed, and localStorage contains no private
key.

### Step 4: Build the guided pair-and-verify wizard

In the shared connections/settings UI, guide users through URL, secure transport,
host identity comparison, short code entry/QR scan where available, device name,
requested scopes, and success. Show the short authentication string on both
operator and joining device and require explicit match confirmation. Never render
codes after success or include them in navigation/history.

Handle expiry, already consumed, throttled, clock skew, host offline, denied
scope, and identity change with a retry that creates fresh state. Preserve manual
loopback token connection as an advanced migration path, clearly labeled less
manageable than device pairing.

**Verify**:

```bash
vp exec playwright test --project=web-e2e tests/web/e2e/server-connections.web.spec.ts
```

Expected: desktop/mobile mouse and keyboard complete pairing; all failure states
retain only non-secret safe fields and restore focus.

### Step 5: Add device, scope, session, and audit management

Add a host settings surface listing named devices, key fingerprint suffix,
scopes, added/last-used timestamps, and status. Support rename, least-privilege
scope changes via reauthorization, revoke device, revoke sessions, and inspect a
bounded metadata-only security event list. Current-device revocation requires
clear confirmation and disconnects after acknowledgement.

Server authorization must check device active state and scope at each RPC and at
terminal attach, not only session issuance. Existing WebSockets close promptly
on revocation. Audit records never contain terminal data or secrets.

**Verify**:

```bash
vp run test:server
vp exec playwright test --project=platform-e2e tests/security/pairing.security.spec.ts
```

Expected: scope escalation, session replay, challenge replay, revocation during
WebSocket use, and audit redaction tests pass.

### Step 6: Run security and recovery gates

Test two hosts with the same label, host reinstall at same URL, database restore,
key deletion, browser storage loss, concurrent pair attempts, offline reconnect,
and token-to-device migration. Document reverse-proxy TLS requirements, pairing
ceremony, key storage limits, recovery, and revocation.

**Verify**:

```bash
vp run typecheck
vp run lint
vp run test:server
vp exec playwright test --project=platform-e2e tests/security
vp exec playwright test --project=web-e2e tests/web/e2e/server-connections.web.spec.ts
vp run build:web
vp run build:server
```

Expected: all commands pass; no secret values appear in test artifacts.

## Test plan

- Server: TTL, one-use, attempt/rate/size limits, scopes, challenge replay,
  revocation, concurrent races, audit redaction.
- Transport: loopback classification, HTTPS enforcement, origin normalization,
  redirects, mixed content, identity mismatch.
- Storage: non-extractable reload, session-only fallback, corruption, quota,
  migration, deletion.
- UI: complete wizard plus every typed failure on desktop/mobile/keyboard.
- Runtime: revoke live HTTP and WebSocket access immediately.

## Done criteria

- [ ] Remote onboarding uses a secure, explicit pair-and-verify ceremony.
- [ ] Plain HTTP credentials are loopback-only outside visible development mode.
- [ ] Browser device private keys are non-extractable or explicitly session-only.
- [ ] Trusted server identity mismatch blocks reconnect and credential use.
- [ ] Users can inspect scopes, revoke devices/sessions, and view redacted audit events.
- [ ] Existing tokens migrate safely; no secret remains in localStorage or URLs.
- [ ] All security, server, browser, type, lint, and build gates pass.

## STOP conditions

- A browser limitation would require silently exporting/storing a private key.
- Remote credentials would cross plaintext HTTP or a TLS error can be bypassed.
- Server identity cannot be compared out of band during initial pairing.
- Revocation is checked only at login and cannot stop a live terminal stream.
- A secret enters route state, logs, screenshots, analytics, or support output.
- The work starts a cloud account/relay system.

## Maintenance notes

Device identity is the collaboration and native-client trust root. Keep protocol
limits in one audited module and rerun adversarial tests on any crypto, storage,
proxy, or WebSocket change. Browser capability fallback must stay explicit; never
trade extractability for a smoother-looking wizard.
