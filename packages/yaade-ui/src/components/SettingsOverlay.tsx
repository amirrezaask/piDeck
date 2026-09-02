import type {
  YaadeServerConnection,
  YaadeServerDefinition,
  YaadeTheme,
} from "@yaade/shared"
import {
  Brush,
  Check,
  CircleAlert,
  Download,
  Globe2,
  Keyboard,
  LoaderCircle,
  Monitor,
  Moon,
  PanelLeft,
  PanelTop,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Server,
  SlidersHorizontal,
  Sun,
  Trash2,
  Upload,
  X,
} from "lucide-react"
import { AnimatePresence } from "motion/react"
import { div as MotionDiv } from "motion/react-m"
import { useEffect, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.js"
import { Badge } from "@/components/ui/badge.js"
import { Button } from "@/components/ui/button.js"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.js"
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@/components/ui/combobox.js"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field.js"
import { Input } from "@/components/ui/input.js"
import { Textarea } from "@/components/ui/textarea.js"
import { Label } from "@/components/ui/label.js"
import { ScrollArea } from "@/components/ui/scroll-area.js"
import { Separator } from "@/components/ui/separator.js"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs.js"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group.js"
import {
  siblingThemeForScheme,
  themePreviewSwatches,
} from "@/theme/bundled.js"
import { yaadeMotion } from "@/motion/tokens.js"
import { DEFAULT_MONO_FONT_NAME } from "../theme/appearance-defaults.js"
import { MOBILE_MEDIA_QUERY } from "../hooks/use-mobile.js"
import { listSystemMonoFonts } from "../theme/system-mono-fonts.js"
import { KeyBindingKbd } from "./KeyBindingKbd.js"

/** Navigation chrome for the Session shell. */
export type SessionLayout = "tabs" | "two-sidebars" | "single-sidebar"
export type ColorSchemeMode = "system" | "light" | "dark"
export type YaadeAppearanceSettings = {
  themeId: string
  colorSchemeMode: ColorSchemeMode
  /** Primary monospace face name (CSS stack built via `buildMonoFontStack`). */
  monoFontFamily: string
  /** Session and MuxTerminal navigation chrome. */
  sessionLayout: SessionLayout
  /** Whether the Session/MuxTerminal sidebars are collapsed. */
  sidebarCollapsed: boolean
  /** Sidebar expanded width in px (clamped 240–480). */
  sidebarWidth: number}

const EMPTY_SERVER_DEFINITIONS: readonly YaadeServerDefinition[] = []
const EMPTY_SERVER_CONNECTIONS: readonly YaadeServerConnection[] = []

export type KeyboardCapture = {
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
}

export type KeyboardSettingsRow = {
  readonly id: string
  readonly title: string
  readonly category: string
  readonly context: string
  readonly defaultBinding?: string
  readonly effectiveBinding?: string
  readonly overridden: boolean
  readonly configurable: boolean
}

export type KeyboardSettingsModel = {
  readonly leader: string
  readonly rows: readonly KeyboardSettingsRow[]
  readonly conflicts: readonly { readonly message: string }[]
  readonly canConfirmRisky: boolean
  readonly diagnostic?: string
  readonly exportJson: string
  readonly onCaptureLeader: (capture: KeyboardCapture) => boolean
  readonly onCaptureBinding: (id: string, capture: KeyboardCapture) => boolean
  readonly onClearBinding: (id: string) => boolean
  readonly onRestoreBinding: (id: string) => boolean
  readonly onConfirmRisky: () => boolean
  readonly onImport: (json: string) => boolean
  readonly onReset: () => boolean
}

export type SettingsOverlayProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  themes: YaadeTheme[]
  settings: YaadeAppearanceSettings
  onSettingsChange: (settings: YaadeAppearanceSettings) => void
  onReset: () => void
  keyboard?: KeyboardSettingsModel
  servers?: readonly YaadeServerDefinition[]
  serverConnections?: readonly YaadeServerConnection[]
  currentServerId?: string
  onServersChange?: (servers: readonly YaadeServerDefinition[]) => void
  onTestServer?: (server: YaadeServerDefinition) => Promise<{
    readonly ok: boolean
    readonly sessionCount?: number
    readonly error?: string
  }>
}

function settingPatch(
  settings: YaadeAppearanceSettings,
  patch: Partial<YaadeAppearanceSettings>,
): YaadeAppearanceSettings {
  return { ...settings, ...patch }
}

function colorSchemeForMode(mode: ColorSchemeMode): "light" | "dark" {
  if (mode !== "system") return mode
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light"
}

