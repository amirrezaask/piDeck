import {
  createContext,
  use,
  useMemo,
  type ReactNode,
  type RefCallback,
} from "react"
import { createPortal } from "react-dom"

type SessionHeaderChromeContextValue = {
  target: HTMLElement | null
}

const SessionHeaderChromeContext =
  createContext<SessionHeaderChromeContextValue | null>(null)

export function SessionHeaderChromeProvider(props: {
  target: HTMLElement | null
  children: ReactNode
}) {
  const value = useMemo(() => ({ target: props.target }), [props.target])
  return (
    <SessionHeaderChromeContext.Provider value={value}>
      {props.children}
    </SessionHeaderChromeContext.Provider>
  )
}

/** Portal mode-specific terminal chrome into the session header. */
export function SessionHeaderChromePortal(props: {
  active: boolean
  children: ReactNode
}) {
  const ctx = use(SessionHeaderChromeContext)
  if (!props.active || !ctx?.target) return null
  return createPortal(props.children, ctx.target)
}

export function sessionHeaderContextRef(
  setTarget: (el: HTMLElement | null) => void,
): RefCallback<HTMLElement> {
  return el => setTarget(el)
}
