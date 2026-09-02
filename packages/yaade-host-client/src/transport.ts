import type {
  HostRouteArgs,
  HostRouteName,
  HostRouteResult,
} from "@yaade/rpc";

/** Platform-neutral bridge between the renderer and the Yaade host process. */
export interface YaadeHostTransport {
  /** Typed cold-path RPC. The route registry owns the tuple and result types. */
  invoke<Name extends HostRouteName>(
    channel: Name,
    ...args: HostRouteArgs<Name>
  ): Promise<HostRouteResult<Name>>;
  /** @deprecated Only adapters still carrying an untyped legacy channel may terminal this overload. */
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  /** Optional per-request cancellation used by intent-driven cold-path queries. */
  invokeWithSignal?<Name extends HostRouteName>(
    channel: Name,
    args: HostRouteArgs<Name>,
    signal: AbortSignal,
  ): Promise<HostRouteResult<Name>>;
  /** @deprecated Legacy cancellation overload. */
  invokeWithSignal?(
    channel: string,
    args: unknown[],
    signal: AbortSignal,
  ): Promise<unknown>;
  /** Observable realtime invoke. Resolves only after the host applies the command. */
  invokeRealtime?<Name extends HostRouteName>(
    channel: Name,
    ...args: HostRouteArgs<Name>
  ): Promise<HostRouteResult<Name>> | null;
  /** @deprecated Legacy realtime overload. */
  invokeRealtime?(channel: string, ...args: unknown[]): Promise<unknown> | null;
  /** Fire-and-forget terminal send for callers that do not need delivery status. */
  sendRealtime?(channel: string, ...args: unknown[]): boolean;
  on(channel: string, listener: (...args: unknown[]) => void): () => void;
}
