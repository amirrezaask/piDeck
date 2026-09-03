import { Schema } from 'effect';

import { THEME_PREFERENCES, type ThemePreference } from '/src/domain/theme';

export type { ThemePreference };

const Id = Schema.Number.pipe(Schema.int(), Schema.positive());
const ThemeSchema = Schema.Literal(...THEME_PREFERENCES);

export const RuntimeRequestSchema = Schema.Union(
  Schema.Struct({ type: Schema.Literal('palette/toggle') }),
  Schema.Struct({ type: Schema.Literal('palette/bootstrap') }),
  Schema.Struct({ type: Schema.Literal('palette/refresh') }),
  Schema.Struct({ type: Schema.Literal('tab/activate'), tabId: Id, windowId: Id }),
  Schema.Struct({ type: Schema.Literal('tab/close'), tabId: Id }),
  Schema.Struct({ type: Schema.Literal('tab/set-pinned'), tabId: Id, pinned: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal('tab/set-muted'), tabId: Id, muted: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal('keyboard-shortcut/get') }),
  Schema.Struct({ type: Schema.Literal('theme/set'), theme: ThemeSchema }),
  Schema.Struct({ type: Schema.Literal('test/invoke') }),
);

export type RuntimeRequest = typeof RuntimeRequestSchema.Type;

export const PaletteToggleSchema = Schema.Struct({ type: Schema.Literal('palette/toggle') });
export type PaletteToggle = typeof PaletteToggleSchema.Type;
