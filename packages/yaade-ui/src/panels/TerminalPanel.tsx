import { useEffect, useRef, useState } from "react"
import { ArrowDown, RotateCcw, Terminal as TerminalIcon, X } from "lucide-react"
import type { YaadeTheme } from "@yaade/shared"
import {
  GhosttyTerminalSurface,
  TERMINAL_SCHEDULER_BUDGETS,
  TerminalFrameScheduler,
  type GhosttyColor,
  type GhosttyTheme,
  type TerminalViewportActivity,
} from "@yaade/ghostty-react"
import { subscribeRootStyle } from "./root-style-observer.js"
import { Button } from "../components/ui/button.js"
import { Spinner } from "../components/ui/spinner.js"
import { shouldWaitForExistingPty } from "./terminal-attach.js"
import { stripDa1Responses } from "./terminal-da.js"
import { createTerminalInputWriter } from "./terminal-input-writer.js"
import { createTerminalOutputWriter } from "./terminal-output-writer.js"
import { terminalKeybindingData } from "./terminal-keybindings.js"
import {
  getRegisteredTerminal,
  registerTerminalInstance,
  unregisterTerminalInstance,
} from "./terminal-instance-registry.js"
import {
  extractTerminalLinks,
  isTerminalLinkModifier,
  openTerminalUrl,
  scanTerminalPathLinks,
} from "./terminal-links.js"
import { DEFAULT_MONO_FONT_FAMILY } from "../theme/appearance-defaults.js"
import { registerResidentTerminalSurface } from "./terminal-surface-placement.js"
import { terminalViewportActivityLabels } from "./terminal-viewport-label.js"

export type TerminalPanelProps = {
  cwdRootUri: string
  launchCommand?: string
  launchArgs?: string[]
  launchEnv?: Record<string, string>
  /** Persisted output rendered for an archived session without attaching a PTY. */
  initialOutput?: string
  theme: YaadeTheme
  tabId: string
  focused: boolean
  isActive: boolean
  existingPtyId?: string
  status?: "starting" | "running" | "exited" | "failed"
  exitCode?: number
  sessionGeneration?: number
  readOnly?: boolean
  /** Visible explanation for a history-only terminal surface. */
  readOnlyMessage?: string
  /** Attach to an existing PTY without ever creating, restarting, or disposing it. */
  attachOnly?: boolean
  /** Hold off creating/attaching a PTY until the surrounding session is ready. */
  deferPty?: boolean
  /** False when the pane has no on-screen slot; the PTY still stays connected. */
  visible?: boolean
  /** Override for the starting overlay copy. */
  startingMessage?: string
  onPtyId?: (tabId: string, ptyId: string | null) => void
  onInput?: (tabId: string, data?: string) => void
  onOutput?: (tabId: string, data?: string) => void
  onTitleChange?: (tabId: string, title: string) => void
  onJumpToLive?: () => void
  onRestart?: () => void
  onClose?: () => void
  onFailed?: () => void
  /** Fired when the attached PTY process exits. */
  onExit?: (tabId: string, exitCode: number) => void
  onOpenPath?: (path: string, line?: number, column?: number) => void
}

type TerminalSession = {
  surface: GhosttyTerminalSurface
  ptyId: string | null
  wantedCols: number
  wantedRows: number
  resizeInFlight: boolean
  resizeQueued: boolean
  wantedGeometryGeneration: number
  acknowledgedGeometryGeneration: number
  live: boolean
}

function readRootFontSize(): number {
  const px = parseFloat(getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(px) && px > 0 ? px : 13
}

function readTerminalFontFamily(): string {
  const fromTheme = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-mono")
    .trim()
  return fromTheme || DEFAULT_MONO_FONT_FAMILY
}

function readCssVar(name: string): string | null {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value.length > 0 ? value : null
}

function parseColor(value: string | undefined, fallback: GhosttyColor): GhosttyColor {
  if (!value) return fallback
  const hex = value.trim().replace(/^#/, "")
  if (/^[\da-f]{6}$/i.test(hex)) {
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16),
    }
  }
  if (/^[\da-f]{3}$/i.test(hex)) {
    return {
      r: Number.parseInt(`${hex[0]}${hex[0]}`, 16),
      g: Number.parseInt(`${hex[1]}${hex[1]}`, 16),
      b: Number.parseInt(`${hex[2]}${hex[2]}`, 16),
    }
  }
  if (typeof document === "undefined") return fallback
  try {
    const context = document.createElement("canvas").getContext("2d")
    if (!context) return fallback
    context.fillStyle = "#000000"
    context.fillStyle = value
    const normalized = context.fillStyle
    const match = normalized.match(
      /^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)/i,
    )
    if (!match) return fallback
    return {
      r: Math.max(0, Math.min(255, Math.round(Number(match[1])))),
      g: Math.max(0, Math.min(255, Math.round(Number(match[2])))),
      b: Math.max(0, Math.min(255, Math.round(Number(match[3])))),
    }
  } catch {
    return fallback
  }
}

const TERMINAL_ANSI_KEYS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const

