import { Schema } from "effect"

export const TerminalColor = Schema.Struct({
  r: Schema.Number,
  g: Schema.Number,
  b: Schema.Number,
  a: Schema.optional(Schema.Number),
})
export type TerminalColor = Schema.Schema.Type<typeof TerminalColor>

export const TerminalCell = Schema.Struct({
  text: Schema.String,
  wide: Schema.Number,
  foreground: TerminalColor,
  background: TerminalColor,
  underlineColor: Schema.optional(TerminalColor),
  bold: Schema.Boolean,
  faint: Schema.Boolean,
  italic: Schema.Boolean,
  blink: Schema.Boolean,
  inverse: Schema.Boolean,
  invisible: Schema.Boolean,
  strikethrough: Schema.Boolean,
  overline: Schema.Boolean,
  underline: Schema.Number,
  hyperlinkId: Schema.optional(Schema.String),
})
export type TerminalCell = Schema.Schema.Type<typeof TerminalCell>

export const TerminalRow = Schema.Struct({
  rowId: Schema.String,
  cells: Schema.Array(TerminalCell),
  isWrapContinuation: Schema.Boolean,
  wrapsToNext: Schema.Boolean,
})
export type TerminalRow = Schema.Schema.Type<typeof TerminalRow>

export const TerminalCursor = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  visible: Schema.Boolean,
  blinking: Schema.Boolean,
  style: Schema.Number,
})
export type TerminalCursor = Schema.Schema.Type<typeof TerminalCursor>

export const TerminalModes = Schema.Struct({
  bracketedPaste: Schema.Boolean,
  applicationCursorKeys: Schema.Boolean,
  focusReporting: Schema.Boolean,
  mouseTracking: Schema.Boolean,
  mouseSgr: Schema.Boolean,
  mouseSgrPixels: Schema.Boolean,
  synchronizedOutput: Schema.Boolean,
  kittyKeyboard: Schema.Boolean,
})
export type TerminalModes = Schema.Schema.Type<typeof TerminalModes>

export const TerminalScrollbackSummary = Schema.Struct({
  firstRowId: Schema.NullOr(Schema.String),
  lastRowId: Schema.NullOr(Schema.String),
  rowCount: Schema.Number,
})
export type TerminalScrollbackSummary = Schema.Schema.Type<typeof TerminalScrollbackSummary>

export const TerminalHyperlink = Schema.Struct({
  id: Schema.String,
  uri: Schema.String,
})
export type TerminalHyperlink = Schema.Schema.Type<typeof TerminalHyperlink>

export const TerminalSemanticSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  cols: Schema.Number,
  rows: Schema.Number,
  activeScreen: Schema.Literal("primary", "alternate"),
  revision: Schema.Number,
  cursor: TerminalCursor,
  screenRows: Schema.Array(TerminalRow),
  scrollback: TerminalScrollbackSummary,
  modes: TerminalModes,
  title: Schema.NullOr(Schema.String),
  palette: Schema.Array(TerminalColor),
  hyperlinks: Schema.Array(TerminalHyperlink),
})
export type TerminalSemanticSnapshot = Schema.Schema.Type<typeof TerminalSemanticSnapshot>

export const TerminalSemanticPatch = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  terminalEpoch: Schema.String,
  baseRevision: Schema.Number,
  revision: Schema.Number,
  changedRows: Schema.Array(TerminalRow),
  deletedRowIds: Schema.Array(Schema.String),
  cursor: Schema.optional(TerminalCursor),
  cols: Schema.optional(Schema.Number),
  rows: Schema.optional(Schema.Number),
  activeScreen: Schema.optional(Schema.Literal("primary", "alternate")),
  scrollback: Schema.optional(TerminalScrollbackSummary),
  modes: Schema.optional(TerminalModes),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  palette: Schema.optional(Schema.Array(TerminalColor)),
  hyperlinks: Schema.optional(Schema.Array(TerminalHyperlink)),
  fullReset: Schema.optional(Schema.Boolean),
})
export type TerminalSemanticPatch = Schema.Schema.Type<typeof TerminalSemanticPatch>

export const TerminalSnapshotMessage = Schema.Struct({
  type: Schema.Literal("terminal.snapshot"),
  terminalId: Schema.String,
  ownerEpoch: Schema.String,
  terminalEpoch: Schema.String,
  revision: Schema.Number,
  snapshot: TerminalSemanticSnapshot,
})
export type TerminalSnapshotMessage = Schema.Schema.Type<typeof TerminalSnapshotMessage>

export const TerminalPatchMessage = Schema.Struct({
  type: Schema.Literal("terminal.patch"),
  terminalId: Schema.String,
  ownerEpoch: Schema.String,
  terminalEpoch: Schema.String,
  baseRevision: Schema.Number,
  revision: Schema.Number,
  patch: TerminalSemanticPatch,
})
export type TerminalPatchMessage = Schema.Schema.Type<typeof TerminalPatchMessage>

export const TerminalResyncRequiredMessage = Schema.Struct({
  type: Schema.Literal("terminal.resync-required"),
  terminalId: Schema.String,
  terminalEpoch: Schema.String,
  latestRevision: Schema.Number,
})
export type TerminalResyncRequiredMessage = Schema.Schema.Type<typeof TerminalResyncRequiredMessage>

export const TerminalStreamV3Message = Schema.Union(
  TerminalSnapshotMessage,
  TerminalPatchMessage,
  TerminalResyncRequiredMessage,
)
export type TerminalStreamV3Message = Schema.Schema.Type<typeof TerminalStreamV3Message>

export function applyTerminalSemanticPatch(
  snapshot: TerminalSemanticSnapshot,
  terminalEpoch: string,
  patch: TerminalSemanticPatch,
): TerminalSemanticSnapshot | null {
  if (
    patch.terminalEpoch !== terminalEpoch ||
    patch.baseRevision !== snapshot.revision ||
    !Number.isSafeInteger(patch.baseRevision) ||
    !Number.isSafeInteger(patch.revision) ||
    patch.revision <= patch.baseRevision
  ) return null
  const deleted = new Set(patch.deletedRowIds)
  const changedById = new Map(patch.changedRows.map(row => [row.rowId, row]))
  const screenRows = snapshot.screenRows
    .filter(row => !deleted.has(row.rowId))
    .map(row => changedById.get(row.rowId) ?? row)
  const existingIds = new Set(screenRows.map(row => row.rowId))
  for (const row of patch.changedRows) {
    if (!existingIds.has(row.rowId)) screenRows.push(row)
  }
  return {
    ...snapshot,
    cols: patch.cols ?? snapshot.cols,
    rows: patch.rows ?? snapshot.rows,
    activeScreen: patch.activeScreen ?? snapshot.activeScreen,
    cursor: patch.cursor ?? snapshot.cursor,
    scrollback: patch.scrollback ?? snapshot.scrollback,
    modes: patch.modes ?? snapshot.modes,
    title: patch.title === undefined ? snapshot.title : patch.title,
    palette: patch.palette ?? snapshot.palette,
    hyperlinks: patch.hyperlinks ?? snapshot.hyperlinks,
    revision: patch.revision,
    screenRows: patch.fullReset ? patch.changedRows : screenRows,
  }
}
