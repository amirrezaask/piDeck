import { terminalKeybindingData } from "./terminal-keybindings.js"

export type SemanticTerminalSnapshot = {
  readonly revision: number
  readonly activeScreen: "primary" | "alternate"
  readonly screenRows: readonly {
    readonly rowId: string
    readonly cells: readonly { readonly text: string }[]
  }[]
}

export type SemanticTerminalViewProps = {
  snapshot: SemanticTerminalSnapshot
  focused: boolean
  onInput?: (data: string) => void
}

function rowText(row: SemanticTerminalSnapshot["screenRows"][number]): string {
  return row.cells.map(cell => cell.text).join("")
}

/**
 * Remote semantic renderer. It paints owner-published cells and never parses
 * raw PTY output.
 */
export function SemanticTerminalView({
  snapshot,
  focused,
  onInput,
}: SemanticTerminalViewProps) {
  return (
    <div
      data-yaade-terminal-semantic=""
      data-revision={String(snapshot.revision)}
      data-screen={snapshot.activeScreen}
      data-focused={focused ? "1" : undefined}
      role="region"
      aria-label="Terminal output"
      tabIndex={0}
      className="h-full min-h-0 flex-1 overflow-hidden bg-background p-2 font-mono text-xs leading-tight text-foreground outline-none"
      onKeyDown={event => {
        const payload = terminalKeybindingData(
          {
            altKey: event.altKey,
            ctrlKey: event.ctrlKey,
            isComposing: event.nativeEvent.isComposing,
            key: event.key,
            metaKey: event.metaKey,
            shiftKey: event.shiftKey,
            type: event.type,
          },
          navigator.platform,
        )
        if (payload == null) {
          if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault()
            onInput?.(event.key)
          }
          return
        }
        event.preventDefault()
        onInput?.(payload)
      }}
    >
      {snapshot.screenRows.map(row => (
        <div key={row.rowId} data-row-id={row.rowId} className="whitespace-pre">
          {rowText(row) || " "}
        </div>
      ))}
    </div>
  )
}
