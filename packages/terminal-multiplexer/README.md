# Terminal multiplexer

A session-scoped PTY multiplexer and Ghostty browser client.

- `@pideck/terminal-multiplexer` exports the server-side `SessionTerminalMultiplexer`.
- `@pideck/terminal-multiplexer/client` exports the lazy-loadable React terminal workspace.

The server owns PTYs and bounded replay. Closing or reloading a browser only detaches its viewer; closing a terminal or stopping the supervisor kills the PTY. Each Pi run ID maps to an isolated multiplexer instance.