function terminalPalette(theme: YaadeTheme): readonly GhosttyColor[] | undefined {
  const ansi = theme.terminalAnsi
  if (!ansi) return undefined
  const ansiColors = TERMINAL_ANSI_KEYS.map(key => {
    const cssKey = key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
    return parseColor(
      readCssVar(`--yaade-terminal-ansi-${cssKey}`) ?? ansi[key],
      { r: 0, g: 0, b: 0 },
    )
  })
  const palette = Array.from({ length: 256 }, (_, index) => {
    if (index < 16) return ansiColors[index]!
    if (index < 232) {
      const cube = index - 16
      const channel = (value: number) => (value === 0 ? 0 : 55 + value * 40)
      return {
        r: channel(Math.floor(cube / 36)),
        g: channel(Math.floor((cube % 36) / 6)),
        b: channel(cube % 6),
      }
    }
    const gray = 8 + (index - 232) * 10
    return { r: gray, g: gray, b: gray }
  })
  return palette
}

function terminalTheme(theme: YaadeTheme): GhosttyTheme {
  const colors = theme.colors
  const configured = theme.terminal
  const background =
    readCssVar("--yaade-terminal-background") ?? configured?.background ?? colors.bg
  const foreground =
    readCssVar("--yaade-terminal-foreground") ?? configured?.foreground ?? colors.text
  const cursor =
    readCssVar("--yaade-terminal-cursor") ?? configured?.cursor ?? colors.accent
  const selectionBackground =
    readCssVar("--yaade-terminal-selection") ?? configured?.selectionBackground ?? colors.selection

  return {
    background: parseColor(background, { r: 0, g: 0, b: 0 }),
    foreground: parseColor(foreground, { r: 229, g: 231, b: 235 }),
    cursor: parseColor(cursor, parseColor(foreground, { r: 229, g: 231, b: 235 })),
    palette: terminalPalette(theme),
    selectionBackground,
  }
}

function hostTerminalTheme(theme: GhosttyTheme) {
  return {
    foreground: theme.foreground,
    background: theme.background,
    cursor: theme.cursor,
  }
}

function updateJumpToLiveControl(
  button: HTMLButtonElement | null,
  label: HTMLSpanElement | null,
  activity: TerminalViewportActivity,
): void {
  if (!button || !label) return
  const hidden = activity.mode === "live"
  const count = activity.unseenRows
  const labels = terminalViewportActivityLabels(count)
  label.textContent = labels.visual
  button.setAttribute("aria-label", labels.accessible)
  button.setAttribute("aria-hidden", hidden ? "true" : "false")
  button.tabIndex = hidden ? -1 : 0
  button.inert = hidden
  button.dataset.visible = hidden ? "false" : "true"
  button.dataset.mode = activity.mode
  button.dataset.unseenRows = count === null ? "unknown" : String(count)
}

function focusTerminalInput(tabId: string): void {
  const terminal = getRegisteredTerminal(tabId)
  if (terminal) {
    terminal.focus()
    return
  }
  const docked = document.querySelector<HTMLElement>(
    `[data-yaade-tab-slot="${CSS.escape(tabId)}"] [data-yaade-terminal-panel]`,
  )
  const sessionTerminal = [...document.querySelectorAll<HTMLElement>(
    "[data-yaade-terminal-panel][data-yaade-terminal-tab-id]",
  )].find(panel => panel.dataset.yaadeTerminalTabId === tabId)
  ;(docked ?? sessionTerminal)
    ?.querySelector<HTMLTextAreaElement>("[data-ghostty-terminal-input]")
    ?.focus({ preventScroll: true })
}

function applyAttachReplay(
  attached: {
    output?: Uint8Array;
    outputChunks?: Uint8Array[];
    checkpoint?: { syntheticBytes: Uint8Array };
    replayTruncated?: boolean;
    replayNeedsQueryResponses?: boolean;
  },
  tabId: string,
  onOutput: ((tabId: string, data?: string) => void) | undefined,
  outputWriter: ReturnType<typeof createTerminalOutputWriter>,
  respondToQueries = false,
): void {
  const rawChunks =
    attached.outputChunks && attached.outputChunks.length > 0
      ? attached.outputChunks
      : attached.output?.byteLength
        ? [attached.output]
        : []
  const chunks = attached.checkpoint?.syntheticBytes.byteLength
    ? [attached.checkpoint.syntheticBytes, ...rawChunks]
    : rawChunks
  if (chunks.length === 0) return
  onOutput?.(tabId)
  if (attached.replayTruncated) {
    // The ring may begin inside an escape sequence. Start the best-effort
    // transcript from a clean parser state instead of inheriting corruption.
    // Keep the reset detached even when the replay itself must answer queries.
    outputWriter.enqueueReplay(new Uint8Array([0x1b, 0x63]))
  }
  for (const chunk of chunks) {
    if (chunk.byteLength === 0) continue
    if (respondToQueries) outputWriter.enqueue(chunk)
    else outputWriter.enqueueReplay(chunk)
  }
  outputWriter.flush()
}

