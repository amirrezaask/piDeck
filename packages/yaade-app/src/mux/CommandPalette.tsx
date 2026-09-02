import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ChevronsLeft,
  ChevronsRight,
  Command,
  Layers3,
  Maximize2,
  PanelBottomOpen,
  PanelLeft,
  PanelRightOpen,
  Pause,
  Plus,
  Search,
  Settings,
  Terminal,
  X,
  type LucideIcon,
} from "lucide-react"
import {
  KeyBindingKbd,
  PaletteShell,
  type PaletteShellItem,
} from "@yaade/ui/session"
import {
  commandCategoryLabel,
  paletteCommandDescriptors,
  type CommandDescriptor,
  type CommandIconKey,
} from "../commands/catalog.js"
import type {
  CommandAvailability,
  CommandRuntime,
} from "../commands/runtime.js"
import { muxSessionPrimaryShortcutFor } from "../keybindings.js"

const commandIcons = {
  command: Command,
  terminal: Terminal,
  arrowRight: ArrowRight,
  arrowLeft: ArrowLeft,
  arrowDown: ArrowDown,
  pause: Pause,
  windowNext: ChevronsRight,
  windowPrevious: ChevronsLeft,
  maximize: Maximize2,
  splitRight: PanelRightOpen,
  splitDown: PanelBottomOpen,
  search: Search,
  sidebar: PanelLeft,
  sessions: Layers3,
  plus: Plus,
  close: X,
  settings: Settings,
} satisfies Record<CommandIconKey, LucideIcon>

type CommandPaletteEntry = {
  readonly descriptor: CommandDescriptor
  readonly availability: CommandAvailability
  readonly shortcut?: string
}

export function CommandPalette(props: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly runtime: CommandRuntime
}) {
  const items: PaletteShellItem<CommandPaletteEntry>[] = paletteCommandDescriptors().map(
    descriptor => {
      const shortcut = muxSessionPrimaryShortcutFor(descriptor.id)
      return {
        key: descriptor.id,
        value: [
          descriptor.title,
          commandCategoryLabel(descriptor.category),
          descriptor.id,
          ...descriptor.aliases,
        ].join(" "),
        data: {
          descriptor,
          availability: props.runtime.availability(descriptor.id),
          shortcut,
        },
      }
    },
  )

  return (
    <PaletteShell
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Commands"
      description="Search and run terminal multiplexer commands."
      placeholder="Search commands…"
      surface="commands"
      size="picker"
      items={items}
      rowLayout="detail"
      requireQueryForSelection={false}
      emptyLabel="No matching commands."
      isItemDisabled={entry => entry.availability.status === "disabled"}
      onSelect={entry => {
        void props.runtime.execute(entry.descriptor.id, { source: "palette" })
      }}
      renderItem={entry => {
        const Icon = commandIcons[entry.descriptor.icon]
        const category = commandCategoryLabel(entry.descriptor.category)
        const disabledReason =
          entry.availability.status === "disabled"
            ? entry.availability.reason
            : undefined
        return (
          <span
            className="flex min-w-0 flex-1 items-center gap-2.5"
            data-yaade-command={entry.descriptor.id}
            data-command-category={entry.descriptor.category}
            data-command-availability={entry.availability.status}
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-[var(--yaade-control-radius)] bg-secondary text-muted-foreground">
              <Icon className="size-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground">
                {entry.descriptor.title}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {disabledReason ?? category}
              </span>
            </span>
            {entry.shortcut ? (
              <KeyBindingKbd
                binding={entry.shortcut}
                className="shrink-0 text-muted-foreground"
              />
            ) : null}
          </span>
        )
      }}
    />
  )
}
