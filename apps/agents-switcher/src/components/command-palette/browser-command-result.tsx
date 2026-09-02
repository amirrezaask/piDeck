import { AppWindowIcon, KeyboardIcon, PinIcon, PlusIcon, VolumeXIcon, XIcon } from 'lucide-react';

import { CommandItem, CommandShortcut } from '/src/components/ui/command';
import type { BrowserCommandSwitcherItem } from '/src/domain/switcher-item';
import { cn } from '/src/lib/utils';

const icons = {
  'new-tab': PlusIcon,
  'new-window': AppWindowIcon,
  'toggle-current-tab-pin': PinIcon,
  'toggle-current-tab-mute': VolumeXIcon,
  'close-current-tab': XIcon,
  'open-shortcut-settings': KeyboardIcon,
} as const;

interface BrowserCommandResultProps {
  readonly item: BrowserCommandSwitcherItem;
  readonly onExecute: () => void;
}

export function BrowserCommandResult({ item, onExecute }: BrowserCommandResultProps) {
  const Icon = icons[item.command];
  return (
    <CommandItem
      value={item.id}
      onSelect={onExecute}
      className={cn(
        'min-h-10 gap-2.5 rounded-md px-2.5 py-1.5 text-[13px]',
        item.danger && 'text-destructive data-selected:text-destructive',
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
        <Icon />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">{item.title}</span>
        <span className="truncate text-[11px] leading-4 text-muted-foreground">
          {item.subtitle}
        </span>
      </span>
      {item.command === 'toggle-current-tab-pin' ? (
        <CommandShortcut>⌥ P</CommandShortcut>
      ) : item.command === 'toggle-current-tab-mute' ? (
        <CommandShortcut>⌥ M</CommandShortcut>
      ) : null}
    </CommandItem>
  );
}
