import { useMemo, useState } from "react"
import { Terminal } from "lucide-react"
import type { TerminalKind, MuxTerminal, MuxTerminalId } from "@yaade/rpc"
import { Badge } from "@yaade/ui/primitives"
import { formatKeyBinding, PaletteShell, type PaletteShellItem } from "@yaade/ui/session"
import { muxSessionShortcutFor } from "./mux-keymap.js"
import {
  rankTerminalSwitcherEntries,
  type RankedTerminalSwitcherEntry,
  type TerminalSwitcherContext,
  type TerminalSwitcherSourceEntry,
  type TerminalStatusPreview,
} from "./terminal-switcher-model.js"
import type { TerminalFocusHistory } from "./terminal-focus-history.js"

const terminalIcons = {
  terminal: Terminal,
} satisfies Record<TerminalKind, typeof Terminal>

function statusBadgeVariant(
  tone: TerminalStatusPreview["tone"],
): "success" | "info" | "destructive" | "warning" | "secondary" | "outline" {
  switch (tone) {
    case "running": return "success"
    case "waiting": return "info"
    case "failed": return "destructive"
    case "interrupted": return "warning"
    case "exited": return "secondary"
    case "starting": return "outline"
  }
}

export function TerminalSwitcher(props: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly entries: readonly TerminalSwitcherSourceEntry[]
  readonly history: TerminalFocusHistory
  readonly context: TerminalSwitcherContext
  readonly activeMuxTerminalId?: MuxTerminalId
  readonly onSelect: (terminal: MuxTerminal) => void
}) {
  // The component is mounted per open. Hold ordering/status constant until it closes
  // so host events cannot move the highlighted row under keyboard navigation.
  const [openEntries] = useState(() => props.entries)
  const [openContext] = useState(() => props.context)
  const [query, setQuery] = useState("")
  const ranked = useMemo(
    () => rankTerminalSwitcherEntries(openEntries, props.history, openContext, query),
    [openContext, openEntries, props.history, query],
  )
  const items = useMemo<PaletteShellItem<RankedTerminalSwitcherEntry>[]>(
    () => ranked.map(entry => ({
      key: entry.terminal.id,
      value: entry.searchText,
      data: entry,
    })),
    [ranked],
  )
  const switchShortcut = muxSessionShortcutFor("terminal.switch")

  return (
    <PaletteShell
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Switch terminal"
      description={`Jump to a current terminal across all sessions${switchShortcut ? ` (${formatKeyBinding(switchShortcut)})` : ""}.`}
      placeholder="Search terminals, Windows, sessions, or hosts…"
      surface="terminals"
      size="picker"
      query={query}
      onQueryChange={setQuery}
      items={items}
      shouldFilter={false}
      rowLayout="detail"
      estimateSize={entry => entry.section ? 76 : 56}
      requireQueryForSelection={false}
      emptyLabel="No current terminals."
      onSelect={(entry) => {
        props.onSelect(entry.terminal)
        props.onOpenChange(false)
      }}
      renderItem={(entry) => {
        const Icon = terminalIcons[entry.terminal.kind]
        const current = entry.terminal.id === props.activeMuxTerminalId
        return (
          <span className="flex min-w-0 flex-1 flex-col">
            {entry.section ? (
              <span
                className="px-0.5 pb-1 text-3xs font-medium uppercase tracking-wide text-muted-foreground"
                data-yaade-terminal-switcher-group={entry.section === "Recent" ? "recent" : "other"}
              >
                {entry.section}
              </span>
            ) : null}
            <span
              className="flex min-w-0 flex-1 items-center gap-2.5"
              data-yaade-terminal-switcher-terminal={entry.terminal.id}
              data-yaade-terminal-switcher-recent={entry.recent ? "true" : undefined}
              data-yaade-terminal-switcher-current={current ? "true" : undefined}
            >
              <span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
                <Icon className="size-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {entry.title}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {entry.serverName} · {entry.session.title} / {entry.tab.title}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                {current ? <Badge variant="outline">Current</Badge> : null}
                <Badge
                  variant={statusBadgeVariant(entry.statusPreview.tone)}
                  data-yaade-terminal-status={entry.statusPreview.tone}
                >
                  {entry.statusPreview.label}
                </Badge>
              </span>
            </span>
          </span>
        )
      }}
    />
  )
}
