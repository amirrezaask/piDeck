# Switcher

Switcher is a keyboard-first Chrome command palette for finding and managing open tabs across every normal browser window. It opens only when invoked, searches locally, ranks by textual relevance plus browser context, and supports tab and browser actions without requiring permanent site access.

## Screenshot

Build and load the extension, open Switcher on a page with several tabs, then capture the centered palette at a 1440×900 browser viewport. Store the approved image at `docs/switcher.png` and add it here as `![Switcher command palette](../../docs/switcher.png)`.

## Stack

- WXT and Chrome Manifest V3
- React 19, strict TypeScript, Tailwind CSS 4
- shadcn/ui Command primitives and cmdk (`shouldFilter={false}`)
- Effect for Chrome adapters, provider execution, runtime boundaries, typed errors, layers, and cancellation
- Effect Schema for every runtime request and response
- Lucide icons and Motion transitions
- Vitest, React Testing Library, Playwright, Oxlint, and Oxfmt

## Setup

From the repository root:

```sh
pnpm install
pnpm --filter @pideck/switcher dev
```

WXT opens a development Chrome profile and rebuilds the extension as files change.

## Build and load in Chrome

```sh
pnpm --filter @pideck/switcher build
```

The unpacked production extension is written to:

```text
apps/switcher/build/chrome-mv3
```

To load it:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select `apps/switcher/build/chrome-mv3`.

Create a release archive with:

```sh
pnpm --filter @pideck/switcher zip
```

Before release, run `pnpm --filter @pideck/switcher check`, inspect the generated manifest, load the unpacked build in stable Chrome, and run the headed extension test on each supported desktop OS.

## Using Switcher

Open it with the toolbar action or:

- macOS: **Command+Shift+K**
- Windows/Linux: **Ctrl+Shift+K**

Chrome can decline a suggested command or another extension may claim it. Visit `chrome://extensions/shortcuts` to assign or change the shortcut. Switcher shows a footer warning and an `!` toolbar badge while it is unassigned.

Search matches titles, hostnames, paths, full URLs, and command aliases. Prefix a query with `>` to show only browser commands.

| Key               | Action                      |
| ----------------- | --------------------------- |
| Up / Down         | Move selection              |
| Enter             | Activate tab or run command |
| Shift+Backspace   | Close selected tab          |
| Alt+P             | Pin or unpin selected tab   |
| Alt+M             | Mute or unmute selected tab |
| Home / End        | First or last result        |
| PageUp / PageDown | Move by eight results       |
| Escape            | Dismiss                     |

## Supported and restricted pages

Switcher injects its isolated overlay after explicit invocation on ordinary HTTP and HTTPS pages. It does not register a persistent all-page content script.

Chrome blocks scripting on browser-owned or protected pages such as `chrome://` pages, DevTools, view-source pages, extension management, and the Chrome Web Store. On those pages Switcher opens or focuses one compact extension-owned `switcher.html` window. The fallback uses the same palette component and closes after navigation or a completed command.

## Architecture

```mermaid
flowchart LR
  I[Toolbar or command] --> B[MV3 background worker]
  B -->|toggle existing| O[Shadow DOM overlay]
  B -->|activeTab injection| O
  B -->|restricted URL| F[Extension fallback window]
  O --> P[Validated runtime protocol]
  F --> P
  P --> B
  B --> S[Effect Chrome services]
  S --> T[Tabs / Windows / Commands / Storage / Scripting]
  B --> R[Provider registry]
  R --> OT[OpenTabsProvider]
  R --> BC[BrowserCommandsProvider]
```

### Message flow

1. The command and toolbar listeners synchronously register in `entrypoints/background.ts`.
2. Invocation tries a typed `palette/toggle` tab message.
3. If no receiver exists, the worker executes `content-scripts/overlay.js` under the temporary `activeTab` grant.
4. The content entrypoint creates one WXT `createShadowRootUi`, one React root, and one message listener. Subsequent invocations toggle that root.
5. Opening requests one validated bootstrap snapshot. Search is then entirely local.
6. Actions send Effect Schema-validated requests. The background delegates to injected Effect services and returns a validated success or concise error response.

