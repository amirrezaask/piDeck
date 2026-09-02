import { Suspense, lazy, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence } from "motion/react";
import { div as MotionDiv } from "motion/react-m";
import { Plus, Terminal, X } from "lucide-react";
import type { MuxTerminal, MuxTerminalId, SessionId, TerminalKind } from "@yaade/rpc";
import { Button, Input } from "@yaade/ui/primitives";
import { cn, yaadeMotion } from "@yaade/ui/session";
import { muxTerminalWorkTitle, type RuntimeTerminalTitle } from "./terminal-title.js";

const TerminalDockSourceHandle = lazy(() => import("./TerminalDockSourceHandle.js"));

export type MuxTerminalNavigationLayout = "tabs" | "two-sidebars" | "single-sidebar";

export type TerminalTabStripProps = {
  readonly terminalIds: readonly MuxTerminalId[];
  readonly terminalsById: ReadonlyMap<MuxTerminalId, MuxTerminal>;
  readonly activeMuxTerminalId?: MuxTerminalId;
  readonly openMuxTerminalIds?: ReadonlySet<MuxTerminalId>;
  readonly runtimeTitles: ReadonlyMap<MuxTerminalId, RuntimeTerminalTitle>;
  readonly onSelect: (terminal: MuxTerminal) => void;
  readonly onAddKind: (kind: TerminalKind) => void;
  readonly onClose: (terminal: MuxTerminal) => void;
  readonly onRename: (terminal: MuxTerminal, title: string) => void;
  readonly onReorder: (ids: readonly MuxTerminalId[]) => void;
  readonly onToggleSidebar?: () => void;
  readonly sectionLabel?: string;
  readonly emptyLabel?: string;
  readonly sessionTitlesById?: ReadonlyMap<SessionId, string>;
  readonly dockable?: boolean;
  readonly dockableTerminalIds?: ReadonlySet<MuxTerminalId>;
  readonly layout?: MuxTerminalNavigationLayout;
  readonly collapsed?: boolean;
  readonly sidebarOrientation?: "horizontal" | "vertical";
};

function handleKeyDown(event: KeyboardEvent<HTMLElement>, activate: (index: number) => void): void {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
    return;
  }
  const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
  if (tabs.length === 0) return;
  const current = Math.max(
    0,
    tabs.findIndex((tab) => tab === document.activeElement),
  );
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (current +
            (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) +
            tabs.length) %
          tabs.length;
  event.preventDefault();
  tabs[next]?.focus();
  activate(next);
}

function terminalStatus(terminal: MuxTerminal): string {
  if (terminal.output.kind === "process") {
    switch (terminal.output.activityState) {
      case "waiting_for_input":
        return "Waiting for input";
      case "running_command":
      case "working":
        return "Working";
      case "starting":
        return "Starting";
      case "failed":
        return "Failed";
      case "idle":
        break;
    }
  }

  switch (terminal.status) {
    case "created":
      return "Created";
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "waiting":
      return "Waiting";
    case "succeeded":
      return "Finished";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "disconnected":
      return "Disconnected";
  }
}

function terminalStatusClass(terminal: MuxTerminal): string {
  switch (terminal.status) {
    case "waiting":
      return "bg-warning";
    case "created":
    case "starting":
      return "bg-info";
    case "failed":
    case "cancelled":
      return "bg-destructive";
    case "disconnected":
      return "bg-muted-foreground";
    case "running":
    case "succeeded":
      return "bg-success";
  }
}

