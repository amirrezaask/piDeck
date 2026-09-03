import type {
  TerminalAttachOptions,
  TerminalReplayChunk,
  YaadeHostAPI,
} from "@yaade/workspace"
import { Schema } from "effect";
import {
  GHOSTTY_ENGINE_REVISION,
  GHOSTTY_SNAPSHOT_FORMAT_VERSION,
  MAX_TERMINAL_CHECKPOINT_BYTES,
  MuxEvent,
  TERMINAL_CHECKPOINT_MAGIC,
  TERMINAL_CHECKPOINT_VERSION,
  type TerminalCheckpoint,
} from "@yaade/rpc";
import type { YaadeHostTransport } from "./transport.js";

// Host owns the authoritative terminal replay. This buffer only bridges an
// in-flight attach/resync; off-screen terminals are replayed from the host.
const MAX_BUFFERED_TERMINAL_BYTES = 2 * 1024 * 1024;

function concatTerminalBytes(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array()
  if (chunks.length === 1) return chunks[0]!
  let length = 0
  for (const chunk of chunks) length += chunk.byteLength
  const joined = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}

type TerminalAttachResult = {
  id: string;
  title?: string;
  terminalEpoch?: string;
  ownerId?: string;
  ownerEpoch?: string;
  protocolVersion?: number;
  checkpoint?: TerminalCheckpoint;
  replayQuality?: "exact" | "checkpoint" | "degraded";
  outputChunks?: Uint8Array[];
  output: Uint8Array;
  replayTruncated?: boolean;
  replayNeedsQueryResponses?: boolean;
  archiveAvailable?: boolean;
  lastSequence: number;
  status: "running" | "exited";
  exitCode?: number;
  signal?: number;
  semanticSnapshot?: import("@yaade/rpc").TerminalSemanticSnapshot | null;
};

/** Reject stale or malformed checkpoint envelopes before invoking Ghostty. */
async function validTerminalCheckpoint(
  checkpoint: TerminalCheckpoint,
  terminalEpoch: string | undefined,
): Promise<boolean> {
  const bytes = checkpoint.snapshotBytes
  if (
    checkpoint.magic !== TERMINAL_CHECKPOINT_MAGIC ||
    checkpoint.checkpointVersion !== TERMINAL_CHECKPOINT_VERSION ||
    checkpoint.terminalEpoch !== terminalEpoch ||
    checkpoint.engine !== "ghostty-vt" ||
    checkpoint.engineRevision !== GHOSTTY_ENGINE_REVISION ||
    checkpoint.snapshotFormatVersion !== GHOSTTY_SNAPSHOT_FORMAT_VERSION ||
    checkpoint.codec !== "none" ||
    checkpoint.payloadBytes !== bytes.byteLength ||
    checkpoint.payloadBytes > MAX_TERMINAL_CHECKPOINT_BYTES ||
    bytes.byteLength < 10 ||
    new TextDecoder().decode(bytes.subarray(0, 8)) !== "GHOSTSNP" ||
    new DataView(bytes.buffer, bytes.byteOffset + 8, 2).getUint16(0, true) !==
      GHOSTTY_SNAPSHOT_FORMAT_VERSION
  ) return false
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return false
  const owned = new Uint8Array(bytes.byteLength)
  owned.set(bytes)
  const digest = new Uint8Array(await subtle.digest("SHA-256", owned.buffer))
  let hex = ""
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0")
  return hex === checkpoint.payloadSha256
}

/** Prefer acknowledged WS delivery for hot terminal I/O; fall back to HTTP RPC. */
function invokeTerminalHot(
  transport: YaadeHostTransport,
  channel: string,
  ...args: unknown[]
): Promise<void> {
  const realtime = transport.invokeRealtime?.(channel, ...args);
  if (realtime) return realtime.then(() => undefined);
  return transport.invoke(channel, ...args).then(() => undefined);
}

