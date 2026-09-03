import { lazy, Suspense } from "react"
import { LoaderCircle } from "lucide-react"
import type { MuxTerminal } from "@yaade/rpc"
import type { YaadeTheme } from "@yaade/shared"
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

  const interruptedState =
    processState === "interrupted"
      ? interruptedHistoryId
        ? "history"
        : "unavailable"
      : undefined
  const panelStatus = interruptedState === "history" ? "exited" : status
  const panelPtyId = interruptedState === "history" ? interruptedHistoryId : terminal.output.ptyId

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
        <Suspense
          fallback={
            <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
              {interruptedState === "history" ? "Opening retained history…" : "Opening terminal…"}
            </div>
          }
        >
          <TerminalPanel
            cwdRootUri="file:///"
            theme={theme}
            tabId={terminal.id}
            focused={focused}
            isActive={visible}
            existingPtyId={panelPtyId}
            sessionGeneration={terminal.output.generation}
            status={panelStatus}
            readOnly={interruptedState !== undefined}
            readOnlyMessage="Interrupted by host restart · retained output is read-only"
            interruptedState={interruptedState}
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