export function TerminalTabStrip(props: TerminalTabStripProps) {
  const [editingId, setEditingId] = useState<MuxTerminalId | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const dragId = useRef<MuxTerminalId | null>(null);
  const vertical = props.layout !== "tabs";
  const showSectionHeader = Boolean(props.sectionLabel && vertical && !props.collapsed);

  const finishRename = (terminal: MuxTerminal) => {
    const title = draftTitle.trim();
    setEditingId(null);
    if (title && title !== terminal.title) props.onRename(terminal, title);
  };

  const newTerminalButton = (
    <Button
      type="button"
      size="icon-xs"
      variant={showSectionHeader ? "ghost" : "secondary"}
      aria-label="New terminal"
      title="New terminal"
      data-yaade-new-terminal=""
      onClick={() => props.onAddKind("terminal")}
    >
      <Plus />
    </Button>
  );

  return (
    <aside
      className={cn(
        "flex min-h-0",
        vertical ? "h-full flex-col" : "h-full min-w-0 flex-row items-center",
      )}
      data-yaade-terminal-tabs=""
      data-yaade-terminal-tabs-layout={props.layout ?? "tabs"}
    >
      {showSectionHeader ? (
        <div className="flex min-h-10 shrink-0 items-center gap-2 border-b border-sidebar-border/70 px-3">
          <span className="text-2xs font-semibold tracking-wide text-sidebar-foreground">
            {props.sectionLabel}
          </span>
          <span className="font-mono text-3xs tabular-nums text-sidebar-foreground/50">
            {props.terminalIds.length}
          </span>
          <span className="ml-auto">{newTerminalButton}</span>
        </div>
      ) : null}
      <nav
        className={cn(
          "flex min-h-0 min-w-0 gap-1.5",
          vertical ? "flex-1 flex-col overflow-y-auto p-2" : "flex-1 items-center overflow-x-auto",
        )}
        aria-label={props.sectionLabel ?? "Terminals"}
        role="tablist"
        aria-orientation={vertical ? "vertical" : "horizontal"}
        onKeyDown={(event) =>
          handleKeyDown(event, (index) => {
            const id = props.terminalIds[index];
            const terminal = id ? props.terminalsById.get(id) : undefined;
            if (terminal) props.onSelect(terminal);
          })
        }
      >
        <AnimatePresence initial={false}>
          {props.terminalIds.map((id, index) => {
            const terminal = props.terminalsById.get(id);
            if (!terminal) return null;
            const active = id === props.activeMuxTerminalId;
            const open = props.openMuxTerminalIds?.has(id) ?? false;
            const dockable =
              props.dockable === true && (props.dockableTerminalIds?.has(id) ?? true);
            const title = muxTerminalWorkTitle(terminal, props.runtimeTitles.get(id));
            const status = terminalStatus(terminal);
            return (
              <MotionDiv
                key={id}
                layout
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={yaadeMotion.layoutTransition}
                draggable={!dockable && editingId !== id}
                onDragStart={() => {
                  if (!dockable) dragId.current = id;
                }}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => {
                  const source = dragId.current;
                  dragId.current = null;
                  if (!source || source === id) return;
                  const next = [...props.terminalIds];
                  const from = next.indexOf(source);
                  if (from < 0) return;
                  next.splice(from, 1);
                  next.splice(index, 0, source);
                  props.onReorder(next);
                }}
                className={cn(
                  "group relative flex min-w-0 items-center rounded-[var(--yaade-control-radius)] border border-transparent",
                  active && "border-border/70 bg-accent text-accent-foreground",
                  open && !active && "bg-secondary/35",
                )}
                data-active={active ? "true" : undefined}
                data-open={open ? "true" : undefined}
                data-yaade-terminal={id}
              >
                <span
                  className="absolute inset-y-2 left-0 w-0.5 origin-center scale-y-0 rounded-full bg-primary transition-transform duration-[var(--yaade-motion-menu)] ease-[var(--yaade-ease-out)] group-data-[active=true]:scale-y-100"
                  aria-hidden
                />
                {editingId === id ? (
                  <Input
                    value={draftTitle}
                    onChange={(event) => setDraftTitle(event.target.value)}
                    onBlur={() => finishRename(terminal)}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") finishRename(terminal);
                      if (event.key === "Escape") setEditingId(null);
                    }}
                    autoFocus
                    aria-label={`Rename ${title}`}
                    className="h-8 min-w-24"
                  />
                ) : (
                  <button
                    type="button"
                    role="tab"
                    tabIndex={active ? 0 : -1}
                    aria-selected={active}
                    aria-label={`${title}, ${status}`}
                    title={`${title} — ${status}`}
                    className="flex min-h-10 min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                    onClick={() => props.onSelect(terminal)}
                    onDoubleClick={() => {
                      setDraftTitle(terminal.title);
                      setEditingId(id);
                    }}
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <Terminal className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      {!props.collapsed ? (
                        <span className="min-w-0 flex-1 truncate">{title}</span>
                      ) : null}
                    </span>
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        terminalStatusClass(terminal),
                      )}
                      aria-hidden
                    />
                    {!props.collapsed ? (
                      <span className="hidden shrink-0 text-3xs text-muted-foreground/70 xl:inline">
                        {status}
                      </span>
                    ) : null}
                  </button>
                )}
                {dockable && editingId !== id ? (
                  <Suspense fallback={null}>
                    <TerminalDockSourceHandle
                      tabId={id}
                      label={title}
                      className={cn("max-md:opacity-70", props.collapsed && "opacity-70")}
                    />
                  </Suspense>
                ) : null}
                {!props.collapsed ? (
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Close ${title}`}
                    title={`Close ${title}`}
                    className="mr-0.5 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                    onClick={() => props.onClose(terminal)}
                  >
                    <X />
                  </Button>
                ) : null}
              </MotionDiv>
            );
          })}
        </AnimatePresence>
        {props.terminalIds.length === 0 && !props.collapsed ? (
          <div className="flex min-h-20 flex-col items-center justify-center gap-1 rounded-[var(--yaade-control-radius)] border border-dashed border-sidebar-border/70 px-3 text-center">
            <Terminal className="size-4 text-sidebar-foreground/45" aria-hidden />
            <p className="text-xs text-sidebar-foreground/65">
              {props.emptyLabel ?? "No terminals yet"}
            </p>
            <p className="text-3xs text-sidebar-foreground/45">Create one to start working.</p>
          </div>
        ) : null}
      </nav>
      {!showSectionHeader ? (
        <div
          className={cn(
            vertical ? "shrink-0 border-t border-sidebar-border/70 p-2" : "shrink-0 px-1",
          )}
        >
          {newTerminalButton}
        </div>
      ) : null}
    </aside>
  );
}
