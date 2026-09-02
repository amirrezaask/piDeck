/** Exponential smoothing rates used by the UI's interruptible motion. */
export const YAADE_RATE_MENU = 70

export const YAADE_LAYOUT_EPSILON = 0.5

/** Per-frame exponential rate from half-life N and delta time (seconds). */
export function radAnimationRate(halfLifeN: number, dt: number): number {
  if (halfLifeN <= 0 || dt <= 0) return 1
  return 1 - Math.pow(2, -halfLifeN * dt)
}

/** Single-step exponential interpolation. */
export function radLerp(current: number, target: number, rate: number): number {
  if (rate >= 1) return target
  if (rate <= 0) return current
  return current + rate * (target - current)
}
