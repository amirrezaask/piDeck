import { PinIcon, PinOffIcon, Volume2Icon, VolumeXIcon, XIcon } from 'lucide-react';

import { Button } from '/src/components/ui/button';
import { CommandItem } from '/src/components/ui/command';
import { Tooltip, TooltipContent, TooltipTrigger } from '/src/components/ui/tooltip';
import type { TabSwitcherItem } from '/src/domain/switcher-item';
import { cn } from '/src/lib/utils';

import { Favicon } from './favicon';

interface TabResultProps {
  readonly item: TabSwitcherItem;
  readonly selected: boolean;
  readonly portalContainer: HTMLElement | null;
  readonly onActivate: () => void;
  readonly onClose: () => void;
  readonly onPin: () => void;
  readonly onMute: () => void;
}

interface ActionProps {
  readonly label: string;
  readonly children: React.ReactNode;
  readonly portalContainer: HTMLElement | null;
  readonly onClick: () => void;
}

function RowAction({ label, children, portalContainer, onClick }: ActionProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onClick();
          }}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent container={portalContainer} side="top">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function TabResult({
  item,
  selected,
  portalContainer,
  onActivate,
  onClose,
  onPin,
  onMute,
}: TabResultProps) {
  return (
    <CommandItem
      value={item.id}
      onSelect={onActivate}
      aria-label={`${item.title}, ${item.hostname}${item.currentWindow ? '' : ', another window'}`}
      aria-selected={selected}
      className="group/result gap-3.5 rounded-xl px-4 py-2.5 text-base"
    >
      <Favicon src={item.favIconUrl} label={item.hostname || item.title} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium">{item.title}</span>
          {item.pinned ? (
            <PinIcon className="size-3 text-muted-foreground" aria-label="Pinned" />
          ) : null}
          {item.muted ? (
            <VolumeXIcon className="size-3 text-muted-foreground" aria-label="Muted" />
          ) : item.audible ? (
            <Volume2Icon className="size-3 text-muted-foreground" aria-label="Playing audio" />
          ) : null}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
          {!item.currentWindow ? (
            <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">
              Other window
            </span>
          ) : null}
          <span className="truncate">{item.subtitle}</span>
        </span>
      </span>
      <span
        className={cn(
          'flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/result:opacity-100 group-data-[selected=true]/result:opacity-100',
          selected && 'opacity-100',
        )}
      >
        <RowAction
          label={item.pinned ? 'Unpin tab' : 'Pin tab'}
          portalContainer={portalContainer}
          onClick={onPin}
        >
          {item.pinned ? <PinOffIcon /> : <PinIcon />}
        </RowAction>
        <RowAction
          label={item.muted ? 'Unmute tab' : 'Mute tab'}
          portalContainer={portalContainer}
          onClick={onMute}
        >
          {item.muted ? <Volume2Icon /> : <VolumeXIcon />}
        </RowAction>
        <RowAction label="Close tab" portalContainer={portalContainer} onClick={onClose}>
          <XIcon />
        </RowAction>
      </span>
    </CommandItem>
  );
}
