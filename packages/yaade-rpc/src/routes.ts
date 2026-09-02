import { Schema } from "effect"
import {
  AppSession,
  ArchiveSession,
  ArchiveSessionTab,
  CloseTerminal,
  CreateSessionTab,
  CreateTerminal,
  MoveTerminalToTab,
  RenameSessionTab,
  ReorderSessions,
  ReorderSessionTabs,
  ReorderTerminals,
  RestoreSession,
  SaveSessionTabLayout,
  SelectSessionTab,
  SessionTab,
  MuxTerminal,
  MuxTerminalId,
} from "./mux-session.js"
import {
  TerminalCheckpoint,
  TerminalLease,
  TerminalMutationFence as RpcTerminalMutationFence,
} from "./host.js"
import { TerminalSemanticSnapshot } from "./terminal-stream-v3.js"

/**
 * The policy applied before a route handler runs.  Keeping this next to the
 * argument and result codecs prevents the HTTP and WebSocket adapters from
 * growing independent lists of path-sensitive operations.
 */
export type HostRoutePathPolicy =
  | { readonly kind: "none" }
  | { readonly kind: "allowed-root"; readonly indices: readonly number[] }
  | { readonly kind: "terminal-id-or-path" }

export type HostRouteOptions = {
  readonly pathPolicy?: HostRoutePathPolicy
  readonly realtime?: boolean
}

type HostRouteDefinition<
  Args extends Schema.Schema.AnyNoContext,
  Result extends Schema.Schema.AnyNoContext,
> = {
  readonly args: Args
  readonly result: Result
  readonly pathPolicy: HostRoutePathPolicy
  readonly realtime: boolean
  readonly decodeArgs: (value: unknown) => unknown[]
  readonly decodeResult: (value: unknown) => unknown
}

type AnyHostRouteDefinition = HostRouteDefinition<
  Schema.Schema.AnyNoContext,
  Schema.Schema.AnyNoContext
>

function route<
  Args extends Schema.Schema.AnyNoContext,
  Result extends Schema.Schema.AnyNoContext,
>(
  args: Args,
  result: Result,
  options: HostRouteOptions = {},
): HostRouteDefinition<Args, Result> {
  return {
    args,
    result,
    pathPolicy: options.pathPolicy ?? { kind: "none" },
    realtime: options.realtime ?? false,
    decodeArgs: value => {
      const decoded = Schema.decodeUnknownSync(args)(value)
      if (!Array.isArray(decoded)) throw new Error("host route arguments must be a tuple")
      return decoded
    },
    decodeResult: value => Schema.decodeUnknownSync(result)(value),
  }
}

