import { useEffect, useMemo, useState } from "react"
import { Check, ChevronDown, Layers3, Pencil, Plus, X } from "lucide-react"
import type { AppSession, SessionId } from "@yaade/rpc"
import type { YaadeServerConnection } from "@yaade/shared"
import {
  cn,
  formatKeyBinding,
  fuzzyFilter,
  PaletteShell,
  type PaletteShellItem,
} from "@yaade/ui/session"
import { Button, Input } from "@yaade/ui/primitives"
import { muxSessionShortcutFor } from "./mux-keymap.js"

const MAX_SESSION_TITLE_LENGTH = 120

function nextSessionTitle(sessions: readonly AppSession[]): string {
  const titles = new Set(sessions.map(session => session.title.trim().toLocaleLowerCase()))
  if (!titles.has("new session")) return "New session"
  let index = 2
  while (titles.has(`new session ${index}`)) index += 1
  return `New session ${index}`
}

type SessionPaletteEntry =
  | {
      readonly kind: "session"
      readonly session: AppSession
      readonly count: number
      readonly serverName?: string
      readonly status?: string
    }
  | {
      readonly kind: "create"
      readonly title: string
      readonly serverId?: string
      readonly serverName: string
      readonly disabledReason?: string
    }

type SearchableSessionEntry = {
  readonly searchText: string
  readonly item: PaletteShellItem<SessionPaletteEntry>
}

export type SessionSwitcherProps = {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly sessions: readonly AppSession[]
  readonly activeSessionId?: AppSession["id"]
  readonly onSelect: (session: AppSession) => void
  readonly onCreate: (title: string, serverId?: string) => void
  readonly onClose?: (id: SessionId) => void
  readonly onRename?: (id: SessionId, title: string) => void
  readonly terminalCounts?: ReadonlyMap<SessionId, number>
  readonly serverNamesBySessionId?: ReadonlyMap<SessionId, string>
  readonly sessionStatusById?: ReadonlyMap<SessionId, string>
  readonly activeServer?: YaadeServerConnection
  readonly className?: string
}

