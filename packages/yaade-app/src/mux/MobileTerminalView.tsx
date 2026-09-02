import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"
import { AnimatePresence } from "motion/react"
import { div as MotionDiv } from "motion/react-m"
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  Clipboard,
  ListFilter,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Terminal as TerminalIcon,
  X,
  type LucideIcon,
} from "lucide-react"
import type {
  AppSession,
  SessionId,
  TerminalKind,
  MuxTerminal,
  MuxTerminalId,
} from "@yaade/rpc"
import {
  pasteIntoRegisteredTerminal,
  sendTerminalVirtualKey,
  setTerminalVirtualModifier,
} from "@yaade/ui/terminal-registry"
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@yaade/ui/primitives"
import { GlassSurface, cn, yaadeMotion } from "@yaade/ui/session"
import {
  muxTerminalWorkTitle,
  type RuntimeTerminalTitle,
} from "./terminal-title.js"

const MAX_RETAINED_MOBILE_TERMINALS = 6
const MOBILE_TERMINAL_KINDS = ["terminal"] as const

type MobileTerminalKind = (typeof MOBILE_TERMINAL_KINDS)[number]

function isMobileTerminalKind(kind: TerminalKind): kind is MobileTerminalKind {
  return kind === "terminal"
}

function statusClass(terminal: MuxTerminal): string {
  switch (terminal.status) {
    case "waiting":
      return "bg-warning"
    case "created":
    case "starting":
      return "bg-info"
    case "failed":
    case "cancelled":
      return "bg-destructive"
    case "disconnected":
      return "bg-muted-foreground"
    case "running":
    case "succeeded":
      return "bg-success"
  }
}

function statusLabel(terminal: MuxTerminal): string {
  if (terminal.output.kind === "process") {
    switch (terminal.output.activityState) {
      case "waiting_for_input":
        return "Waiting for input"
      case "running_command":
      case "working":
        return "Working"
      case "starting":
        return "Starting"
      case "failed":
        return "Failed"
      case "idle":
        break
    }
  }

  switch (terminal.status) {
    case "created":
      return "Created"
    case "starting":
      return "Starting"
    case "running":
      return "Running"
    case "waiting":
      return "Waiting"
    case "succeeded":
      return "Finished"
    case "failed":
      return "Failed"
    case "cancelled":
      return "Cancelled"
    case "disconnected":
      return "Disconnected"
  }
}

const TERMINAL_KIND_META = {
  terminal: { label: "Terminal", Icon: TerminalIcon },
} satisfies Record<
  MobileTerminalKind,
  { readonly label: string; readonly Icon: LucideIcon }
>

function terminalCountLabel(count: number): string {
  return `${count} ${count === 1 ? "terminal" : "terminals"}`
}

export type MobileTerminalViewProps = {
  readonly sessions: readonly AppSession[]
  readonly terminalsById: ReadonlyMap<MuxTerminalId, MuxTerminal>
  readonly terminalIdsBySession: ReadonlyMap<SessionId, readonly MuxTerminalId[]>
  readonly routeMuxTerminalId?: MuxTerminalId
  readonly runtimeTitles: ReadonlyMap<MuxTerminalId, RuntimeTerminalTitle>
  readonly onSelect: (terminal: MuxTerminal) => void
  readonly onShowTerminalList: (terminal: MuxTerminal) => void
  readonly onCreateTerminal: (
    sessionId: SessionId,
    kind: MobileTerminalKind,
  ) => Promise<MuxTerminal | undefined>
  readonly onCreateSession: () => Promise<void>
  readonly onCloseSession: (sessionId: SessionId) => void
  readonly onOpenCommands: () => void
  readonly actionError?: string
  readonly onCloseTerminal: (terminal: MuxTerminal) => Promise<void>
  readonly onRestartTerminal: (terminal: MuxTerminal) => Promise<void>
  /** Render the selected or retained terminal; the argument order matches the desktop renderer. */
  readonly renderTerminal: (
    terminal: MuxTerminal,
    focused: boolean,
    visible: boolean,
  ) => ReactNode
}

type MobileTerminalGroup = {
  readonly session: AppSession
  readonly terminals: readonly MuxTerminal[]
}

