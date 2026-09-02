import { Data } from "effect"
import type { MuxSessionError } from "./mux-session.js"

/** Host / shared wire error codes (stable JSON). */
export type HostErrorCode =
  | "PATH_OUTSIDE_ALLOWED_ROOTS"
  | "UNKNOWN_OPERATION"
  | "OPERATION_FAILED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "HOST_DISCONNECTED"
  | "WRITER_LEASE_REQUIRED"
  | "WRITER_LEASE_STALE"
  | "LEASE_NOT_HELD"
  | "TERMINAL_INTERRUPTED"
  | "SERVER_EPOCH_CHANGED"
  | "SCOPE_DENIED"
  | "ORIGIN_DENIED"
  | "RATE_LIMITED"

export class PathOutsideRootsError extends Data.TaggedError("PathOutsideRoots")<{
  readonly message: string
  readonly path?: string
}> {
  readonly code = "PATH_OUTSIDE_ALLOWED_ROOTS" as const
}

export class UnknownChannelError extends Data.TaggedError("UnknownChannel")<{
  readonly channel: string
  readonly message: string
}> {
  readonly code = "UNKNOWN_OPERATION" as const
}

export function unknownChannel(channel: string): UnknownChannelError {
  return new UnknownChannelError({
    channel,
    message: `unknown host channel: ${channel}`,
  })
}

export class OperationFailedError extends Data.TaggedError("OperationFailed")<{
  readonly message: string
  readonly cause?: unknown
}> {
  readonly code = "OPERATION_FAILED" as const
}

export class NotFoundError extends Data.TaggedError("NotFound")<{
  readonly message: string
  readonly resource?: string
}> {
  readonly code = "NOT_FOUND" as const
}

export class ConflictError extends Data.TaggedError("Conflict")<{
  readonly message: string
}> {
  readonly code = "CONFLICT" as const
}

export class InvalidRpcPayloadError extends Data.TaggedError("InvalidRpcPayload")<{
  readonly message: string
  readonly cause?: unknown
}> {
  readonly code = "OPERATION_FAILED" as const
}

/** Transport closed or WS dropped while an invoke was in flight. */
export class HostDisconnectedError extends Data.TaggedError("HostDisconnected")<{
  readonly message: string
  readonly cause?: unknown
}> {
  readonly code = "HOST_DISCONNECTED" as const
}

export class TerminalLeaseError extends Data.TaggedError("TerminalLeaseError")<{
  readonly message: string
  readonly terminalId: string
  readonly leaseId?: string
}> {
  readonly code: "WRITER_LEASE_REQUIRED" | "WRITER_LEASE_STALE" | "LEASE_NOT_HELD"

  constructor(args: {
    readonly message: string
    readonly terminalId: string
    readonly leaseId?: string
    readonly code: "WRITER_LEASE_REQUIRED" | "WRITER_LEASE_STALE" | "LEASE_NOT_HELD"
  }) {
    super(args)
    this.code = args.code
  }
}

export class ScopeDeniedError extends Data.TaggedError("ScopeDenied")<{
  readonly message: string
  readonly channel?: string
}> {
  readonly code = "SCOPE_DENIED" as const
}

export type HostRpcError =
  | PathOutsideRootsError
  | UnknownChannelError
  | OperationFailedError
  | NotFoundError
  | ConflictError
  | InvalidRpcPayloadError
  | HostDisconnectedError
  | TerminalLeaseError
  | ScopeDeniedError
  | MuxSessionError

export function hostErrorHttpStatus(error: HostRpcError): number {
  switch (error._tag) {
    case "PathOutsideRoots":
    case "ScopeDenied":
      return 403
    case "NotFound":
      return 404
    case "Conflict":
      return 409
    case "HostDisconnected":
      return 503
    case "TerminalLeaseError":
      return 409
    default:
      return 400
  }
}

export function hostErrorWire(error: HostRpcError): {
  code: HostErrorCode
  message: string
  details: Record<string, unknown>
} {
  const details =
    error._tag === "PathOutsideRoots"
          ? (error.path ? { path: error.path } : {})
          : error._tag === "TerminalConflict"
          ? {
              muxTerminalId: error.muxTerminalId,
              expectedRevision: error.expectedRevision,
              actualRevision: error.actualRevision,
            }
          : error._tag === "SessionTabConflict"
            ? {
                tabId: error.tabId,
                expectedRevision: error.expectedRevision,
                actualRevision: error.actualRevision,
              }
          : error._tag === "SessionNotFound"
            ? { sessionId: error.sessionId }
            : error._tag === "SessionTabNotFound"
              ? { tabId: error.tabId }
              : error._tag === "TerminalNotFound"
            ? { muxTerminalId: error.muxTerminalId }
              : error._tag === "ScopeDenied"
                ? (error.channel ? { channel: error.channel } : {})
                : error._tag === "InvalidTerminalInput" ||
                error._tag === "InvalidMuxCommand" ||
                false
              ? {}
              : error._tag === "TerminalRuntimeFailure"
                ? { terminalError: error._tag, muxTerminalId: error.muxTerminalId }
                : {}
  return {
    code: error.code,
    message: error.message,
    details,
  }
}
