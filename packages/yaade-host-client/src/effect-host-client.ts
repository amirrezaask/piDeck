import { Effect, Schema } from "effect"
import {
  ConflictError,
  decodeHostRpcRequest,
  decodeHostRouteArgs,
  decodeHostRouteResult,
  isHostRouteName,
  type HostRouteArgs,
  type HostRouteName,
  type HostRouteResult,
  HostDisconnectedError,
  HostRpcRequest,
  HostRpcResponse,
  InvalidRpcPayloadError,
  InvalidMuxCommand,
  InvalidTerminalInput,
  NotFoundError,
  OperationFailedError,
  PathOutsideRootsError,
  SessionNotFound,
  SessionTabConflict,
  SessionTabNotFound,
  TerminalRuntimeFailure,
  TerminalConflict,
  TerminalNotFound,
  type HostRpcError,
} from "@yaade/rpc"
import { readHostAuthToken } from "./web-transport.js"

function mapFetchError(
  message: string,
  code?: string,
  details?: Record<string, unknown>,
): HostRpcError {
  if (code === "PATH_OUTSIDE_ALLOWED_ROOTS" || message.includes("PATH_OUTSIDE")) {
    return new PathOutsideRootsError({
      message,
      ...(typeof details?.path === "string" ? { path: details.path } : {}),
    })
  }
  if (code === "CONFLICT") {
    const expectedRevision = typeof details?.expectedRevision === "number" ? details.expectedRevision : undefined
    const actualRevision = typeof details?.actualRevision === "number" ? details.actualRevision : undefined
    const muxTerminalId = typeof details?.muxTerminalId === "string" ? details.muxTerminalId : undefined
    if (muxTerminalId && expectedRevision !== undefined && actualRevision !== undefined) {
      return new TerminalConflict({ muxTerminalId, expectedRevision, actualRevision, message })
    }
    const tabId = typeof details?.tabId === "string" ? details.tabId : undefined
    if (tabId && expectedRevision !== undefined && actualRevision !== undefined) {
      return new SessionTabConflict({ tabId, expectedRevision, actualRevision, message })
    }
    return new ConflictError({ message })
  }
  if (code === "NOT_FOUND") {
    if (typeof details?.sessionId === "string") return new SessionNotFound({ sessionId: details.sessionId, message })
    if (typeof details?.tabId === "string") return new SessionTabNotFound({ tabId: details.tabId, message })
    if (typeof details?.muxTerminalId === "string") return new TerminalNotFound({ muxTerminalId: details.muxTerminalId, message })
    return new NotFoundError({ message })
  }
  switch (details?.terminalError) {
    case "InvalidTerminalInput":
      return new InvalidTerminalInput({ message })
    case "InvalidMuxCommand":
      return new InvalidMuxCommand({ message })
    case "TerminalRuntimeFailure":
      if (typeof details.muxTerminalId === "string") {
        return new TerminalRuntimeFailure({ muxTerminalId: details.muxTerminalId, message })
      }
      break
  }
  return new OperationFailedError({ message })
}

/** Effect invoke over fetch + the canonical route registry. */
export function invokeHostRpc<Name extends HostRouteName>(
  clientId: string,
  channel: Name,
  args: HostRouteArgs<Name> | readonly unknown[],
  options?: {
    signal?: AbortSignal
    baseUrl?: string
    authToken?: string | null
  },
): Effect.Effect<HostRouteResult<Name>, HostRpcError> {
  return invokeHostRpcUnchecked(clientId, channel, args, options).pipe(
    Effect.map(value => decodeHostRouteResult(channel, value)),
  )
}

/** Dynamic route adapter used by the transport's hot and cold paths. */
export function invokeHostRpcUnchecked(
  clientId: string,
  channel: string,
  args: readonly unknown[],
  options?: {
    signal?: AbortSignal
    baseUrl?: string
    authToken?: string | null
  },
): Effect.Effect<unknown, HostRpcError> {
  return Effect.gen(function* () {
    const routeArgs = yield* Effect.try({
      try: () => {
        if (!isHostRouteName(channel)) throw new Error(`unknown host channel: ${channel}`)
        return decodeHostRouteArgs(channel, [...args])
      },
      catch: cause =>
        new InvalidRpcPayloadError({
          message: "invalid host RPC arguments",
          cause,
        }),
    })
    const body = yield* Effect.mapError(
      decodeHostRpcRequest({ channel, args: routeArgs, clientId }),
      cause =>
        new InvalidRpcPayloadError({
          message: "invalid host RPC request",
          cause,
        }),
    )
    const token =
      options?.authToken === undefined
        ? readHostAuthToken()
        : options.authToken
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (token) headers.authorization = `Bearer ${token}`
    const rpcUrl = options?.baseUrl
      ? `${options.baseUrl}/terminal/api/v1/rpc`
      : "/terminal/api/v1/rpc"
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch(rpcUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(body satisfies HostRpcRequest),
          signal: options?.signal,
        }),
      catch: err => {
        if (
          options?.signal?.aborted ||
          (err instanceof Error && err.name === "AbortError") ||
          (typeof DOMException !== "undefined" &&
            err instanceof DOMException &&
            err.name === "AbortError")
        ) {
          const reason = options?.signal?.reason
          if (reason instanceof HostDisconnectedError) return reason
          return new HostDisconnectedError({
            message: "host invoke aborted",
            cause: err,
          })
        }
        return new OperationFailedError({
          message: err instanceof Error ? err.message : String(err),
          cause: err,
        })
      },
    })
    const payload = yield* Effect.tryPromise({
      try: async () =>
        Schema.decodeUnknownPromise(HostRpcResponse)(await response.json()),
      catch: err =>
        new OperationFailedError({
          message: err instanceof Error ? err.message : String(err),
          cause: err,
        }),
    })
    if (!response.ok) {
      const error = "error" in payload ? payload.error : undefined
      return yield* Effect.fail(
        mapFetchError(
          error?.message ?? `YAADE API request failed (${response.status})`,
          error?.code,
          error?.details,
        ),
      )
    }
    return yield* Effect.try({
      try: () => {
        if (!isHostRouteName(channel)) throw new Error(`unknown host channel: ${channel}`)
        return decodeHostRouteResult(
          channel,
          "value" in payload ? payload.value : undefined,
        )
      },
      catch: cause =>
        new InvalidRpcPayloadError({
          message: "invalid host RPC result",
          cause,
        }),
    })
  })
}
