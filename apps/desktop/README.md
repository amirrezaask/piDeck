# YAADE Desktop

A thin [Tauri 2](https://v2.tauri.app/) shell around YAADE's React client.
The browser and desktop applications use the same `@yaade/app` implementation,
terminal renderer, typed host client, settings, and Session → Window → terminal
interaction model. The Rust side creates the native window and ensures the
local YAADE server is running.

On startup, the desktop client checks `http://127.0.0.1:7774`. If no YAADE
server is available, it installs and starts the bundled server as an OS user
service. The service owns the PTYs and agent processes independently, so closing
or killing the desktop app does not stop them. Add authenticated or remote hosts
through **Settings → Servers**, just as in the browser client.

```bash
vp install
vp run dev:desktop
```

Build the native application and installers with:

```bash
vp run build:desktop
```

Tauri runs the web build automatically and embeds `apps/web/dist`, so desktop
releases cannot drift onto a separate client implementation.
