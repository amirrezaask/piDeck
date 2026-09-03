# Plan 043: Harden the Tauri desktop shell and validate an iOS/iPadOS remote shell

> **Executor instructions**: Complete Plans 029, 035, 037, 039, and 041 first.
> Preserve all pre-existing working-tree changes. Read `apps/desktop/AGENTS.md` and preserve the three-application rule. Browser,
> desktop, iPhone, and iPad must all embed the same `@yaade/app`; do not create a
> fourth app or duplicate Session/Window/terminal state. Native code remains a
> narrow capability boundary and never owns PTYs or agent processes. Update this
> plan and `plans/README.md` to `DONE` only if the iOS feasibility gate passes. If
> it fails, complete the independently accepted desktop scope and set the README
> row to `BLOCKED (iOS feasibility: <evidence-backed reason>; desktop complete)`
> so downstream release work can consume the platform decision without bypassing it.
>
> **Drift check (run first)**:
>
> ```bash
> git status --short
> git diff --stat a0bb3fc9..HEAD -- \
>   apps/desktop packages/yaade-app packages/yaade-host-client \
>   packages/yaade-workspace packages/yaade-ui \
>   tests/desktop tests/web/e2e .github/workflows/ci.yml package.json
> git diff --stat -- \
>   apps/desktop packages/yaade-app packages/yaade-host-client \
>   packages/yaade-workspace packages/yaade-ui \
>   tests/desktop tests/web/e2e .github/workflows/ci.yml package.json
> ```

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: Plans 029, 035, 037, 039, and 041
- **Category**: desktop / mobile / platform integration
- **Planned at**: commit `a0bb3fc9`, 2026-08-30
- **Source finding**: Superlogical native desktop and iPhone/iPad client parity

## Why this matters

The desktop app is intentionally a thin single-window Tauri shell that starts a
bundled host service and loads the shared React client. That architecture is a
strength, but production native quality is incomplete: the CSP is unset,
credential storage is not OS-backed, there are no native menus/notifications or
multi-window restoration, and native E2E is thin. The shared mobile UI is already
a strong foundation for iOS/iPadOS; a gated Tauri mobile target can make it a
secure remote-only client without moving agents or PTYs onto the device.

## Current state

- `apps/desktop/src-tauri/src/main.rs` uses Tauri setup to ensure the bundled host
  service is running, then loads the shared app. Native Rust owns no terminal.
- `tauri.conf.json` defines one main window and has `security.csp: null`.
- `capabilities/default.json` grants the current main window a small set of core,
  process, and shell permissions; wildcard/dynamic-window review is still needed.
- Desktop setup starts the service asynchronously, so first-load offline/startup
  state is not a deliberate native lifecycle.
- The shared client has `MobileTerminalView` and responsive terminal controls.
- iOS cannot run the bundled Linux/macOS/Windows host service or local PTYs; it
  must connect to a Plan 037 verified remote host and recover after suspension.
- App isolation requires exactly `apps/server`, `apps/web`, and `apps/desktop`.

## Platform contract

- Native shells are replaceable viewports. Closing/crashing any native window
  unsubscribes only; it never kills a PTY. Explicit terminal close remains the
  only client action that kills that terminal.
- All business state, routes, commands, transports, and terminal surfaces remain
  in packages. Native adapters expose the minimum typed ports for keychain,
  menu, notification, external URL, lifecycle, and window management.
- Desktop may ensure the existing host OS service on the default port. iOS/iPadOS
  is remote-only and never bundles/launches `yaade-server`.
- Native credentials use Keychain/credential vault and are bound to verified
  server/device identity. No private key/token is stored in WebView localStorage.
- CSP, Tauri capabilities, navigation, deep links, and external URLs are
  allowlisted and deny-by-default.

Any new `@yaade/app` unit test file must also be listed in
`packages/yaade-app/package.json`, per repository convention.

## Commands you will need

| Purpose | Command | Expected result |
|---|---|---|
| Shared | `vp run typecheck && vp run test:web` | shared app tests pass |
| Desktop | `vp run build:desktop && vp run test:desktop` | native shell builds/tests pass |
| Native E2E | `vp run test:desktop:e2e` | Tauri WebDriver/platform lifecycle/menu/keychain/window cases pass |
| iOS gate | `vp run build:ios && vp run test:ios` | simulator build and remote-client smoke pass |
| Security | `vp exec playwright test --project=platform-e2e tests/security/native-shell.security.spec.ts` | capability/navigation/secret tests pass |

## Scope

**In scope**

