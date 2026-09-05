/** Ceiling uses the selected clock, never a slower clock measured under load.
 * @param {{ ceiling: number, frameAllowance?: number, processingAllowanceMs?: number }} objective
 * @param {number} refreshHz
 */
export function budgetCeiling(objective, refreshHz) {
  if (![60, 120].includes(refreshHz)) throw new Error(`Unsupported refresh profile: ${refreshHz}`)
  if (objective.frameAllowance === undefined && objective.processingAllowanceMs === undefined)
    return objective.ceiling
  if (
    typeof objective.frameAllowance !== "number" ||
    typeof objective.processingAllowanceMs !== "number" ||
    !Number.isInteger(objective.frameAllowance) ||
    !(objective.frameAllowance > 0) ||
    !Number.isFinite(objective.processingAllowanceMs) ||
    !(objective.processingAllowanceMs >= 0)
  )
    throw new Error(
      "Frame budget requires positive integer frames and a nonnegative processing allowance",
    )
  return Math.ceil(objective.processingAllowanceMs + (objective.frameAllowance * 1000) / refreshHz)
}

/** @param {number} selectedHz @param {number} observedHz @param {number} tolerance */
export function validateRefreshProfile(selectedHz, observedHz, tolerance) {
  if (
    ![60, 120].includes(selectedHz) ||
    !Number.isFinite(observedHz) ||
    !Number.isFinite(tolerance) ||
    tolerance <= 0 ||
    tolerance >= 1 ||
    Math.abs(observedHz - selectedHz) > selectedHz * tolerance
  )
    throw new Error(
      `Refresh profile mismatch: selected ${selectedHz} Hz, observed ${observedHz} Hz`,
    )
}
