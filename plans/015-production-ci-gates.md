# Plan 015: Enforce production build, test, security, and artifact gates in CI

> **Executor instructions**: Do not weaken failing tests or thresholds to make CI green. Fix root causes or mark the plan blocked.
>
> **Drift check**: `git diff --stat e1a8022..HEAD -- .github package.json pnpm-lock.yaml playwright.config.ts scripts apps/client/forge.config.cjs`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans 010, 012, 013, 014
- **Category**: dx
- **Planned at**: commit `e1a8022`, 2026-08-26

## Why this matters

The repository has useful local commands but no enforced CI. At audit time browser E2E and coverage were already failing while build/unit/lint passed. Production releases need reproducible gates for source quality, recovery, packaged Electron startup, dependencies, fuses, signatures, and supported platforms.

## Current state

- Root scripts exist in `package.json`, but `check` only covers typecheck and boundaries.
- There is no `.github/workflows` directory.
- Playwright uses a locally installed Chrome channel.
- `pnpm build` packages the current host and `verify-build.mjs` checks artifact existence.
- Electron Forge has hardened fuses but no repository-visible signing/notarization configuration.

## Commands

Local preflight after changes:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm lint
pnpm format:check
pnpm test
pnpm test:coverage
pnpm test:e2e
pnpm test:recovery
pnpm test:soak:ci
pnpm audit --prod --audit-level high
pnpm build
pnpm test:electron:packaged
```

Every command must exit 0.

## Scope

**In scope**: `.github/workflows/**`, package scripts, Playwright install/config, release verification scripts, Forge signing/notarization config through secrets references only, README contributor/release section.

**Out of scope**: storing certificates/keys in the repo, publishing releases automatically on ordinary pushes, weakening production fuses.

## Steps

1. Add required pull-request CI using Node 22.19+, pnpm 9.15 from `packageManager`, frozen install, cache keyed by lockfile, then check/lint/format/unit/coverage/browser E2E/recovery/audit. Install the exact Playwright browser/channel explicitly.
2. Add a bounded soak job with artifact summary and timeout. Keep it required if runtime is acceptable; otherwise required nightly plus a smaller required PR profile.
3. Add OS matrix packaged jobs on macOS, Windows, and Linux for each claimed architecture feasible on hosted runners. Run build, fuse/ASAR verification, and packaged smoke. Do not claim unsupported targets.
4. Add release workflow triggered only by signed/version tags or manual dispatch. Build draft artifacts, configure macOS signing/notarization and Windows signing from CI secret references/HSM-compatible service, verify signatures after packaging, and publish only after gates.
5. Add branch protection documentation naming required checks. Configure concurrency cancellation for superseded PRs but never cancel an in-progress release.
6. Fix the existing mobile project-picker E2E failure and coverage deficit through tests/code—not timeout or threshold relaxation.
7. Add artifact retention for traces/logs without prompts, tokens, database contents, or session files.

## Test plan

Validate workflow syntax locally where possible, run commands on current host, then inspect one real PR workflow and one draft release. Add script tests for artifact locator/fuse/signature verification.

## Done criteria

- [ ] Required PR workflow runs every listed source/recovery gate.
- [ ] Packaged smoke runs on every claimed OS.
- [ ] Coverage meets existing 80% thresholds without reduction.
- [ ] All 18+ browser E2E tests pass without blanket timeout increases.
- [ ] Release artifacts are signed/notarized where platforms require it and verified post-package.
- [ ] No secret material is committed or printed.

## STOP conditions

- STOP before publishing any artifact unless signing/notarization and smoke checks pass.
- STOP if required CI needs secret values on forked PRs; split trusted release jobs instead of exposing secrets.
- STOP if platform support claims exceed available validation.

## Maintenance notes

Electron supports a fast-moving window; add dependency update checks but review major upgrades one at a time. CI is a release contract, not optional documentation.