- Typed native capability ports and Tauri implementations
- Desktop startup/reopen/multi-window/menu/notification/keychain/security behavior
- iOS/iPadOS feasibility spike and, only if passed, remote-only Tauri target
- Native lifecycle, responsive, security, and simulator/desktop E2E
- Shared route/window restoration without process ownership changes

- Test manifests/scripts required by this plan, including
  `packages/yaade-app/package.json`

**Out of scope**

- A fourth application or forked native React client
- Local iOS PTYs, agents, bundled server, SSH engine, or background daemon
- Native terminal parser/renderer fork
- General desktop file browser/editor/Git/chat surfaces
- Signing, distribution, and update rollout; Plan 044

## Steps

### Step 1: Define narrow native ports and security inventory

Inventory each native operation and create typed interfaces under a lower shared
package that imports no React: secure device-key/session storage, notification,
external URL open, app lifecycle, native command events, and window route
open/focus. Implement browser no-op/Web adapters and Tauri adapters behind
runtime capability detection; components consume ports, never import Tauri.

Map every plugin/command to allowed platforms, windows, URL schemes, arguments,
and user gesture. Remove broad shell/process permissions not required after host
service launch design is understood. Add tests that web builds cannot import
Tauri and package imports remain acyclic.

**Verify**:

```bash
vp run typecheck
vp run lint
vp test packages/yaade-workspace packages/yaade-app
```

Expected: dependency-boundary tests pass and each native command has a documented
minimal capability.

### Step 2: Harden the desktop WebView and service startup lifecycle

Set a production CSP for self assets and explicit verified `connect-src` hosts,
with no unsafe remote navigation or eval. Validate all deep-link/window routes
through shared route schemas. Open external `http(s)` destinations only through
the reviewed native external-URL port from Plan 039; deny file/custom schemes.

Represent bundled host startup as `checking`, `starting`, `ready`, `failed`, and
`remote-only` UI states. Bound retry and expose diagnostics, never a permanent
blank/offline race. Closing/reopening the app must reconnect to the still-running
host service; desktop exit never sends terminal close.

Add `test:desktop:e2e` root/package scripts backed by `tauri-driver` plus a
WebDriver client, or another Tauri-supported platform automation harness. Do not
pretend ordinary browser Playwright controls a native WebView. Keep shared visual
and DOM behavior in the existing web Playwright project; use the native driver
for window, process, menu, keychain, deep-link, and lifecycle evidence.

**Verify**:

```bash
vp run build:desktop
vp run test:desktop:e2e -- --spec=lifecycle
vp exec playwright test --project=platform-e2e tests/security/native-shell.security.spec.ts
```

Expected: CSP/navigation attacks fail, startup states are visible/recoverable,
and PTY output continues through window/app close and reopen.

### Step 3: Add OS-backed device credential storage

Implement Plan 037's identity store using macOS Keychain, Windows Credential
Manager, and Linux Secret Service/keyring through a reviewed maintained Tauri
plugin or minimal audited commands. Store private key handles/bytes with
application-only access where the platform permits; persist non-secret metadata
in shared storage. Never pass secrets through Tauri event broadcasts or logs.

Provide explicit migration from browser local/session storage and deletion on
device removal. If secure storage is locked/unavailable, show typed unlock,
session-only, or reconnect states without a plaintext fallback.

**Verify**:

```bash
vp run test:desktop
vp exec playwright test --project=platform-e2e tests/security/native-shell.security.spec.ts
```

Expected: relaunch retains device access, locked/corrupt/delete/migration cases
fail safely, and canary secrets are absent from WebView storage/logs/artifacts.

### Step 4: Add native menus, notifications, activation, and multi-window routes

Generate native menu labels/shortcuts/enabled state from Plan 035 stable command
IDs. Native events dispatch through the shared command runtime; no native command
reimplements session logic. Route Plan 036 redacted notification requests to OS
notifications and handle clicks through validated server-qualified routes.

Support OS reopen/activate, open exact Session/Window/terminal in a new native
window, and restore bounded window geometry/routes after relaunch. Each WebView
creates an independent observer/writer attachment according to existing lease
rules; opening a second window must not duplicate PTY state. Dynamic window
capabilities are scoped by label pattern and tested.

**Verify**:

```bash
vp run test:desktop:e2e
```

Expected: menu/notification/deep-link actions execute one shared command, two
windows observe one PTY, writer control remains singular, and all windows closing
leaves PTY alive.

### Step 5: Run a time-boxed iOS/iPadOS feasibility gate

Before product implementation, create a build-only Tauri mobile target inside
`apps/desktop` and answer with executable tests:

1. Can the same production `@yaade/app` bundle load without platform forks?
2. Can WebSocket binary frames, workers, WASM Ghostty, Canvas/WebGL, IME,
   clipboard user gestures, and visual viewport/safe areas pass on current iOS?
