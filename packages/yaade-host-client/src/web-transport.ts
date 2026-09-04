import type { YaadeHostTransport } from "./transport.js";
import {
  HostDisconnectedError,
  decodeHostRouteResult,
  decodeTerminalDataFrame,
  encodeTerminalAckFrame,
  encodeTerminalAttachFrame,
  encodeTerminalDetachFrame,
  encodeTerminalInputFrame,
  encodeTerminalPingFrame,
  encodeTerminalReadyFrame,
  encodeTerminalResizeFrame,
  encodeTerminalResyncRequest,
  encodeTerminalScrollbackRequest,
  isTerminalWsHotOp,
  tryDecodeRealtimeHostEvent,
  tryDecodeTerminalReplayRequired,
  tryDecodeTerminalWsResult,
  type HostEvent,
  type HostRpcError,
  type HostRouteArgs,
  type HostRouteName,
  type HostRouteResult,
  type TerminalWsHotOp,
} from "@yaade/rpc";
import { Duration, Effect, Fiber } from "effect";
import { invokeHostRpcUnchecked } from "./effect-host-client.js";

async function runInvokePromise<T>(effect: Effect.Effect<T, HostRpcError>): Promise<T> {
  const outcome = await Effect.runPromise(
    effect.pipe(
      Effect.match({
        onFailure: (error) => ({ ok: false as const, error }),
        onSuccess: (value) => ({ ok: true as const, value }),
      }),
    ),
  );
  if (!outcome.ok) throw outcome.error;
  return outcome.value as T;
}

export function acceptHostEvent(
  lastSequence: number,
  message: HostEvent,
  identity?: { readonly serverId: string; readonly serverEpoch: string },
): boolean {
  if (!Array.isArray(message.args) || message.sequence <= lastSequence) return false;
  if (message.protocolVersion === 1) return true;
  return Boolean(
    identity &&
    message.serverId === identity.serverId &&
    message.serverEpoch === identity.serverEpoch,
  );
}

export function normalizeHostBaseUrl(baseUrl?: string): string {
  const fallback = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  const url = new URL(baseUrl ?? fallback, fallback);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("YAADE server URL must terminal http or https");
  }
  if (url.username || url.password) {
    throw new Error("YAADE server URLs cannot contain credentials");
  }
  return `${url.protocol}//${url.host}`;
}

export function websocketUrl(
  location: Pick<Location, "protocol" | "host">,
  since = 0,
  clientId?: string,
  token?: string | null,
  baseUrl?: string,
  protocolVersion = 1,
): string {
  const base = baseUrl ? new URL(normalizeHostBaseUrl(baseUrl)) : undefined;
  const protocol = (base?.protocol ?? location.protocol) === "https:" ? "wss:" : "ws:";
  const host = base?.host ?? location.host;
  const client = clientId ? `&clientId=${encodeURIComponent(clientId)}` : "";
  // Modern connections authenticate in-band after the socket opens. Legacy
  // URLs retain the compatibility token path until device auth is negotiated.
  const auth = token && protocolVersion < 2 ? `&token=${encodeURIComponent(token)}` : "";
  const protocolQuery = protocolVersion >= 2 ? `&protocol=${protocolVersion}` : "";
  return `${protocol}//${host}/terminal/ws?since=${since}${client}${auth}${protocolQuery}`;
}

export function readHostAuthToken(
  search = typeof window === "undefined" ? "" : window.location.search,
  storage: Pick<Storage, "getItem" | "setItem"> | null = typeof sessionStorage === "undefined"
    ? null
    : sessionStorage,
): string | null {
  const query = new URLSearchParams(search).get("token")?.trim();
  if (query) {
    try {
      storage?.setItem("yaade-host-token", query);
    } catch {
      /* ignore */
    }
    return query;
  }
  try {
    return storage?.getItem("yaade-host-token")?.trim() || null;
  } catch {
    return null;
  }
}

/** Copy a one-shot query token into session storage and drop it from the URL/history. */
export function consumeHostAuthTokenFromLocation(
  location: Pick<Location, "search" | "pathname" | "hash"> = typeof window === "undefined"
    ? { search: "", pathname: "/", hash: "" }
    : window.location,
  historyApi: Pick<History, "replaceState"> | null = typeof history === "undefined"
    ? null
    : history,
  storage: Pick<Storage, "getItem" | "setItem"> | null = typeof sessionStorage === "undefined"
    ? null
    : sessionStorage,
): string | null {
  const token = readHostAuthToken(location.search, storage);
  const params = new URLSearchParams(location.search);
  if (!params.has("token") || !historyApi) return token;
  params.delete("token");
  const search = params.toString();
  historyApi.replaceState(
    null,
    "",
    `${location.pathname}${search ? `?${search}` : ""}${location.hash}`,
  );
  return token;
}

/** Reconnect backoff matching legacy setTimeout: 250ms × 2^n, cap 10s. */
export function hostRealtimeReconnectDelay(attempt: number): Duration.Duration {
  return Duration.millis(Math.min(10_000, 250 * 2 ** Math.max(0, attempt)));
}

