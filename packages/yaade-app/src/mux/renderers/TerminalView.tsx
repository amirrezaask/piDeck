import { lazy, Suspense } from "react"
import { LoaderCircle, RotateCcw, X } from "lucide-react"
import type { MuxTerminal } from "@yaade/rpc"
import type { YaadeTheme } from "@yaade/shared"
import { Button } from "@yaade/ui/primitives"

const TerminalPanel = lazy(() =>
  import("@yaade/ui/terminal").then(module => ({ default: module.TerminalPanel })),
)

export type ProcessTerminalViewProps = {
  readonly terminal: MuxTerminal
  readonly theme: YaadeTheme
  readonly visible?: boolean
  readonly focused?: boolean
  readonly onTitleChange?: (title: string) => void
  readonly onJumpToLive?: () => void
  readonly onRestart?: () => void
  readonly onClose?: () => void
}

export function ProcessTerminalView({
  terminal,
  theme,
  onTitleChange,
  onJumpToLive,
  onRestart,
  onClose,
  visible = true,
  focused = visible,
}: ProcessTerminalViewProps) {
  const processState = terminal.output.processState
  const waitingForPty =
    !terminal.output.ptyId &&
    (processState === "starting" ||
      processState === "restoring" ||
      processState === "orphaned")
  const interruptedHistoryId =
    processState === "interrupted" && terminal.output.replayAvailable
      ? terminal.output.historyId
      : undefined
  const status =
    processState === "starting" ||
    processState === "running" ||
    processState === "exited" ||
    processState === "failed"
      ? processState
      : "failed"
  const statusMessage =
    processState === "restoring"
      ? "Restoring terminal…"
      : processState === "interrupted"
        ? "Terminal interrupted — restart to continue"
        : processState === "orphaned"
          ? "Terminal process is unavailable"
          : "Starting terminal…"

  if (processState === "interrupted" && interruptedHistoryId) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col" data-yaade-terminal-interrupted="history">
        <Suspense fallback={<div className="grid flex-1 place-items-center text-sm text-muted-foreground">Opening retained history…</div>}>
          <TerminalPanel
            cwdRootUri="file:///"
            theme={theme}
            tabId={terminal.id}
            focused={focused}
            isActive={visible}
            existingPtyId={interruptedHistoryId}
            sessionGeneration={terminal.output.generation}
            status="exited"
            readOnly
            readOnlyMessage="Interrupted by host restart · retained output is read-only"
            attachOnly
            visible={visible}
            onJumpToLive={onJumpToLive}
            onRestart={onRestart}
            onClose={onClose}
          />
        </Suspense>
      </div>
    )
  }

  if (processState === "interrupted") {
    return (
      <div
        className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-4 px-4 text-center"
        data-yaade-terminal-interrupted="unavailable"
      >
        <div className="max-w-md space-y-1.5" role="status">
          <p className="text-sm font-medium text-foreground">Terminal ended when the host restarted</p>
          <p className="text-sm text-muted-foreground">
            Retained output is unavailable. Restarting opens a new shell; it does not resume the previous process.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button type="button" size="sm" onClick={onRestart}>
            <RotateCcw />
            Restart terminal
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onClose}>
            <X />
            Close
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {waitingForPty ? (
        <div
          className="grid flex-1 place-items-center text-sm text-muted-foreground"
          data-yaade-terminal-starting=""
          role="status"
        >
          {(processState === "starting" || processState === "restoring") && (
            <LoaderCircle className="mr-2 size-4 animate-spin" />
          )}
          {statusMessage}
        </div>
      ) : (
        <Suspense fallback={<div className="grid flex-1 place-items-center text-sm text-muted-foreground">Opening terminal…</div>}>
          <TerminalPanel
            cwdRootUri="file:///"
            theme={theme}
            tabId={terminal.id}
            focused={focused}
            isActive={visible}
            existingPtyId={terminal.output.ptyId}
            sessionGeneration={terminal.output.generation}
            status={status}
            attachOnly
            visible={visible}
            onTitleChange={(_id, title) => onTitleChange?.(title)}
            onJumpToLive={onJumpToLive}
            onRestart={onRestart}
            onClose={onClose}
          />
        </Suspense>
      )}
    </div>
  )
}