3. Can Keychain persist Plan 037 identity without WebView serialization?
4. Can app suspend/resume trigger bounded reconnect/replay without claiming a
   background socket stays alive?
5. Can capabilities exclude process/shell/sidecar and prevent arbitrary navigation?
6. Can CI build and boot an iPhone and iPad simulator target?

Time-box platform investigation. Produce `docs/platform/ios-feasibility.md` with
PASS/BLOCKED per item and artifacts. Any load-bearing BLOCKED item stops iOS
shipping; keep web/mobile-browser support and do not fork terminal implementation.

**Verify**:

```bash
vp run build:ios
vp run test:ios -- --gate
```

Expected: machine-readable PASS/BLOCKED report plus simulator artifacts; no
unsupported claim is marked pass.

### Step 6: If the gate passes, ship a remote-only iPhone/iPad shell

Add platform configuration/capabilities under `apps/desktop`; compile out desktop
host-service/process/shell code on mobile. First run enters Plan 037 remote pairing.
Use shared `MobileTerminalView`, command palette, search, paste/clipboard policy,
and accessibility. Add safe-area, compact/regular width, hardware keyboard,
software keyboard/visual viewport, rotation, pointer/trackpad, and iPad multiwindow
behavior without separate React screens.

On background assume transport suspension. On foreground validate host/device
identity, reconnect, request current screen, catch up history, and enable input
only at Plan 034's safe fence. OS memory-pressure termination must behave like a
browser reload and leave server PTYs alive.

**Verify**:

```bash
vp run build:ios
vp run test:ios
vp exec playwright test --project=web-e2e tests/web/e2e/terminal-multiplexer.web.spec.ts
```

Expected: iPhone/iPad simulator cases pair to a real test host, render/type real
PTY output, suspend/resume exactly, and share web regression behavior.

### Step 7: Enforce native security, lifecycle, and shared-client gates

Test macOS/Windows/Linux desktop plus current supported iOS/iPadOS simulator
versions. Cover service absent/failure, app/window crash, multiwindow,
notifications denied, keychain locked, offline/identity mismatch, mobile suspend,
rotation, IME, keyboard, paste, accessibility, and renderer fallback. Capture
platform screenshots and accessibility evidence.

**Verify**:

```bash
vp run typecheck
vp run lint
vp run build:web
vp run build:desktop
vp run test:desktop
vp run test:desktop:e2e
vp exec playwright test --project=platform-e2e tests/security/native-shell.security.spec.ts
vp run build:ios
vp run test:ios
```

Expected: all applicable commands pass; a blocked iOS gate is reported rather
than bypassed, and web/shared tests remain green.

## Test plan

- Package import/capability/CSP/navigation/deep-link security.
- Desktop service startup, close/reopen, crash, multiwindow, menu, notification.
- OS keychain persist/locked/corrupt/migrate/delete and secret leakage.
- iPhone/iPad renderer/worker/WASM/WebSocket/IME/keyboard/safe-area/a11y.
- Mobile suspend/resume/memory termination and host PTY continuation.
- Real PTY output in desktop native-driver and simulator remote-host smoke; shared
  visible UI states also remain covered by web Playwright.

## Done criteria

- [ ] Native operations are narrow typed ports; shared packages own all product behavior.
- [ ] Desktop CSP/capabilities/navigation are deny-by-default and tested.
- [ ] Native device credentials use OS secure storage without plaintext fallback.
- [ ] Menus/notifications/windows dispatch stable shared commands/routes.
- [ ] Closing any native viewport leaves server PTYs alive.
- [ ] iOS/iPadOS is either evidence-backed PASS and remote-only, or explicitly BLOCKED without a fork.
- [ ] Desktop/platform/shared/type/lint/build gates pass on supported targets.

## STOP conditions

- iOS requires a fourth app, forked React client, parser, or renderer.
- Native code starts PTYs/agents outside `apps/server` or iOS bundles a host.
- Secure storage requires plaintext WebView/localStorage fallback.
- CSP requires unrestricted remote navigation, eval, or broad Tauri capabilities.
- Multiwindow duplicates/owns terminal state or closing a window kills a PTY.
- A load-bearing iOS feasibility item fails and the implementation proceeds anyway.

## Maintenance notes

Treat native shells as capability adapters around the shared client. Every new
Tauri plugin expands the attack surface and needs capability, CSP, secret-flow,
and platform review. Re-run the iOS feasibility matrix on Tauri/WebKit/Ghostty
upgrades rather than accumulating mobile-only patches.
