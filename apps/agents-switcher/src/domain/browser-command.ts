export const BROWSER_COMMANDS = [
  'new-tab',
  'new-window',
  'toggle-current-tab-pin',
  'toggle-current-tab-mute',
  'close-current-tab',
  'open-shortcut-settings',
] as const;

export type BrowserCommand = (typeof BROWSER_COMMANDS)[number];
