const easeOutCss = "cubic-bezier(0.23, 1, 0.32, 1)"

export const yaadeMotion = {
  ease: {
    outCss: easeOutCss,
  },
  duration: {
    hot: 0.12,
    fast: 0.12,
    overlay: 0.18,
    panel: 0.22,
    slowMenu: 0.24,
    scroll: 0.14,
    entity: 0.24,
    overlayExit: 0.15,
  },
  css: {
    hot: "var(--yaade-motion-hot)",
    fast: "var(--yaade-motion-fast)",
    menu: "var(--yaade-motion-menu)",
    overlay: "var(--yaade-motion-overlay)",
    panel: "var(--yaade-motion-panel)",
    slowMenu: "var(--yaade-motion-slow-menu)",
    scroll: "var(--yaade-motion-scroll)",
    entity: "var(--yaade-motion-entity)",
    squishScale: "var(--yaade-motion-squish-scale)",
  },
  squishScale: 0.9,
  /** Fixed-duration overlay transition approximating RAD menu rate (N=70). */
  overlayTransition: { duration: 0.18 /* overlay */, ease: "easeOut" as const },
  quickFade: { duration: 0.12, ease: "easeOut" as const },
  tabGhostTransition: { duration: 0.18 /* overlay */, ease: "easeOut" as const },
  dockDropTransition: { duration: 0.18, ease: easeOutCss },
  /** Critically damped: pane geometry can be retargeted mid-settle without bounce. */
  dockLayoutTransition: {
    type: "spring" as const,
    stiffness: 500,
    damping: 45,
    mass: 1,
  },
  layoutTransition: { duration: 0.16, ease: "easeOut" as const },
  sidebarTransition: { duration: 0.16, ease: "easeOut" as const },
}

export const yaadePressClass = "yaade-press"
export const yaadeInteractiveRowClass = "yaade-interactive-row"
export const yaadeFocusRingClass = "yaade-focus-ring"
export const yaadeDisabledClass = "yaade-disabled"
export const yaadeScrollFadeClass = "yaade-scroll-fade"

export const yaadeOverlayEnterClass = "yaade-overlay-enter"

export type YaadeOverlayMotion = "instant" | "standard"

export const yaadeOverlayContentClass = "yaade-dialog-motion"

export const yaadePopoverContentClass =
  "duration-[var(--yaade-motion-menu)] ease-[var(--yaade-ease-out)] data-[state=closed]:duration-[var(--yaade-motion-fast)] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"

export const yaadeMenuContentClass =
  "duration-[var(--yaade-motion-menu)] ease-[var(--yaade-ease-out)] data-[state=closed]:duration-[var(--yaade-motion-fast)]"
