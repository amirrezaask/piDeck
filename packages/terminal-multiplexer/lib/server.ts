import { randomUUID } from 'node:crypto';
import process from 'node:process';
import * as pty from 'node-pty';
import type { WebSocket } from 'ws';
import type { MultiplexerTerminal, TerminalSocketInput } from './protocol.js';

const MAX_REPLAY_BYTES = 4_000_000;
const MAX_TERMINALS_PER_SESSION = 8;

type LiveTerminal = {
  summary: MultiplexerTerminal;
  process: pty.IPty;
  replay: Buffer;
  viewers: Set<WebSocket>;
};

type SessionMultiplexer = { terminals: Map<string, LiveTerminal> };

/**
 * Server-side PTY owner. Each Pi session receives an isolated multiplexer;
 * browser disconnects remove a viewer but never stop its PTYs.
 */
export class SessionTerminalMultiplexer {
  private readonly sessions = new Map<string, SessionMultiplexer>();
  private closing = false;

  list(sessionId: string): MultiplexerTerminal[] {
    return [...(this.sessions.get(sessionId)?.terminals.values() ?? [])]
      .map((terminal) => terminal.summary)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  create(sessionId: string, cwd: string): MultiplexerTerminal {
    if (this.closing) throw new Error('Terminal multiplexer is shutting down');
    const mux = this.sessions.get(sessionId) ?? { terminals: new Map<string, LiveTerminal>() };
    this.sessions.set(sessionId, mux);
    if (mux.terminals.size >= MAX_TERMINALS_PER_SESSION) {
      throw new Error(`A session can have at most ${MAX_TERMINALS_PER_SESSION} terminals`);
    }

    const id = randomUUID();
    const shell = process.env.SHELL?.trim() || '/bin/sh';
    const child = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 100,
      rows: 28,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    const live: LiveTerminal = {
      summary: {
        id,
        sessionId,
        title: shell.split('/').at(-1) || 'shell',
        cwd,
        status: 'running',
        createdAt: new Date().toISOString(),
      },
      process: child,
      replay: Buffer.alloc(0),
      viewers: new Set(),
    };
    mux.terminals.set(id, live);

    child.onData((data) => {
      const chunk = Buffer.from(data, 'utf8');
      live.replay = Buffer.concat([live.replay, chunk]);
      if (live.replay.byteLength > MAX_REPLAY_BYTES) {
        live.replay = live.replay.subarray(live.replay.byteLength - MAX_REPLAY_BYTES);
      }
      for (const viewer of live.viewers) {
        if (viewer.readyState === viewer.OPEN && viewer.bufferedAmount < 1_000_000) {
          viewer.send(chunk, { binary: true });
        }
      }
    });
    child.onExit(({ exitCode }) => {
      live.summary = { ...live.summary, status: 'exited', exitCode };
      for (const viewer of live.viewers) viewer.close(1000, 'Terminal exited');
      live.viewers.clear();
    });
    return live.summary;
  }

  attach(sessionId: string, terminalId: string, socket: WebSocket): boolean {
    const terminal = this.sessions.get(sessionId)?.terminals.get(terminalId);
    if (!terminal) return false;
    terminal.viewers.add(socket);
    if (terminal.replay.byteLength > 0) socket.send(terminal.replay, { binary: true });
    socket.on('message', (payload, isBinary) => {
      if (isBinary || terminal.summary.status !== 'running') return;
      let message: TerminalSocketInput;
      try {
        message = JSON.parse(payload.toString()) as TerminalSocketInput;
      } catch {
        socket.close(1003, 'Invalid terminal message');
        return;
      }
      if (message.type === 'input' && typeof message.data === 'string') {
        terminal.process.write(message.data.slice(0, 65_536));
      } else if (
        message.type === 'resize' &&
        Number.isInteger(message.cols) &&
        Number.isInteger(message.rows)
      ) {
        terminal.process.resize(
          Math.max(2, Math.min(500, message.cols)),
          Math.max(1, Math.min(300, message.rows)),
        );
      }
    });
    const detach = () => terminal.viewers.delete(socket);
    socket.once('close', detach);
    socket.once('error', detach);
    return true;
  }

  closeTerminal(sessionId: string, terminalId: string): boolean {
    const mux = this.sessions.get(sessionId);
    const terminal = mux?.terminals.get(terminalId);
    if (!mux || !terminal) return false;
    terminal.process.kill();
    for (const viewer of terminal.viewers) viewer.close(1000, 'Terminal closed');
    mux.terminals.delete(terminalId);
    if (mux.terminals.size === 0) this.sessions.delete(sessionId);
    return true;
  }

  close(): void {
    this.closing = true;
    for (const mux of this.sessions.values()) {
      for (const terminal of mux.terminals.values()) {
        terminal.process.kill();
        for (const viewer of terminal.viewers) viewer.close(1001, 'Server shutting down');
      }
    }
    this.sessions.clear();
  }
}
