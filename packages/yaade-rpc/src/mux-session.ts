import { Data, Schema } from "effect";

/** Stable identifiers for sessions, session windows, and persisted terminals. */
export const SessionId = Schema.String.pipe(
  Schema.pattern(/^ses-[A-Za-z0-9_-]+$/),
  Schema.brand("SessionId"),
);
export type SessionId = Schema.Schema.Type<typeof SessionId>;

export const MuxTerminalId = Schema.String.pipe(
  Schema.pattern(/^term-[A-Za-z0-9_-]+$/),
  Schema.brand("MuxTerminalId"),
);
export type MuxTerminalId = Schema.Schema.Type<typeof MuxTerminalId>;

/** A tmux-window equivalent: one session can contain many independent tabs. */
export const SessionTabId = Schema.String.pipe(
  Schema.pattern(/^tab-[A-Za-z0-9_-]+$/),
  Schema.brand("SessionTabId"),
);
export type SessionTabId = Schema.Schema.Type<typeof SessionTabId>;

export const TerminalKind = Schema.Literal("terminal");
export type TerminalKind = Schema.Schema.Type<typeof TerminalKind>;

export const TerminalStatus = Schema.Literal(
  "created",
  "starting",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
  "disconnected",
);
export type TerminalStatus = Schema.Schema.Type<typeof TerminalStatus>;

export class TerminalInput extends Schema.TaggedClass<TerminalInput>()(
  "TerminalInput",
  {
    kind: Schema.Literal("terminal"),
    shellArgs: Schema.optional(Schema.Array(Schema.String)),
  },
) {}

export const ProcessState = Schema.Literal(
  "starting",
  "running",
  "exited",
  "failed",
  "disconnected",
  "interrupted",
  "restoring",
  "orphaned",
);
export const ActivityState = Schema.Literal(
  "starting",
  "working",
  "running_command",
  "waiting_for_input",
  "idle",
  "failed",
);

export class ProcessIdentity extends Schema.Class<ProcessIdentity>("ProcessIdentity")({
  pid: Schema.Number,
  platform: Schema.String,
  bootId: Schema.optional(Schema.String),
  startToken: Schema.String,
  executablePath: Schema.optional(Schema.String),
}) {}

export class TerminalOutput extends Schema.TaggedClass<TerminalOutput>()(
  "TerminalOutput",
  {
    kind: Schema.Literal("process"),
    terminalInstanceId: Schema.String,
    ptyId: Schema.optional(Schema.String),
    historyId: Schema.optional(Schema.String),
    processIdentity: Schema.optional(ProcessIdentity),
    generation: Schema.Number,
    processState: ProcessState,
    activityState: ActivityState,
    replayAvailable: Schema.Boolean,
    exitCode: Schema.optional(Schema.Number),
    truncated: Schema.Boolean,
  },
) {}

export class AppSession extends Schema.Class<AppSession>("AppSession")({
  id: SessionId,
  title: Schema.String,
  position: Schema.Number,
  /** Current tmux-window equivalent. */
  activeTabId: Schema.optional(SessionTabId),
  /** Selected terminal in the active window, when one exists. */
  activeMuxTerminalId: Schema.optional(MuxTerminalId),
  revision: Schema.optional(Schema.Number),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  archivedAt: Schema.optional(Schema.String),
}) {}

export class SessionTab extends Schema.Class<SessionTab>("SessionTab")({
  id: SessionTabId,
  sessionId: SessionId,
  title: Schema.String,
  position: Schema.Number,
  activeMuxTerminalId: Schema.optional(MuxTerminalId),
  /** Versioned JSON snapshot of this Window's one-MuxTerminal-per-pane split tree. */
  layoutJson: Schema.optional(Schema.String),
  revision: Schema.optional(Schema.Number),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  archivedAt: Schema.optional(Schema.String),
}) {}

const MuxTerminalRecord = Schema.Struct({
  id: MuxTerminalId,
  sessionId: SessionId,
  /** Window containing the terminal. */
  tabId: Schema.optional(SessionTabId),
  kind: TerminalKind,
  title: Schema.String,
  position: Schema.Number,
  status: TerminalStatus,
  input: TerminalInput,
  inputRevision: Schema.Number,
  output: TerminalOutput,
  error: Schema.optional(Schema.String),
  revision: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  startedAt: Schema.optional(Schema.String),
  finishedAt: Schema.optional(Schema.String),
  archivedAt: Schema.optional(Schema.String),
});

/** A persisted terminal invocation. */
export const MuxTerminal = MuxTerminalRecord;
export type MuxTerminal = Schema.Schema.Type<typeof MuxTerminalRecord>;

