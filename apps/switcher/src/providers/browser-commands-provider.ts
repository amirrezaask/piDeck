import { Effect } from 'effect';

import type { BrowserCommand } from '/src/domain/browser-command';
import type { SwitcherProvider } from '/src/domain/switcher-provider';
import type { BrowserCommandSwitcherItem } from '/src/domain/switcher-item';
import { normalizeSearchText } from '/src/search/normalize';

interface CommandDefinition {
  readonly command: BrowserCommand;
  readonly title: string;
  readonly description: string;
  readonly aliases: readonly string[];
  readonly danger?: boolean;
  readonly priority: number;
}

const definitions: readonly CommandDefinition[] = [
  {
    command: 'new-tab',
    title: 'New tab',
    description: 'Open a tab in this window',
    aliases: ['create tab', 'open tab'],
    priority: 34,
  },
  {
    command: 'new-window',
    title: 'New window',
    description: 'Open a normal browser window',
    aliases: ['create window', 'open window'],
    priority: 28,
  },
  {
    command: 'toggle-current-tab-pin',
    title: 'Toggle current tab pin',
    description: 'Pin or unpin the host tab',
    aliases: ['pin tab', 'unpin tab'],
    priority: 18,
  },
  {
    command: 'toggle-current-tab-mute',
    title: 'Toggle current tab mute',
    description: 'Mute or unmute the host tab',
    aliases: ['mute tab', 'unmute tab', 'silence tab'],
    priority: 17,
  },
  {
    command: 'close-current-tab',
    title: 'Close current tab',
    description: 'Close the tab where Switcher opened',
    aliases: ['close tab', 'remove tab'],
    danger: true,
    priority: -5,
  },
  {
    command: 'open-shortcut-settings',
    title: 'Open keyboard shortcut settings',
    description: 'Assign or change the Switcher shortcut',
    aliases: ['keyboard shortcut', 'change shortcut', 'hotkey', 'keybinding'],
    priority: 12,
  },
];

const makeCommand = (definition: CommandDefinition): BrowserCommandSwitcherItem => {
  const searchText = `${definition.title} ${definition.description} ${definition.aliases.join(' ')}`;
  return {
    id: `command:${definition.command}`,
    kind: 'browser-command',
    title: definition.title,
    subtitle: definition.description,
    searchText,
    keywords: definition.aliases,
    normalizedTitle: normalizeSearchText(definition.title),
    normalizedHostname: '',
    normalizedSearchText: normalizeSearchText(searchText),
    command: definition.command,
    danger: definition.danger ?? false,
    priority: definition.priority,
  };
};

export const BrowserCommandsProvider: SwitcherProvider = {
  id: 'browser-commands',
  load: () => Effect.succeed(definitions.map(makeCommand)),
};