The last invocation tab/window is stored locally so an MV3 worker restart does not break fallback commands. No important state relies only on worker memory.

### Provider architecture

`SwitcherItem` is a discriminated union. `SwitcherProvider` returns an Effect and providers load concurrently through a registry. The MVP registers `OpenTabsProvider` and `BrowserCommandsProvider`; the React palette only consumes generic items. Future `BookmarksProvider`, `HistoryProvider`, `AgentSessionsProvider`, and `ExtensionCommandsProvider` can join the registry without replacing palette state or ranking.

### Effect service architecture

Chrome APIs live in adapters behind `ChromeTabs`, `ChromeCommands`, `ChromeStorage`, and `PaletteInjection` services. `makeLiveLayer` wires production implementations once at the background boundary. UI code receives a `PaletteClient`; component tests replace it with deterministic fakes. Runtime requests, provider loads, concurrent bootstrap work, action workflows, storage, and typed errors remain in Effect, while pure normalization and ranking stay ordinary TypeScript.

## Permissions

| Permission  | Purpose                                                                     |
| ----------- | --------------------------------------------------------------------------- |
| `tabs`      | Read tab titles/URLs across windows and activate, close, pin, or mute tabs. |
| `activeTab` | Grant temporary access to the page only after the user invokes Switcher.    |
| `scripting` | Execute the generated runtime overlay bundle after explicit invocation.     |
| `storage`   | Persist theme preference and the fallback invocation context locally.       |

The production manifest has no `host_permissions`, no static `content_scripts`, no `<all_urls>`, and no remotely hosted code. WXT exposes only the generated overlay CSS to the HTTP/HTTPS pages where the runtime UI can mount.

## Search and performance

Searchable fields are normalized once when providers load. Ranking combines exact, prefix, word-boundary, contiguous, and ordered-character matching with hostname weighting, recency decay, current-window affinity, active-tab penalty, pinned boost, and command priority. Ordering is deterministic, only the top 50 rows render, and a unit performance test scores 500 synthetic tabs.

## Themes

The footer selects system, light, or dark. Explicit choices persist in `browser.storage.local`; system is the default. Scoped semantic variables and Shadow DOM CSS keep the injected and fallback surfaces visually identical without affecting host-page styles.

## Testing and quality

```sh
pnpm --filter @pideck/switcher format:check
pnpm --filter @pideck/switcher lint
pnpm --filter @pideck/switcher typecheck
pnpm --filter @pideck/switcher test
pnpm --filter @pideck/switcher test:e2e
pnpm --filter @pideck/switcher check
```

Unit tests cover normalization, URL handling, ranking signals, command syntax, stable limits, restricted URLs, schemas, typed error mapping, and a 500-tab performance tripwire. Component tests cover filtering, focus, navigation, activation, close/pin/mute behavior, mouse action isolation, errors, empty results, favicons, shortcut warnings, themes, and reduced-motion-safe markup. Playwright loads an unpacked MV3 build in a persistent Chromium context and exercises ordinary-page injection, fuzzy search, repeated idempotent toggles, tab activation and management, theme persistence, and restricted-page fallback. Because browser-level extension shortcuts are not dispatched reliably by headless Chromium, the suite uses the validated `test/invoke` request to call the same background application service. The E2E build temporarily grants HTTP/HTTPS origins so `chrome.scripting` can reproduce an `activeTab` grant; the final production build removes those origins.

## Privacy and security

Switcher makes no network requests, includes no analytics or telemetry, and reads no arbitrary page content. It mounts one isolated UI host at body level, treats tab metadata as untrusted React text, validates every message in both directions, and uses neither `eval`, remotely downloaded code, page-world execution, nor `dangerouslySetInnerHTML`.

## Current limitations

- Chrome is the only supported browser for this release.
- Search covers currently open tabs and built-in commands only; bookmarks and history are deliberately excluded.
- Chrome owns shortcut assignment, so the suggested shortcut is not guaranteed to be available.
- Browser-protected pages always use the compact fallback window.
- Favicons are displayed only when Chrome provides a usable URL; deterministic letter fallbacks are otherwise shown.

Pi and local agents are intentionally absent from the browser-only MVP. A future `AgentSessionsProvider` can add them after a separately reviewed trust and transport design.