export function MobileTerminalView(props: MobileTerminalViewProps) {
  const [selectedMuxTerminalId, setSelectedMuxTerminalId] = useState<MuxTerminalId | null>(
    props.routeMuxTerminalId ?? null,
  )
  const [creating, setCreating] = useState<string | null>(null)
  const [sessionActionsId, setSessionActionsId] = useState<SessionId | null>(null)
  const [retainedTerminalIds, setRetainedTerminalIds] = useState<
    readonly MuxTerminalId[]
  >([])

  const groups = useMemo<readonly MobileTerminalGroup[]>(
    () =>
      props.sessions.map(session => ({
        session,
        terminals: (props.terminalIdsBySession.get(session.id) ?? [])
          .map(id => props.terminalsById.get(id))
          .filter(
            (terminal): terminal is MuxTerminal =>
              terminal != null && isMobileTerminalKind(terminal.kind),
          ),
      })),
    [props.sessions, props.terminalIdsBySession, props.terminalsById],
  )

  const visibleTerminals = useMemo(
    () => new Map(groups.flatMap(group => group.terminals.map(terminal => [terminal.id, terminal]))),
    [groups],
  )

  useEffect(() => {
    const routed = props.routeMuxTerminalId
      ? visibleTerminals.get(props.routeMuxTerminalId)
      : undefined
    setSelectedMuxTerminalId(routed ? routed.id : null)
  }, [props.routeMuxTerminalId, visibleTerminals])

  const selectedTerminal = selectedMuxTerminalId
    ? visibleTerminals.get(selectedMuxTerminalId)
    : undefined

  useEffect(() => {
    if (selectedTerminal?.kind !== "terminal") return
    setRetainedTerminalIds(previous => [
      selectedTerminal.id,
      ...previous.filter(id => id !== selectedTerminal.id),
    ].slice(0, MAX_RETAINED_MOBILE_TERMINALS))
  }, [selectedTerminal?.id, selectedTerminal?.kind])

  const mountedTerminalIds = useMemo(() => {
    const ids = selectedTerminal?.kind === "terminal"
      ? [selectedTerminal.id, ...retainedTerminalIds]
      : [...retainedTerminalIds]
    return [...new Set(ids)].filter(id => {
      const terminal = visibleTerminals.get(id)
      return terminal?.kind === "terminal"
    }).slice(0, MAX_RETAINED_MOBILE_TERMINALS)
  }, [retainedTerminalIds, selectedTerminal, visibleTerminals])

  const openTerminal = (terminal: MuxTerminal) => {
    setSelectedMuxTerminalId(terminal.id)
    props.onSelect(terminal)
  }

  const createTerminal = async (sessionId: SessionId, kind: MobileTerminalKind) => {
    const key = `${sessionId}:${kind}`
    if (creating) return
    setCreating(key)
    try {
      const created = await props.onCreateTerminal(sessionId, kind)
      if (created) openTerminal(created)
    } finally {
      setCreating(null)
    }
  }

  const sessionActions = sessionActionsId
    ? props.sessions.find(session => session.id === sessionActionsId)
    : undefined
  const selectedVisibleTerminal = selectedTerminal?.kind === "terminal" ? selectedTerminal : undefined

  return (
    <div
      className="relative flex h-full min-h-0 flex-col overflow-hidden"
      data-yaade-mobile-shell=""
      data-yaade-mobile-view={selectedVisibleTerminal ? "terminal" : "terminals"}
    >
      <AnimatePresence initial={false} mode="wait">
        {!selectedVisibleTerminal ? (
          <MobileTerminalList
            key="terminal-list"
            groups={groups}
            runtimeTitles={props.runtimeTitles}
            creating={creating}
            actionError={props.actionError}
            onCreateTerminal={(sessionId, kind) => void createTerminal(sessionId, kind)}
            onCreateSession={() => void props.onCreateSession()}
            onOpenCommands={props.onOpenCommands}
            onOpenSessionActions={session => setSessionActionsId(session.id)}
            onSelect={openTerminal}
          />
        ) : (
          <MobileTerminalDetail
            key={`terminal:${selectedVisibleTerminal.id}`}
            terminal={selectedVisibleTerminal}
            runtimeTitle={props.runtimeTitles.get(selectedVisibleTerminal.id)}
            onBack={() => {
              setSelectedMuxTerminalId(null)
              props.onShowTerminalList(selectedVisibleTerminal)
            }}
            onOpenCommands={props.onOpenCommands}
            onClose={async () => {
              await props.onCloseTerminal(selectedVisibleTerminal)
              setSelectedMuxTerminalId(null)
            }}
          >
            {props.renderTerminal(selectedVisibleTerminal, true, true)}
          </MobileTerminalDetail>
        )}
      </AnimatePresence>

      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 top-[var(--yaade-touch-target)] bottom-[calc(var(--yaade-touch-target)+env(safe-area-inset-bottom))] min-h-0 overflow-hidden",
          selectedVisibleTerminal
            ? "visible"
            : "pointer-events-none invisible",
        )}
        aria-hidden={selectedVisibleTerminal ? undefined : true}
        data-yaade-mobile-terminal-surfaces=""
      >
        {mountedTerminalIds
          .filter(id => id !== selectedVisibleTerminal?.id)
          .map(id => {
            const terminal = visibleTerminals.get(id)
            if (!terminal || terminal.kind !== "terminal") return null
            return (
              <div
                key={terminal.id}
                className="pointer-events-none invisible absolute inset-0 min-h-0 overflow-hidden"
                aria-hidden
                inert
                data-yaade-mobile-retained-terminal={terminal.id}
                data-active="false"
              >
                {props.renderTerminal(terminal, false, false)}
              </div>
            )
          })}
      </div>

      {selectedVisibleTerminal?.output.processState === "interrupted" ? (
        <MobileInterruptedActions
          onRestart={() => props.onRestartTerminal(selectedVisibleTerminal)}
          onClose={() => props.onCloseTerminal(selectedVisibleTerminal)}
        />
      ) : selectedVisibleTerminal ? (
        <MobileTerminalAccessory terminal={selectedVisibleTerminal} />
      ) : null}

      <Drawer
        open={sessionActions != null}
        onOpenChange={open => {
          if (!open) setSessionActionsId(null)
        }}
      >
        <DrawerContent data-yaade-mobile-session-actions="">
          <DrawerHeader className="text-left">
            <DrawerTitle>{sessionActions?.title ?? "Session"}</DrawerTitle>
            <DrawerDescription>Session actions</DrawerDescription>
          </DrawerHeader>
          <div className="flex flex-col gap-2 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <Button
              type="button"
              variant="destructive"
              className="min-h-11 w-full"
              onClick={() => {
                if (!sessionActions) return
                setSessionActionsId(null)
                props.onCloseSession(sessionActions.id)
              }}
            >
              <X data-icon="inline-start" />
              Close session
            </Button>
            <DrawerClose asChild>
              <Button type="button" variant="outline" className="min-h-11 w-full">
                Cancel
              </Button>
            </DrawerClose>
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  )
}

