import {
  GhosttyTerminal,
  type GhosttyTerminalHandle,
  type GhosttyTheme,
} from '@pideck/ghostty-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MultiplexerTerminal } from './protocol.js';
import './client.css';

void React.version;

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M8 3v10M3 8h10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path
        d="m3 4 3 3-3 3m5 0h5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        d="m4 4 8 8m0-8-8 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

const TERMINAL_THEME: GhosttyTheme = {
  background: { r: 10, g: 10, b: 11 },
  foreground: { r: 232, g: 232, b: 229 },
  cursor: { r: 232, g: 232, b: 229 },
  selectionBackground: 'rgb(84 84 91 / 0.72)',
};

const QUICK_TRANSITION = {
  duration: 0.16,
  ease: [0.16, 1, 0.3, 1] as [number, number, number, number],
};

function closeViewerSocket(socket: WebSocket): void {
  if (socket.readyState === WebSocket.CONNECTING) {
    socket.onopen = () => socket.close(1000, 'Terminal view closed');
  } else if (socket.readyState === WebSocket.OPEN) {
    socket.close(1000, 'Terminal view closed');
  }
}

export interface GhosttyMultiplexerClient {
  listSessionTerminals(sessionId: string): Promise<{ terminals: MultiplexerTerminal[] }>;
  createSessionTerminal(sessionId: string): Promise<MultiplexerTerminal>;
  closeSessionTerminal(sessionId: string, terminalId: string): Promise<void>;
  openSessionTerminalSocket(sessionId: string, terminalId: string): Promise<WebSocket>;
}

export interface GhosttyMultiplexerProps {
  readonly client: GhosttyMultiplexerClient;
  readonly sessionId: string;
  readonly cwd: string;
  readonly onClosePanel?: () => void;
}

function TerminalSurface({
  client,
  sessionId,
  terminalId,
}: {
  client: GhosttyMultiplexerClient;
  sessionId: string;
  terminalId: string;
}) {
  const surfaceRef = useRef<GhosttyTerminalHandle | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef<string[]>([]);
  const decoderRef = useRef(new TextDecoder());
  const [error, setError] = useState<string>();

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | undefined;
    const connect = async () => {
      try {
        const socket = await client.openSessionTerminalSocket(sessionId, terminalId);
        if (disposed) {
          closeViewerSocket(socket);
          return;
        }
        socketRef.current = socket;
        socket.binaryType = 'arraybuffer';
        socket.onopen = () => setError(undefined);
        socket.onmessage = (event) => {
          const bytes =
            event.data instanceof ArrayBuffer
              ? new Uint8Array(event.data)
              : typeof event.data === 'string'
                ? new TextEncoder().encode(event.data)
                : undefined;
          if (!bytes) return;
          const data = decoderRef.current.decode(bytes, { stream: true });
          if (surfaceRef.current) surfaceRef.current.write(data);
          else pendingRef.current.push(data);
        };
        socket.onclose = (event) => {
          socketRef.current = null;
          if (!disposed && event.code !== 1000) {
            reconnectTimer = window.setTimeout(() => void connect(), 600);
          }
        };
        socket.onerror = () => setError('Terminal connection interrupted. Reconnecting…');
      } catch (reason) {
        if (disposed) return;
        setError(reason instanceof Error ? reason.message : 'Terminal connection failed');
        reconnectTimer = window.setTimeout(() => void connect(), 1_000);
      }
    };
    void connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      const socket = socketRef.current;
      if (socket) closeViewerSocket(socket);
    };
  }, [client, sessionId, terminalId]);

  return (
    <div className="pideck-mux__surface">
      <AnimatePresence initial={false}>
        {error ? (
          <motion.div
            key="terminal-connection-error"
            className="pideck-mux__connection"
            role="status"
            initial={{ opacity: 0.7, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -3 }}
            transition={QUICK_TRANSITION}
          >
            {error}
          </motion.div>
        ) : null}
      </AnimatePresence>
      <GhosttyTerminal
        ref={surfaceRef}
        theme={TERMINAL_THEME}
        font={{ family: 'ui-monospace, SFMono-Regular, Menlo, monospace', size: 13 }}
        ariaLabel="Interactive terminal"
        onReady={(surface) => {
          surfaceRef.current = surface;
          for (const data of pendingRef.current) surface.write(data);
          pendingRef.current = [];
        }}
        onError={(reason) => setError(reason.message)}
        onData={(data) => {
          const socket = socketRef.current;
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'input', data }));
          }
        }}
        onResize={(cols, rows) => {
          const socket = socketRef.current;
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'resize', cols, rows }));
          }
        }}
      />
    </div>
  );
}

