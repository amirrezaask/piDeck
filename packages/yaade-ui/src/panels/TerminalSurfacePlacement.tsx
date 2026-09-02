import { useLayoutEffect, useRef } from "react"
import {
  acquireTerminalSurfacePlacement,
  subscribeResidentTerminalSurface,
} from "./terminal-surface-placement.js"

/**
 * Moves the one resident, imperative terminal DOM mount into this layout slot.
 * The parser, renderer, transport subscription, canvas, and textarea stay owned
 * by the canonical TerminalPanel controller.
 */
export function TerminalSurfacePlacement(props: {
  readonly terminalId: string
  readonly focused?: boolean
  readonly visible?: boolean
  readonly onFocused?: (terminalId: string) => void
  readonly onInteraction?: (terminalId: string) => void
}) {
  const { terminalId, focused, visible = true, onFocused, onInteraction } = props
  const slotRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const slot = slotRef.current
    if (!slot) return
    let release: (() => void) | null = null
    const acquire = () => {
      release?.()
      release = acquireTerminalSurfacePlacement(
        terminalId,
        slot,
        visible,
      )
      if (!release || !focused) return
      slot
        .querySelector<HTMLTextAreaElement>("[data-ghostty-terminal-input]")
        ?.focus({ preventScroll: true })
      onFocused?.(terminalId)
    }
    acquire()
    const unsubscribe = subscribeResidentTerminalSurface(terminalId, acquire)
    return () => {
      unsubscribe()
      release?.()
    }
  }, [focused, onFocused, terminalId, visible])

  useLayoutEffect(() => {
    const slot = slotRef.current
    if (!slot || !onInteraction) return
    const interact = () => onInteraction(terminalId)
    slot.addEventListener("pointerdown", interact, { capture: true })
    return () => slot.removeEventListener("pointerdown", interact, { capture: true })
  }, [onInteraction, terminalId])

  return (
    <div
      ref={slotRef}
      className="relative h-full min-h-0 w-full overflow-hidden"
      data-yaade-terminal-placement={terminalId}
      data-focused={focused ? "" : undefined}
    />
  )
}