function MobileTerminalList(props: {
  readonly groups: readonly MobileTerminalGroup[]
  readonly runtimeTitles: ReadonlyMap<MuxTerminalId, RuntimeTerminalTitle>
  readonly creating: string | null
  readonly actionError?: string
  readonly onCreateTerminal: (sessionId: SessionId, kind: MobileTerminalKind) => void
  readonly onCreateSession: () => void
  readonly onOpenCommands: () => void
  readonly onOpenSessionActions: (session: AppSession) => void
  readonly onSelect: (terminal: MuxTerminal) => void
}) {
  return (
    <MotionDiv
      initial={{ opacity: 0, transform: "translateX(-10px)" }}
      animate={{ opacity: 1, transform: "translateX(0px)" }}
      exit={{ opacity: 0, transform: "translateX(-10px)" }}
      transition={yaadeMotion.layoutTransition}
      className="flex min-h-0 flex-1 flex-col"
      data-yaade-mobile-terminal-list=""
    >
      <GlassSurface material="shell" asChild>
        <header className="flex h-[var(--yaade-touch-target)] shrink-0 items-center gap-1 border-b border-border/70 px-2">
          <p className="min-w-0 flex-1 truncate text-sm font-medium">Sessions</p>
          <Button
            type="button"
            size="icon-lg"
            variant="ghost"
            aria-label="Commands"
            title="Commands"
            onClick={props.onOpenCommands}
            data-yaade-command-palette-trigger="mobile-list"
          >
            <ListFilter />
          </Button>
        </header>
      </GlassSurface>
      {props.actionError ? (
        <div className="shrink-0 px-3 pt-3">
          <Alert variant="destructive">
            <AlertTitle>Action failed</AlertTitle>
            <AlertDescription>{props.actionError}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3 touch-pan-y">
        <div className="flex flex-col gap-4" role="list" aria-label="Terminals by session">
          {props.groups.map(group => (
            <MobileSessionGroup
              key={group.session.id}
              group={group}
              runtimeTitles={props.runtimeTitles}
              creating={props.creating}
              onCreateTerminal={props.onCreateTerminal}
              onOpenActions={() => props.onOpenSessionActions(group.session)}
              onSelect={props.onSelect}
            />
          ))}
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full border-dashed"
            onClick={props.onCreateSession}
            data-yaade-mobile-new-session=""
          >
            <Plus data-icon="inline-start" />
            New session
          </Button>
        </div>
      </main>
    </MotionDiv>
  )
}

function MobileSessionGroup(props: {
  readonly group: MobileTerminalGroup
  readonly runtimeTitles: ReadonlyMap<MuxTerminalId, RuntimeTerminalTitle>
  readonly creating: string | null
  readonly onCreateTerminal: (sessionId: SessionId, kind: MobileTerminalKind) => void
  readonly onOpenActions: () => void
  readonly onSelect: (terminal: MuxTerminal) => void
}) {
  const holdTimer = useRef<number | null>(null)
  const holdStart = useRef<{ x: number; y: number } | null>(null)

  const clearHold = () => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current)
    holdTimer.current = null
    holdStart.current = null
  }
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType !== "touch") return
    if (event.target instanceof HTMLElement && event.target.closest("button")) return
    holdStart.current = { x: event.clientX, y: event.clientY }
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null
      navigator.vibrate?.(8)
      props.onOpenActions()
    }, 500)
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const start = holdStart.current
    if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) < 8) return
    clearHold()
  }

  return (
    <section
      className="flex flex-col gap-1.5"
      role="listitem"
      data-yaade-mobile-session-group={props.group.session.id}
      aria-labelledby={`mobile-session-${props.group.session.id}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={clearHold}
      onPointerCancel={clearHold}
      onContextMenu={event => {
        event.preventDefault()
        props.onOpenActions()
      }}
    >
      <div className="flex min-h-11 items-center gap-2 px-1">
        <div className="min-w-0 flex-1">
          <h2
            id={`mobile-session-${props.group.session.id}`}
            className="truncate text-xs font-semibold"
          >
            {props.group.session.title}
          </h2>
          <p className="font-mono text-3xs tabular-nums text-muted-foreground">
            {terminalCountLabel(props.group.terminals.length)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <MobileNewTerminalMenu
            sessionId={props.group.session.id}
            creating={props.creating}
            onCreateTerminal={props.onCreateTerminal}
          />
          <Button
            type="button"
            size="icon-lg"
            variant="ghost"
            aria-label={`Session actions for ${props.group.session.title}`}
            title={`Session actions for ${props.group.session.title}`}
            data-yaade-mobile-session-actions={props.group.session.id}
            onClick={props.onOpenActions}
          >
            <MoreHorizontal />
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-1.5" role="group">
        {props.group.terminals.length > 0 ? (
          <AnimatePresence initial={false} mode="popLayout">
            {props.group.terminals.map(terminal => (
              <MobileTerminalRow
                key={terminal.id}
                terminal={terminal}
                runtimeTitle={props.runtimeTitles.get(terminal.id)}
                onSelect={() => props.onSelect(terminal)}
              />
            ))}
          </AnimatePresence>
        ) : (
          <div
            className="flex min-h-12 items-center justify-between gap-2 rounded-[var(--yaade-control-radius)] border border-dashed border-border/70 px-3"
            data-yaade-mobile-session-empty=""
          >
            <span className="text-xs text-muted-foreground">No terminals yet</span>
            <MobileNewTerminalMenu
              sessionId={props.group.session.id}
              creating={props.creating}
              onCreateTerminal={props.onCreateTerminal}
              labelled
            />
          </div>
        )}
      </div>
    </section>
  )
}

function MobileNewTerminalMenu(props: {
  readonly sessionId: SessionId
  readonly creating: string | null
  readonly onCreateTerminal: (sessionId: SessionId, kind: MobileTerminalKind) => void
  readonly labelled?: boolean
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size={props.labelled ? "sm" : "icon-lg"}
          variant="ghost"
          aria-label={`New terminal in session`}
          disabled={props.creating != null}
          data-yaade-mobile-new-terminal={props.sessionId}
        >
          <Plus data-icon={props.labelled ? "inline-start" : undefined} />
          {props.labelled ? "New terminal" : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>New terminal</DropdownMenuLabel>
        <DropdownMenuGroup>
          {MOBILE_TERMINAL_KINDS.map(kind => {
            const { Icon, label } = TERMINAL_KIND_META[kind]
            return (
              <DropdownMenuItem
                key={kind}
                className="min-h-11"
                data-yaade-mobile-new-terminal-kind={kind}
                onSelect={() => props.onCreateTerminal(props.sessionId, kind)}
              >
                <Icon />
                {label}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function MobileTerminalRow(props: {
  readonly terminal: MuxTerminal
  readonly runtimeTitle?: RuntimeTerminalTitle
  readonly onSelect: () => void
}) {
  if (!isMobileTerminalKind(props.terminal.kind)) return null
  const { Icon, label } = TERMINAL_KIND_META[props.terminal.kind]
  const title = muxTerminalWorkTitle(props.terminal, props.runtimeTitle)
  const status = statusLabel(props.terminal)

  return (
    <MotionDiv
      layout
      initial={{ opacity: 0, transform: "translateY(5px)" }}
      animate={{ opacity: 1, transform: "translateY(0px)" }}
      exit={{ opacity: 0, transform: "translateY(-5px)" }}
      transition={yaadeMotion.layoutTransition}
    >
      <GlassSurface material="chrome" interactive asChild>
        <button
          type="button"
          className="group flex min-h-14 w-full items-center gap-2.5 px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          aria-label={`Open ${label}: ${title}. Status: ${status}`}
          data-yaade-mobile-terminal={props.terminal.id}
          data-terminal-kind={props.terminal.kind}
          onClick={props.onSelect}
        >
        <span
          className="grid size-9 shrink-0 place-items-center rounded-[var(--yaade-control-radius)] border border-border bg-secondary text-muted-foreground"
          aria-hidden
        >
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{title}</span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
            <span className="shrink-0">{label}</span>
            <span aria-hidden>·</span>
            <span className="truncate">{status}</span>
          </span>
        </span>
        <span
          className={cn("size-2 shrink-0 rounded-full", statusClass(props.terminal))}
          aria-hidden
          title={status}
        />
        <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />
        </button>
      </GlassSurface>
    </MotionDiv>
  )
}

function MobileTerminalDetail(props: {
  readonly terminal: MuxTerminal
  readonly runtimeTitle?: RuntimeTerminalTitle
  readonly onBack: () => void
  readonly onOpenCommands: () => void
  readonly onClose: () => Promise<void>
  readonly children: ReactNode
}) {
  const title = muxTerminalWorkTitle(props.terminal, props.runtimeTitle)
  const status = statusLabel(props.terminal)

  return (
    <MotionDiv
      initial={{ opacity: 0, transform: "translateX(12px)" }}
      animate={{ opacity: 1, transform: "translateX(0px)" }}
      exit={{ opacity: 0, transform: "translateX(12px)" }}
      transition={yaadeMotion.layoutTransition}
      className="flex min-h-0 flex-1 flex-col"
      data-yaade-mobile-terminal-detail=""
    >
      <GlassSurface material="shell" asChild>
        <header className="flex h-[var(--yaade-touch-target)] shrink-0 items-center gap-1 border-b border-border/70 px-1">
          <Button
            type="button"
            size="icon-lg"
            variant="ghost"
            aria-label="Back to terminals"
            onClick={props.onBack}
            data-yaade-mobile-terminal-back=""
          >
            <ArrowLeft />
          </Button>
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{title}</p>
          <span className="sr-only" role="status">
            {status}
          </span>
          <span
            className={cn("size-2 shrink-0 rounded-full", statusClass(props.terminal))}
            aria-hidden
            title={status}
          />
          <Button
            type="button"
            size="icon-lg"
            variant="ghost"
            aria-label="Commands"
            title="Commands"
            onClick={props.onOpenCommands}
            data-yaade-command-palette-trigger="mobile-terminal"
          >
            <ListFilter />
          </Button>
          <Button
            type="button"
            size="icon-lg"
            variant="ghost"
            aria-label="Close terminal"
            onClick={() => void props.onClose()}
            data-yaade-mobile-terminal-close=""
          >
            <X />
          </Button>
        </header>
      </GlassSurface>
      <main
        className="min-h-0 flex-1 overflow-hidden"
        data-yaade-mobile-terminal-surface=""
      >
        {props.children}
      </main>
    </MotionDiv>
  )
}

function MobileInterruptedActions(props: {
  readonly onRestart: () => Promise<void>
  readonly onClose: () => Promise<void>
}) {
  return (
    <GlassSurface material="shell" asChild>
      <div
        className="absolute inset-x-0 bottom-0 z-10 flex min-h-[calc(var(--yaade-touch-target)+env(safe-area-inset-bottom))] flex-wrap items-center justify-center gap-2 border-t border-border/70 px-2 pb-[env(safe-area-inset-bottom)]"
        data-yaade-mobile-interrupted-actions=""
        role="group"
        aria-label="Interrupted terminal actions"
      >
        <span className="min-w-0 flex-1 text-xs text-muted-foreground">
          The previous process ended. Restart opens a new shell.
        </span>
        <Button type="button" size="sm" onClick={() => void props.onRestart()}>
          <RotateCcw />
          Restart terminal
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => void props.onClose()}>
          <X />
          Close
        </Button>
      </div>
    </GlassSurface>
  )
}

function MobileTerminalAccessory(props: { readonly terminal: MuxTerminal }) {
  const [ctrl, setCtrl] = useState(false)
  const [alt, setAlt] = useState(false)

  useEffect(() => {
    setCtrl(false)
    setAlt(false)
    setTerminalVirtualModifier("ctrl", false, props.terminal.id)
    setTerminalVirtualModifier("alt", false, props.terminal.id)
  }, [props.terminal.id])

  useEffect(() => {
    if (!ctrl && !alt) return
    const consume = (event: Event) => {
      if (!(event.target instanceof HTMLElement)) return
      if (!event.target.matches("[data-ghostty-terminal-input]")) return
      queueMicrotask(() => {
        setCtrl(false)
        setAlt(false)
        setTerminalVirtualModifier("ctrl", false, props.terminal.id)
        setTerminalVirtualModifier("alt", false, props.terminal.id)
      })
    }
    window.addEventListener("keydown", consume, true)
    window.addEventListener("input", consume, true)
    return () => {
      window.removeEventListener("keydown", consume, true)
      window.removeEventListener("input", consume, true)
    }
  }, [alt, ctrl, props.terminal.id])

  const toggleModifier = (modifier: "ctrl" | "alt") => {
    if (modifier === "ctrl") {
      const next = !ctrl
      setCtrl(next)
      setTerminalVirtualModifier("ctrl", next, props.terminal.id)
      return
    }
    const next = !alt
    setAlt(next)
    setTerminalVirtualModifier("alt", next, props.terminal.id)
  }
  const sendKey = (key: string, code: string) => {
    sendTerminalVirtualKey(key, code, props.terminal.id)
    setCtrl(false)
    setAlt(false)
  }

  return (
    <GlassSurface material="shell" asChild>
      <nav
        className="absolute inset-x-0 bottom-0 z-10 flex h-[calc(var(--yaade-touch-target)+env(safe-area-inset-bottom))] items-start gap-1 overflow-x-auto border-t border-border/70 px-1 pb-[env(safe-area-inset-bottom)]"
        aria-label="Terminal keys"
        data-yaade-mobile-terminal-keys=""
      >
        <Button type="button" size="sm" variant="ghost" className="min-w-11" onClick={() => sendKey("Escape", "Escape")}>
          Esc
        </Button>
        <Button type="button" size="sm" variant="ghost" className="min-w-11" onClick={() => sendKey("Tab", "Tab")}>
          Tab
        </Button>
        <Button
          type="button"
          size="sm"
          variant={ctrl ? "secondary" : "ghost"}
          className="min-w-11"
          aria-pressed={ctrl}
          onClick={() => toggleModifier("ctrl")}
        >
          Ctrl
        </Button>
        <Button
          type="button"
          size="sm"
          variant={alt ? "secondary" : "ghost"}
          className="min-w-11"
          aria-pressed={alt}
          onClick={() => toggleModifier("alt")}
        >
          Alt
        </Button>
        <Button type="button" size="icon-lg" variant="ghost" aria-label="Arrow left" onClick={() => sendKey("ArrowLeft", "ArrowLeft")}>
          <ArrowLeft />
        </Button>
        <Button type="button" size="icon-lg" variant="ghost" aria-label="Arrow down" onClick={() => sendKey("ArrowDown", "ArrowDown")}>
          <ArrowDown />
        </Button>
        <Button type="button" size="icon-lg" variant="ghost" aria-label="Arrow up" onClick={() => sendKey("ArrowUp", "ArrowUp")}>
          <ArrowUp />
        </Button>
        <Button type="button" size="icon-lg" variant="ghost" aria-label="Arrow right" onClick={() => sendKey("ArrowRight", "ArrowRight")}>
          <ArrowRight />
        </Button>
        <Button
          type="button"
          size="icon-lg"
          variant="ghost"
          aria-label="Paste"
          onClick={() => void pasteIntoRegisteredTerminal(props.terminal.id).catch(() => undefined)}
        >
          <Clipboard />
        </Button>
      </nav>
    </GlassSurface>
  )
}