export class CreateSession extends Schema.TaggedClass<CreateSession>()(
  "CreateSession",
  {
    title: Schema.optional(Schema.String),
  },
) {}
export class RenameSession extends Schema.TaggedClass<RenameSession>()(
  "RenameSession",
  {
    sessionId: SessionId,
    title: Schema.String,
  },
) {}
export class CreateSessionTab extends Schema.TaggedClass<CreateSessionTab>()(
  "CreateSessionTab",
  {
    sessionId: SessionId,
    title: Schema.optional(Schema.String),
  },
) {}
export class RenameSessionTab extends Schema.TaggedClass<RenameSessionTab>()(
  "RenameSessionTab",
  {
    tabId: SessionTabId,
    title: Schema.String,
  },
) {}
export class SaveSessionTabLayout extends Schema.TaggedClass<SaveSessionTabLayout>()(
  "SaveSessionTabLayout",
  {
    tabId: SessionTabId,
    layoutJson: Schema.String.pipe(Schema.maxLength(65_536)),
    /** Revision observed by the writer; prevents an older layout overwriting a newer one. */
    revision: Schema.optional(Schema.Number),
  },
) {}
export class ReorderSessionTabs extends Schema.TaggedClass<ReorderSessionTabs>()(
  "ReorderSessionTabs",
  {
    sessionId: SessionId,
    tabIds: Schema.Array(SessionTabId),
  },
) {}
export class ArchiveSessionTab extends Schema.TaggedClass<ArchiveSessionTab>()(
  "ArchiveSessionTab",
  {
    tabId: SessionTabId,
    mode: Schema.Literal("keep-running", "stop-terminals"),
  },
) {}
export class SelectSessionTab extends Schema.TaggedClass<SelectSessionTab>()(
  "SelectSessionTab",
  {
    sessionId: SessionId,
    tabId: Schema.optional(SessionTabId),
  },
) {}
export class ReorderSessions extends Schema.TaggedClass<ReorderSessions>()(
  "ReorderSessions",
  {
    sessionIds: Schema.Array(SessionId),
  },
) {}
export class ArchiveSession extends Schema.TaggedClass<ArchiveSession>()(
  "ArchiveSession",
  {
    sessionId: SessionId,
    mode: Schema.Literal("keep-running", "stop-terminals"),
  },
) {}
export class RestoreSession extends Schema.TaggedClass<RestoreSession>()(
  "RestoreSession",
  {
    sessionId: SessionId,
  },
) {}
export class CreateTerminal extends Schema.TaggedClass<CreateTerminal>()(
  "CreateTerminal",
  {
    sessionId: SessionId,
    /** Defaults to the session's active window when omitted. */
    tabId: Schema.optional(SessionTabId),
    title: Schema.optional(Schema.String),
    kind: TerminalKind,
    input: TerminalInput,
  },
) {}
export class ReorderTerminals extends Schema.TaggedClass<ReorderTerminals>()(
  "ReorderTerminals",
  {
    sessionId: SessionId,
    /** Defaults to the terminal's window when omitted. */
    tabId: Schema.optional(SessionTabId),
    muxTerminalIds: Schema.Array(MuxTerminalId),
  },
) {}
export class MoveTerminalToTab extends Schema.TaggedClass<MoveTerminalToTab>()(
  "MoveTerminalToTab",
  {
    muxTerminalId: MuxTerminalId,
    targetTabId: SessionTabId,
  },
) {}
export class StopTerminal extends Schema.TaggedClass<StopTerminal>()(
  "StopTerminal",
  {
    muxTerminalId: MuxTerminalId,
    revision: Schema.Number,
  },
) {}
export class RestartTerminal extends Schema.TaggedClass<RestartTerminal>()(
  "RestartTerminal",
  {
    muxTerminalId: MuxTerminalId,
    revision: Schema.Number,
  },
) {}
export class CloseTerminal extends Schema.TaggedClass<CloseTerminal>()(
  "CloseTerminal",
  {
    muxTerminalId: MuxTerminalId,
  },
) {}
export class SelectSessionTerminal extends Schema.TaggedClass<SelectSessionTerminal>()(
  "SelectSessionTerminal",
  { sessionId: SessionId, muxTerminalId: Schema.optional(MuxTerminalId) },
) {}
export class ListSessions extends Schema.TaggedClass<ListSessions>()(
  "ListSessions",
  {
    includeArchived: Schema.optional(Schema.Boolean),
  },
) {}
export class GetSession extends Schema.TaggedClass<GetSession>()("GetSession", {
  sessionId: SessionId,
}) {}
export class GetTerminal extends Schema.TaggedClass<GetTerminal>()("GetTerminal", {
  muxTerminalId: MuxTerminalId,
}) {}
export const MuxCommand = Schema.Union(
  CreateSession,
  RenameSession,
  CreateSessionTab,
  RenameSessionTab,
  SaveSessionTabLayout,
  ReorderSessionTabs,
  ArchiveSessionTab,
  SelectSessionTab,
  ReorderSessions,
  ArchiveSession,
  RestoreSession,
  CreateTerminal,
  ReorderTerminals,
  MoveTerminalToTab,
  StopTerminal,
  RestartTerminal,
  CloseTerminal,
  SelectSessionTerminal,
  ListSessions,
  GetSession,
  GetTerminal,
);
export type MuxCommand = Schema.Schema.Type<typeof MuxCommand>;

