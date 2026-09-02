export type IdleReclaimInput = {
  readonly now: number
  readonly allocatedBytes: number
  readonly targetBytes: number
  readonly inFlight: number
  readonly queued: number
  readonly lastActivityAt: number
  readonly lastResizeAt: number
}

export type IdleReclaimPolicy = {
  readonly idleMs: number
  readonly cooldownMs: number
  readonly minimumReclaimBytes: number
  readonly shrinkRatio: number
}

export const IDLE_RECLAIM_POLICY = {
  idleMs: 30_000,
  cooldownMs: 60_000,
  minimumReclaimBytes: 1024 * 1024,
  shrinkRatio: 4,
} as const satisfies IdleReclaimPolicy

export function shouldReclaimIdleCapacity(
  input: IdleReclaimInput,
  policy: IdleReclaimPolicy = IDLE_RECLAIM_POLICY,
): boolean {
  if (input.inFlight > 0 || input.queued > 0) return false
  if (input.allocatedBytes <= input.targetBytes) return false
  if (input.now - input.lastActivityAt < policy.idleMs) return false
  if (input.now - input.lastResizeAt < policy.cooldownMs) return false
  if (input.allocatedBytes < input.targetBytes * policy.shrinkRatio) return false
  return input.allocatedBytes - input.targetBytes >= policy.minimumReclaimBytes
}