export function GhosttyMultiplexer({
  client,
  sessionId,
  cwd,
  onClosePanel,
}: GhosttyMultiplexerProps) {
  const reducedMotion = useReducedMotion();
  const [terminals, setTerminals] = useState<MultiplexerTerminal[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    const result = await client.listSessionTerminals(sessionId);
    setTerminals(result.terminals);
    setActiveId((current) =>
      current && result.terminals.some((terminal) => terminal.id === current)
        ? current
        : result.terminals[0]?.id,
    );
    return result.terminals;
  }, [client, sessionId]);

  const createTerminal = useCallback(async () => {
    setError(undefined);
    try {
      const created = await client.createSessionTerminal(sessionId);
      setTerminals((current) => [...current, created]);
      setActiveId(created.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create terminal');
    }
  }, [client, sessionId]);

  useEffect(() => {
    let active = true;
    setTerminals([]);
    setActiveId(undefined);
    setLoading(true);
    setError(undefined);
    void refresh()
      .then((current) => {
        if (active && current.length === 0) return createTerminal();
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not load terminals');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [createTerminal, refresh]);

  const closeTerminal = async (terminalId: string) => {
    setError(undefined);
    try {
      await client.closeSessionTerminal(sessionId, terminalId);
      const next = terminals.filter((terminal) => terminal.id !== terminalId);
      setTerminals(next);
      setActiveId((currentActiveId) =>
        currentActiveId === terminalId ? next[0]?.id : currentActiveId,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not close terminal');
    }
  };

  return (
    <section className="pideck-mux" aria-label="Session terminal multiplexer">
      <div className="pideck-mux__tabs">
        <div className="pideck-mux__tab-strip" role="tablist" aria-label="Terminals">
          <AnimatePresence initial={false}>
            {terminals.map((terminal, index) => {
              const selected = activeId === terminal.id;
              return (
                <motion.div
                  layout={reducedMotion ? false : 'position'}
                  className="pideck-mux__tab-group"
                  key={terminal.id}
                  initial={reducedMotion ? { opacity: 0.8 } : { opacity: 0, x: -8, scale: 0.96 }}
                  animate={{ opacity: 1, x: 0, scale: 1 }}
                  exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: -6, scale: 0.96 }}
                  transition={QUICK_TRANSITION}
                >
                  {selected ? (
                    <motion.span
                      className="pideck-mux__active-tab"
                      layoutId={`active-terminal-tab:${sessionId}`}
                      transition={QUICK_TRANSITION}
                      aria-hidden="true"
                    />
                  ) : null}
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    className="pideck-mux__tab"
                    onClick={() => setActiveId(terminal.id)}
                  >
                    <TerminalIcon />
                    <span>{terminal.title || `Terminal ${index + 1}`}</span>
                    {terminal.status === 'exited' ? (
                      <span className="pideck-mux__exit">exited</span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    className="pideck-mux__close"
                    aria-label={`Close ${terminal.title}`}
                    onClick={() => void closeTerminal(terminal.id)}
                  >
                    <XIcon />
                  </button>
                </motion.div>
              );
            })}
          </AnimatePresence>
          <motion.button
            type="button"
            className="pideck-mux__new"
            onClick={() => void createTerminal()}
            whileTap={reducedMotion ? {} : { scale: 0.96 }}
            transition={QUICK_TRANSITION}
          >
            <PlusIcon />
            <span>New terminal</span>
          </motion.button>
        </div>
        <code className="pideck-mux__cwd" title={cwd}>
          {cwd}
        </code>
        {onClosePanel ? (
          <motion.button
            type="button"
            className="pideck-mux__panel-close"
            aria-label="Close terminal panel"
            onClick={onClosePanel}
            whileTap={reducedMotion ? {} : { scale: 0.9 }}
            transition={QUICK_TRANSITION}
          >
            <XIcon />
          </motion.button>
        ) : null}
      </div>
      <div className="pideck-mux__body">
        <AnimatePresence mode="wait" initial={false}>
          {loading ? (
            <motion.div
              key="terminal-loading"
              className="pideck-mux__empty"
              initial={{ opacity: 0.76 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={QUICK_TRANSITION}
            >
              Starting terminal…
            </motion.div>
          ) : error && !activeId ? (
            <motion.div
              key="terminal-error"
              className="pideck-mux__empty pideck-mux__error"
              role="alert"
              initial={reducedMotion ? { opacity: 0.76 } : { opacity: 0.7, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={QUICK_TRANSITION}
            >
              {error}
            </motion.div>
          ) : !activeId ? (
            <motion.button
              key="terminal-empty"
              type="button"
              className="pideck-mux__empty-action"
              onClick={() => void createTerminal()}
              initial={{ opacity: 0.76 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={QUICK_TRANSITION}
            >
              Open a terminal
            </motion.button>
          ) : (
            <motion.div
              key={activeId}
              className="pideck-mux__surface-frame"
              initial={
                reducedMotion ? { opacity: 0.82 } : { opacity: 0.72, y: 4, filter: 'blur(1px)' }
              }
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={reducedMotion ? { opacity: 0.74 } : { opacity: 0.62, y: -3 }}
              transition={QUICK_TRANSITION}
            >
              <TerminalSurface client={client} sessionId={sessionId} terminalId={activeId} />
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence initial={false}>
          {error && activeId ? (
            <motion.div
              key="terminal-action-error"
              className="pideck-mux__connection"
              role="status"
              initial={{ opacity: 0.7, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={QUICK_TRANSITION}
            >
              {error}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </section>
  );
}