const EventBase = {
  eventId: Schema.String,
  revision: Schema.Number,
  occurredAt: Schema.String,
};

export class SessionCreated extends Schema.TaggedClass<SessionCreated>()(
  "SessionCreated",
  {
    ...EventBase,
    session: AppSession,
  },
) {}
export class SessionUpdated extends Schema.TaggedClass<SessionUpdated>()(
  "SessionUpdated",
  {
    ...EventBase,
    session: AppSession,
  },
) {}
export class SessionArchived extends Schema.TaggedClass<SessionArchived>()(
  "SessionArchived",
  {
    ...EventBase,
    session: AppSession,
  },
) {}
export class SessionRestored extends Schema.TaggedClass<SessionRestored>()(
  "SessionRestored",
  {
    ...EventBase,
    session: AppSession,
  },
) {}
export class SessionTabCreated extends Schema.TaggedClass<SessionTabCreated>()(
  "SessionTabCreated",
  {
    ...EventBase,
    tab: SessionTab,
  },
) {}
export class SessionTabUpdated extends Schema.TaggedClass<SessionTabUpdated>()(
  "SessionTabUpdated",
  {
    ...EventBase,
    tab: SessionTab,
  },
) {}
export class SessionTabArchived extends Schema.TaggedClass<SessionTabArchived>()(
  "SessionTabArchived",
  {
    ...EventBase,
    tab: SessionTab,
  },
) {}
export class MuxTerminalCreated extends Schema.TaggedClass<MuxTerminalCreated>()(
  "MuxTerminalCreated",
  {
    ...EventBase,
    muxTerminalId: MuxTerminalId,
    muxTerminal: MuxTerminal,
  },
) {}
export class MuxTerminalUpdated extends Schema.TaggedClass<MuxTerminalUpdated>()(
  "MuxTerminalUpdated",
  {
    ...EventBase,
    muxTerminalId: MuxTerminalId,
    muxTerminal: MuxTerminal,
  },
) {}
export class TerminalOutputChanged extends Schema.TaggedClass<TerminalOutputChanged>()(
  "TerminalOutputChanged",
  { ...EventBase, muxTerminalId: MuxTerminalId, output: TerminalOutput },
) {}
export class MuxTerminalArchived extends Schema.TaggedClass<MuxTerminalArchived>()(
  "MuxTerminalArchived",
  {
    ...EventBase,
    muxTerminalId: MuxTerminalId,
  },
) {}

export const MuxEvent = Schema.Union(
  SessionCreated,
  SessionUpdated,
  SessionArchived,
  SessionRestored,
  SessionTabCreated,
  SessionTabUpdated,
  SessionTabArchived,
  MuxTerminalCreated,
  MuxTerminalUpdated,
  TerminalOutputChanged,
  MuxTerminalArchived,
);
export type MuxEvent = Schema.Schema.Type<typeof MuxEvent>;

export class SessionTabNotFound extends Data.TaggedError("SessionTabNotFound")<{
  readonly tabId: string;
  readonly message: string;
}> {
  readonly code = "NOT_FOUND" as const;
}
export class SessionTabConflict extends Data.TaggedError("SessionTabConflict")<{
  readonly tabId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;
  readonly message: string;
}> {
  readonly code = "CONFLICT" as const;
}
export class SessionNotFound extends Data.TaggedError("SessionNotFound")<{
  readonly sessionId: string;
  readonly message: string;
}> {
  readonly code = "NOT_FOUND" as const;
}
export class TerminalNotFound extends Data.TaggedError("TerminalNotFound")<{
  readonly muxTerminalId: string;
  readonly message: string;
}> {
  readonly code = "NOT_FOUND" as const;
}
export type InvalidTerminalInputDetails = object;

export class InvalidTerminalInput extends Data.TaggedError("InvalidTerminalInput")<{
  readonly message: string;
  readonly details?: InvalidTerminalInputDetails;
}> {
  readonly code = "OPERATION_FAILED" as const;
}
export class InvalidMuxCommand extends Data.TaggedError("InvalidMuxCommand")<{
  readonly message: string;
}> {
  readonly code = "OPERATION_FAILED" as const;
}
export class TerminalConflict extends Data.TaggedError("TerminalConflict")<{
  readonly muxTerminalId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;
  readonly message: string;
}> {
  readonly code = "CONFLICT" as const;
}
export class TerminalRuntimeFailure extends Data.TaggedError("TerminalRuntimeFailure")<{
  readonly muxTerminalId: string;
  readonly message: string;
  readonly cause?: unknown;
}> {
  readonly code = "OPERATION_FAILED" as const;
}

export type MuxSessionError =
  | SessionNotFound
  | SessionTabNotFound
  | SessionTabConflict
  | TerminalNotFound
  | InvalidTerminalInput
  | InvalidMuxCommand
  | TerminalConflict
  | TerminalRuntimeFailure;