const StringArgs = Schema.Tuple(Schema.String)
const StringStringArgs = Schema.Tuple(Schema.String, Schema.String)
const OptionalStringArgs = Schema.Tuple(Schema.optionalElement(Schema.String))
const TerminalColorChannel = Schema.Int.pipe(Schema.between(0, 255))
const TerminalColor = Schema.Struct({
  r: TerminalColorChannel,
  g: TerminalColorChannel,
  b: TerminalColorChannel,
})
const TerminalTheme = Schema.Struct({
  foreground: TerminalColor,
  background: TerminalColor,
  cursor: TerminalColor,
})
const TerminalLaunch = Schema.Struct({
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  cols: Schema.optional(Schema.Number),
  rows: Schema.optional(Schema.Number),
  theme: Schema.optional(TerminalTheme),
})
const TerminalCreateArgs = Schema.Tuple(
  Schema.String,
  Schema.optionalElement(Schema.NullOr(TerminalLaunch)),
)
const ProcessIdentity = Schema.Struct({
  pid: Schema.Number,
  platform: Schema.Literal("linux", "darwin", "windows"),
  bootId: Schema.optional(Schema.String),
  startToken: Schema.String,
  executablePath: Schema.optional(Schema.String),
})
const TerminalCreateResult = Schema.Struct({
  id: Schema.String,
  title: Schema.NullOr(Schema.String),
  osPid: Schema.optional(Schema.NullOr(Schema.Number)),
  processIdentity: Schema.optional(Schema.NullOr(ProcessIdentity)),
  terminalEpoch: Schema.optional(Schema.String),
  ownerId: Schema.optional(Schema.String),
  ownerEpoch: Schema.optional(Schema.String),
  protocolVersion: Schema.optional(Schema.Number),
})
const TerminalAttachArgs = Schema.Tuple(
  Schema.String,
  Schema.optionalElement(Schema.Number),
  Schema.optionalElement(Schema.Literal("raw", "semantic", "both")),
)
const TerminalAttachResult = Schema.NullOr(
  Schema.Struct({
    id: Schema.String,
    title: Schema.NullOr(Schema.String),
    terminalEpoch: Schema.optional(Schema.String),
    ownerId: Schema.optional(Schema.String),
    ownerEpoch: Schema.optional(Schema.String),
    protocolVersion: Schema.optional(Schema.Number),
    checkpoint: Schema.optional(TerminalCheckpoint),
    replayQuality: Schema.optional(Schema.Literal("exact", "checkpoint", "degraded")),
    outputChunks: Schema.Array(Schema.Uint8ArrayFromBase64),
    output: Schema.Uint8ArrayFromBase64,
    replayTruncated: Schema.Boolean,
    replayNeedsQueryResponses: Schema.Boolean,
    archiveAvailable: Schema.optional(Schema.Boolean),
    lastSequence: Schema.Number,
    cols: Schema.optional(Schema.Number),
    rows: Schema.optional(Schema.Number),
    status: Schema.Literal("running", "exited"),
    exitCode: Schema.NullOr(Schema.Number),
    signal: Schema.NullOr(Schema.Number),
    semanticSnapshot: Schema.optional(Schema.NullOr(TerminalSemanticSnapshot)),
  }),
)
const TerminalReplayPage = Schema.Struct({
  chunks: Schema.Array(Schema.Uint8ArrayFromBase64),
  firstSequence: Schema.Number,
  lastSequence: Schema.Number,
  nextSequence: Schema.Number,
  complete: Schema.Boolean,
})
const TerminalReplayPageArgs = Schema.Tuple(
  Schema.String,
  Schema.Number,
  Schema.optionalElement(Schema.Number),
  Schema.optionalElement(Schema.Literal("forward", "backward")),
)
const TerminalWriteArgs = Schema.Tuple(
  Schema.String,
  Schema.String,
  Schema.optionalElement(RpcTerminalMutationFence),
)
const TerminalResizeArgs = Schema.Tuple(
  Schema.String,
  Schema.Number,
  Schema.Number,
  Schema.optionalElement(RpcTerminalMutationFence),
)
const TerminalSetThemeArgs = Schema.Tuple(Schema.String, TerminalTheme)
const SessionSnapshot = Schema.Struct({
  session: AppSession,
  tabs: Schema.Array(SessionTab),
  muxTerminals: Schema.Array(MuxTerminal),
})
export type HostMuxSessionSnapshot = {
  session: AppSession
  tabs: SessionTab[]
  muxTerminals: MuxTerminal[]
}

export type HostTerminalAttachResult = {
  id: string
  title?: string
  terminalEpoch?: string
  ownerId?: string
  ownerEpoch?: string
  protocolVersion?: number
  checkpoint?: Schema.Schema.Type<typeof TerminalCheckpoint>
  replayQuality?: "exact" | "checkpoint" | "degraded"
  outputChunks?: Uint8Array[]
  output: Uint8Array
  replayTruncated?: boolean
  replayNeedsQueryResponses?: boolean
  lastSequence: number
  archiveAvailable?: boolean
  cols?: number
  rows?: number
  status: "running" | "exited"
  exitCode?: number
  signal?: number
  semanticSnapshot?: Schema.Schema.Type<typeof TerminalSemanticSnapshot> | null
}

type HostRouteResultOverrides = {
  "mux:listSessions": HostMuxSessionSnapshot[]
  "mux:reorderSessions": AppSession[]
  "mux:createTab": SessionTab
  "mux:renameTab": SessionTab
  "mux:saveTabLayout": SessionTab
  "mux:reorderTabs": SessionTab[]
  "mux:archiveTab": SessionTab
  "mux:selectTab": AppSession
  "mux:archiveSession": AppSession
  "mux:restoreSession": AppSession
  "mux:getSession": HostMuxSessionSnapshot | null
  "mux:createTerminal": MuxTerminal
  "mux:reorderTerminals": MuxTerminal[]
  "mux:moveTerminal": MuxTerminal
  "mux:selectTerminal": AppSession
  "mux:getTerminal": MuxTerminal | null
  "mux:stopTerminal": MuxTerminal
  "mux:restartTerminal": MuxTerminal
  "mux:closeTerminal": MuxTerminal
  "mux:renameTerminal": MuxTerminal
  "terminal:create": { id: string; title?: string }
  "terminal:write": void
  "terminal:writeBinary": void
  "terminal:resize": void
  "terminal:setTheme": void
  "terminal:ready": void
  "terminal:detach": void
  "terminal:dispose": void
  "terminal:attach": HostTerminalAttachResult | null
  "terminal:readReplayPage": Schema.Schema.Type<typeof TerminalReplayPage> | null
  "terminal:getCwd": string | null
  "terminal:getForegroundProcess": string | null
}