const REALTIME_CONNECT_TIMEOUT_MS = 15_000;
const REALTIME_HEARTBEAT_INTERVAL_MS = 15_000;
const REALTIME_HEARTBEAT_TIMEOUT_MS = 45_000;

export function createClientId(cryptoSource: Crypto | undefined = globalThis.crypto): string {
  if (typeof cryptoSource?.randomUUID === "function") {
    return cryptoSource.randomUUID();
  }
  return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

type RealtimeWakeTarget = {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
};
type RealtimeWakeDocument = RealtimeWakeTarget & {
  readonly visibilityState: DocumentVisibilityState;
};

export type WebHostTransportOptions = {
  readonly baseUrl?: string;
  /** `undefined` terminals the legacy query/session token; `null` sends no token. */
  readonly authToken?: string | null;
};

/**
 * Background tabs heavily throttle reconnect timers. Wake the realtime loop as
 * soon as the page becomes usable again; a hidden→visible transition also
 * replaces an apparently-open socket because a suspended network path can stay
 * half-open until the next write.
 */
export function subscribeRealtimeWake(
  onWake: (replaceOpenSocket: boolean) => void,
  doc: RealtimeWakeDocument,
  target: RealtimeWakeTarget,
): () => void {
  let wasHidden = doc.visibilityState === "hidden";
  let wasBlurred = false;
  const onVisibilityChange = () => {
    if (doc.visibilityState === "hidden") {
      wasHidden = true;
      return;
    }
    if (!wasHidden) return;
    wasHidden = false;
    onWake(true);
  };
  const onBlur = () => {
    wasBlurred = true;
  };
  const onFocus = () => {
    if (!wasBlurred) return;
    wasBlurred = false;
    // Wake a dead reconnect loop after alt-tab, but never replace an OPEN
    // socket. Ordinary blur/focus is Slack, Spotlight, a native menu — not a
    // suspended network path. Hidden→visible still replaces below.
    onWake(false);
  };
  const onPageShow = (event: Event) => {
    if ("persisted" in event && event.persisted === true) onWake(true);
  };
  const onOnline = () => onWake(true);
  doc.addEventListener("visibilitychange", onVisibilityChange);
  target.addEventListener("blur", onBlur);
  target.addEventListener("focus", onFocus);
  target.addEventListener("pageshow", onPageShow);
  target.addEventListener("online", onOnline);
  return () => {
    doc.removeEventListener("visibilitychange", onVisibilityChange);
    target.removeEventListener("blur", onBlur);
    target.removeEventListener("focus", onFocus);
    target.removeEventListener("pageshow", onPageShow);
    target.removeEventListener("online", onOnline);
  };
}

/**
 * Host realtime WS client.
 *
 * - Reconnect owned by an Effect Fiber (interrupt on `close`)
 * - `terminal:data` / `terminal:exit` terminal structural decode (no Schema)
 * - Binary `terminal:data` frames skip JSON.stringify/parse on the hot path
 * - Hot terminal control (`write`/`ack`/`resize`) sent fire-and-forget on WS
 * - In-flight HTTP invokes aborted with `HostDisconnectedError` on WS drop / close
 */
export class WebHostTransport implements YaadeHostTransport {
  private readonly baseUrl: string;
  private readonly authToken: string | null | undefined;
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  private socket: WebSocket | null = null;
  private reconnectAttempt = 0;
  private lastSequence = 0;
  private serverId: string | null = null;
  private serverEpoch: string | null = null;
  private synchronized = false;
  private closed = false;
  private lastPongAt = 0;
  private readonly clientId = createClientId();
  private readonly pendingAborts = new Set<AbortController>();
  private readonly pendingRealtime = new Map<
    string,
    {
      channel: TerminalWsHotOp;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly unobservedRealtime = new Map<string, string>();
  private readonly terminalStreams = new Map<
    number,
    { id: string; epoch: number; position: number; inputPosition: number; controlPosition: number }
  >();
  private readonly terminalStreamIds = new Map<string, number>();
  private readonly pendingHistory = new Map<
    number,
    {
      epoch: number;
      chunks: Uint8Array[];
      firstSequence: number;
      lastSequence: number;
      resolve: (page: {
        chunks: Uint8Array[];
        firstSequence: number;
        lastSequence: number;
        nextSequence: number;
        complete: boolean;
      }) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private realtimeRequestSequence = 0;
  private loopFiber: Fiber.RuntimeFiber<void, never> | null = null;
  private reconnectRequested = false;
  private reconnectWake: (() => void) | null = null;
  private preservePendingOnReconnect = false;
  private accessRevoked = false;
  private readonly disposeRealtimeWake: (() => void) | null;

  constructor(options: WebHostTransportOptions = {}) {
    this.baseUrl = normalizeHostBaseUrl(options.baseUrl);
    this.authToken = options.authToken;
    this.disposeRealtimeWake =
      typeof document === "undefined" || typeof window === "undefined"
        ? null
        : subscribeRealtimeWake(
            (replaceOpenSocket) => this.wakeRealtime(replaceOpenSocket),
            document,
            window,
          );
    this.loopFiber = Effect.runFork(this.reconnectLoop().pipe(Effect.orDie, Effect.asVoid));
  }

  async invoke<Name extends HostRouteName>(
    channel: Name,
    ...args: HostRouteArgs<Name>
  ): Promise<HostRouteResult<Name>>;
  async invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (this.closed) {
      throw new Error("host transport closed");
    }
    const ac = new AbortController();
    this.pendingAborts.add(ac);
    try {
      return await runInvokePromise(
        invokeHostRpcUnchecked(this.clientId, channel, args, {
          signal: ac.signal,
          baseUrl: this.baseUrl,
          authToken: this.authToken,
        }),
      );
    } finally {
      this.pendingAborts.delete(ac);
    }
  }

  async invokeWithSignal<Name extends HostRouteName>(
    channel: Name,
    args: HostRouteArgs<Name>,
    signal: AbortSignal,
  ): Promise<HostRouteResult<Name>>;
  async invokeWithSignal(channel: string, args: unknown[], signal: AbortSignal): Promise<unknown>;
  async invokeWithSignal(channel: string, args: unknown[], signal: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error("host transport closed");
    if (signal.aborted) throw requestAbortError(signal);
    const ac = new AbortController();
    const abort = () => ac.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    this.pendingAborts.add(ac);
    try {
      try {
        return await runInvokePromise(
          invokeHostRpcUnchecked(this.clientId, channel, args, {
            signal: ac.signal,
            baseUrl: this.baseUrl,
            authToken: this.authToken,
          }),
        );
      } catch (error) {
        if (signal.aborted) throw requestAbortError(signal);
        throw error;
      }
    } finally {
      signal.removeEventListener("abort", abort);
      this.pendingAborts.delete(ac);
    }
  }

  invokeRealtime<Name extends HostRouteName>(
    channel: Name,
    ...args: HostRouteArgs<Name>
  ): Promise<HostRouteResult<Name>> | null;
  invokeRealtime(channel: string, ...args: unknown[]): Promise<unknown> | null;
  invokeRealtime(channel: string, ...args: unknown[]): Promise<unknown> | null {
    if (this.closed || !isTerminalWsHotOp(channel)) return null;
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return null;
    const requestSequence = ++this.realtimeRequestSequence;
    const requestId = `${this.clientId}:${requestSequence}`;
    let encoded: Uint8Array<ArrayBuffer>;
    if (channel === "terminal:attach") {
      const terminalId = args[0];
      const afterSequence = args[1] ?? 0;
      const mode = args[2] ?? "raw";
      if (
        typeof terminalId !== "string" ||
        typeof afterSequence !== "number" ||
        (mode !== "raw" && mode !== "semantic" && mode !== "both")
      )
        return null;
      encoded = encodeTerminalAttachFrame(
        requestSequence,
        requestId,
        terminalId,
        afterSequence,
        mode,
      );
    } else if (channel === "terminal:ready" || channel === "terminal:detach") {
      const terminalId = args[0];
      if (typeof terminalId !== "string") return null;
      const streamId = this.terminalStreamIds.get(terminalId);
      const stream = streamId === undefined ? undefined : this.terminalStreams.get(streamId);
      if (streamId === undefined || !stream) return null;
      encoded =
        channel === "terminal:ready"
          ? encodeTerminalReadyFrame(streamId, stream.epoch, stream.position, requestId)
          : encodeTerminalDetachFrame(streamId, stream.epoch, stream.position, requestId);
    } else {
      return null;
    }
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRealtime.delete(requestId);
        reject(new Error(`terminal realtime command timed out: ${channel}`));
      }, 10_000);
      this.pendingRealtime.set(requestId, {
        channel,
        resolve,
        reject,
        timeout,
      });
      try {
        socket.send(encoded);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRealtime.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  readTerminalHistory(
    terminalId: string,
    cursor: number,
    maxBytes: number,
    reverse = false,
  ): Promise<{
    chunks: Uint8Array[];
    firstSequence: number;
    lastSequence: number;
    nextSequence: number;
    complete: boolean;
  }> | null {
    const socket = this.socket;
    const streamId = this.terminalStreamIds.get(terminalId);
    const stream = streamId === undefined ? undefined : this.terminalStreams.get(streamId);
    if (!socket || socket.readyState !== WebSocket.OPEN || streamId === undefined || !stream) {
      return null;
    }
    if (this.pendingHistory.has(streamId)) return null;
    stream.controlPosition += 1;
    const request = encodeTerminalScrollbackRequest(
      streamId,
      stream.epoch,
      stream.controlPosition,
      cursor,
      maxBytes,
      reverse,
    );
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingHistory.delete(streamId);
        reject(new Error("terminal scrollback request timed out"));
      }, 10_000);
      this.pendingHistory.set(streamId, {
        epoch: stream.epoch,
        chunks: [],
        firstSequence: 0,
        lastSequence: 0,
        resolve,
        reject,
        timeout,
      });
      try {
        socket.send(request);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingHistory.delete(streamId);
        stream.controlPosition -= 1;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  sendRealtime(channel: string, ...args: unknown[]): boolean {
    if (this.closed || !isTerminalWsHotOp(channel)) return false;
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    if (channel === "terminal:write" || channel === "terminal:writeBinary") {
      const terminalId = args[0];
      const value = args[1];
      if (typeof terminalId !== "string" || typeof value !== "string") return false;
      const streamId = this.terminalStreamIds.get(terminalId);
      const stream = streamId === undefined ? undefined : this.terminalStreams.get(streamId);
      if (streamId === undefined || !stream) return false;
      let payload: Uint8Array;
      if (channel === "terminal:write") {
        payload = new TextEncoder().encode(value);
      } else {
        try {
          const binary = atob(value);
          payload = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        } catch {
          return false;
        }
      }
      if (payload.byteLength === 0) return true;
      stream.inputPosition += payload.byteLength;
      try {
        socket.send(
          encodeTerminalInputFrame(streamId, stream.epoch, stream.inputPosition, payload),
        );
        return true;
      } catch {
        stream.inputPosition -= payload.byteLength;
        return false;
      }
    }
    if (channel === "terminal:resize") {
      const terminalId = args[0];
      const cols = args[1];
      const rows = args[2];
      if (typeof terminalId !== "string" || typeof cols !== "number" || typeof rows !== "number")
        return false;
      const streamId = this.terminalStreamIds.get(terminalId);
      const stream = streamId === undefined ? undefined : this.terminalStreams.get(streamId);
      if (streamId === undefined || !stream) return false;
      stream.controlPosition += 1;
      try {
        socket.send(
          encodeTerminalResizeFrame(streamId, stream.epoch, stream.controlPosition, cols, rows),
        );
        return true;
      } catch {
        stream.controlPosition -= 1;
        return false;
      }
    }
    if (channel !== "terminal:detach" && channel !== "terminal:ready") return false;
    const terminalId = args[0];
    if (typeof terminalId !== "string") return false;
    const streamId = this.terminalStreamIds.get(terminalId);
    const stream = streamId === undefined ? undefined : this.terminalStreams.get(streamId);
    if (streamId === undefined || !stream) return false;
    const requestSequence = ++this.realtimeRequestSequence;
    const requestId = `${this.clientId}:unobserved:${requestSequence}`;
    this.unobservedRealtime.set(requestId, channel);
    // A healthy server answers these immediately. Bound defensive bookkeeping
    // so a peer that violates the result contract cannot leak browser memory.
    if (this.unobservedRealtime.size > 1_024) {
      const oldest = this.unobservedRealtime.keys().next().value;
      if (oldest) this.unobservedRealtime.delete(oldest);
    }
    try {
      if (channel === "terminal:detach") {
        socket.send(encodeTerminalDetachFrame(streamId, stream.epoch, stream.position, requestId));
      } else {
        socket.send(encodeTerminalReadyFrame(streamId, stream.epoch, stream.position, requestId));
      }
      return true;
    } catch {
      this.unobservedRealtime.delete(requestId);
      return false;
    }
  }

  on(channel: string, listener: (...args: unknown[]) => void): () => void {
    let channelListeners = this.listeners.get(channel);
    if (!channelListeners) {
      channelListeners = new Set();
      this.listeners.set(channel, channelListeners);
    }
    channelListeners.add(listener);
    return () => {
      channelListeners!.delete(listener);
      if (channelListeners!.size === 0) this.listeners.delete(channel);
    };
  }

  close(): void {
    this.closed = true;
    this.disposeRealtimeWake?.();
    this.reconnectWake?.();
    this.reconnectWake = null;
    this.rejectPending(new HostDisconnectedError({ message: "host transport closed" }));
    this.rejectRealtime(new Error("host transport closed"));
    this.rejectHistory(new Error("host transport closed"));
    const fiber = this.loopFiber;
    this.loopFiber = null;
    if (fiber) {
      Effect.runFork(Fiber.interrupt(fiber));
    }
    this.socket?.close();
    this.socket = null;
  }

  private reconnectLoop(): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      if (typeof WebSocket === "undefined") return;
      while (!self.closed && !self.accessRevoked) {
        yield* self.openSession();
        if (self.closed || self.accessRevoked) return;
        const preservePending = self.preservePendingOnReconnect;
        self.preservePendingOnReconnect = false;
        self.dispatch("connection:status", "disconnected");
        if (!preservePending) {
          self.rejectPending(
            new HostDisconnectedError({
              message: "host websocket disconnected",
            }),
          );
        }
        // Realtime commands belong to the socket that carried them. Even an
        // intentional foreground reconnect cannot preserve or retransmit raw
        // terminal input safely, so fail them immediately instead of leaving
        // callers parked until the ten-second request timeout.
        self.rejectRealtime(new Error("host websocket disconnected"));
        self.rejectHistory(new Error("host websocket disconnected"));
        const delay = hostRealtimeReconnectDelay(self.reconnectAttempt++);
        if (self.reconnectRequested) {
          self.reconnectRequested = false;
        } else {
          yield* self.waitForReconnect(delay);
          self.reconnectRequested = false;
        }
      }
    });
  }

  private waitForReconnect(delay: Duration.Duration): Effect.Effect<void> {
    const self = this;
    return Effect.async<void>((resume) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (self.reconnectWake === finish) self.reconnectWake = null;
        resume(Effect.void);
      };
      const timer = setTimeout(finish, Duration.toMillis(delay));
      self.reconnectWake = finish;
      return Effect.sync(() => {
        finished = true;
        clearTimeout(timer);
        if (self.reconnectWake === finish) self.reconnectWake = null;
      });
    });
  }

  private wakeRealtime(replaceOpenSocket: boolean): void {
    if (this.closed || this.accessRevoked) return;
    const socket = this.socket;
    const socketOpen = socket?.readyState === WebSocket.OPEN;
    if (!replaceOpenSocket && socketOpen) return;
    this.reconnectRequested = true;
    if (
      replaceOpenSocket &&
      socket &&
      (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
    ) {
      this.preservePendingOnReconnect = true;
      socket.close(4000, "page returned to foreground");
    }
    this.reconnectWake?.();
  }

  private openSession(): Effect.Effect<void> {
    const self = this;
    return Effect.scoped(
      Effect.acquireRelease(
        Effect.sync(() => {
          const socket = new WebSocket(
            websocketUrl(
              window.location,
              self.lastSequence,
              self.clientId,
              self.authToken === undefined ? readHostAuthToken() : self.authToken,
              self.baseUrl,
              2,
            ),
          );
          socket.binaryType = "arraybuffer";
          self.socket = socket;
          return socket;
        }),
        (socket) =>
          Effect.sync(() => {
            if (self.socket === socket) self.socket = null;
            if (
              socket.readyState === WebSocket.OPEN ||
              socket.readyState === WebSocket.CONNECTING
            ) {
              socket.close();
            }
          }),
      ).pipe(
        Effect.flatMap((socket) =>
          Effect.async<void>((resume) => {
            let settled = false;
            let heartbeat: ReturnType<typeof setInterval> | null = null;
            self.lastPongAt = Date.now();
            const connectTimeout = setTimeout(() => {
              try {
                socket.close(4000, "realtime connection timed out");
              } catch {
                finish();
              }
            }, REALTIME_CONNECT_TIMEOUT_MS);
            const stopTimers = () => {
              clearTimeout(connectTimeout);
              if (heartbeat !== null) {
                clearInterval(heartbeat);
                heartbeat = null;
              }
            };
            const finish = () => {
              if (settled) return;
              settled = true;
              stopTimers();
              resume(Effect.void);
            };
            socket.addEventListener("open", () => {
              clearTimeout(connectTimeout);
              self.reconnectAttempt = 0;
              self.synchronized = false;
              self.terminalStreams.clear();
              self.terminalStreamIds.clear();
              self.dispatch("connection:status", "synchronizing");
              self.lastPongAt = Date.now();
              heartbeat = setInterval(() => {
                if (Date.now() - self.lastPongAt > REALTIME_HEARTBEAT_TIMEOUT_MS) {
                  socket.close(4000, "realtime heartbeat timed out");
                  return;
                }
                if (socket.readyState === WebSocket.OPEN) {
                  try {
                    socket.send(encodeTerminalPingFrame(Date.now()));
                  } catch {
                    socket.close();
                  }
                }
              }, REALTIME_HEARTBEAT_INTERVAL_MS);
              const token = self.authToken === undefined ? readHostAuthToken() : self.authToken;
              if (token) {
                try {
                  socket.send(JSON.stringify({ type: "protocol:auth", token }));
                } catch {
                  socket.close();
                }
              }
            });
            socket.addEventListener("message", (event) => {
              if (typeof event.data !== "string") {
                self.handleBinaryMessage(event.data);
                return;
              }
              if (event.data === "pong") {
                self.lastPongAt = Date.now();
                return;
              }
              let raw: unknown;
              try {
                raw = JSON.parse(event.data);
              } catch {
                self.dispatch("protocol:error", "Invalid realtime message");
                return;
              }
              if (self.handleProtocolControl(raw)) return;
              const terminalResult = tryDecodeTerminalWsResult(raw);
              if (terminalResult) {
                self.resolveRealtime(terminalResult);
                return;
              }
              const message = tryDecodeRealtimeHostEvent(raw);
              if (!message) {
                self.dispatch("protocol:error", "Unsupported realtime protocol");
                return;
              }
              const identity =
                self.serverId && self.serverEpoch
                  ? { serverId: self.serverId, serverEpoch: self.serverEpoch }
                  : undefined;
              if (!acceptHostEvent(self.lastSequence, message, identity)) return;
              self.lastSequence = message.sequence;
              if (message.channel === "server:shuttingDown") {
                self.rejectPending(
                  new HostDisconnectedError({
                    message: "host server shutting down",
                  }),
                );
              }
              self.dispatch(message.channel, ...message.args);
            });
            socket.addEventListener("close", (event) => {
              if (event.code === 4003) {
                self.accessRevoked = true;
                const reason = event.reason.trim() || "authentication failed";
                self.dispatch(
                  "protocol:error",
                  /revoked/i.test(reason) ? "access revoked" : reason,
                );
              }
              finish();
            });
            socket.addEventListener("error", () => {
              try {
                socket.close();
              } catch {
                /* ignore */
              }
            });
            return Effect.sync(() => {
              stopTimers();
              try {
                socket.close();
              } catch {
                /* ignore */
              }
            });
          }),
        ),
      ),
    );
  }

  private handleProtocolControl(raw: unknown): boolean {
    const replayRequired = tryDecodeTerminalReplayRequired(raw);
    if (replayRequired) {
      this.dispatch("terminal:replay-required", replayRequired.terminalId, replayRequired.sequence);
      return true;
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
    const record = raw as Record<string, unknown>;
    if (record.type === "protocol:auth-required") {
      const token = this.authToken === undefined ? readHostAuthToken() : this.authToken;
      if (!token) {
        this.dispatch("protocol:error", "authentication required");
        this.socket?.close(4003, "authentication required");
      }
      return true;
    }
    if (record.type === "protocol:hello") {
      const identity = record.identity;
      if (identity === null || typeof identity !== "object" || Array.isArray(identity)) {
        this.dispatch("protocol:error", "Invalid protocol hello");
        return true;
      }
      const value = identity as Record<string, unknown>;
      if (typeof value.serverId !== "string" || typeof value.serverEpoch !== "string") {
        this.dispatch("protocol:error", "Invalid server identity");
        return true;
      }
      const changed =
        this.serverId !== null &&
        (this.serverId !== value.serverId || this.serverEpoch !== value.serverEpoch);
      this.serverId = value.serverId;
      this.serverEpoch = value.serverEpoch;
      if (changed) {
        this.lastSequence = 0;
        this.rejectRealtime(new Error("SERVER_EPOCH_CHANGED"));
      }
      this.dispatch("protocol:hello", raw);
      return true;
    }
    if (record.type !== "runtime:snapshot") return false;
    const identity = record.identity;
    const cursor = record.cursor;
    if (
      identity === null ||
      typeof identity !== "object" ||
      Array.isArray(identity) ||
      cursor === null ||
      typeof cursor !== "object" ||
      Array.isArray(cursor)
    ) {
      this.dispatch("protocol:error", "Invalid runtime snapshot");
      return true;
    }
    const identityRecord = identity as Record<string, unknown>;
    const cursorRecord = cursor as Record<string, unknown>;
    if (
      typeof identityRecord.serverId !== "string" ||
      typeof identityRecord.serverEpoch !== "string" ||
      identityRecord.serverId !== this.serverId ||
      identityRecord.serverEpoch !== this.serverEpoch ||
      typeof cursorRecord.sequence !== "number" ||
      cursorRecord.serverEpoch !== this.serverEpoch
    ) {
      this.dispatch("protocol:error", "Snapshot identity does not match connection");
      return true;
    }
    this.lastSequence = cursorRecord.sequence;
    this.synchronized = true;
    this.dispatch("runtime:snapshot", raw);
    this.dispatch("connection:status", "connected");
    return true;
  }

  private handleBinaryMessage(data: unknown): void {
    // Prefer zero-copy views — decodeTerminalDataFrame accepts ArrayBufferView.
    // Avoid TypedArray.buffer.slice() which allocated on every terminal:data frame.
    let frame: ArrayBuffer | ArrayBufferView | null = null;
    if (data instanceof ArrayBuffer) frame = data;
    else if (ArrayBuffer.isView(data)) frame = data;
    if (!frame) {
      this.dispatch("protocol:error", "Unsupported realtime binary message");
      return;
    }
    const decoded = decodeTerminalDataFrame(frame);
    if (!decoded) {
      this.dispatch("protocol:error", "Unsupported realtime binary message");
      return;
    }
    if (decoded.frameType === "pong") {
      this.lastPongAt = Date.now();
      return;
    }
    if (
      decoded.frameType === "hello" ||
      decoded.frameType === "attach-ack" ||
      decoded.frameType === "control-ack" ||
      decoded.frameType === "error"
    ) {
      let control: unknown;
      try {
        control = JSON.parse(new TextDecoder().decode(decoded.payload));
      } catch {
        this.dispatch("protocol:error", "Invalid terminal control payload");
        return;
      }
      if (decoded.frameType === "hello") {
        this.handleProtocolControl(control);
        return;
      }
      const result = tryDecodeTerminalWsResult(control);
      if (result) {
        this.resolveRealtime(result);
        return;
      }
      if (decoded.frameType === "error") {
        const message =
          control !== null && typeof control === "object" && "message" in control
            ? control.message
            : undefined;
        this.dispatch(
          "protocol:error",
          typeof message === "string" ? message : "terminal operation failed",
        );
        return;
      }
      this.dispatch("protocol:error", "Invalid terminal control acknowledgement");
      return;
    }
    const stream =
      decoded.streamId === undefined ? null : (this.terminalStreams.get(decoded.streamId) ?? null);
    const terminalId = decoded.id ?? stream?.id;
    if (!terminalId) {
      this.dispatch("protocol:error", "Terminal data arrived before ATTACH_ACK");
      return;
    }
    if (decoded.frameType === "session-exit") {
      if (!stream || decoded.streamEpoch !== stream.epoch) {
        this.dispatch("protocol:error", "Invalid terminal exit epoch");
        return;
      }
      try {
        const args: unknown = JSON.parse(new TextDecoder().decode(decoded.payload));
        if (!Array.isArray(args)) throw new Error("invalid exit payload");
        this.dispatch("terminal:exit", ...args);
      } catch {
        this.dispatch("protocol:error", "Invalid terminal exit payload");
      }
      return;
    }
    if (
      decoded.frameType === "scrollback-begin" ||
      decoded.frameType === "scrollback-chunk" ||
      decoded.frameType === "scrollback-end"
    ) {
      if (!stream || decoded.streamEpoch !== stream.epoch) {
        this.dispatch("protocol:error", "Invalid terminal scrollback epoch");
        return;
      }
      const pending = this.pendingHistory.get(decoded.streamId!);
      if (!pending || pending.epoch !== stream.epoch) return;
      if (decoded.frameType === "scrollback-begin") {
        pending.chunks.length = 0;
        pending.firstSequence = 0;
        pending.lastSequence = 0;
        return;
      }
      if (decoded.frameType === "scrollback-chunk") {
        if (pending.firstSequence === 0) pending.firstSequence = decoded.terminalSequence;
        if (pending.lastSequence !== 0) {
          const firstByte = decoded.terminalSequence - decoded.payload.byteLength + 1;
          if (firstByte !== pending.lastSequence + 1) {
            clearTimeout(pending.timeout);
            this.pendingHistory.delete(decoded.streamId!);
            pending.reject(new Error("terminal scrollback sequence gap"));
            return;
          }
        }
        pending.lastSequence = decoded.terminalSequence;
        pending.chunks.push(decoded.payload);
        return;
      }
      if (decoded.payload.byteLength !== 1 || decoded.payload[0]! > 1) {
        clearTimeout(pending.timeout);
        this.pendingHistory.delete(decoded.streamId!);
        pending.reject(
          new Error(
            decoded.payload[0] === 2
              ? "terminal scrollback queue is full"
              : "invalid terminal scrollback completion",
          ),
        );
        return;
      }
      clearTimeout(pending.timeout);
      this.pendingHistory.delete(decoded.streamId!);
      pending.resolve({
        chunks: pending.chunks,
        firstSequence: pending.firstSequence,
        lastSequence: pending.lastSequence,
        nextSequence: decoded.terminalSequence,
        complete: decoded.payload[0] === 1,
      });
      return;
    }
    if (decoded.frameType === "resync-begin") {
      if (!stream || decoded.streamEpoch !== stream.epoch) {
        this.dispatch("protocol:error", "Invalid terminal resynchronization epoch");
        return;
      }
      stream.position = decoded.terminalSequence;
      this.dispatch("terminal:replay-required", terminalId, stream.position);
      return;
    }
    if (decoded.frameType === "snapshot") {
      if (
        !stream ||
        decoded.streamEpoch !== stream.epoch ||
        decoded.terminalSequence !== stream.position
      ) {
        this.dispatch("terminal:replay-required", terminalId, stream?.position ?? 0);
        return;
      }
      this.dispatch(
        "terminal:snapshot-bytes",
        terminalId,
        decoded.payload,
        decoded.terminalSequence,
      );
      return;
    }
    if (decoded.frameType === "ready") {
      if (
        !stream ||
        decoded.streamEpoch !== stream.epoch ||
        decoded.terminalSequence !== stream.position
      ) {
        this.dispatch("terminal:replay-required", terminalId, stream?.position ?? 0);
        return;
      }
      this.dispatch("terminal:ready", terminalId, decoded.terminalSequence);
      return;
    }
    if (stream) {
      const firstByte = decoded.terminalSequence - decoded.payload.byteLength + 1;
      if (decoded.streamEpoch !== stream.epoch || firstByte !== stream.position + 1) {
        const socket = this.socket;
        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(
            encodeTerminalResyncRequest(decoded.streamId!, stream.epoch, stream.position),
          );
        }
        this.dispatch("terminal:replay-required", terminalId, stream.position);
        return;
      }
      stream.position = decoded.terminalSequence;
    }
    const message: HostEvent =
      this.serverId && this.serverEpoch
        ? {
            protocolVersion: 2,
            serverId: this.serverId,
            serverEpoch: this.serverEpoch,
            sequence: decoded.eventSequence,
            channel: "terminal:data",
            args: [terminalId, decoded.payload, decoded.terminalSequence],
          }
        : {
            protocolVersion: 1,
            sequence: decoded.eventSequence,
            channel: "terminal:data",
            args: [terminalId, decoded.payload, decoded.terminalSequence],
          };
    const identity =
      this.serverId && this.serverEpoch
        ? { serverId: this.serverId, serverEpoch: this.serverEpoch }
        : undefined;
    if (decoded.streamId === undefined) {
      if (!acceptHostEvent(this.lastSequence, message, identity)) return;
      this.lastSequence = message.sequence;
    }
    const socket = this.socket;
    let acknowledged = false;
    const acknowledge = () => {
      if (acknowledged) return;
      acknowledged = true;
      if (
        socket?.readyState === WebSocket.OPEN &&
        decoded.streamId !== undefined &&
        decoded.streamEpoch !== undefined
      ) {
        socket.send(
          encodeTerminalAckFrame(decoded.streamId, decoded.streamEpoch, decoded.terminalSequence),
        );
      }
    };
    const delivered = this.dispatch(message.channel, ...message.args, acknowledge);
    // A transport without an API projection still must not strand server-side
    // flow credit forever.
    if (delivered === 0) acknowledge();
  }

  private rejectPending(error: HostDisconnectedError): void {
    for (const ac of [...this.pendingAborts]) {
      ac.abort(error);
    }
  }

  private resolveRealtime(result: import("@yaade/rpc").TerminalWsResult): void {
    const pending = this.pendingRealtime.get(result.requestId);
    if (!pending) {
      const channel = this.unobservedRealtime.get(result.requestId);
      if (!channel) return;
      this.unobservedRealtime.delete(result.requestId);
      if (!result.ok) {
        this.dispatch(
          "protocol:error",
          `${channel} failed: ${result.error?.message ?? "terminal command failed"}`,
        );
      }
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingRealtime.delete(result.requestId);
    if (result.ok) {
      try {
        const decoded = decodeHostRouteResult(pending.channel, result.value);
        if (
          pending.channel === "terminal:attach" &&
          decoded !== null &&
          typeof decoded === "object"
        ) {
          const streamId = "streamId" in decoded ? decoded.streamId : undefined;
          const streamEpoch = "streamEpoch" in decoded ? decoded.streamEpoch : undefined;
          const terminalId = "id" in decoded ? decoded.id : undefined;
          const position = "lastSequence" in decoded ? decoded.lastSequence : undefined;
          if (
            typeof streamId === "number" &&
            Number.isSafeInteger(streamId) &&
            typeof streamEpoch === "number" &&
            Number.isSafeInteger(streamEpoch) &&
            typeof terminalId === "string" &&
            typeof position === "number" &&
            Number.isSafeInteger(position)
          ) {
            this.terminalStreams.set(streamId, {
              id: terminalId,
              epoch: streamEpoch,
              position,
              inputPosition: 0,
              controlPosition: 0,
            });
            this.terminalStreamIds.set(terminalId, streamId);
          }
        }
        pending.resolve(decoded);
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    pending.reject(new Error(result.error?.message ?? "terminal command failed"));
  }

  private rejectHistory(error: Error): void {
    for (const pending of this.pendingHistory.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingHistory.clear();
  }

  private rejectRealtime(error: Error): void {
    for (const pending of this.pendingRealtime.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRealtime.clear();
    if (this.unobservedRealtime.size > 0) {
      const count = this.unobservedRealtime.size;
      this.unobservedRealtime.clear();
      this.dispatch(
        "protocol:error",
        `${count} terminal command${count === 1 ? " was" : "s were"} not acknowledged before disconnect`,
      );
    }
  }

  private dispatch(channel: string, ...args: unknown[]): number {
    const listeners = this.listeners.get(channel);
    if (!listeners) return 0;
    let delivered = 0;
    for (const listener of [...listeners]) {
      delivered += 1;
      try {
        listener(...args);
      } catch (error) {
        if (channel === "protocol:error") continue;
        const message = error instanceof Error ? error.message : String(error);
        for (const onProtocolError of [...(this.listeners.get("protocol:error") ?? [])]) {
          try {
            onProtocolError(`Realtime listener failed: ${message}`);
          } catch {
            // A diagnostic listener must not compromise socket delivery.
          }
        }
      }
    }
    return delivered;
  }
}

function requestAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error && signal.reason.name === "AbortError") {
    return signal.reason;
  }
  const error = new Error(
    signal.reason instanceof Error ? signal.reason.message : "host invoke aborted",
  );
  error.name = "AbortError";
  return error;
}

export function createWebTransport(): YaadeHostTransport {
  return new WebHostTransport();
}