export function TerminalPanel({
  cwdRootUri,
  launchCommand,
  launchArgs,
  launchEnv,
  initialOutput,
  theme,
  tabId,
  focused,
  isActive,
  existingPtyId,
  status = "starting",
  exitCode,
  sessionGeneration = 0,
  readOnly = false,
  readOnlyMessage = "Archived · read-only",
  attachOnly = false,
  deferPty = false,
  visible = true,
  startingMessage,
  onPtyId,
  onInput,
  onOutput,
  onTitleChange,
  onJumpToLive,
  onRestart,
  onClose,
  onFailed,
  onExit,
  onOpenPath,
}: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const jumpToLiveRef = useRef<HTMLButtonElement>(null)
  const jumpToLiveLabelRef = useRef<HTMLSpanElement>(null)
  const renderCountRef = useRef(0)
  renderCountRef.current += 1
  const sessionRef = useRef<TerminalSession | null>(null)
  const surfaceRef = useRef<GhosttyTerminalSurface | null>(null)
  const [displayStatus, setDisplayStatus] = useState(status)
  const [displayExitCode, setDisplayExitCode] = useState(exitCode)
  const [connectedPtyId, setConnectedPtyId] = useState<string | null>(existingPtyId ?? null)
  const [terminalError, setTerminalError] = useState<string | null>(null)
  const themeRef = useRef(theme)
  themeRef.current = theme
  const statusRef = useRef(status)
  statusRef.current = status
  const exitCodeRef = useRef(exitCode)
  exitCodeRef.current = exitCode
  const focusedRef = useRef(focused)
  focusedRef.current = focused
  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const replayPresentationPausedRef = useRef(false)
  const onTitleChangeRef = useRef(onTitleChange)
  onTitleChangeRef.current = onTitleChange
  const onPtyIdRef = useRef(onPtyId)
  onPtyIdRef.current = onPtyId
  const onInputRef = useRef(onInput)
  onInputRef.current = onInput
  const onOutputRef = useRef(onOutput)
  onOutputRef.current = onOutput
  const onFailedRef = useRef(onFailed)
  onFailedRef.current = onFailed
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit
  const onOpenPathRef = useRef(onOpenPath)
  onOpenPathRef.current = onOpenPath
  const launchCommandRef = useRef(launchCommand)
  launchCommandRef.current = launchCommand
  const launchArgsRef = useRef(launchArgs)
  launchArgsRef.current = launchArgs
  const launchEnvRef = useRef(launchEnv)
  launchEnvRef.current = launchEnv

  useEffect(() => {
    const terminalApi = window.yaade?.terminal
    if (!terminalApi || !cwdRootUri || !containerRef.current) return
    let cancelled = false
    let session: TerminalSession | null = null
    let surface: GhosttyTerminalSurface | null = null
    let unsub: (() => void) | null = null
    let dataDispose: (() => void) | null = null
    let inputWriter: ReturnType<typeof createTerminalInputWriter> | null = null
    const pendingTerminalInput: string[] = []
    let outputWriter: ReturnType<typeof createTerminalOutputWriter> | null = null
    let unregisterResidentSurface: (() => void) | null = null
    let unsubscribeViewportActivity: (() => void) | null = null
    let replayPreviewActive = false
    let previewPresentationWaiter: {
      afterModelFrameId: number
      resolve: () => void
    } | null = null
    const frameScheduler = new TerminalFrameScheduler()
    const updateSchedulerDiagnostics = () => {
      const panel = containerRef.current?.closest<HTMLElement>("[data-yaade-terminal-panel]")
      if (!panel) return
      const metrics = frameScheduler.snapshot()
      panel.dataset.yaadeTerminalPipelinePendingBytes = String(metrics.pendingBytes)
      panel.dataset.yaadeTerminalPipelineMaxPendingBytes = String(metrics.maxPendingBytes)
      panel.dataset.yaadeTerminalPipelineParsedP95 = metrics.receivedToParsedP95.toFixed(1)
      panel.dataset.yaadeTerminalPipelineSubmittedP95 = metrics.parsedToSubmittedP95.toFixed(1)
      panel.dataset.yaadeTerminalPipelinePresentedP95 = metrics.receivedToPresentedP95.toFixed(1)
      panel.dataset.yaadeTerminalPipelineFrameDelayP95 = metrics.frameDelayP95.toFixed(1)
      panel.dataset.yaadeTerminalLastSubmittedFrame = String(metrics.lastSubmittedModelFrame)
      panel.dataset.yaadeTerminalLastPresentedFrame = String(metrics.lastNextPaintObservedFrame)
    }

    const enqueueTerminalInput = (data: string) => {
      // Host already answered DA1 on the PTY. Drop Ghostty's copy so fish
      // does not see a second response as typed input after startup.
      const payload = stripDa1Responses(data)
      if (payload.length === 0) return
      if (inputWriter) inputWriter.enqueue(payload)
      else pendingTerminalInput.push(payload)
    }
    const container = containerRef.current
    const surfaceMount = document.createElement("div")
    surfaceMount.className = "relative h-full min-h-0 w-full overflow-hidden"
    surfaceMount.dataset.yaadeResidentTerminalSurface = tabId
    container.replaceChildren(surfaceMount)
    const launchCommandAtStart = launchCommandRef.current
    const launchArgsAtStart = launchArgsRef.current
    const launchEnvAtStart = launchEnvRef.current
    const launchForSize = (cols: number, rows: number) => {
      const theme = hostTerminalTheme(terminalTheme(themeRef.current))
      if (launchCommandAtStart) {
        return {
          command: launchCommandAtStart,
          args: launchArgsAtStart,
          env: launchEnvAtStart,
          cols,
          rows,
          theme,
        }
      }
      return { cols, rows, theme }
    }
    const shouldPrecreatePty =
      !deferPty &&
      !existingPtyId &&
      !initialOutput &&
      !readOnly &&
      !attachOnly &&
      !((statusRef.current === "failed" || statusRef.current === "exited") && !launchCommandAtStart)
    const precreatedPty = shouldPrecreatePty
      ? Promise.resolve().then(() => terminalApi.create(cwdRootUri, launchForSize(80, 24)))
      : null
    // The renderer can take longer than PTY startup. Attach the rejection now
    // so a failed speculative create never becomes an unhandled promise.
    void precreatedPty?.catch(() => {})
    let precreatedPtyConsumed = false

    const disposePrecreatedPty = () => {
      if (!precreatedPty || precreatedPtyConsumed) return
      precreatedPtyConsumed = true
      void precreatedPty.then(({ id }) => terminalApi.dispose(id)).catch(() => {})
    }

    const resizePty = (next: TerminalSession | null) => {
      if (!next?.live || !next.ptyId || !next.surface.hasMeasuredSize()) return
      if (next.resizeInFlight) {
        next.resizeQueued = true
        return
      }
      const id = next.ptyId
      const cols = next.wantedCols
      const rows = next.wantedRows
      const geometryGeneration = next.wantedGeometryGeneration
      next.resizeInFlight = true
      next.resizeQueued = false
      const settle = () => {
        if (!next.live) return
        next.resizeInFlight = false
        next.acknowledgedGeometryGeneration = Math.max(
          next.acknowledgedGeometryGeneration,
          geometryGeneration,
        )
        const panel = containerRef.current?.closest<HTMLElement>("[data-yaade-terminal-panel]")
        if (panel) {
          panel.dataset.yaadeTerminalHostResizeAcknowledgedGeneration = String(
            next.acknowledgedGeometryGeneration,
          )
        }
        if (
          next.resizeQueued ||
          next.wantedCols !== cols ||
          next.wantedRows !== rows ||
          next.wantedGeometryGeneration !== geometryGeneration
        ) {
          resizePty(next)
        }
      }
      void Promise.resolve()
        .then(() => terminalApi.resize(id, cols, rows))
        .then(settle, settle)
    }

    const handleLink = (text: string, event: MouseEvent) => {
      if (!isTerminalLinkModifier(event)) return
      if (/^https?:\/\//i.test(text)) {
        openTerminalUrl(text)
        return
      }
      const path = scanTerminalPathLinks(text)[0]
      if (path) onOpenPathRef.current?.(path.path, path.line, path.column)
    }

    const consumeAttachPreview = async (replay: {
      data: Uint8Array
      replayNeedsQueryResponses: boolean
      replayTruncated: boolean
    }): Promise<void> => {
      if (cancelled) throw new Error("terminal replay cancelled")
      if (!surface || replay.data.byteLength === 0) return
      const previewSurface = surface
      onOutputRef.current?.(tabId)
      const waitForPresentation =
        visibleRef.current && document.visibilityState === "visible"
      const presented = waitForPresentation
        ? new Promise<void>(resolve => {
            previewPresentationWaiter = {
              afterModelFrameId: previewSurface.lifecycleSnapshot().lastNextPaintObservedFrame,
              resolve,
            }
          })
        : Promise.resolve()
      await new Promise<void>(resolve => previewSurface.resetAndWrite(replay.data, resolve))
      await presented
      if (cancelled) throw new Error("terminal replay cancelled")
      replayPreviewActive = true
      surfaceMount.dataset.yaadeTerminalReplayPhase = "preview"
    }

    const consumeAttachReplay = (replay: {
      data: Uint8Array
      replayNeedsQueryResponses: boolean
      replayTruncated: boolean
    }): void => {
      if (cancelled) throw new Error("terminal replay cancelled")
      if (!outputWriter || replay.data.byteLength === 0) return
      const replacingPreview = replayPreviewActive
      if (replacingPreview) {
        replayPreviewActive = false
        replayPresentationPausedRef.current = true
        surface?.setVisible(false)
        surfaceMount.dataset.yaadeTerminalReplayPhase = "history"
      }
      onOutputRef.current?.(tabId)
      if (replay.replayTruncated || replacingPreview) {
        outputWriter.enqueueReplay(new Uint8Array([0x1b, 0x63]))
      }
      if (replay.replayNeedsQueryResponses) {
        outputWriter.enqueue(replay.data)
      } else {
        outputWriter.enqueueReplay(replay.data)
      }
      // Archive pages are bounded by the host. Parse each page before asking
      // for the next one so a large scrollback never becomes one browser task
      // or one unbounded client-side queue.
      outputWriter.flush()
    }
    const attachToNewSurface = (id: string) => {
      surface?.recordAttach()
      return terminalApi.attach(id, {
        replay: "full",
        onReplayPreview: consumeAttachPreview,
        onReplay: consumeAttachReplay,
      }).finally(() => {
        replayPreviewActive = false
        previewPresentationWaiter?.resolve()
        previewPresentationWaiter = null
        replayPresentationPausedRef.current = false
        surface?.setVisible(visibleRef.current)
        delete surfaceMount.dataset.yaadeTerminalReplayPhase
      })
    }

    let receivingReplay = false
    const syncHostTheme = (id: string, nextTheme: GhosttyTheme) => {
      if (readOnly) return
      void terminalApi.setTheme(id, hostTerminalTheme(nextTheme)).catch(() => {})
    }

    const connectPty = (id: string, replayMayNeedQueryResponses = false) => {
      if (!session || !surface || cancelled) return
      session.ptyId = id
      syncHostTheme(id, terminalTheme(themeRef.current))
      setConnectedPtyId(id)
      setDisplayStatus("running")
      setDisplayExitCode(undefined)
      unsub = terminalApi.onData(
        id,
        (
          data,
          replay = false,
          replayNeedsQueryResponses = false,
          replayTruncated = false,
          acknowledgeConsumed,
        ) => {
          onOutputRef.current?.(tabId)
          if (replay && !receivingReplay) {
            receivingReplay = true
            outputWriter?.discardPending()
            frameScheduler.resetGeneration()
          } else if (!replay) {
            receivingReplay = false
          }
          const pipelineToken = frameScheduler.received(data.byteLength)
          const parsedAndAcknowledge = () => {
            frameScheduler.parsed(pipelineToken)
            updateSchedulerDiagnostics()
            acknowledgeConsumed?.()
          }
          if (replay && replayTruncated) {
            // A reconnect gap means the ring starts after the current parser
            // state. Reset before applying the best-effort replacement stream.
            outputWriter?.flush()
            surface?.resetAndWrite("")
          }
          if (
            replay &&
            !replayMayNeedQueryResponses &&
            !replayNeedsQueryResponses
          ) {
            outputWriter?.enqueueReplay(data, parsedAndAcknowledge)
            outputWriter?.flush()
          } else {
            outputWriter?.enqueue(data, parsedAndAcknowledge)
            if (replay && replayNeedsQueryResponses) {
              outputWriter?.flush()
              // Query replies are queued on a microtask by the input writer;
              // flush them before the host is told this replay is complete.
              void inputWriter?.flush()
              void terminalApi.markReplayReady(id).catch(() => {})
            }
          }
        },
        { acknowledgement: "consumption" },
      )
      if (!readOnly) {
        inputWriter = createTerminalInputWriter(
          data => terminalApi.write(id, data),
          error => {
            const message = error instanceof Error ? error.message : String(error)
            surface?.write(`\r\n\x1b[31mTerminal input failed:\x1b[0m ${message}`)
          },
        )
        for (const queued of pendingTerminalInput.splice(0)) inputWriter.enqueue(queued)
        // Flush replies generated while parsing the attach snapshot before
        // declaring the first live replay ready. This makes a rapid reload
        // retry query responses instead of turning a startup race into a
        // permanently waiting shell.
        outputWriter?.flush()
        void inputWriter.flush()
        void terminalApi.markReplayReady(id).catch(() => {})
        dataDispose = () => inputWriter?.dispose()
      }
      session.wantedCols = surface.cols
      session.wantedRows = surface.rows
      resizePty(session)
      if (focusedRef.current && isActiveRef.current) focusTerminalInput(tabId)
    }

    const createFreshPty = (prepared: typeof precreatedPty = null): void => {
      if (!surface || cancelled) return
      if (prepared !== null) precreatedPtyConsumed = true
      const created =
        prepared ?? terminalApi.create(cwdRootUri, launchForSize(surface.cols, surface.rows))
      void created
        .then(async ({ id, title }) => {
          if (cancelled) {
            void terminalApi.dispose(id)
            return
          }
          onPtyIdRef.current?.(tabId, id)
          if (title) onTitleChangeRef.current?.(tabId, title)

          // Creating the PTY does not subscribe this WebSocket to its stream.
          // Every fresh surface therefore performs the same ordered attach as
          // a restored one before it starts accepting live output.
          const attached = await attachToNewSurface(id)
          if (cancelled) {
            void terminalApi.dispose(id)
            return
          }
          if (!attached) throw new Error("created terminal disappeared before attach")
          if (outputWriter) {
            applyAttachReplay(
              attached,
              tabId,
              onOutputRef.current,
              outputWriter,
              !readOnly && attached.replayNeedsQueryResponses === true,
            )
          }
          if (attached.status === "exited") {
            setDisplayStatus("exited")
            setDisplayExitCode(attached.exitCode)
            return
          }
          connectPty(
            id,
            !readOnly && attached.replayNeedsQueryResponses === true,
          )
        })
        .catch(error => {
          if (cancelled) return
          const message = error instanceof Error ? error.message : String(error)
          surface?.write(`\r\n\x1b[31mTerminal failed to start:\x1b[0m ${message}`)
          setDisplayStatus("failed")
          onFailedRef.current?.()
        })
    }

    const startPty = (prepared: typeof precreatedPty = null) => {
      if (cancelled || !surface) return
      if (deferPty) return
      if (initialOutput && !existingPtyId) surface.resetAndWrite(initialOutput)
      if (existingPtyId) {
        void attachToNewSurface(existingPtyId)
          .then(attached => {
            if (cancelled) return
            if (!attached) {
              if (!readOnly && !attachOnly) {
                createFreshPty()
                return
              }
              surface?.write("\r\n\x1b[31mTerminal session is no longer available.\x1b[0m")
              setDisplayStatus("failed")
              onFailedRef.current?.()
              return
            }
            if (attached.status === "exited") {
              if (!readOnly && !attachOnly && launchCommandAtStart) {
                void terminalApi.dispose(existingPtyId).catch(() => {})
                createFreshPty()
                return
              }
              if (outputWriter) {
                applyAttachReplay(attached, tabId, onOutputRef.current, outputWriter)
              }
              setDisplayStatus("exited")
              setDisplayExitCode(attached.exitCode)
              return
            }
            const respondToQueries =
              !readOnly && attached.replayNeedsQueryResponses === true
            if (outputWriter) {
              applyAttachReplay(
                attached,
                tabId,
                onOutputRef.current,
                outputWriter,
                respondToQueries,
              )
            }
            if (attached.title) onTitleChangeRef.current?.(tabId, attached.title)
            if (!readOnly) connectPty(existingPtyId, respondToQueries)
            else {
              setDisplayStatus("exited")
              setDisplayExitCode(attached.exitCode)
            }
          })
          .catch(error => {
            if (cancelled) return
            const message = error instanceof Error ? error.message : String(error)
            surface?.write(`\r\n\x1b[31mTerminal attach failed:\x1b[0m ${message}`)
            setDisplayStatus("failed")
            onFailedRef.current?.()
          })
        return
      }
      if (
        shouldWaitForExistingPty({
          attachOnly,
          existingPtyId,
          status: statusRef.current,
        })
      ) {
        return
      }
      if (
        attachOnly ||
        ((statusRef.current === "failed" || statusRef.current === "exited") && !launchCommandAtStart)
      ) {
        setDisplayStatus(statusRef.current === "failed" ? "failed" : "exited")
        setDisplayExitCode(exitCodeRef.current)
        return
      }
      createFreshPty(prepared)
    }

    const exitUnsubscribe = terminalApi.onExit((id, code) => {
      if (session?.ptyId !== id) return
      setDisplayStatus("exited")
      setDisplayExitCode(code)
      onExitRef.current?.(tabId, code)
    })

    const setup = async () => {
      try {
        surface = await GhosttyTerminalSurface.create(surfaceMount, {
          theme: terminalTheme(themeRef.current),
          font: { family: readTerminalFontFamily(), size: readRootFontSize() },
          visible: visibleRef.current,
          // The host terminal runtime owns device/query responses. This browser
          // core renders and encodes user input only, preventing every attached
          // viewer from answering the same terminal query.
          responsePolicy: "render-only",
          onData: data => {
            onInputRef.current?.(tabId, data)
            enqueueTerminalInput(data)
          },
          onResize: (cols, rows) => {
            if (!session?.live) return
            session.wantedCols = cols
            session.wantedRows = rows
            session.wantedGeometryGeneration = surface?.lifecycleSnapshot().geometryGeneration ?? 0
            const panel = containerRef.current?.closest<HTMLElement>("[data-yaade-terminal-panel]")
            if (panel) {
              panel.dataset.yaadeTerminalHostResizeRequestedGeneration = String(
                session.wantedGeometryGeneration,
              )
            }
            resizePty(session)
          },
          onSelectionChange: () => undefined,
          linkMatcher: extractTerminalLinks,
          beforeKey: event => {
            const data = terminalKeybindingData(event, navigator.platform)
            if (data === null) return true
            event.preventDefault()
            event.stopPropagation()
            onInputRef.current?.(tabId, data)
            enqueueTerminalInput(data)
            return false
          },
          onLinkActivate: handleLink,
          onPresented: sample => {
            frameScheduler.presented(sample)
            updateSchedulerDiagnostics()
            if (
              previewPresentationWaiter &&
              sample.modelFrameId > previewPresentationWaiter.afterModelFrameId
            ) {
              const waiter = previewPresentationWaiter
              previewPresentationWaiter = null
              waiter.resolve()
            }
          },
          onRuntimeRecoveryRequired: () => {
            const id = session?.ptyId
            if (!id || !surface || !outputWriter) return
            outputWriter.discardPending()
            frameScheduler.resetGeneration()
            surface.resetAndWrite("")
            void attachToNewSurface(id).then(attached => {
              if (!attached || cancelled || !outputWriter) return
              applyAttachReplay(
                attached,
                tabId,
                onOutputRef.current,
                outputWriter,
                !readOnly && attached.replayNeedsQueryResponses === true,
              )
            })
          },
          onTitleChange: title => {
            onTitleChangeRef.current?.(
              tabId,
              title.length > 80 ? `${title.slice(0, 77)}…` : title,
            )
          },
        })
        if (cancelled) {
          surface.dispose()
          return
        }
        surfaceRef.current = surface
        const panel = container.closest<HTMLElement>("[data-yaade-terminal-panel]")
        const panelHome = panel?.parentElement
        if (panel && panelHome) {
          unregisterResidentSurface = registerResidentTerminalSurface({
            terminalId: tabId,
            mount: panel,
            home: panelHome,
            surface,
          })
        } else {
          const viewportAccessory = jumpToLiveRef.current ?? undefined
          unregisterResidentSurface = registerResidentTerminalSurface({
            terminalId: tabId,
            mount: surfaceMount,
            home: container,
            accessory: viewportAccessory,
            accessoryHome: viewportAccessory?.parentElement ?? undefined,
            surface,
          })
        }
        if (panel) {
          panel.dataset.yaadeTerminalRenderer = "ghostty"
          panel.dataset.yaadeTerminalRenderBackend = surface.renderBackend
          panel.dataset.yaadeTerminalRuntime = surface.runtimeKind
          panel.dataset.yaadeTerminalSurfaceInstance = String(surface.surfaceInstanceId)
        }
        session = {
          surface,
          ptyId: null,
          wantedCols: surface.cols,
          wantedRows: surface.rows,
          resizeInFlight: false,
          resizeQueued: false,
          wantedGeometryGeneration: surface.lifecycleSnapshot().geometryGeneration,
          acknowledgedGeometryGeneration: 0,
          live: true,
        }
        sessionRef.current = session
        registerTerminalInstance(tabId, surface)
        unsubscribeViewportActivity = surface.subscribeViewportActivity(activity => {
          updateJumpToLiveControl(
            jumpToLiveRef.current,
            jumpToLiveLabelRef.current,
            activity,
          )
          if (panel) {
            panel.dataset.yaadeTerminalViewportMode = activity.mode
            panel.dataset.yaadeTerminalUnseenRows =
              activity.unseenRows === null ? "unknown" : String(activity.unseenRows)
          }
        })

        outputWriter = createTerminalOutputWriter({
          // Bound each command so a pooled worker yields between terminals;
          // the same quantum keeps forced-main fallback tasks finite.
          maxBytesPerFlush: TERMINAL_SCHEDULER_BUDGETS.workerSliceBytes,
          // The server allows at most 8 MiB of unacknowledged output per PTY.
          // Keep the local queue above that ceiling so server-side resync wins
          // before the writer's last-resort shedding path can drop a frame.
          maxPendingBytes: TERMINAL_SCHEDULER_BUDGETS.livePendingBytes,
          onPosted: bytes => frameScheduler.posted(bytes),
          write: (data, onParsed) => {
            surface?.write(data, onParsed)
          },
          writeReplay: (chunks, onParsed) => {
            surface?.writeReplay(chunks, onParsed)
          },
        })

        startPty(precreatedPty)
      } catch (error) {
        disposePrecreatedPty()
        if (cancelled) return
        const message = error instanceof Error ? error.message : String(error)
        setTerminalError(message)
        setDisplayStatus("failed")
        onFailedRef.current?.()
      }
    }

    void setup()
    const unsubscribeRootStyleObserver = subscribeRootStyle(() => {
      const next = sessionRef.current?.surface
      if (!next) return
      const nextTheme = terminalTheme(themeRef.current)
      next.setTheme(nextTheme)
      const ptyId = sessionRef.current?.ptyId
      if (ptyId) syncHostTheme(ptyId, nextTheme)
      void next.setFont({ family: readTerminalFontFamily(), size: readRootFontSize() })
    })

    return () => {
      cancelled = true
      replayPreviewActive = false
      previewPresentationWaiter?.resolve()
      previewPresentationWaiter = null
      replayPresentationPausedRef.current = false
      disposePrecreatedPty()
      if (session) session.live = false
      if (sessionRef.current === session) sessionRef.current = null
      if (surfaceRef.current === surface) surfaceRef.current = null
      unsubscribeRootStyleObserver()
      exitUnsubscribe()
      // Drain pending parser work and terminal input before replacing the page.
      outputWriter?.flush()
      void inputWriter?.flush()
      if (session?.ptyId) void terminalApi.markReplayReady(session.ptyId).catch(() => {})
      dataDispose?.()
      inputWriter = null
      pendingTerminalInput.length = 0
      outputWriter?.dispose()
      unsub?.()
      unsubscribeViewportActivity?.()
      unsubscribeViewportActivity = null
      unregisterResidentSurface?.()
      unregisterResidentSurface = null
      if (surface) {
        unregisterTerminalInstance(tabId, surface)
        surface.dispose()
      }
      surfaceMount.remove()
    }
  }, [
    cwdRootUri,
    tabId,
    sessionGeneration,
    readOnly,
    attachOnly,
    deferPty,
    existingPtyId,
    initialOutput,
  ])

  useEffect(() => {
    setDisplayStatus(status)
    setDisplayExitCode(exitCode)
  }, [status, exitCode, sessionGeneration])

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    const nextTheme = terminalTheme(themeRef.current)
    surface.setTheme(nextTheme)
    const ptyId = sessionRef.current?.ptyId
    const terminalApi = window.yaade?.terminal
    if (ptyId && terminalApi && !readOnly) {
      void terminalApi.setTheme(ptyId, hostTerminalTheme(nextTheme)).catch(() => {})
    }
  }, [theme.id, readOnly])

  useEffect(() => {
    surfaceRef.current?.setVisible(visible && !replayPresentationPausedRef.current)
  }, [visible])

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface || !focused || !isActive) return
    const focusRaf = requestAnimationFrame(() => {
      if (surfaceRef.current === surface) focusTerminalInput(tabId)
    })
    return () => cancelAnimationFrame(focusRaf)
  }, [focused, isActive, tabId])

  if (!window.yaade?.terminal) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-2 text-[var(--yaade-text-muted)]"
        role="region"
        aria-label="Terminal"
        data-yaade-terminal-panel=""
        data-yaade-terminal-tab-id={tabId}
      >
        <TerminalIcon className="size-8 opacity-40" />
        <p className="text-sm">Integrated terminal</p>
        <p className="max-w-xs text-center text-xs opacity-70">
          The terminal host is unavailable. Start or reconnect the YAADE host.
        </p>
      </div>
    )
  }

  return (
    <div
      className="relative flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden bg-transparent"
      data-yaade-terminal-panel=""
      data-yaade-terminal-tab-id={tabId}
      data-yaade-terminal-pty-id={connectedPtyId ?? ""}
      data-yaade-terminal-status={displayStatus}
      data-yaade-terminal-renderer="ghostty"
      data-yaade-terminal-panel-render-count={renderCountRef.current}
      onMouseDown={() => focusTerminalInput(tabId)}
    >
      <div className="yaade-terminal-surface relative min-h-0 flex-1 overflow-hidden">
        <div
          ref={containerRef}
          className="relative h-full min-h-0 w-full overflow-hidden"
          data-yaade-terminal-fit=""
          data-yaade-terminal-surface=""
        />
        <Button
          ref={jumpToLiveRef}
          type="button"
          size="sm"
          variant="secondary"
          aria-label="Jump to live"
          aria-hidden="true"
          tabIndex={-1}
          inert
          data-yaade-jump-to-live=""
          data-visible="false"
          data-mode="live"
          data-unseen-rows="0"
          className="absolute bottom-2 right-4 z-20 min-h-[44px] min-w-[44px] gap-1.5 rounded-full border border-border/70 bg-popover/95 px-3 text-popover-foreground opacity-100 shadow-md backdrop-blur-sm transition-[opacity,transform] duration-[var(--yaade-motion-hot)] data-[visible=false]:pointer-events-none data-[visible=false]:translate-y-1 data-[visible=false]:opacity-0 motion-reduce:translate-y-0 motion-reduce:transition-none sm:min-h-8 sm:min-w-0"
          onMouseDown={event => event.stopPropagation()}
          onClick={() => {
            if (onJumpToLive) onJumpToLive()
            else surfaceRef.current?.jumpToLive()
          }}
        >
          <ArrowDown className="size-3.5" aria-hidden />
          <span ref={jumpToLiveLabelRef}>Jump to live</span>
        </Button>
      </div>
      {displayStatus === "starting" || deferPty ? (
        <div
          role="status"
          aria-live="polite"
          data-yaade-terminal-starting=""
          data-yaade-terminal-defer-pty={deferPty ? "1" : undefined}
          className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/70 text-xs text-muted-foreground"
        >
          <Spinner className="size-4 text-muted-foreground" />
          <span>
            {startingMessage ??
              (deferPty ? "Preparing terminal…" : `Starting ${launchCommand ?? "terminal"}…`)}
          </span>
        </div>
      ) : null}
      {terminalError ? (
        <div
          role="alert"
          className="pointer-events-none absolute inset-x-0 bottom-7 border-t border-destructive/30 bg-background/90 px-3 py-2 text-xs text-destructive"
        >
          Ghostty terminal failed to load: {terminalError}
        </div>
      ) : null}
      {readOnly ? (
        <div
          role="status"
          data-yaade-terminal-archived=""
          className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-md border bg-popover px-2.5 py-1 text-center text-xs text-popover-foreground shadow-md"
        >
          {readOnlyMessage}
        </div>
      ) : null}
      {displayStatus === "exited" || displayStatus === "failed" ? (
        <div
          data-yaade-terminal-exit-bar
          role={displayStatus === "failed" ? "alert" : "status"}
          className="flex h-7 shrink-0 items-center gap-2 border-t border-border/50 bg-muted/25 px-2 text-xs text-muted-foreground"
        >
          <span className="min-w-0 flex-1 truncate">
            {displayStatus === "failed"
              ? "Terminal failed to start"
              : `Process exited${displayExitCode == null ? "" : ` with code ${displayExitCode}`}`}
          </span>
          {onRestart ? (
            <Button type="button" size="xs" variant="ghost" onClick={onRestart}>
              <RotateCcw className="size-3" />
              Restart terminal
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Close terminal"
            onClick={onClose}
          >
            <X className="size-3" />
          </Button>
        </div>
      ) : null}
    </div>
  )
}
