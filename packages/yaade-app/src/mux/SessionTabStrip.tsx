import { useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence } from "motion/react";
import { div as MotionDiv } from "motion/react-m";
import { ListFilter, Plus, Settings, X } from "lucide-react";
import type { AppSession, SessionId } from "@yaade/rpc";
import { SidebarShell, cn, yaadeMotion } from "@yaade/ui/session";
import { Button, Input } from "@yaade/ui/primitives";
import { ShortcutTooltip } from "./ShortcutTooltip.js";
import {
  muxSessionDirectShortcutFor,
  muxSessionShortcutFor,
} from "./mux-keymap.js";

function handleSessionTabKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (
    !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(
      event.key,
    )
  ) {
    return;
  }
  const tabs = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'),
  ];
  if (tabs.length === 0) return;
  const current = Math.max(
    0,
    tabs.findIndex(tab => tab === document.activeElement),
  );
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (current +
            (event.key === "ArrowRight" || event.key === "ArrowDown"
              ? 1
              : -1) +
            tabs.length) %
          tabs.length;
  event.preventDefault();
  tabs[next]?.focus();
  tabs[next]?.click();
}

export type SessionNavigationLayout =
  | "tabs"
  | "two-sidebars"
  | "single-sidebar";

export type SessionTabStripProps = {
  readonly sessions: readonly AppSession[];
  readonly activeSessionId?: SessionId;
  readonly onSelect: (id: SessionId) => void;
  readonly onClose: (id: SessionId) => void;
  readonly onOpenSettings: () => void;
  readonly onOpenCommands: () => void;
  readonly onCreate: () => void;
  readonly onRename: (id: SessionId, title: string) => void;
  readonly onReorder: (ids: readonly SessionId[]) => void;
  readonly serverNamesBySessionId?: ReadonlyMap<SessionId, string>;
  readonly terminalCounts?: ReadonlyMap<SessionId, number>;
  readonly layout?: SessionNavigationLayout;
  readonly collapsed?: boolean;
  readonly sidebarOrientation?: "horizontal" | "vertical";
};

