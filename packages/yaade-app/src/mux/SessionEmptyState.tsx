import { Terminal, type LucideIcon } from "lucide-react"
import type { TerminalKind } from "@yaade/rpc"
import { KeyBindingKbd } from "@yaade/ui/session"
import {
  Button,
  Empty,
  EmptyContent,
  Skeleton,
} from "@yaade/ui/primitives"
import { muxSessionShortcutFor } from "./mux-keymap.js"

type TerminalTile = {
  readonly kind: TerminalKind
  readonly label: string
  readonly hint: string
  readonly command: string
  readonly Icon: LucideIcon
}

const TERMINAL_TILES: readonly TerminalTile[] = [
  {
    kind: "terminal",
    label: "Terminal",
    hint: "Host shell",
    command: "terminal.newTerminal",
    Icon: Terminal,
  },
]

export function SessionLoadingState() {
  return (
    <div
      className="flex h-full min-h-0 w-full items-center justify-center p-4 sm:p-6"
      data-yaade-session-boot=""
      role="status"
      aria-label="Loading sessions"
    >
      <div className="flex w-full max-w-3xl flex-col items-center gap-6">
        <Skeleton className="h-4 w-28" />
        <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-3">
          {TERMINAL_TILES.map(tile => (
            <Skeleton key={tile.kind} className="h-28 rounded-md" />
          ))}
        </div>
      </div>
    </div>
  )
}

export function SessionEmptyState(props: {
  readonly onAddKind: (kind: TerminalKind) => void
}) {
  return (
    <Empty
      className="h-full min-h-0 w-full justify-center rounded-none border-0 p-4 sm:p-6"
      data-yaade-session-empty=""
      role="region"
      aria-label="Available terminals"
    >
      <EmptyContent className="max-w-3xl gap-6">
        <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-4">
          {TERMINAL_TILES.map(tile => {
            const shortcut = muxSessionShortcutFor(tile.command)
            const Icon = tile.Icon
            return (
              <Button
                key={tile.kind}
                type="button"
                variant="outline"
                data-yaade-empty-terminal={tile.kind}
                aria-label={tile.label}
                onClick={() => props.onAddKind(tile.kind)}
                className="group/empty-tile h-auto flex-col gap-2.5 border-border bg-card px-3 py-4 text-center"
              >
                <span
                  className="flex size-10 items-center justify-center rounded-md border border-border bg-secondary text-foreground transition-colors duration-[var(--yaade-motion-hot)] group-hover/empty-tile:border-primary/35 group-hover/empty-tile:text-primary"
                  aria-hidden
                >
                  <Icon className="size-5" />
                </span>
                <span className="flex flex-col items-center gap-0.5">
                  <span className="text-xs font-medium text-foreground">
                    {tile.label}
                  </span>
                  <span className="line-clamp-2 text-3xs text-muted-foreground">
                    {tile.hint}
                  </span>
                </span>
                {shortcut ? (
                  <KeyBindingKbd
                    binding={shortcut}
                    className="opacity-70 group-hover/empty-tile:opacity-100"
                  />
                ) : null}
              </Button>
            )
          })}
        </div>
      </EmptyContent>
    </Empty>
  )
}
