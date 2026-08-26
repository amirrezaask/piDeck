# Plan 009: Require TLS for token-bearing non-loopback supervisors

> **Executor instructions**: Preserve loopback development without allowing plaintext remote credentials.
>
> **Drift check**: `git diff --stat e1a8022..HEAD -- apps/client/src/main.ts apps/client/src/preload.cts apps/web/src/lib/server-connections.ts apps/web/src/lib/server-connections.test.ts apps/client`

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plan 008
- **Category**: security
- **Planned at**: commit `e1a8022`, 2026-08-26

## Why this matters

Electron accepts arbitrary `http://` supervisor origins and then sends decrypted bearer tokens through `net.fetch`. Plaintext remote transport exposes control credentials, history, and model quota. HTTP should remain allowed only for exact loopback hosts; remote supervisors must use HTTPS.

## Current state

`apps/client/src/main.ts:91-99` accepts both HTTP and HTTPS. `:219-224` adds the bearer header. Browser-mode normalization in `apps/web/src/lib/server-connections.ts` has similar permissive behavior and stores browser credentials separately.

## Commands

- `pnpm --filter @pideck/web test -- src/lib/server-connections.test.ts` → pass
- `pnpm --filter @pideck/client test` → new tests pass, not “no tests”
- `pnpm check && pnpm test && pnpm lint` → pass

## Scope

**In scope**: shared/duplicated address validation, client tests, server-connections tests, README connection guidance.

**Out of scope**: certificate pinning, private CA provisioning, reverse-proxy implementation.

## Steps

1. Extract or implement a runtime-tested origin policy: HTTPS is accepted; HTTP is accepted only for loopback literals/names (`127.0.0.1`, `[::1]`, `localhost`) after URL parsing. Reject lookalikes, credentials, paths, query, hash, and nonstandard schemes.
2. Apply the policy in Electron main before saving and again before each request (defense against stale/tampered config). Never trust renderer-provided addresses.
3. Apply equivalent browser-mode validation when a token is supplied. If tokenless browser connections intentionally allow HTTP, label them insecure and do not persist a token later without revalidation.
4. Add unit tests in `apps/client` by extracting pure validation from Electron lifecycle code; do not require a real Electron process.
5. Update README to state TLS is mandatory off-host.

## Test plan

Accept HTTPS, localhost HTTP, IPv4/IPv6 loopback with ports. Reject LAN/public HTTP, userinfo, path/query/hash, deceptive host suffixes, and tampered stored origins at request time.

## Done criteria

- [ ] No bearer token is transmitted over non-loopback HTTP.
- [ ] Loopback development still works.
- [ ] Policy is tested in Electron and browser adapters.
- [ ] Focused/full gates pass.

## STOP conditions

- STOP if an existing production deployment requires remote HTTP; document a migration period but do not silently retain token transport.
- STOP if validation relies on string prefix/suffix checks rather than parsed host identity.

## Maintenance notes

TLS validates transport, not application authorization. Keep plan 008's token requirement and never expose certificate bypass switches to the renderer.