export function SessionTabStrip(props: SessionTabStripProps) {
  const dragId = useRef<SessionId | null>(null);
  const [editingId, setEditingId] = useState<SessionId | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const layout = props.layout ?? "tabs";
  const settingsChord = muxSessionDirectShortcutFor("settings.show");
  const commandsChord = muxSessionShortcutFor("commandPalette.show");
  const newSessionChord = muxSessionShortcutFor("session.new");

  const finishRename = (session: AppSession) => {
    const next = draftTitle.trim();
    setEditingId(null);
    if (next && next !== session.title) props.onRename(session.id, next);
  };

  const moveSession = (sessionId: SessionId, index: number) => {
    const from = dragId.current;
    dragId.current = null;
    if (!from || from === sessionId) return;
    const ids = props.sessions.map((item) => item.id);
    const fromIndex = ids.indexOf(from);
    if (fromIndex < 0) return;
    ids.splice(fromIndex, 1);
    ids.splice(index, 0, from);
    props.onReorder(ids);
  };

  const sidebarActions = (
    <div
      className="flex h-full w-full shrink-0 items-center justify-end gap-1"
      role="toolbar"
      aria-label="Session actions"
    >
      <ShortcutTooltip label="Commands" shortcut={commandsChord} side="right">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Commands"
          onClick={props.onOpenCommands}
          data-yaade-command-palette-trigger="session-sidebar"
        >
          <ListFilter />
        </Button>
      </ShortcutTooltip>
      <ShortcutTooltip label="Settings" shortcut={settingsChord} side="right">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Open settings"
          onClick={props.onOpenSettings}
          data-yaade-session-settings=""
        >
          <Settings />
        </Button>
      </ShortcutTooltip>
      <ShortcutTooltip
        label="New session"
        shortcut={newSessionChord}
        side="right"
      >
        <Button
          size="icon-xs"
          variant="secondary"
          aria-label="New session"
          data-yaade-new-session=""
          onClick={props.onCreate}
        >
          <Plus />
        </Button>
      </ShortcutTooltip>
    </div>
  );

  const sessionItems = props.sessions.map((session, index) => {
    const active = session.id === props.activeSessionId;
    const editing = editingId === session.id;
    const serverName = props.serverNamesBySessionId?.get(session.id);
    const terminalCount = props.terminalCounts?.get(session.id) ?? 0;
    return (
      <MotionDiv
        key={session.id}
        layout
        initial={{ opacity: 0, scale: 0.97, y: 4 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: -4 }}
        transition={{
          layout: yaadeMotion.layoutTransition,
          default: yaadeMotion.layoutTransition,
        }}
        role="presentation"
        data-active={active ? "true" : undefined}
        draggable={!editing}
        onDragStart={() => {
          dragId.current = session.id;
        }}
        onDragOver={event => event.preventDefault()}
        onDrop={() => moveSession(session.id, index)}
        className="group relative flex min-h-11 w-full shrink-0 items-center rounded-md border border-transparent px-1 outline-none transition-[color,background-color,border-color] duration-[var(--yaade-motion-hot)] hover:bg-sidebar-accent/70 data-[active=true]:border-sidebar-border data-[active=true]:bg-sidebar-accent max-md:h-full max-md:min-h-0 max-md:w-36"
      >
        <span
          className="absolute inset-y-2 left-0 w-0.5 origin-center scale-y-0 rounded-full bg-sidebar-primary transition-transform duration-[var(--yaade-motion-menu)] ease-[var(--yaade-ease-out)] group-data-[active=true]:scale-y-100"
          aria-hidden
        />
        {editing ? (
          <Input
            aria-label={`Rename ${session.title}`}
            className="h-7 min-w-0 flex-1 border-sidebar-primary/50 bg-sidebar px-1.5"
            autoFocus
            value={draftTitle}
            onClick={event => event.stopPropagation()}
            onChange={event => setDraftTitle(event.target.value)}
            onBlur={() => finishRename(session)}
            onKeyDown={event => {
              event.stopPropagation();
              if (event.key === "Enter") finishRename(session);
              if (event.key === "Escape") setEditingId(null);
            }}
          />
        ) : (
          <button
            type="button"
            role="tab"
            tabIndex={active ? 0 : -1}
            aria-selected={active}
            aria-label={session.title}
            data-yaade-session={session.id}
            data-active={active ? "true" : undefined}
            onClick={() => props.onSelect(session.id)}
            onDoubleClick={() => {
              setDraftTitle(session.title);
              setEditingId(session.id);
            }}
            onKeyDown={event => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                props.onSelect(session.id);
              }
            }}
            className="flex min-h-10 min-w-0 flex-1 items-center gap-2 overflow-hidden px-1.5 text-left text-xs font-medium text-sidebar-foreground/70 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring/50 group-data-[active=true]:text-sidebar-accent-foreground"
          >
            <span className="flex min-w-0 flex-1 flex-col justify-center">
              <span className="truncate">{session.title}</span>
              {serverName ? (
                <span className="truncate text-3xs text-sidebar-foreground/50">
                  {serverName}
                </span>
              ) : null}
            </span>
            {terminalCount > 0 ? (
              <span
                className="shrink-0 rounded-full bg-sidebar-accent/80 px-1.5 py-0.5 font-mono text-3xs tabular-nums text-sidebar-foreground/65"
                aria-label={`${terminalCount} terminal${terminalCount === 1 ? "" : "s"}`}
              >
                {terminalCount}
              </span>
            ) : null}
          </button>
        )}
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Close ${session.title}`}
          title={`Close ${session.title}`}
          className="ml-0.5 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 group-data-[active=true]:opacity-70"
          onClick={event => {
            event.stopPropagation();
            props.onClose(session.id);
          }}
          onKeyDown={event => event.stopPropagation()}
        >
          <X />
        </Button>
      </MotionDiv>
    );
  });

  const animatedSessionItems = (
    <AnimatePresence initial={false} mode="popLayout">
      {sessionItems}
    </AnimatePresence>
  );

  if (layout === "two-sidebars") {
    return (
      <MotionDiv
        initial={false}
        animate={{ opacity: props.collapsed ? 0 : 1, x: props.collapsed ? -12 : 0 }}
        transition={yaadeMotion.sidebarTransition}
        className={cn(
          "h-full min-w-0 overflow-hidden",
          props.collapsed && "pointer-events-none max-md:hidden",
        )}
        aria-hidden={props.collapsed || undefined}
        inert={props.collapsed || undefined}
      >
      <SidebarShell
        aria-label="Sessions"
        contentAs="nav"
        contentProps={{
          "aria-label": "Sessions",
          "aria-orientation": props.sidebarOrientation ?? "vertical",
          role: "tablist",
          onKeyDown: handleSessionTabKeyDown,
        }}
        contentClassName="flex flex-col gap-1 p-2 max-md:flex-row max-md:gap-1 max-md:overflow-x-auto max-md:overflow-y-hidden max-md:p-1"
        footerClassName="border-sidebar-border p-2 max-md:h-full max-md:w-auto max-md:border-t-0 max-md:border-l max-md:p-1"
        headerClassName="border-sidebar-border/70 px-3 py-2"
        className={cn(
          "w-full border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
          !props.collapsed &&
            "max-md:h-10 max-md:w-full max-md:flex-row max-md:border-r-0 max-md:border-b",
        )}
        dataAttributes={{
          "data-yaade-session-sidebar": "",
          "data-yaade-sidebar-state": props.collapsed
            ? "collapsed"
            : "expanded",
          // Keep the navigation hook stable for existing integrations.
          "data-yaade-session-tabs": "",
        }}
        footer={sidebarActions}
        header={
          <div className="flex min-w-0 items-center justify-between gap-3">
            <span className="text-2xs font-semibold tracking-wide text-sidebar-foreground">
              Sessions
            </span>
            <span className="font-mono text-3xs tabular-nums text-sidebar-foreground/50">
              {props.sessions.length}
            </span>
          </div>
        }
      >
        {animatedSessionItems}
      </SidebarShell>
      </MotionDiv>
    );
  }

  if (layout === "single-sidebar") {
    return (
      <section
        className={cn(
          "flex min-h-0 flex-[2_1_0%] flex-col bg-sidebar text-sidebar-foreground",
          props.collapsed && "hidden",
          "max-md:h-10 max-md:flex-none max-md:flex-row",
        )}
        aria-label="Sessions"
        data-yaade-session-sidebar=""
        data-yaade-sidebar-state={props.collapsed ? "collapsed" : "expanded"}
        data-yaade-session-tabs=""
      >
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-sidebar-border px-3 max-md:h-full max-md:w-auto max-md:border-r max-md:border-b-0 max-md:px-2">
          <span className="text-3xs font-bold uppercase tracking-[0.1em] text-sidebar-foreground/60">
            Sessions
          </span>
          <span className="font-mono text-3xs tabular-nums text-sidebar-foreground/45">
            {props.sessions.length}
          </span>
          <div className="ml-auto">{sidebarActions}</div>
        </div>
        <nav
          className="min-h-0 flex-1 overflow-auto p-2 max-md:flex max-md:gap-1 max-md:overflow-x-auto max-md:overflow-y-hidden max-md:p-1"
          aria-label="Sessions"
          aria-orientation={props.sidebarOrientation ?? "vertical"}
          role="tablist"
          onKeyDown={handleSessionTabKeyDown}
        >
          {animatedSessionItems}
        </nav>
      </section>
    );
  }

  return (
    <header
      className="flex h-9 shrink-0 items-center border-b border-border bg-card"
      data-yaade-session-tabs
    >
      <div className="flex h-full shrink-0 items-center px-1">
        <ShortcutTooltip
          label="Settings"
          shortcut={settingsChord}
          side="bottom"
        >
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Open settings"
            onClick={props.onOpenSettings}
            data-yaade-session-settings=""
          >
            <Settings />
          </Button>
        </ShortcutTooltip>
      </div>
      <nav
        className="flex h-full min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto px-1"
        aria-label="Sessions"
        role="tablist"
        onKeyDown={handleSessionTabKeyDown}
      >
        {props.sessions.map((session, index) => {
          const active = session.id === props.activeSessionId;
          const editing = editingId === session.id;
          const serverName = props.serverNamesBySessionId?.get(session.id);
          return (
            <div
              key={session.id}
              role="presentation"
              data-yaade-session={session.id}
              data-active={active ? "true" : undefined}
              draggable={!editing}
              onDragStart={() => {
                dragId.current = session.id;
              }}
              onDragOver={event => event.preventDefault()}
              onDrop={() => moveSession(session.id, index)}
              className="group relative flex h-full min-w-24 shrink-0 items-center px-0.5 transition-[color,background-color] duration-[var(--yaade-motion-hot)] data-[active=true]:bg-background"
            >
              <span
                className="absolute inset-x-2 bottom-0 h-0.5 origin-center scale-x-0 rounded-full bg-primary transition-transform duration-[var(--yaade-motion-menu)] ease-[var(--yaade-ease-out)] group-data-[active=true]:scale-x-100"
                aria-hidden
              />
              {editing ? (
                <Input
                  aria-label={`Rename ${session.title}`}
                  className="h-6 min-w-24 border-primary/50 bg-background px-1.5"
                  autoFocus
                  value={draftTitle}
                  onChange={event => setDraftTitle(event.target.value)}
                  onBlur={() => finishRename(session)}
                  onKeyDown={event => {
                    event.stopPropagation();
                    if (event.key === "Enter") finishRename(session);
                    if (event.key === "Escape") setEditingId(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  tabIndex={active ? 0 : -1}
                  aria-selected={active}
                  aria-label={session.title}
                  onClick={() => props.onSelect(session.id)}
                  onDoubleClick={() => {
                    setDraftTitle(session.title);
                    setEditingId(session.id);
                  }}
                  onKeyDown={event => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      props.onSelect(session.id);
                    }
                  }}
                  className="flex h-full min-w-0 flex-1 cursor-pointer items-center overflow-hidden px-1.5 text-left text-xs font-medium text-muted-foreground outline-none transition-colors focus-visible:bg-accent group-data-[active=true]:text-foreground"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{session.title}</span>
                    {serverName ? (
                      <span className="truncate text-3xs text-muted-foreground">
                        {serverName}
                      </span>
                    ) : null}
                  </span>
                </button>
              )}
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Close ${session.title}`}
                title={`Close ${session.title}`}
                className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 group-data-[active=true]:opacity-70"
                onClick={event => {
                  event.stopPropagation();
                  props.onClose(session.id);
                }}
                onKeyDown={event => event.stopPropagation()}
              >
                <X />
              </Button>
            </div>
          );
        })}
      </nav>
      <div className="flex h-full shrink-0 items-center px-1">
        <ShortcutTooltip label="New session" shortcut={newSessionChord}>
          <Button
            size="icon-xs"
            variant="secondary"
            aria-label="New session"
            data-yaade-new-session=""
            onClick={props.onCreate}
          >
            <Plus />
          </Button>
        </ShortcutTooltip>
      </div>
    </header>
  );
}