function MonoFontPicker({
  value,
  onChange,
}: {
  value: string
  onChange: (family: string) => void
}) {
  const [fonts, setFonts] = useState<string[]>([DEFAULT_MONO_FONT_NAME])
  const [popupContainer, setPopupContainer] =
    useState<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    void listSystemMonoFonts().then(list => {
      if (cancelled) return
      setFonts(list)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const items = (() => {
    const set = new Set(fonts)
    const current = value.trim() || DEFAULT_MONO_FONT_NAME
    set.add(current)
    return [...set].sort((a, b) => a.localeCompare(b))
  })()

  return (
    <div
      ref={setPopupContainer}
      data-yaade-mono-font-picker=""
      className="w-full min-w-0"
    >
      <Combobox
        items={items}
        value={value.trim() || DEFAULT_MONO_FONT_NAME}
        onValueChange={next => {
          if (next && next.trim()) onChange(next.trim())
        }}
        itemToStringValue={item => String(item)}
      >
        <ComboboxInput
          id="yaade-mono-font"
          placeholder="Select monospace font…"
          showClear={false}
          size="sm"
          className="w-full min-w-0"
          inputClassName="font-mono"
          aria-label="Terminal font"
        />
        <ComboboxPopup
          className="w-(--anchor-width)"
          portalContainer={popupContainer}
        >
          <ComboboxEmpty>No monospace fonts found.</ComboboxEmpty>
          <ComboboxList>
            {(item: string) => (
              <ComboboxItem
                key={item}
                value={item}
                style={{
                  fontFamily: `"${item.replaceAll('"', '\\"')}", monospace`,
                }}
              >
                <span data-yaade-mono-font-option={item}>{item}</span>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    </div>
  )
}

function ThemeButton({
  theme,
  active,
  onSelect,
}: {
  theme: YaadeTheme
  active: boolean
  onSelect: () => void
}) {
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "ghost"}
      data-yaade-theme-option={theme.id}
      aria-pressed={active}
      onClick={onSelect}
      className="h-auto min-h-12 w-full justify-start gap-3 px-3 py-2 text-left"
    >
      <span className="block min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-current">
          {theme.name}
        </span>
        <span className="mt-1 block font-mono text-3xs text-muted-foreground">
          {theme.scheme ?? "dark"}
        </span>
      </span>
      <span className="flex w-28 shrink-0 overflow-hidden rounded-sm border border-border">
        {themePreviewSwatches(theme)
          .slice(0, 10)
          .map((color, index) => (
            <span
              key={`${theme.id}:${index}:${color}`}
              aria-hidden
              className="h-5 flex-1"
              style={{ backgroundColor: color }}
            />
          ))}
      </span>
    </Button>
  )
}

type SettingsCategory = "appearance" | "keyboard" | "servers"

function isSettingsCategory(value: string): value is SettingsCategory {
  return value === "appearance" || value === "keyboard" || value === "servers"
}

const SETTINGS_CATEGORIES = {
  appearance: {
    label: "Appearance",
    description: "Tune navigation, theme, and typography across the app.",
    icon: Brush,
  },
  keyboard: {
    label: "Keyboard",
    description: "Adapt the leader and command bindings without stealing terminal input.",
    icon: Keyboard,
  },
  servers: {
    label: "Servers",
    description: "Connect to the machines that hold your sessions.",
    icon: Server,
  },
} satisfies Record<
  SettingsCategory,
  { label: string; description: string; icon: typeof SlidersHorizontal }
>

function SettingsSectionHeader({ category }: { category: SettingsCategory }) {
  const item = SETTINGS_CATEGORIES[category]
  return (
    <header className="flex flex-col gap-1">
      <h2 className="text-base font-semibold tracking-tight text-foreground">
        {item.label}
      </h2>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {item.description}
      </p>
    </header>
  )
}

function useCompactSettingsNavigation(): boolean {
  const [compact, setCompact] = useState(() =>
    window.matchMedia(MOBILE_MEDIA_QUERY).matches,
  )

  useEffect(() => {
    const media = window.matchMedia(MOBILE_MEDIA_QUERY)
    const sync = () => setCompact(media.matches)
    media.addEventListener("change", sync)
    return () => media.removeEventListener("change", sync)
  }, [])

  return compact
}

type CaptureTarget =
  | { readonly kind: "leader" }
  | { readonly kind: "binding"; readonly id: string }

function captureValue(event: import("react").KeyboardEvent<HTMLButtonElement>): KeyboardCapture {
  return {
    key: event.key,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
  }
}

function KeyboardCommandRows(props: {
  readonly rows: readonly KeyboardSettingsRow[]
  readonly capture: CaptureTarget | null
  readonly model: KeyboardSettingsModel
  readonly onCaptureChange: (target: CaptureTarget) => void
  readonly onCaptureKeyDown: (
    event: import("react").KeyboardEvent<HTMLButtonElement>,
    target: CaptureTarget,
  ) => void
}) {
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: props.rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 76,
    overscan: 6,
  })
  return (
    <div
      ref={parentRef}
      role="list"
      data-yaade-keymap-command-list=""
      className="h-[min(28rem,50dvh)] overflow-y-auto overscroll-contain rounded-lg"
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map(virtualRow => {
          const row = props.rows[virtualRow.index]
          if (!row) return null
          const capturing = props.capture?.kind === "binding" && props.capture.id === row.id
          return (
            <div
              key={row.id}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              role="listitem"
              data-yaade-keymap-command={row.id}
              className="absolute left-0 top-0 grid w-full min-w-0 gap-3 border-b border-border bg-card/60 p-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium text-foreground">{row.title}</span>
                  <Badge variant="outline" className="shrink-0">{row.category}</Badge>
                  <span className="shrink-0 text-3xs text-muted-foreground">{row.context}</span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-3xs text-muted-foreground">
                  <span>Effective</span>
                  {row.effectiveBinding ? (
                    <KeyBindingKbd binding={row.effectiveBinding} />
                  ) : (
                    <span className="font-mono">Unbound</span>
                  )}
                  <span className="opacity-60">Default {row.defaultBinding ?? "Unbound"}</span>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                {row.overridden ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => props.model.onRestoreBinding(row.id)}
                  >
                    Restore
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="xs"
                  variant={capturing ? "default" : "outline"}
                  disabled={!row.configurable}
                  data-yaade-keymap-capture={row.id}
                  onClick={() => props.onCaptureChange({ kind: "binding", id: row.id })}
                  onKeyDown={event => {
                    if (capturing && props.capture) props.onCaptureKeyDown(event, props.capture)
                  }}
                >
                  {capturing ? "Press binding…" : "Change"}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={!row.configurable || !row.effectiveBinding}
                  onClick={() => props.model.onClearBinding(row.id)}
                >
                  Clear
                </Button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function KeyboardSettingsPanel({ model }: { readonly model: KeyboardSettingsModel }) {
  const [query, setQuery] = useState("")
  const [capture, setCapture] = useState<CaptureTarget | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importJson, setImportJson] = useState("")
  const [copyStatus, setCopyStatus] = useState<string | null>(null)
  const normalizedQuery = query.trim().toLowerCase()
  const rows = normalizedQuery
    ? model.rows.filter(row =>
      `${row.title} ${row.category} ${row.defaultBinding ?? ""} ${row.effectiveBinding ?? ""}`
        .toLowerCase()
        .includes(normalizedQuery))
    : model.rows

  const onCaptureKeyDown = (
    event: import("react").KeyboardEvent<HTMLButtonElement>,
    target: CaptureTarget,
  ) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.key === "Escape") {
      setCapture(null)
      return
    }
    if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return
    const value = captureValue(event)
    if (target.kind === "leader") model.onCaptureLeader(value)
    else model.onCaptureBinding(target.id, value)
    setCapture(null)
  }

  const exportProfile = async () => {
    try {
      await navigator.clipboard.writeText(model.exportJson)
      setCopyStatus("Keymap JSON copied")
    } catch {
      setCopyStatus("Clipboard unavailable. Use Import to paste JSON on this device.")
    }
  }

  return (
    <section className="flex flex-col gap-5" data-yaade-keyboard-settings="">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <SettingsSectionHeader category="keyboard" />
        <Button type="button" size="sm" variant="outline" onClick={() => model.onReset()}>
          <RotateCcw data-icon="inline-start" />
          Reset keymap
        </Button>
      </div>
      <Separator />

      {model.diagnostic ? (
        <Alert data-yaade-keymap-diagnostic="">
          <CircleAlert />
          <AlertTitle>Defaults restored</AlertTitle>
          <AlertDescription>{model.diagnostic}</AlertDescription>
        </Alert>
      ) : null}
      {model.conflicts.length > 0 ? (
        <Alert variant="destructive" data-yaade-keymap-conflict="">
          <CircleAlert />
          <AlertTitle>Keymap not applied</AlertTitle>
          <AlertDescription className="space-y-2">
            {model.conflicts.map(item => <p key={item.message}>{item.message}</p>)}
            {model.canConfirmRisky ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => model.onConfirmRisky()}
              >
                Confirm risky binding
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <Card className="gap-3 py-4" data-yaade-keymap-leader="">
        <CardHeader className="px-4">
          <CardTitle className="flex items-center gap-2 text-sm">
            Leader
            <KeyBindingKbd binding={model.leader} className="ml-auto" />
          </CardTitle>
          <CardDescription className="text-xs">
            Press it twice in a terminal to send its control byte exactly once.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2 px-4">
          <Button
            type="button"
            size="sm"
            variant={capture?.kind === "leader" ? "default" : "outline"}
            data-yaade-keymap-capture="leader"
            onClick={() => setCapture({ kind: "leader" })}
            onKeyDown={event => {
              if (capture?.kind === "leader") onCaptureKeyDown(event, capture)
            }}
          >
            {capture?.kind === "leader" ? "Press leader chord…" : "Change leader"}
          </Button>
          {capture?.kind === "leader" ? (
            <span className="text-xs text-muted-foreground">Escape cancels</span>
          ) : null}
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search commands…"
            aria-label="Search keyboard commands"
            className="pl-9"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Capture a plain key for a leader sequence, or a modified chord for a direct binding.
        </p>
        {rows.length > 0 ? (
          <KeyboardCommandRows
            rows={rows}
            capture={capture}
            model={model}
            onCaptureChange={setCapture}
            onCaptureKeyDown={onCaptureKeyDown}
          />
        ) : (
          <div className="rounded-lg border border-dashed p-5 text-center text-xs text-muted-foreground">
            No commands match “{query}”.
          </div>
        )}
      </div>

      <Separator />
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-medium text-foreground">Import and export</h3>
            <p className="mt-1 text-xs text-muted-foreground">JSON data only. Profiles never include terminal content or credentials.</p>
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => void exportProfile()}>
              <Download data-icon="inline-start" />
              Export
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setImportOpen(value => !value)}>
              <Upload data-icon="inline-start" />
              Import
            </Button>
          </div>
        </div>
        {copyStatus ? <p role="status" className="text-xs text-muted-foreground">{copyStatus}</p> : null}
        {importOpen ? (
          <div className="grid gap-2 rounded-lg border border-border bg-muted/20 p-3" data-yaade-keymap-import="">
            <Label htmlFor="yaade-keymap-json">Keymap JSON</Label>
            <Textarea
              id="yaade-keymap-json"
              value={importJson}
              onChange={event => setImportJson(event.target.value)}
              className="min-h-36 font-mono text-xs"
              placeholder="Paste a version 1 keymap profile"
            />
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => setImportOpen(false)}>Cancel</Button>
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  if (model.onImport(importJson)) {
                    setImportJson("")
                    setImportOpen(false)
                  }
                }}
              >
                Apply import
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}

type ServerDraft = {
  readonly id: string | null
  readonly name: string
  readonly url: string
  readonly token: string
}

function newServerId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return `srv-${uuid}`
  return `srv-${Date.now().toString(36)}`
}

function validServerUrl(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    if (url.username || url.password || url.search || url.hash) return null
    return `${url.protocol}//${url.host}`
  } catch {
    return null
  }
}

