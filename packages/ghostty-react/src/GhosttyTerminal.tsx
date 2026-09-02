import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
} from "react"
import {
  GhosttyTerminalSurface,
  type GhosttyTerminalFont,
  type GhosttyTerminalSurfaceOptions,
} from "./surface.js"
import { matchTerminalUrls } from "./links.js"
import type { GhosttyTheme } from "./core.js"
import "./styles.css"

export type GhosttyTerminalHandle = GhosttyTerminalSurface

export interface GhosttyTerminalProps
  extends Omit<GhosttyTerminalSurfaceOptions, "theme" | "font" | "visible"> {
  readonly theme: GhosttyTheme
  readonly font?: GhosttyTerminalFont
  /** Skip canvas work while hidden while keeping the parser and input alive. */
  readonly visible?: boolean
  readonly className?: string
  readonly style?: CSSProperties
  readonly ariaLabel?: string
  /** Called after the WASM parser, canvas, and input surface are ready. */
  readonly onReady?: (surface: GhosttyTerminalSurface) => void
  /** Called when the WASM runtime or canvas cannot be initialized. */
  readonly onError?: (error: Error) => void
}

type GhosttyTerminalCallbacks = {
  onData?: GhosttyTerminalProps["onData"]
  onResize?: GhosttyTerminalProps["onResize"]
  onSelectionChange?: GhosttyTerminalProps["onSelectionChange"]
  beforeKey?: GhosttyTerminalProps["beforeKey"]
  onLinkActivate?: GhosttyTerminalProps["onLinkActivate"]
  linkMatcher?: GhosttyTerminalProps["linkMatcher"]
  onTitleChange?: GhosttyTerminalProps["onTitleChange"]
  onPresented?: GhosttyTerminalProps["onPresented"]
  onReady?: GhosttyTerminalProps["onReady"]
  onError?: GhosttyTerminalProps["onError"]
}

function asError(value: Error | string): Error {
  return value instanceof Error ? value : new Error(value)
}

/**
 * A browser-native Ghostty terminal surface.
 *
 * The component owns WASM, canvas, IME, selection, scrollback, and sizing. A
 * host only needs to send parsed PTY output through the imperative surface and
 * consume `onData`/`onResize` events. No process, transport, or application
 * state is coupled to this component.
 */
export const GhosttyTerminal = forwardRef<
  GhosttyTerminalHandle | null,
  GhosttyTerminalProps
>(function GhosttyTerminal(
  {
    theme,
    font,
    visible = true,
    renderer,
    runtime,
    className,
    style,
    ariaLabel = "Terminal",
    onData,
    onResize,
    onSelectionChange,
    beforeKey,
    onLinkActivate,
    linkMatcher,
    onTitleChange,
    onPresented,
    onReady,
    onError,
  },
  ref,
) {
  const mountRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<GhosttyTerminalSurface | null>(null)
  const [surface, setSurface] = useState<GhosttyTerminalSurface | null>(null)
  const callbacksRef = useRef<GhosttyTerminalCallbacks>({})
  callbacksRef.current = {
    onData,
    onResize,
    onSelectionChange,
    beforeKey,
    onLinkActivate,
    linkMatcher,
    onTitleChange,
    onPresented,
    onReady,
    onError,
  }
  const themeRef = useRef(theme)
  const fontRef = useRef(font)
  const visibleRef = useRef(visible)
  themeRef.current = theme
  fontRef.current = font
  visibleRef.current = visible

  useImperativeHandle<GhosttyTerminalHandle | null, GhosttyTerminalHandle | null>(
    ref,
    () => surface,
    [surface],
  )

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    let cancelled = false

    void GhosttyTerminalSurface.create(mount, {
      theme: themeRef.current,
      font: fontRef.current,
      visible: visibleRef.current,
      renderer,
      runtime,
      onData: (data) => callbacksRef.current.onData?.(data),
      onResize: (cols, rows) => callbacksRef.current.onResize?.(cols, rows),
      onSelectionChange: () => callbacksRef.current.onSelectionChange?.(),
      beforeKey: (event) => callbacksRef.current.beforeKey?.(event) ?? true,
      onLinkActivate: (text, event) => callbacksRef.current.onLinkActivate?.(text, event),
      linkMatcher: (line) =>
        callbacksRef.current.linkMatcher?.(line) ?? matchTerminalUrls(line),
      onTitleChange: (title) => callbacksRef.current.onTitleChange?.(title),
      onPresented: sample => callbacksRef.current.onPresented?.(sample),
      onRuntimeError: error => callbacksRef.current.onError?.(error),
    }).then(
      (next) => {
        if (cancelled) {
          next.dispose()
          return
        }
        // Props may change while WASM and fonts are loading. Apply the latest
        // values before exposing the surface so onReady never observes stale
        // theme, font, or visibility state.
        next.setTheme(themeRef.current)
        void next.setFont(fontRef.current ?? {})
        next.setVisible(visibleRef.current)
        surfaceRef.current = next
        setSurface(next)
        callbacksRef.current.onReady?.(next)
      },
      (reason: Error | string) => {
        if (!cancelled) callbacksRef.current.onError?.(asError(reason))
      },
    )

    return () => {
      cancelled = true
      const current = surfaceRef.current
      surfaceRef.current = null
      if (current) current.dispose()
      setSurface(null)
    }
  }, [])

  useEffect(() => {
    surface?.setTheme(theme)
  }, [surface, theme])

  useEffect(() => {
    if (!surface) return
    void surface.setFont(font ?? {})
  }, [surface, font])

  useEffect(() => {
    surface?.setVisible(visible)
  }, [surface, visible])

  const classes = ["ghostty-terminal", className].filter(Boolean).join(" ")
  return (
    <div
      ref={mountRef}
      className={classes}
      style={style}
      role="application"
      aria-label={ariaLabel}
      aria-busy={surface === null}
      data-ghostty-terminal-ready={surface === null ? "false" : "true"}
    />
  )
})

GhosttyTerminal.displayName = "GhosttyTerminal"