export function createYaadeApi(transport: YaadeHostTransport): YaadeHostAPI {
  type TerminalDataListener = (
    data: Uint8Array,
    replay?: boolean,
    replayNeedsQueryResponses?: boolean,
    replayTruncated?: boolean,
    acknowledgeConsumed?: () => void,
  ) => void;
  type TerminalDataRegistration = {
    callback: TerminalDataListener;
    acknowledgement: "delivery" | "consumption";
  };
  const terminalDataListeners = new Map<
    string,
    Set<TerminalDataRegistration>
  >();
  type BufferedTerminalData = {
    data: Uint8Array;
    sequence: number;
    replay?: boolean;
    replayNeedsQueryResponses?: boolean;
    replayTruncated?: boolean;
    acknowledge?: () => void;
  };
  const terminalDataBuffers = new Map<string, BufferedTerminalData[]>();
  const terminalDataBufferSizes = new Map<string, number>();
  const terminalBufferGaps = new Set<string>();
  const terminalReplayFloors = new Map<string, number>();
  const terminalResyncing = new Set<string>();
  const terminalResyncInFlight = new Map<string, Promise<boolean>>();
  const terminalResyncAgain = new Set<string>();
  const terminalResyncAttempts = new Map<string, number>();
  const terminalResyncRetryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  const terminalReplayStreaming = new Set<string>();
  const terminalCheckpointRestorers = new Map<
    string,
    NonNullable<TerminalAttachOptions["onCheckpoint"]>
  >();
  const terminalBinarySnapshots = new Map<
    string,
    { sequence: number; bytes: Uint8Array }
  >();
  const terminalReadyPositions = new Map<string, number>();
  const terminalSyncWaiters = new Map<string, Set<() => void>>();
  const wakeTerminalSync = (id: string) => {
    for (const wake of terminalSyncWaiters.get(id) ?? []) wake();
  };
  const awaitTerminalSnapshot = async (
    id: string,
    sequence: number,
  ): Promise<Uint8Array> => {
    const available = () => {
      const snapshot = terminalBinarySnapshots.get(id);
      const ready = terminalReadyPositions.get(id);
      return snapshot?.sequence === sequence && ready === sequence
        ? snapshot.bytes
        : null;
    };
    const current = available();
    if (current) {
      terminalBinarySnapshots.delete(id);
      terminalReadyPositions.delete(id);
      return current;
    }
    await new Promise<void>((resolve, reject) => {
      const waiters = terminalSyncWaiters.get(id) ?? new Set<() => void>();
      const wake = () => {
        if (!available()) return;
        clearTimeout(timeout);
        waiters.delete(wake);
        resolve();
      };
      const timeout = setTimeout(() => {
        waiters.delete(wake);
        reject(new Error("terminal snapshot READY barrier timed out"));
      }, 10_000);
      waiters.add(wake);
      terminalSyncWaiters.set(id, waiters);
    });
    const snapshot = available();
    if (!snapshot) throw new Error("terminal snapshot missing at READY barrier");
    terminalBinarySnapshots.delete(id);
    terminalReadyPositions.delete(id);
    return snapshot;
  };
  let realtimeConnected = false;
  let reconnectGeneration = 0;
  let hadRealtimeDisconnect = false;

  const bufferTerminalData = (
    id: string,
    data: Uint8Array,
    sequence: number,
    replay = false,
    replayNeedsQueryResponses = false,
    replayTruncated = false,
    acknowledge?: () => void,
  ) => {
    const pending = terminalDataBuffers.get(id) ?? [];
    const buffered: BufferedTerminalData = { data, sequence }
    if (replay) buffered.replay = true
    if (replayNeedsQueryResponses) buffered.replayNeedsQueryResponses = true
    if (replayTruncated) buffered.replayTruncated = true
    if (acknowledge) buffered.acknowledge = acknowledge
    pending.push(buffered)
    let size = (terminalDataBufferSizes.get(id) ?? 0) + data.byteLength;
    while (size > MAX_BUFFERED_TERMINAL_BYTES && pending.length > 1) {
      size -= pending.shift()!.data.byteLength;
      terminalBufferGaps.add(id);
    }
    if (size > MAX_BUFFERED_TERMINAL_BYTES) terminalBufferGaps.add(id);
    terminalDataBuffers.set(id, pending);
    terminalDataBufferSizes.set(id, size);
  };

  const deliverTerminalData = (
    id: string,
    data: Uint8Array,
    replay = false,
    replayNeedsQueryResponses = false,
    replayTruncated = false,
    acknowledge?: () => void,
  ) => {
    const listeners = terminalDataListeners.get(id);
    if (!listeners || listeners.size === 0) return false;
    const registrations = [...listeners];
    let awaitingConsumption = acknowledge
      ? registrations.filter(
          registration => registration.acknowledgement === "consumption",
        ).length
      : 0;
    let acknowledged = false;
    const acknowledgeOnce = () => {
      if (acknowledged) return;
      acknowledged = true;
      acknowledge?.();
    };
    for (const registration of registrations) {
      if (
        acknowledge &&
        registration.acknowledgement === "consumption"
      ) {
        let consumed = false;
        registration.callback(
          data,
          replay,
          replayNeedsQueryResponses,
          replayTruncated,
          () => {
            if (consumed) return;
            consumed = true;
            awaitingConsumption -= 1;
            if (awaitingConsumption === 0) acknowledgeOnce();
          },
        );
      } else {
        registration.callback(
          data,
          replay,
          replayNeedsQueryResponses,
          replayTruncated,
        );
      }
    }
    if (awaitingConsumption === 0) acknowledgeOnce();
    return true;
  };

  const attachTerminal = (
    id: string,
    afterSequence = 0,
    mode: "raw" | "semantic" | "both" = "raw",
  ): Promise<TerminalAttachResult | null> => {
    const realtime = transport.invokeRealtime?.(
      "terminal:attach",
      id,
      afterSequence,
      mode,
    );
    if (realtime) return realtime;
    return transport.invoke("terminal:attach", id, afterSequence, mode);
  };

  const restoreCheckpoint = async (
    id: string,
    result: TerminalAttachResult,
    restore?: TerminalAttachOptions["onCheckpoint"],
  ): Promise<number | null> => {
    const checkpoint = result.checkpoint
    const restoreSnapshot = restore ?? terminalCheckpointRestorers.get(id)
    if (!checkpoint || !restoreSnapshot) return null
    try {
      if (!await validTerminalCheckpoint(checkpoint, result.terminalEpoch)) return null
      await restoreSnapshot(checkpoint)
      return checkpoint.sequence
    } catch {
      // The restore target is atomic. Fall back to exact raw history without
      // exposing its rejected replacement core.
      return null
    }
  }

  const previewNewestReplay = async (
    id: string,
    result: TerminalAttachResult,
    onPreview: NonNullable<TerminalAttachOptions["onReplayPreview"]>,
  ): Promise<boolean> => {
    if (result.archiveAvailable !== true || result.lastSequence <= 0) return false;
    const resultChunks =
      result.outputChunks && result.outputChunks.length > 0
        ? result.outputChunks
        : result.output.byteLength > 0
          ? [result.output]
          : [];
    let previewChunks = resultChunks;
    let replayTruncated = result.replayTruncated === true;
    if (previewChunks.length === 0) {
      try {
        const page = await transport.invoke(
          "terminal:readReplayPage",
          id,
          0,
          256 * 1024,
          "backward",
        );
        if (page?.chunks.length) {
          previewChunks = page.chunks;
          replayTruncated = page.firstSequence > 1;
        }
      } catch {
        // A preview is opportunistic. Ordered replay remains authoritative.
      }
    }
    if (previewChunks.length === 0) return false;
    await onPreview({
      data: concatTerminalBytes(previewChunks),
      replayNeedsQueryResponses: false,
      replayTruncated,
    });
    return true;
  };

  const streamArchivedReplay = async (
    id: string,
    result: TerminalAttachResult,
    afterSequence: number,
    generation?: number,
    onReplay?: TerminalAttachOptions["onReplay"],
  ): Promise<{
    delivered: boolean;
    complete: boolean;
    lastSequence: number;
  }> => {
    if (
      result.archiveAvailable !== true ||
      afterSequence >= result.lastSequence
    ) {
      return {
        delivered: false,
        complete: afterSequence >= result.lastSequence,
        lastSequence: afterSequence,
      };
    }
    let cursor = afterSequence;
    let complete = false;
    let delivered = false;
    let firstChunk = true;
    while (
      !complete &&
      (generation === undefined || generation === reconnectGeneration)
    ) {
      const page = await transport.invoke(
        "terminal:readReplayPage",
        id,
        cursor,
        256 * 1024,
      );
      if (!page || page.chunks.length === 0 || page.nextSequence <= cursor) break;
      const firstChunkBytes = page.chunks[0]?.byteLength ?? 0;
      const firstByte = Math.max(1, page.firstSequence - firstChunkBytes + 1);
      const pageHasGap = firstByte > cursor + 1;
      const replay: TerminalReplayChunk = {
        data: concatTerminalBytes(page.chunks),
        replayNeedsQueryResponses:
          result.replayNeedsQueryResponses === true,
        replayTruncated:
          firstChunk && (result.replayTruncated === true || pageHasGap),
      };
      if (onReplay) {
        await onReplay(replay);
      } else if (
        !deliverTerminalData(
          id,
          replay.data,
          true,
          replay.replayNeedsQueryResponses,
          replay.replayTruncated,
        )
      ) {
        bufferTerminalData(
          id,
          replay.data,
          0,
          true,
          replay.replayNeedsQueryResponses,
          replay.replayTruncated,
        );
      }
      firstChunk = false;
      delivered = true;
      cursor = page.nextSequence;
      complete = page.complete || cursor >= result.lastSequence;
      terminalReplayFloors.set(id, cursor);
      // Yield between pages so large archives never monopolize the browser.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    return { delivered, complete, lastSequence: cursor };
  };

  const resyncTerminal = async (id: string, generation: number) => {
    const afterSequence = terminalReplayFloors.get(id) ?? 0;
    if (terminalBufferGaps.delete(id)) {
      terminalDataBuffers.delete(id);
      terminalDataBufferSizes.delete(id);
    }
    try {
      // Must go over the live socket so the host arms `attachedTerminals`.
      // HTTP attach replays the ring but leaves live `terminal:data` dropped.
      const result = await attachTerminal(id, afterSequence);
      if (
        generation !== reconnectGeneration ||
        !realtimeConnected ||
        !terminalResyncing.has(id)
      ) {
        return true;
      }
      if (!result) {
        terminalResyncing.delete(id);
        return true;
      }
      let chunks =
        result.outputChunks && result.outputChunks.length > 0
          ? result.outputChunks
          : result.output.byteLength > 0
            ? [result.output]
            : [];
      const restoredSequence = await restoreCheckpoint(id, result)
      const replayStart = restoredSequence ?? afterSequence
      const archived = await streamArchivedReplay(
        id,
        restoredSequence === null ? result : { ...result, replayTruncated: false },
        replayStart,
        generation,
      );
      if (archived.complete) chunks = [];
      const replayedThrough = Math.max(
        result.lastSequence,
        archived.lastSequence,
      );
      const pending = terminalDataBuffers.get(id);
      terminalDataBuffers.delete(id);
      terminalDataBufferSizes.delete(id);
      terminalReplayFloors.set(id, replayedThrough);
      if (terminalBufferGaps.delete(id)) {
        // Live output outran the bounded attach bridge. Retry from the
        // authoritative result cursor instead of exposing a partial stream.
        terminalResyncAgain.add(id);
        return true;
      }
      terminalResyncing.delete(id);
      let firstReplayChunk = true;
      for (const chunk of chunks) {
        const replayTruncated =
          firstReplayChunk && result.replayTruncated === true;
        if (chunk.byteLength > 0) {
          if (
            !deliverTerminalData(
              id,
              chunk,
              true,
              result.replayNeedsQueryResponses === true,
              replayTruncated,
            )
          ) {
            bufferTerminalData(
              id,
              chunk,
              0,
              true,
              result.replayNeedsQueryResponses === true,
              replayTruncated,
            );
          }
          firstReplayChunk = false;
        }
      }
      for (const chunk of pending ?? []) {
        if (chunk.sequence > 0 && chunk.sequence <= replayedThrough) {
          chunk.acknowledge?.();
          continue;
        }
        if (
          !deliverTerminalData(
            id,
            chunk.data,
            chunk.replay === true,
            chunk.replayNeedsQueryResponses === true,
            chunk.replayTruncated === true,
            chunk.acknowledge,
          )
        ) {
          bufferTerminalData(
            id,
            chunk.data,
            chunk.sequence,
            chunk.replay === true,
            chunk.replayNeedsQueryResponses === true,
            chunk.replayTruncated === true,
            chunk.acknowledge,
          );
        }
      }
      return true;
    } catch {
      // Keep the terminal marked for a bounded connected-socket retry.
      return false;
    }
  };

  const requestTerminalResync = (id: string, generation: number): void => {
    terminalResyncing.add(id);
    if (terminalResyncInFlight.has(id)) {
      terminalResyncAgain.add(id);
      return;
    }
    let succeeded = false;
    let request: Promise<boolean>;
    request = resyncTerminal(id, generation)
      .then(result => {
        succeeded = result;
        if (result) terminalResyncAttempts.delete(id);
        return result;
      })
      .finally(() => {
        if (terminalResyncInFlight.get(id) === request) {
          terminalResyncInFlight.delete(id);
        }
        if (
          terminalResyncAgain.delete(id) &&
          generation === reconnectGeneration &&
          realtimeConnected
        ) {
          terminalResyncing.add(id);
          requestTerminalResync(id, generation);
          return;
        }
        if (
          !succeeded &&
          generation === reconnectGeneration &&
          realtimeConnected &&
          !terminalResyncRetryTimers.has(id)
        ) {
          const attempt = terminalResyncAttempts.get(id) ?? 0;
          terminalResyncAttempts.set(id, attempt + 1);
          const delay = Math.min(10_000, 250 * 2 ** attempt);
          const timer = setTimeout(() => {
            terminalResyncRetryTimers.delete(id);
            if (
              generation === reconnectGeneration &&
              realtimeConnected &&
              terminalResyncing.has(id)
            ) {
              requestTerminalResync(id, generation);
            }
          }, delay);
          terminalResyncRetryTimers.set(id, timer);
        }
      });
    terminalResyncInFlight.set(id, request);
  };

  transport.on("connection:status", (...args: unknown[]) => {
    const status = args[0];
    if (status === "disconnected") {
      realtimeConnected = false;
      hadRealtimeDisconnect = true;
      reconnectGeneration += 1;
      for (const timer of terminalResyncRetryTimers.values()) {
        clearTimeout(timer);
      }
      terminalResyncRetryTimers.clear();
      terminalResyncAttempts.clear();
      for (const id of terminalDataListeners.keys()) terminalResyncing.add(id);
      return;
    }
    if (status !== "connected") return;
    realtimeConnected = true;
    const generation = reconnectGeneration;
    for (const id of terminalResyncing) {
      requestTerminalResync(id, generation);
    }
    if (hadRealtimeDisconnect && typeof window !== "undefined") {
      hadRealtimeDisconnect = false;
      window.dispatchEvent(new Event("yaade:host-reconnected"));
    }
  });

  transport.on("protocol:replay-gap", (...args: unknown[]) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("yaade:host-replay-gap", {
        detail: { replayFloor: args[0], lastSequence: args[1] },
      }),
    );
  });

  transport.on("runtime:snapshot", (...args: unknown[]) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("yaade:runtime-snapshot", { detail: args[0] }),
    );
  });

  transport.on("terminal:snapshot-bytes", (...args: unknown[]) => {
    const id = args[0];
    const bytes = args[1];
    const sequence = args[2];
    if (
      typeof id !== "string" ||
      !(bytes instanceof Uint8Array) ||
      typeof sequence !== "number"
    ) return;
    terminalBinarySnapshots.set(id, { sequence, bytes });
    wakeTerminalSync(id);
  });
  transport.on("terminal:ready", (...args: unknown[]) => {
    const id = args[0];
    const sequence = args[1];
    if (typeof id !== "string" || typeof sequence !== "number") return;
    terminalReadyPositions.set(id, sequence);
    wakeTerminalSync(id);
  });

  transport.on("terminal:data", (...args: unknown[]) => {
    const id = args[0] as string;
    const data = args[1] as Uint8Array;
    const sequence = (args[2] as number | undefined) ?? 0;
    const rawAcknowledge = args[3];
    const transportAcknowledge =
      typeof rawAcknowledge === "function"
        ? () => rawAcknowledge()
        : undefined;
    let consumed = false;
    const acknowledgeConsumed = () => {
      if (consumed) return;
      consumed = true;
      if (sequence > 0) {
        terminalReplayFloors.set(
          id,
          Math.max(terminalReplayFloors.get(id) ?? 0, sequence),
        );
      }
      transportAcknowledge?.();
    };
    const floor = terminalReplayFloors.get(id) ?? 0;
    if (sequence > 0 && sequence <= floor) {
      acknowledgeConsumed();
      return;
    }
    if (terminalResyncing.has(id) || terminalReplayStreaming.has(id)) {
      bufferTerminalData(
        id,
        data,
        sequence,
        false,
        false,
        false,
        acknowledgeConsumed,
      );
      // The bounded attach bridge now owns these bytes. Release socket credit
      // so a producer cannot trigger nested resyncs while history is replayed;
      // the parser cursor advances only when the buffered callback is consumed.
      transportAcknowledge?.();
      return;
    }
    if (
      deliverTerminalData(
        id,
        data,
        false,
        false,
        false,
        acknowledgeConsumed,
      )
    ) return;
    // No renderer is consuming this terminal. Do not build a second output
    // history in browser memory; the next surface performs an ordered replay
    // from the host's durable archive.
    acknowledgeConsumed();
    return;
  });
  transport.on("terminal:replay-required", (...args: unknown[]) => {
    const id = args[0] as string;
    const acknowledgedSequence = (args[1] as number | undefined) ?? 0;
    const current = terminalReplayFloors.get(id) ?? 0;
    terminalReplayFloors.set(id, Math.max(current, acknowledgedSequence));
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("yaade:terminal-replay-required", {
          detail: { terminalId: id, acknowledgedSequence },
        }),
      );
    }
    requestTerminalResync(id, reconnectGeneration);
  });
  transport.on("terminal:exit", (...args: unknown[]) => {
    const id = args[0] as string;
    const exitCode = args[1] as number;
    const signal = args[2] as number | undefined;
    for (const cb of terminalExitListeners) cb(id, exitCode, signal);
  });
  transport.on("mux:event", (...args: unknown[]) => {
    try {
      const event = Schema.decodeUnknownSync(MuxEvent)(args[0]);
      for (const cb of muxEventListeners) cb(event);
    } catch {
      // Malformed generic events are ignored; the next reconciliation refetches state.
    }
  });

  const terminalExitListeners = new Set<
    (id: string, exitCode: number, signal?: number) => void
  >();
  const muxEventListeners = new Set<
    (event: import("@yaade/rpc").MuxEvent) => void
  >();
  return {
    mux: {
      listSessions: (includeArchived) =>
        transport.invoke("mux:listSessions", includeArchived === true),
      reorderSessions: (command) =>
        transport.invoke("mux:reorderSessions", command),
      createTab: (command) => transport.invoke("mux:createTab", command),
      renameTab: (command) => transport.invoke("mux:renameTab", command),
      saveTabLayout: (command) =>
        transport.invoke("mux:saveTabLayout", command),
      reorderTabs: (command) => transport.invoke("mux:reorderTabs", command),
      archiveTab: (command) => transport.invoke("mux:archiveTab", command),
      selectTab: (command) => transport.invoke("mux:selectTab", command),
      archiveSession: (command) =>
        transport.invoke("mux:archiveSession", command),
      restoreSession: (command) =>
        transport.invoke("mux:restoreSession", command),
      createSession: (title) => transport.invoke("mux:createSession", title),
      renameSession: (sessionId, title) =>
        transport.invoke("mux:renameSession", sessionId, title),
      getSession: (sessionId) =>
        transport.invoke("mux:getSession", sessionId),
      createTerminal: (command) => transport.invoke("mux:createTerminal", command),
      getTerminal: (muxTerminalId) => transport.invoke("mux:getTerminal", muxTerminalId),
      reorderTerminals: (command) => transport.invoke("mux:reorderTerminals", command),
      moveTerminal: (command) => transport.invoke("mux:moveTerminal", command),
      selectTerminal: (sessionId, muxTerminalId) =>
        transport.invoke("mux:selectTerminal", sessionId, muxTerminalId),
      stopTerminal: (muxTerminalId, revision) =>
        transport.invoke("mux:stopTerminal", muxTerminalId, revision),
      restartTerminal: (muxTerminalId, revision) =>
        transport.invoke("mux:restartTerminal", muxTerminalId, revision),
      closeTerminal: (command) => transport.invoke("mux:closeTerminal", command),
      renameTerminal: (muxTerminalId, title) =>
        transport.invoke("mux:renameTerminal", muxTerminalId, title),
      onEvent: (callback) => {
        muxEventListeners.add(callback);
        return () => muxEventListeners.delete(callback);
      },
    },
    terminal: {
      create: async (cwdUri, launch) => {
        const result = await transport.invoke("terminal:create", cwdUri, launch);
        if (result.title) return { id: result.id, title: result.title }
        return { id: result.id }
      },
      attach: async (id, options) => {
        if (options?.onCheckpoint) {
          terminalCheckpointRestorers.set(id, options.onCheckpoint)
        }
        const fullReplay = options?.replay === "full";
        const afterSequence = fullReplay
          ? 0
          : terminalReplayFloors.get(id);
        const replayAfterSequence = afterSequence ?? 0;
        if (fullReplay) {
          terminalReplayStreaming.add(id);
          terminalDataBuffers.delete(id);
          terminalDataBufferSizes.delete(id);
        }
        try {
          let result = await attachTerminal(id, afterSequence);
          if (!result) return result;
          if (result.checkpoint?.snapshotBytes.byteLength === 0) {
            const snapshotBytes = await awaitTerminalSnapshot(
              id,
              result.checkpoint.sequence,
            );
            result = {
              ...result,
              checkpoint: { ...result.checkpoint, snapshotBytes },
            };
          }

          const restoredSequence = await restoreCheckpoint(
            id,
            result,
            options?.onCheckpoint,
          )
          let replayDelivered = restoredSequence !== null;
          let replayedThrough = restoredSequence ?? replayAfterSequence;
          if (restoredSequence === null && fullReplay && options?.onReplayPreview) {
            await previewNewestReplay(id, result, options.onReplayPreview);
          }
          if (options?.onReplay) {
            const archived = await streamArchivedReplay(
              id,
              restoredSequence === null ? result : { ...result, replayTruncated: false },
              restoredSequence ?? replayAfterSequence,
              undefined,
              options.onReplay,
            );
            replayDelivered = replayDelivered || archived.delivered;
            replayedThrough = Math.max(replayedThrough, archived.lastSequence);
            if (!archived.complete) {
              const chunks =
                result.outputChunks && result.outputChunks.length > 0
                  ? result.outputChunks
                  : result.output.byteLength > 0
                    ? [result.output]
                    : [];
              let firstChunk = true;
              for (const data of chunks) {
                if (data.byteLength === 0) continue;
                await options.onReplay({
                  data,
                  replayNeedsQueryResponses:
                    result.replayNeedsQueryResponses === true,
                  replayTruncated:
                    firstChunk &&
                    (result.replayTruncated === true || archived.delivered),
                });
                firstChunk = false;
                replayDelivered = true;
                replayedThrough = result.lastSequence;
              }
            }
          } else if ((terminalDataListeners.get(id)?.size ?? 0) > 0) {
            const archived = await streamArchivedReplay(
              id,
              restoredSequence === null ? result : { ...result, replayTruncated: false },
              restoredSequence ?? replayAfterSequence,
            );
            replayedThrough = Math.max(
              replayedThrough,
              archived.lastSequence,
            );
          }

          terminalReplayFloors.set(id, replayedThrough);
          const pending = terminalDataBuffers.get(id);
          if (pending) {
            const kept: BufferedTerminalData[] = [];
            for (const chunk of pending) {
              if (
                chunk.sequence === 0 ||
                chunk.sequence > replayedThrough
              ) {
                kept.push(chunk);
              } else {
                chunk.acknowledge?.();
              }
            }
            terminalDataBuffers.delete(id);
            terminalDataBufferSizes.delete(id);
            if (
              kept.length > 0 &&
              (terminalDataListeners.get(id)?.size ?? 0) > 0
            ) {
              for (const chunk of kept) {
                deliverTerminalData(
                  id,
                  chunk.data,
                  chunk.replay === true,
                  chunk.replayNeedsQueryResponses === true,
                  chunk.replayTruncated === true,
                  chunk.acknowledge,
                );
              }
            } else if (kept.length > 0) {
              let size = 0;
              for (const chunk of kept) size += chunk.data.byteLength;
              terminalDataBuffers.set(id, kept);
              terminalDataBufferSizes.set(id, size);
            }
          }
          if (!replayDelivered) return result;
          const replayedResult = {
            ...result,
            outputChunks: [],
            output: new Uint8Array(),
          };
          delete replayedResult.checkpoint;
          return replayedResult;
        } finally {
          if (fullReplay) terminalReplayStreaming.delete(id);
        }
      },
      write: (id, data) => {
        if (transport.sendRealtime?.("terminal:write", id, data)) {
          return Promise.resolve();
        }
        return invokeTerminalHot(transport, "terminal:write", id, data);
      },
      writeBinary: (id, dataBase64) => {
        if (transport.sendRealtime?.("terminal:writeBinary", id, dataBase64)) {
          return Promise.resolve();
        }
        return invokeTerminalHot(
          transport,
          "terminal:writeBinary",
          id,
          dataBase64,
        );
      },
      resize: (id, cols, rows) => {
        if (transport.sendRealtime?.("terminal:resize", id, cols, rows)) {
          return Promise.resolve();
        }
        return invokeTerminalHot(transport, "terminal:resize", id, cols, rows);
      },
      setTheme: (id, theme) => transport.invoke("terminal:setTheme", id, theme),
      markReplayReady: (id) =>
        invokeTerminalHot(transport, "terminal:ready", id),
      getCwd: (id) => transport.invoke("terminal:getCwd", id),
      getForegroundProcess: (id) =>
        transport.invoke("terminal:getForegroundProcess", id),
      onData: (id, callback, options) => {
        let set = terminalDataListeners.get(id);
        if (!set) {
          set = new Set();
          terminalDataListeners.set(id, set);
        }
        const registration: TerminalDataRegistration = {
          callback,
          acknowledgement: options?.acknowledgement ?? "delivery",
        };
        set.add(registration);
        if (!realtimeConnected) terminalResyncing.add(id);
        if (terminalBufferGaps.delete(id)) {
          terminalDataBuffers.delete(id);
          terminalDataBufferSizes.delete(id);
          terminalResyncing.add(id);
          if (realtimeConnected) {
            requestTerminalResync(id, reconnectGeneration);
          }
        } else {
          const pending = terminalDataBuffers.get(id);
          if (pending) {
            for (const chunk of pending) {
              deliverTerminalData(
                id,
                chunk.data,
                chunk.replay === true,
                chunk.replayNeedsQueryResponses === true,
                chunk.replayTruncated === true,
                chunk.acknowledge,
              );
            }
            terminalDataBuffers.delete(id);
            terminalDataBufferSizes.delete(id);
          }
        }
        return () => {
          set!.delete(registration);
          if (set!.size !== 0) return;
          terminalDataListeners.delete(id);
          terminalDataBuffers.delete(id);
          terminalDataBufferSizes.delete(id);
          terminalCheckpointRestorers.delete(id);
          terminalBufferGaps.delete(id);
          terminalResyncing.delete(id);
          terminalResyncAgain.delete(id);
          const retryTimer = terminalResyncRetryTimers.get(id);
          if (retryTimer) clearTimeout(retryTimer);
          terminalResyncRetryTimers.delete(id);
          terminalResyncAttempts.delete(id);
          void invokeTerminalHot(transport, "terminal:detach", id).catch(
            () => undefined,
          );
        };
      },
      // Semantic screen diffs are compatibility-only and are not connected to
      // the capable-client data plane.
      onSemanticSnapshot: () => () => undefined,
      onExit: (cb) => {
        terminalExitListeners.add(cb);
        return () => terminalExitListeners.delete(cb);
      },
      dispose: (id) => {
        terminalDataBuffers.delete(id);
        terminalDataBufferSizes.delete(id);
        terminalDataListeners.delete(id);
        terminalCheckpointRestorers.delete(id);
        terminalReplayFloors.delete(id);
        terminalBufferGaps.delete(id);
        terminalResyncing.delete(id);
        terminalResyncAgain.delete(id);
        terminalResyncInFlight.delete(id);
        const retryTimer = terminalResyncRetryTimers.get(id);
        if (retryTimer) clearTimeout(retryTimer);
        terminalResyncRetryTimers.delete(id);
        terminalResyncAttempts.delete(id);
        terminalReplayStreaming.delete(id);
        terminalBinarySnapshots.delete(id);
        terminalReadyPositions.delete(id);
        terminalSyncWaiters.delete(id);
        return transport.invoke("terminal:dispose", id);
      },
      acquireLease: (id, mode) =>
        mode === undefined
          ? transport.invoke("terminal:acquireLease", id)
          : transport.invoke("terminal:acquireLease", id, mode),
      renewLease: (id, leaseId) =>
        transport.invoke("terminal:renewLease", id, leaseId),
      releaseLease: (id, leaseId) =>
        transport.invoke("terminal:releaseLease", id, leaseId),
      requestControl: id => transport.invoke("terminal:requestControl", id),
      transferControl: (id, leaseId, targetClientId) =>
        transport.invoke("terminal:transferControl", id, leaseId, targetClientId),
      listViewers: id => transport.invoke("terminal:listViewers", id),
    },
  };
}