function serverStatusLabel(status: YaadeServerConnection["status"] | "testing"): string {
  switch (status) {
    case "connected":
      return "Connected"
    case "offline":
      return "Offline"
    case "incompatible":
      return "Incompatible"
    case "revoked":
      return "Access revoked"
    case "authenticating":
      return "Authenticating"
    case "synchronizing":
      return "Synchronizing"
    case "testing":
      return "Testing"
    default:
      return "Connecting"
  }
}

function serverStatusVariant(
  status: YaadeServerConnection["status"] | "testing",
): "success" | "destructive" | "warning" {
  switch (status) {
    case "connected":
      return "success"
    case "offline":
      return "destructive"
    default:
      return "warning"
  }
}

function ServerSettingsPanel(props: {
  readonly servers: readonly YaadeServerDefinition[]
  readonly connections: readonly YaadeServerConnection[]
  readonly currentServerId?: string
  readonly onServersChange: (servers: readonly YaadeServerDefinition[]) => void
  readonly onTestServer?: (server: YaadeServerDefinition) => Promise<{
    readonly ok: boolean
    readonly sessionCount?: number
    readonly error?: string
  }>
}) {
  const [draft, setDraft] = useState<ServerDraft | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<
    ReadonlyMap<string, { readonly ok: boolean; readonly message: string }>
  >(() => new Map())
  const statusById = new Map(props.connections.map(connection => [connection.id, connection]))
  const current = props.currentServerId
    ? statusById.get(props.currentServerId)
    : undefined

  const beginAdd = () => {
    setFormError(null)
    setDraft({ id: null, name: "", url: "", token: "" })
  }

  const beginEdit = (server: YaadeServerDefinition) => {
    setFormError(null)
    setDraft({
      id: server.id,
      name: server.name,
      url: server.url,
      token: server.token ?? "",
    })
  }

  const saveDraft = (event: import("react").FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!draft) return
    const url = validServerUrl(draft.url)
    const name = draft.name.trim()
    if (!name) {
      setFormError("Give this server a name.")
      return
    }
    if (!url) {
      setFormError("Use a server URL such as https://devbox.example.com.")
      return
    }
    const id = draft.id ?? newServerId()
    let next: YaadeServerDefinition = { id, name, url }
    const token = draft.token.trim()
    if (token) next = { ...next, token }
    props.onServersChange([
      ...props.servers.filter(server => server.id !== id),
      next,
    ])
    setDraft(null)
    setFormError(null)
    setTestResult(previous => {
      const nextResults = new Map(previous)
      nextResults.delete(id)
      return nextResults
    })
  }

  const removeServer = (id: string) => {
    props.onServersChange(props.servers.filter(server => server.id !== id))
    if (draft?.id === id) setDraft(null)
  }

  const testServer = async (server: YaadeServerDefinition) => {
    if (!props.onTestServer) return
    setTestingId(server.id)
    setTestResult(previous => {
      const next = new Map(previous)
      next.delete(server.id)
      return next
    })
    try {
      const result = await props.onTestServer(server)
      setTestResult(previous => {
        const next = new Map(previous)
        next.set(server.id, {
          ok: result.ok,
          message: result.ok
            ? `${result.sessionCount ?? 0} sessions available`
            : result.error ?? "The server could not be reached.",
        })
        return next
      })
    } catch (error) {
      setTestResult(previous => {
        const next = new Map(previous)
        next.set(server.id, {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        })
        return next
      })
    } finally {
      setTestingId(null)
    }
  }

  return (
    <section className="flex flex-col gap-6" data-yaade-server-settings="">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <SettingsSectionHeader category="servers" />
        <Button type="button" size="sm" onClick={beginAdd}>
          <Plus data-icon="inline-start" />
          Add server
        </Button>
      </div>
      <Separator />
      <Card className="gap-3 border-info/25 bg-info/5 py-3">
        <CardHeader className="gap-1 px-4">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Globe2 className="size-4 text-info" aria-hidden />
            This client
            <Badge
              variant={current ? serverStatusVariant(current.status) : "outline"}
              className="ml-auto"
              data-yaade-current-server-status={current?.status ?? "connecting"}
            >
              {serverStatusLabel(current?.status ?? "connecting")}
            </Badge>
          </CardTitle>
          <CardDescription className="text-xs">
            The host serving this web or desktop client stays available alongside your remote servers.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4 font-mono text-3xs text-muted-foreground">
          {current?.url ?? "Current host"}
          {current ? ` · ${current.sessionCount} sessions` : ""}
        </CardContent>
      </Card>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium text-foreground">Remote servers</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Sessions from every connected server appear in the session switcher.
            </p>
          </div>
          <span className="font-mono text-3xs text-muted-foreground">
            {props.servers.length} configured
          </span>
        </div>
        {props.servers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-5 text-xs text-muted-foreground">
            No remote servers yet. Add one when you want to work with sessions on another machine.
          </div>
        ) : (
          <div className="grid gap-2">
            {props.servers.map(server => {
              const connection = statusById.get(server.id)
              const testing = testingId === server.id
              const result = testResult.get(server.id)
              const status = testing ? "testing" : (connection?.status ?? "connecting")
              return (
                <div
                  key={server.id}
                  className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card/70 p-3 transition-colors duration-[var(--yaade-motion-hot)] hover:bg-accent/30 sm:flex-row sm:items-center"
                  data-yaade-server={server.id}
                >
                  <span
                    className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"
                    aria-hidden
                  >
                    <Server className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{server.name}</span>
                      <Badge variant={serverStatusVariant(status)}>{serverStatusLabel(status)}</Badge>
                    </div>
                    <div className="mt-1 truncate font-mono text-3xs text-muted-foreground">
                      {server.url}
                      {connection ? ` · ${connection.sessionCount} sessions` : ""}
                    </div>
                    {connection?.error ? (
                      <p className="mt-1 truncate text-3xs text-destructive">{connection.error}</p>
                    ) : null}
                    {result ? (
                      <p className={result.ok ? "mt-1 text-3xs text-success" : "mt-1 text-3xs text-destructive"}>
                        {result.message}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center justify-end gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Test ${server.name}`}
                      disabled={testing || !props.onTestServer}
                      onClick={() => void testServer(server)}
                    >
                      {testing ? <LoaderCircle className="animate-spin" /> : <Check />}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Edit ${server.name}`}
                      onClick={() => beginEdit(server)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Remove ${server.name}`}
                      className="text-destructive hover:text-destructive"
                      onClick={() => removeServer(server.id)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
      <AnimatePresence initial={false}>
        {draft ? (
          <MotionDiv
            initial={{ opacity: 0, height: 0, y: -8 }}
            animate={{ opacity: 1, height: "auto", y: 0 }}
            exit={{ opacity: 0, height: 0, y: -8 }}
            transition={{ duration: yaadeMotion.duration.panel, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <Card className="gap-4 border-primary/30 bg-primary/5 py-4">
              <CardHeader className="px-4">
                <CardTitle className="text-sm">{draft.id ? "Edit server" : "Add remote server"}</CardTitle>
                <CardDescription className="text-xs">
                  Use the host server URL, not the YAADE client URL.
                </CardDescription>
              </CardHeader>
              <form className="grid gap-4 px-4" onSubmit={saveDraft}>
                <div className="grid gap-1.5">
                  <Label htmlFor="yaade-server-name">Name</Label>
                  <Input
                    id="yaade-server-name"
                    value={draft.name}
                    placeholder="Dev workstation"
                    autoFocus
                    onChange={event => setDraft({ ...draft, name: event.target.value })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="yaade-server-url">Server URL</Label>
                  <Input
                    id="yaade-server-url"
                    value={draft.url}
                    placeholder="https://devbox.example.com"
                    inputMode="url"
                    onChange={event => setDraft({ ...draft, url: event.target.value })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="yaade-server-token">Access token <span className="font-normal text-muted-foreground">(optional)</span></Label>
                  <Input
                    id="yaade-server-token"
                    type="password"
                    value={draft.token}
                    placeholder="Bearer token for this host"
                    autoComplete="off"
                    onChange={event => setDraft({ ...draft, token: event.target.value })}
                  />
                </div>
                {formError ? (
                  <Alert variant="destructive" className="py-2">
                    <CircleAlert />
                    <AlertTitle>Server not saved</AlertTitle>
                    <AlertDescription>{formError}</AlertDescription>
                  </Alert>
                ) : null}
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
                  <Button type="submit">Save server</Button>
                </div>
              </form>
            </Card>
          </MotionDiv>
        ) : null}
      </AnimatePresence>
    </section>
  )
}

export function SettingsOverlay({
  open,
  onOpenChange,
  themes,
  settings,
  onSettingsChange,
  onReset,
  keyboard,
  servers = EMPTY_SERVER_DEFINITIONS,
  serverConnections = EMPTY_SERVER_CONNECTIONS,
  currentServerId,
  onServersChange,
  onTestServer,
}: SettingsOverlayProps) {
  const [category, setCategory] = useState<SettingsCategory>("appearance")
  const compactNavigation = useCompactSettingsNavigation()

  const categories: SettingsCategory[] = ["appearance"]
  if (keyboard) categories.push("keyboard")
  if (onServersChange) categories.push("servers")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-yaade-settings-overlay=""
        showCloseButton={false}
        size="wide"
        className="h-[calc(100dvh-2rem)] gap-0 overflow-hidden border-border bg-popover p-0 text-popover-foreground sm:h-[min(44rem,calc(100dvh-2rem))] sm:max-w-[50rem]"
        style={{
          width: "min(50rem, calc(100vw - 2rem))",
          maxWidth: "min(50rem, calc(100vw - 2rem))",
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Configure terminal appearance, keyboard behavior, and server connections.
          </DialogDescription>
        </DialogHeader>
        <Tabs
          value={category}
          onValueChange={value => {
            if (isSettingsCategory(value)) setCategory(value)
          }}
          orientation={compactNavigation ? "horizontal" : "vertical"}
          className="min-h-0 flex-1 flex-col gap-0 md:flex-row"
          data-yaade-settings-tabs=""
        >
          <aside className="flex shrink-0 flex-col border-b border-border bg-muted/35 md:w-52 md:border-r md:border-b-0">
            <div className="flex h-14 items-center justify-between gap-3 px-4">
              <div className="min-w-0">
                <div className="text-sm font-semibold tracking-tight text-foreground">
                  Settings
                </div>
                <div className="text-3xs text-muted-foreground">
                  YAADE preferences
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={onReset}
                  aria-label="Reset appearance"
                  className="md:hidden"
                >
                  <RotateCcw />
                </Button>
                <DialogClose asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Close settings"
                  >
                    <X />
                  </Button>
                </DialogClose>
              </div>
            </div>
            <Separator />
            <TabsList
              variant="line"
              aria-label="Settings categories"
              className="scroll-fade-x flex h-auto w-full justify-start overflow-x-auto rounded-none p-2 md:flex-1 md:flex-col md:justify-start md:overflow-visible"
            >
              {categories.map((id) => {
                const item = SETTINGS_CATEGORIES[id]
                const Icon = item.icon
                return (
                  <TabsTrigger
                    key={id}
                    value={id}
                    data-yaade-settings-category={id}
                    className="h-9 flex-none px-3 md:w-full"
                  >
                    <Icon aria-hidden />
                    {item.label}
                  </TabsTrigger>
                )
              })}
            </TabsList>
            <div className="hidden p-3 md:block">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onReset}
                className="w-full justify-start"
              >
                <RotateCcw data-icon="inline-start" />
                Reset appearance
              </Button>
            </div>
          </aside>

          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            <TabsContent
              value="appearance"
              className="min-h-0 flex-1"
              data-yaade-settings-panel="appearance"
            >
              <ScrollArea className="size-full">
                <section className="flex flex-col gap-6 p-5 sm:p-7">
                  <SettingsSectionHeader category="appearance" />
                  <Separator />
                  <FieldGroup className="gap-0">
                    <Field
                      orientation="responsive"
                      className="grid items-start gap-3 py-4 first:pt-0 last:pb-0 sm:grid-cols-[minmax(10rem,13rem)_minmax(14rem,1fr)] sm:gap-6"
                    >
                      <FieldContent className="min-w-0">
                        <FieldLabel className="text-sm font-medium leading-snug text-foreground">
                          Window navigation
                        </FieldLabel>
                        <FieldDescription className="mt-1 text-xs leading-relaxed">
                          Keep Windows in the title bar or move them into a sidebar.
                        </FieldDescription>
                      </FieldContent>
                      <ToggleGroup
                        type="single"
                        variant="outline"
                        size="sm"
                        value={settings.sessionLayout}
                        aria-label="Window navigation"
                        className="w-full"
                        onValueChange={value => {
                          if (value !== "tabs" && value !== "single-sidebar") return
                          onSettingsChange(
                            settingPatch(settings, { sessionLayout: value }),
                          )
                        }}
                      >
                        <ToggleGroupItem
                          value="tabs"
                          aria-label="Top bar"
                          className="flex-1"
                          data-yaade-session-layout-option="tabs"
                        >
                          <PanelTop aria-hidden />
                          Top bar
                        </ToggleGroupItem>
                        <ToggleGroupItem
                          value="single-sidebar"
                          aria-label="Sidebar"
                          className="flex-1"
                          data-yaade-session-layout-option="single-sidebar"
                        >
                          <PanelLeft aria-hidden />
                          Sidebar
                        </ToggleGroupItem>
                      </ToggleGroup>
                    </Field>
                  </FieldGroup>
                  <Separator />
                  <FieldGroup className="gap-0">
                    <div className="pb-3">
                      <h3 className="text-sm font-medium text-foreground">
                        Theme
                      </h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Choose the default light or dark palette.
                      </p>
                    </div>
                    <Field
                      orientation="responsive"
                      className="grid items-start gap-3 py-4 first:pt-0 last:pb-0 sm:grid-cols-[minmax(10rem,13rem)_minmax(14rem,1fr)] sm:gap-6"
                    >
                      <FieldContent className="min-w-0">
                        <FieldLabel className="text-sm font-medium leading-snug text-foreground">
                          Color mode
                        </FieldLabel>
                        <FieldDescription className="mt-1 text-xs leading-relaxed">
                          Auto follows your system's light or dark appearance.
                        </FieldDescription>
                      </FieldContent>
                      <ToggleGroup
                        type="single"
                        variant="outline"
                        size="sm"
                        value={settings.colorSchemeMode}
                        aria-label="Color mode"
                        className="w-full"
                        onValueChange={value => {
                          if (
                            value !== "system" &&
                            value !== "light" &&
                            value !== "dark"
                          ) {
                            return
                          }
                          const scheme = colorSchemeForMode(value)
                          onSettingsChange(
                            settingPatch(settings, {
                              colorSchemeMode: value,
                              themeId: siblingThemeForScheme(
                                settings.themeId,
                                scheme,
                              ).id,
                            }),
                          )
                        }}
                      >
                        <ToggleGroupItem
                          value="system"
                          aria-label="Auto color mode"
                          className="flex-1"
                          data-yaade-color-mode-option="system"
                        >
                          <Monitor aria-hidden />
                          Auto
                        </ToggleGroupItem>
                        <ToggleGroupItem
                          value="light"
                          aria-label="Light color mode"
                          className="flex-1"
                          data-yaade-color-mode-option="light"
                        >
                          <Sun aria-hidden />
                          Light
                        </ToggleGroupItem>
                        <ToggleGroupItem
                          value="dark"
                          aria-label="Dark color mode"
                          className="flex-1"
                          data-yaade-color-mode-option="dark"
                        >
                          <Moon aria-hidden />
                          Dark
                        </ToggleGroupItem>
                      </ToggleGroup>
                    </Field>
                    <div className="grid gap-4">
                      {Array.from(
                        themes.reduce((map, theme) => {
                          const family = theme.family ?? "Default"
                          const list = map.get(family) ?? []
                          list.push(theme)
                          map.set(family, list)
                          return map
                        }, new Map<string, typeof themes>()),
                      ).map(([family, familyThemes]) => (
                        <div key={family} className="grid gap-1.5">
                          <p className="text-3xs font-bold uppercase tracking-[0.09em] text-muted-foreground">
                            {family}
                          </p>
                          <div className="grid gap-1.5 lg:grid-cols-2">
                            {familyThemes.map(theme => (
                              <ThemeButton
                                key={theme.id}
                                theme={theme}
                                active={settings.themeId === theme.id}
                                onSelect={() =>
                                  onSettingsChange(
                                    settingPatch(settings, {
                                      themeId: theme.id,
                                      colorSchemeMode:
                                        theme.scheme ?? "dark",
                                    }),
                                  )
                                }
                              />
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </FieldGroup>
                  <Separator />
                  <FieldGroup className="divide-y divide-border gap-0">
                    <Field
                      orientation="responsive"
                      className="grid items-start gap-3 py-4 first:pt-0 last:pb-0 sm:grid-cols-[minmax(10rem,13rem)_minmax(14rem,1fr)] sm:gap-6"
                    >
                      <FieldContent className="min-w-0">
                        <FieldLabel
                          htmlFor="yaade-mono-font"
                          className="text-sm font-medium leading-snug text-foreground"
                        >
                          Terminal font
                        </FieldLabel>
                        <FieldDescription className="mt-1 text-xs leading-relaxed">
                          Sets the terminal and code monospace face. Lists fonts available on this system.
                        </FieldDescription>
                      </FieldContent>
                      <MonoFontPicker
                        value={settings.monoFontFamily || DEFAULT_MONO_FONT_NAME}
                        onChange={family =>
                          onSettingsChange(
                            settingPatch(settings, { monoFontFamily: family }),
                          )
                        }
                      />
                    </Field>
                  </FieldGroup>
                </section>
              </ScrollArea>
            </TabsContent>

            {keyboard ? (
              <TabsContent
                value="keyboard"
                className="min-h-0 flex-1"
                data-yaade-settings-panel="keyboard"
              >
                <ScrollArea className="size-full">
                  <div className="p-5 sm:p-7">
                    <KeyboardSettingsPanel model={keyboard} />
                  </div>
                </ScrollArea>
              </TabsContent>
            ) : null}

            {onServersChange ? (
              <TabsContent
                value="servers"
                className="min-h-0 flex-1"
                data-yaade-settings-panel="servers"
              >
                <ScrollArea className="size-full">
                  <section className="flex flex-col p-5 sm:p-7">
                    <ServerSettingsPanel
                      servers={servers}
                      connections={serverConnections}
                      currentServerId={currentServerId}
                      onServersChange={onServersChange}
                      onTestServer={onTestServer}
                    />
                  </section>
                </ScrollArea>
              </TabsContent>
            ) : null}

          </main>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
