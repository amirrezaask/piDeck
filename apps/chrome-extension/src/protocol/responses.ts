import { Schema } from 'effect';

const Id = Schema.Number.pipe(Schema.int(), Schema.positive());

export const TabSnapshotSchema = Schema.Struct({
  id: Id,
  windowId: Id,
  index: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  title: Schema.String,
  url: Schema.String,
  favIconUrl: Schema.optional(Schema.String),
  active: Schema.Boolean,
  pinned: Schema.Boolean,
  audible: Schema.Boolean,
  muted: Schema.Boolean,
  lastAccessed: Schema.optional(Schema.Number),
});
export type TabSnapshot = typeof TabSnapshotSchema.Type;

export const BootstrapSnapshotSchema = Schema.Struct({
  tabs: Schema.Array(TabSnapshotSchema),
  currentTabId: Schema.optional(Id),
  currentWindowId: Schema.optional(Id),
  shortcut: Schema.optional(Schema.String),
  theme: Schema.Literal('system', 'light', 'dark'),
  fallback: Schema.Boolean,
  pageZoom: Schema.Number.pipe(Schema.positive()),
});
export type BootstrapSnapshot = typeof BootstrapSnapshotSchema.Type;

export const RuntimeResponseSchema = Schema.Union(
  Schema.Struct({
    ok: Schema.Literal(true),
    type: Schema.Literal('snapshot'),
    data: BootstrapSnapshotSchema,
  }),
  Schema.Struct({ ok: Schema.Literal(true), type: Schema.Literal('tab'), data: TabSnapshotSchema }),
  Schema.Struct({
    ok: Schema.Literal(true),
    type: Schema.Literal('shortcut'),
    shortcut: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ok: Schema.Literal(true),
    type: Schema.Literal('done'),
    closePalette: Schema.Boolean,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    type: Schema.Literal('palette/error'),
    code: Schema.String,
    message: Schema.String,
  }),
);
export type RuntimeResponse = typeof RuntimeResponseSchema.Type;