/**
 * Canonical RPC route registry.
 *
 * The object is contract-only: browser transports, HTTP dispatch, and the
 * realtime terminal adapter all consume the same route definitions.
 * A route's decoded argument tuple and result type are therefore part of one
 * interface instead of being reconstructed at every adapter.
 */
export const HOST_ROUTES = {
  "mux:listSessions": route(Schema.Tuple(Schema.Boolean), Schema.Array(SessionSnapshot)),
  "mux:createSession": route(OptionalStringArgs, AppSession),
  "mux:renameSession": route(StringStringArgs, AppSession),
  "mux:reorderSessions": route(Schema.Tuple(ReorderSessions), Schema.Array(AppSession)),
  "mux:createTab": route(Schema.Tuple(CreateSessionTab), SessionTab),
  "mux:renameTab": route(Schema.Tuple(RenameSessionTab), SessionTab),
  "mux:saveTabLayout": route(Schema.Tuple(SaveSessionTabLayout), SessionTab),
  "mux:reorderTabs": route(Schema.Tuple(ReorderSessionTabs), Schema.Array(SessionTab)),
  "mux:archiveTab": route(Schema.Tuple(ArchiveSessionTab), SessionTab),
  "mux:selectTab": route(Schema.Tuple(SelectSessionTab), AppSession),
  "mux:archiveSession": route(Schema.Tuple(ArchiveSession), AppSession),
  "mux:restoreSession": route(Schema.Tuple(RestoreSession), AppSession),
  "mux:getSession": route(StringArgs, Schema.NullOr(SessionSnapshot)),
  "mux:createTerminal": route(Schema.Tuple(CreateTerminal), MuxTerminal),
  "mux:reorderTerminals": route(Schema.Tuple(ReorderTerminals), Schema.Array(MuxTerminal)),
  "mux:moveTerminal": route(Schema.Tuple(MoveTerminalToTab), MuxTerminal),
  "mux:selectTerminal": route(Schema.Tuple(Schema.String, Schema.optionalElement(MuxTerminalId)), AppSession),
  "mux:getTerminal": route(Schema.Tuple(MuxTerminalId), Schema.NullOr(MuxTerminal)),
  "mux:stopTerminal": route(Schema.Tuple(MuxTerminalId, Schema.Number), MuxTerminal),
  "mux:restartTerminal": route(Schema.Tuple(MuxTerminalId, Schema.Number), MuxTerminal),
  "mux:closeTerminal": route(Schema.Tuple(CloseTerminal), MuxTerminal),
  "mux:renameTerminal": route(StringStringArgs, MuxTerminal),

  "terminal:create": route(TerminalCreateArgs, TerminalCreateResult, { pathPolicy: { kind: "allowed-root", indices: [0] } }),
  "terminal:write": route(TerminalWriteArgs, Schema.Unknown, { pathPolicy: { kind: "terminal-id-or-path" }, realtime: true }),
  "terminal:writeBinary": route(TerminalWriteArgs, Schema.Unknown, { pathPolicy: { kind: "terminal-id-or-path" }, realtime: true }),
  "terminal:resize": route(TerminalResizeArgs, Schema.Unknown, { pathPolicy: { kind: "terminal-id-or-path" }, realtime: true }),
  "terminal:setTheme": route(TerminalSetThemeArgs, Schema.Unknown, { pathPolicy: { kind: "terminal-id-or-path" } }),
  "terminal:acquireLease": route(
    Schema.Tuple(Schema.String, Schema.optionalElement(Schema.Literal("writer", "observer"))),
    Schema.NullOr(TerminalLease),
    { pathPolicy: { kind: "terminal-id-or-path" } },
  ),
  "terminal:renewLease": route(
    Schema.Tuple(Schema.String, Schema.String),
    Schema.NullOr(TerminalLease),
    { pathPolicy: { kind: "terminal-id-or-path" } },
  ),
  "terminal:releaseLease": route(
    Schema.Tuple(Schema.String, Schema.String),
    Schema.Null,
    { pathPolicy: { kind: "terminal-id-or-path" } },
  ),
  "terminal:requestControl": route(
    StringArgs,
    Schema.NullOr(TerminalLease),
    { pathPolicy: { kind: "terminal-id-or-path" } },
  ),
  "terminal:transferControl": route(
    Schema.Tuple(Schema.String, Schema.String, Schema.String),
    Schema.NullOr(TerminalLease),
    { pathPolicy: { kind: "terminal-id-or-path" } },
  ),
  "terminal:listViewers": route(
    StringArgs,
    Schema.Array(Schema.String),
    { pathPolicy: { kind: "terminal-id-or-path" } },
  ),
  "terminal:ready": route(StringArgs, Schema.Unknown, { pathPolicy: { kind: "terminal-id-or-path" }, realtime: true }),
  "terminal:detach": route(StringArgs, Schema.Null, { pathPolicy: { kind: "terminal-id-or-path" }, realtime: true }),
  "terminal:attach": route(TerminalAttachArgs, TerminalAttachResult, { pathPolicy: { kind: "terminal-id-or-path" }, realtime: true }),
  "terminal:readReplayPage": route(
    TerminalReplayPageArgs,
    Schema.NullOr(TerminalReplayPage),
    { pathPolicy: { kind: "terminal-id-or-path" } },
  ),
  "terminal:getCwd": route(StringArgs, Schema.NullOr(Schema.String), { pathPolicy: { kind: "terminal-id-or-path" } }),
  "terminal:getForegroundProcess": route(StringArgs, Schema.NullOr(Schema.String), { pathPolicy: { kind: "terminal-id-or-path" } }),
  "terminal:dispose": route(StringArgs, Schema.Null, { pathPolicy: { kind: "terminal-id-or-path" } }),
} as const satisfies Record<string, AnyHostRouteDefinition>

