# YAADE Desktop

- This application is a thin Tauri shell around the production React client from `@yaade/app`.
- Do not add desktop-only Session, Window, terminal, transport, or state implementations. Shared client behavior belongs in `packages/` and must remain usable by the browser.
- On startup, the shell ensures the bundled YAADE host is running on the default port as an OS user service. The service—not the desktop process—owns the host, PTYs, and agent processes, so desktop exit must not stop them.
- Keep Tauri permissions minimal. Add commands, plugins, or capabilities only for a concrete native requirement.
- First-party verification commands:
  - `vp run test:desktop`
  - `vp run build:desktop`
  - `vp run test:web`
