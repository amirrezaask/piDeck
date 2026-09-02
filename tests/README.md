# Browser verification

Browser product scenarios live under `tests/web/e2e/` and drive Chromium against
a separately launched server application.

```bash
vp run test:web:e2e
YAADE_HEADED=1 vp run test:web:e2e
vp run test:bench
```

Global setup builds the React frontend. Every scenario launches one TypeScript
host-server process on a free loopback port with a temporary data directory.
Browser scenarios use an in-process PTY host and kill it during teardown. Test
hosts are restricted to repository fixtures through `YAADE_ALLOWED_ROOTS`.

Failures retain Playwright traces, screenshots, video, browser console output,
and server logs. New UI or terminal behavior must include scoped DOM assertions
and runtime verification.

## E2E projects

```bash
vp exec playwright test --project=web-e2e
vp exec playwright test --project=security-e2e
vp exec playwright test --project=platform-e2e
```

| Project | Directory | Boundary |
| --- | --- | --- |
| Web | `tests/web/e2e/` | Browser session and terminal behavior |
| Security | `tests/security/` | Pairing, auth, and revocation |
| Platform | `tests/platform/` | User service lifecycle |

Run the core gates with:

```bash
vp run typecheck
vp run test:server
vp run test:web
vp run test:web:e2e
```