export type HostRouteName = keyof typeof HOST_ROUTES
export type HostRouteArgs<Name extends HostRouteName> = Schema.Schema.Type<
  (typeof HOST_ROUTES)[Name]["args"]
>
type MutableResult<Value> = Value extends Uint8Array
  ? Value
  : Value extends
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  ? Value
  : Value extends readonly [infer First, infer Second]
    ? [MutableResult<First>, MutableResult<Second>]
    : Value extends readonly (infer Item)[]
      ? MutableResult<Item>[]
      : Value extends object
        ? { -readonly [Key in keyof Value]: MutableResult<Value[Key]> }
        : Value

type RouteResultValue<Name extends HostRouteName> = Name extends keyof HostRouteResultOverrides
  ? HostRouteResultOverrides[Name]
  : Schema.Schema.Type<(typeof HOST_ROUTES)[Name]["result"]>

export type HostRouteResult<Name extends HostRouteName> = [
  RouteResultValue<Name>,
] extends [null]
  ? void
  : MutableResult<RouteResultValue<Name>>
export type HostRoute = (typeof HOST_ROUTES)[HostRouteName]

const HOST_ROUTE_ENTRIES = Object.entries(HOST_ROUTES)

/** Runtime lookup used by adapters after the channel crosses the wire. */
export function getHostRoute(channel: string): HostRoute | undefined {
  return HOST_ROUTE_ENTRIES.find(([name]) => name === channel)?.[1]
}

/** Decode positional arguments exactly once at the RPC seam. */
export function decodeHostRouteArgs(channel: string, args: unknown[]): unknown[] {
  const route = getHostRoute(channel)
  if (!route) throw new Error(`unknown host channel: ${channel}`)
  return route.decodeArgs(args)
}

/** Validate a handler result before it is put on HTTP or WS. */
export function decodeHostRouteResult<Name extends HostRouteName>(
  name: Name,
  value: unknown,
): HostRouteResult<Name>
export function decodeHostRouteResult(
  name: HostRouteName,
  value: unknown,
): unknown {
  const route = getHostRoute(name)
  if (!route) throw new Error(`unknown host channel: ${name}`)
  return route.decodeResult(value)
}

export function terminalAttachControlResult(value: unknown) {
  const decoded = Schema.decodeUnknownSync(TerminalAttachResult)(value)
  if (decoded === null) return null
  const { semanticSnapshot: _semanticSnapshot, ...control } = decoded
  return control
}

export const HOST_ROUTE_CHANNELS = HOST_ROUTE_ENTRIES
  .map(([name]) => name)
  .filter(isHostRouteName)
export const HOST_HOT_ROUTES = HOST_ROUTE_ENTRIES
  .filter(([, route]) => route.realtime)
  .map(([channel]) => channel)
  .filter(isHostRouteName)

export function isHostRouteName(value: string): value is HostRouteName {
  return getHostRoute(value) !== undefined
}
