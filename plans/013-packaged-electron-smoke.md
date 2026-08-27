# Plan 013: Smoke-test the packaged Electron application

> **Executor instructions**: Test the packaged artifact, not `electron .`. Use isolated user data and deterministic fake agents; never consume provider tokens.
>
> **Drift check**: `git diff --stat e1a8022..HEAD -- apps/client scripts package.json playwright.config.ts tests apps/client/forge.config.cjs`

## Status

- **State**: Implemented and verified against the packaged macOS artifact

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans 003, 008, 009, 012
- **Category**: tests
- **Planned at**: commit `e1a8022`, 2026-08-26

## Why this matters

Current browser E2E mocks the supervisor API, and `scripts/verify-build.mjs` checks only that artifact files and executable bits exist. Main/preload loading, safeStorage, embedded supervisor migrations, shutdown, and packaged paths can all break while current tests pass.

## Current state

- `apps/client/forge.config.cjs` enables hardened fuses including disabled CLI inspector; do not weaken production fuses for Playwright.
- `scripts/verify-build.mjs` verifies existence only.
- `tests/e2e/chat.spec.ts` intercepts API routes and does not launch Electron.
- Build output is under `dist/electron`.

## Commands

- `pnpm build` → artifact created and verified
- New `pnpm test:electron:packaged` → pass
- `pnpm check && pnpm test && pnpm lint` → pass

## Scope

**In scope**: packaged smoke harness/tests, scripts, package scripts, minimal observable readiness marker/health mechanism, client tests.

**Out of scope**: disabling hardened fuses, real provider authentication, broad UI visual tests, auto-update implementation.

## Steps

1. Implement a cross-platform artifact locator shared with `verify-build.mjs` for macOS app binary, Windows exe, and Linux executable/package output.
2. Launch the packaged binary as a child process with a temporary `--user-data-dir`, isolated HOME where safe, and deterministic no-provider configuration. Never use the user's normal app data.
3. Establish readiness without inspector flags: wait for the expected SQLite database/session directory plus a narrowly scoped app-ready signal or OS process/window check. If adding a smoke-mode signal, authenticate/narrow it, avoid arbitrary paths/commands, and keep normal production behavior unchanged.
4. Verify main starts, preload capability is present through a safe observable action, embedded supervisor migrates, renderer loads, and no crash/unhandled startup error occurs.
5. Terminate gracefully; verify database integrity and no orphan child process. Relaunch on the same temp userData to exercise restart/recovery, then terminate again.
6. Make the test capture bounded logs/screenshots on failure with credential/prompt redaction.
7. Extend `verify-build.mjs` to run signature/fuse/ASAR checks that are possible locally, while leaving signing requirements to CI/release configuration.

## Test plan

Cover first launch, second launch same data, single-instance behavior, malformed server config recovery, graceful quit, forced renderer reload, missing safeStorage availability behavior where injectable, and artifact paths containing spaces.

## Done criteria

- [x] Test launches the packaged binary with production fuses intact.
- [x] Embedded supervisor and renderer readiness are verified.
- [x] Restart on existing temp data succeeds.
- [x] Shutdown leaves no child process and DB integrity is `ok`.
- [x] Works on each CI target OS or is explicitly platform-scoped with equivalent jobs.

## STOP conditions

- STOP if the proposed harness requires enabling Node CLI inspect arguments in release artifacts.
- STOP if it can read/write normal userData.
- STOP if readiness requires exposing an unauthenticated production control endpoint.

## Maintenance notes

Dev launch is not a substitute. Every packaging, fuse, Electron-major, native dependency, or migration change must run this smoke test.
