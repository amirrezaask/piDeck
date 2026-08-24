import type { ExecutionStatus } from '@nextflow/contracts';

const transitions: Record<ExecutionStatus, readonly ExecutionStatus[]> = {
  pending: ['starting', 'failed', 'cancelled', 'timed_out'],
  starting: ['running', 'failed', 'cancelled', 'timed_out'],
  running: ['succeeded', 'failed', 'cancelled', 'timed_out'],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

export function isTerminalExecutionStatus(status: ExecutionStatus): boolean {
  return (transitions[status] ?? []).length === 0;
}

export function canTransitionExecution(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return (transitions[from] ?? []).includes(to);
}

export class InvalidExecutionTransitionError extends Error {
  readonly code = 'invalid_state_transition';

  constructor(
    readonly from: ExecutionStatus,
    readonly to: ExecutionStatus,
  ) {
    super(`Cannot transition execution from ${from} to ${to}`);
    this.name = 'InvalidExecutionTransitionError';
  }
}

export function assertExecutionTransition(from: ExecutionStatus, to: ExecutionStatus): void {
  if (!canTransitionExecution(from, to)) {
    throw new InvalidExecutionTransitionError(from, to);
  }
}