export function SessionSwitcher(props: SessionSwitcherProps) {
  const [query, setQuery] = useState("")
  const [highlightedSession, setHighlightedSession] = useState<AppSession | null>(null)
  const [editingId, setEditingId] = useState<SessionId | null>(null)
  const [draftTitle, setDraftTitle] = useState("")
  const activeSession = props.sessions.find(session => session.id === props.activeSessionId)
  const switchShortcut = muxSessionShortcutFor("session.switch")
  const normalizedQuery = query.trim()

  useEffect(() => {
    if (props.open) return
    setQuery("")
    setHighlightedSession(null)
    setEditingId(null)
    setDraftTitle("")
  }, [props.open])

  const items = useMemo(() => {
    const searchable: SearchableSessionEntry[] = props.sessions.map(session => {
      const count = props.terminalCounts?.get(session.id) ?? 0
      const serverName = props.serverNamesBySessionId?.get(session.id)
      const status = props.sessionStatusById?.get(session.id)
      return {
        searchText: [session.title, serverName, status, session.id].filter(Boolean).join(" "),
        item: {
          key: session.id,
          value: [session.title, serverName, status, session.id].filter(Boolean).join(" "),
          data: { kind: "session", session, count, serverName, status },
        },
      }
    })
    const filtered = normalizedQuery
      ? fuzzyFilter(normalizedQuery, searchable)
      : searchable
    const result = filtered.map(entry => entry.item)
    const exactTitle = normalizedQuery.length > 0 && props.sessions.some(
      session => session.title.trim().toLocaleLowerCase() === normalizedQuery.toLocaleLowerCase(),
    )
    if (exactTitle) return result

    const title = normalizedQuery || nextSessionTitle(props.sessions)
    const activeServer = props.activeServer
    const disabledReason = title.length > MAX_SESSION_TITLE_LENGTH
      ? `Session names must be ${MAX_SESSION_TITLE_LENGTH} characters or fewer.`
      : activeServer && activeServer.status !== "connected"
        ? `${activeServer.name} is not connected.`
        : activeServer
          ? undefined
          : "No host is available."
    result.push({
      key: `create:${activeServer?.id ?? "unavailable"}:${title}`,
      value: `${title} create new session ${activeServer?.name ?? "host"}`,
      data: {
        kind: "create",
        title,
        serverId: activeServer?.id,
        serverName: activeServer?.name ?? "Current host",
        disabledReason,
      },
    })
    return result
  }, [
    normalizedQuery,
    props.activeServer,
    props.serverNamesBySessionId,
    props.sessionStatusById,
    props.sessions,
    props.terminalCounts,
  ])

  const finishRename = (session: AppSession) => {
    const next = draftTitle.trim()
    setEditingId(null)
    if (next && next !== session.title) props.onRename?.(session.id, next)
  }

  const startRename = (session: AppSession) => {
    setDraftTitle(session.title)
    setEditingId(session.id)
  }

  const editingSession = editingId
    ? props.sessions.find(session => session.id === editingId)
    : undefined

  const statusRow = editingSession ? (
    <div
      className="flex min-h-11 items-center gap-1 border-y border-border/60 px-2 py-1"
      data-yaade-session-rename=""
    >
      <Input
        aria-label={`Rename ${editingSession.title}`}
        autoFocus
        value={draftTitle}
        onChange={event => setDraftTitle(event.target.value)}
        onKeyDown={event => {
          event.stopPropagation()
          if (event.key === "Enter") finishRename(editingSession)
          if (event.key === "Escape") setEditingId(null)
        }}
        className="h-8 min-w-0 flex-1 bg-background px-2"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Save name for ${editingSession.title}`}
        onClick={() => finishRename(editingSession)}
      >
        <Check />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Cancel renaming ${editingSession.title}`}
        onClick={() => setEditingId(null)}
      >
        <X />
      </Button>
    </div>
  ) : highlightedSession && (props.onRename || props.onClose) ? (
    <div
      className="flex min-h-10 items-center gap-1 border-y border-border/60 px-2 py-1"
      role="group"
      aria-label={`Actions for ${highlightedSession.title}`}
      data-yaade-session-actions=""
    >
      <span className="min-w-0 flex-1 truncate px-1 text-xs text-muted-foreground">
        {highlightedSession.title}
      </span>
      {props.onRename ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Rename ${highlightedSession.title}`}
          onClick={() => startRename(highlightedSession)}
        >
          <Pencil data-icon="inline-start" />
          Rename
        </Button>
      ) : null}
      {props.onClose ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Close ${highlightedSession.title}`}
          className="text-muted-foreground hover:text-destructive"
          onClick={() => {
            props.onOpenChange(false)
            props.onClose?.(highlightedSession.id)
          }}
        >
          <X data-icon="inline-start" />
          Close
        </Button>
      ) : null}
    </div>
  ) : undefined

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Switch session${activeSession ? `, current ${activeSession.title}` : ""}`}
        aria-haspopup="dialog"
        aria-expanded={props.open}
        data-yaade-session-switcher=""
        data-yaade-active-session={activeSession?.id}
        title={
          switchShortcut
            ? `Switch session (${formatKeyBinding(switchShortcut)})`
            : "Switch session"
        }
        className={cn(
          "h-[var(--yaade-tab-pill-height)] min-w-0 max-w-56 shrink-0 justify-start gap-1.5 rounded-[var(--yaade-pill-radius)] px-2.5 text-left text-muted-foreground hover:bg-accent/60 hover:text-foreground aria-expanded:bg-accent/70 aria-expanded:text-foreground",
          props.className,
        )}
        onClick={() => props.onOpenChange(!props.open)}
      >
        <Layers3 className="shrink-0" data-icon="inline-start" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {activeSession?.title ?? "Sessions"}
        </span>
        <ChevronDown className="shrink-0 opacity-60" data-icon="inline-end" aria-hidden />
      </Button>
      <PaletteShell
        open={props.open}
        onOpenChange={props.onOpenChange}
        title="Switch session"
        description="Find a session across connected hosts or create a named session on the current host."
        placeholder="Search sessions or create one…"
        surface="sessions"
        size="picker"
        query={query}
        onQueryChange={setQuery}
        items={items}
        shouldFilter={false}
        rowLayout="detail"
        requireQueryForSelection={false}
        statusRow={statusRow}
        emptyLabel="No matching sessions."
        isItemDisabled={entry => entry.kind === "create" && entry.disabledReason != null}
        onHighlightChange={entry => {
          setHighlightedSession(entry?.kind === "session" ? entry.session : null)
        }}
        onSelect={entry => {
          setEditingId(null)
          if (entry.kind === "session") {
            props.onSelect(entry.session)
            return
          }
          props.onCreate(entry.title, entry.serverId)
        }}
        renderItem={entry => {
          if (entry.kind === "create") {
            const label = normalizedQuery ? `Create “${entry.title}”` : "New session"
            return (
              <span
                className="flex min-w-0 flex-1 items-center gap-2.5"
                data-yaade-new-session=""
              >
                <span className="grid size-7 shrink-0 place-items-center rounded-[var(--yaade-control-radius)] bg-primary/15 text-primary">
                  <Plus className="size-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {label}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {entry.disabledReason ?? `on ${entry.serverName}`}
                  </span>
                </span>
              </span>
            )
          }

          const active = entry.session.id === props.activeSessionId
          const detail = [
            entry.serverName,
            entry.status,
            `${entry.count} terminal${entry.count === 1 ? "" : "s"}`,
          ].filter(Boolean).join(" · ")
          return (
            <span
              className="flex min-w-0 flex-1 items-center gap-2.5"
              data-yaade-session={entry.session.id}
              data-active={active ? "true" : undefined}
            >
              <span
                className={cn(
                  "grid size-7 shrink-0 place-items-center rounded-full border border-border/60 text-muted-foreground",
                  active && "border-primary/30 bg-primary/15 text-primary",
                )}
                aria-hidden
              >
                {active ? <Check className="size-3.5" /> : <Layers3 className="size-3.5" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {entry.session.title}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {detail}
                </span>
              </span>
              {active ? (
                <span className="shrink-0 text-3xs font-medium uppercase tracking-wide text-primary">
                  current
                </span>
              ) : null}
            </span>
          )
        }}
      />
    </>
  )
}
