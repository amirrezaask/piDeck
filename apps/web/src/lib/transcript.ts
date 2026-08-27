import type { JsonValue, ManagedAgentEvent } from '@nextflow/contracts';

export type TranscriptMarkerVariant = 'default' | 'separator' | 'border';

export type TranscriptEvent =
  | {
      kind: 'marker';
      id: string;
      label: string;
      detail?: string;
      tone: 'neutral' | 'active' | 'success';
      variant: TranscriptMarkerVariant;
      shimmer?: boolean;
      toolCall?: boolean;
      toolArguments?: JsonValue;
      filePath?: string;
      createdAt: string;
      sequence: number;
    }
  | {
      kind: 'error';
      id: string;
      label: string;
      detail?: string;
      variant: 'border';
      createdAt: string;
      sequence: number;
    };

export type TranscriptItem =
  | {
      kind: 'assistant' | 'user';
      id: string;
      content: string;
      createdAt: string;
      sequence: number;
    }
  | TranscriptEvent
  | {
      kind: 'event-group';
      id: string;
      events: TranscriptEvent[];
      createdAt: string;
      sequence: number;
      startSequence: number;
      endSequence: number;
    };

export const TRANSCRIPT_EVENT_WINDOW = 1_000;

/**
 * Incremental sequence-keyed merge. Contiguous live delivery appends without a
 * full-history Map/sort and retention is capped; durable history stays server-side.
 */
export function mergeTranscriptEvents(
  current: readonly ManagedAgentEvent[],
  incoming: readonly ManagedAgentEvent[],
  limit = TRANSCRIPT_EVENT_WINDOW,
): ManagedAgentEvent[] {
  if (incoming.length === 0) return current as ManagedAgentEvent[];
  let next = current as ManagedAgentEvent[];
  for (const event of incoming) {
    const last = next.at(-1);
    if (!last || event.sequence > last.sequence) {
      next = next === current ? [...current, event] : [...next, event];
    } else {
      const index = binarySearchSequence(next, event.sequence);
      if (index < next.length && next[index]?.sequence === event.sequence) {
        if (next[index] === event) continue;
        next = [...next];
        next[index] = event;
      } else {
        next = [...next.slice(0, index), event, ...next.slice(index)];
      }
    }
    if (next.length > limit) next = next.slice(next.length - limit);
  }
  return next;
}

function binarySearchSequence(events: readonly ManagedAgentEvent[], sequence: number): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((events[middle]?.sequence ?? Number.POSITIVE_INFINITY) < sequence) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function collapseThinkingMarkers(events: readonly TranscriptEvent[]): TranscriptEvent[] {
  const collapsed: TranscriptEvent[] = [];
  let hasThinkingMarker = false;

  for (const event of events) {
    if (event.kind === 'marker' && event.label === 'Thinking...') {
      if (!hasThinkingMarker) collapsed.push(event);
      hasThinkingMarker = true;
      continue;
    }

    collapsed.push(event);
  }

  return collapsed;
}

export function mapPiEvents(events: readonly ManagedAgentEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const ordered = [...new Map(events.map((event) => [event.sequence, event])).values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const completedToolStarts = new Set<number>();
  const activeToolStarts = new Map<string, number[]>();
  for (const event of ordered) {
    const payload = asRecord(event.payload);
    const toolName = typeof payload.toolName === 'string' ? payload.toolName : 'tool';
    if (event.type === 'tool_execution_start') {
      const starts = activeToolStarts.get(toolName) ?? [];
      starts.push(event.sequence);
      activeToolStarts.set(toolName, starts);
      continue;
    }
    if (event.type !== 'tool_execution_end') continue;

    const startSequence = activeToolStarts.get(toolName)?.shift();
    if (startSequence !== undefined && payload.isError !== true) {
      completedToolStarts.add(startSequence);
    }
  }

  for (const event of ordered) {
    const payload = asRecord(event.payload);
    const assistantEvent = asRecord(payload.assistantMessageEvent);
    if (
      event.type === 'message_update' &&
      assistantEvent.type === 'text_delta' &&
      typeof assistantEvent.delta === 'string'
    ) {
      const previous = items.at(-1);
      if (previous?.kind === 'assistant') {
        previous.content += assistantEvent.delta;
        previous.sequence = event.sequence;
        continue;
      }
      items.push({
        kind: 'assistant',
        id: `assistant-${event.sequence}`,
        content: assistantEvent.delta,
        createdAt: event.createdAt,
        sequence: event.sequence,
      });
      continue;
    }

    const mapped = mapEvent(event, payload, completedToolStarts.has(event.sequence));
    if (mapped) items.push(mapped);
  }

  return groupConsecutiveEvents(items);
}

function groupConsecutiveEvents(items: readonly TranscriptItem[]): TranscriptItem[] {
  const grouped: TranscriptItem[] = [];
  let pending: TranscriptEvent[] = [];

  const flush = () => {
    if (pending.length > 0) {
      grouped.push({
        kind: 'event-group',
        id: `event-group-${pending[0].sequence}`,
        events: pending,
        createdAt: pending[0].createdAt,
        sequence: pending.at(-1)?.sequence ?? pending[0].sequence,
        startSequence: pending[0].sequence,
        endSequence: pending.at(-1)?.sequence ?? pending[0].sequence,
      });
    }
    pending = [];
  };

  for (const item of items) {
    if (item.kind === 'marker' || item.kind === 'error') pending.push(item);
    else {
      flush();
      grouped.push(item);
    }
  }
  flush();
  return grouped;
}

const THINKING_EVENT_TYPES = new Set([
  'agent_start',
  'turn_start',
  'message_start',
  'message_end',
  'turn_end',
  'agent_end',
  'agent_settled',
]);

function thinkingMarker(base: {
  id: string;
  createdAt: string;
  sequence: number;
}): TranscriptEvent {
  return {
    ...base,
    kind: 'marker',
    label: 'Thinking...',
    tone: 'active',
    variant: 'default',
    shimmer: true,
  };
}

function mapEvent(
  event: ManagedAgentEvent,
  payload: Record<string, JsonValue>,
  toolCompleted = false,
):
  | TranscriptEvent
  | { kind: 'user'; id: string; content: string; createdAt: string; sequence: number }
  | undefined {
  const base = {
    id: `event-${event.sequence}`,
    createdAt: event.createdAt,
    sequence: event.sequence,
  };
  const toolName = typeof payload.toolName === 'string' ? payload.toolName : undefined;
  const message = stringValue(payload.message);

  if (
    event.type === 'supervisor.follow_up_accepted' ||
    event.type === 'supervisor.steer_accepted'
  ) {
    return message ? { ...base, kind: 'user', content: message } : undefined;
  }

  if (event.type.includes('failed') || event.type.includes('rejected')) {
    return {
      ...base,
      kind: 'error',
      label: stringValue(payload.message) ?? humanize(event.type),
      detail: toolName ? `${toolName} failed` : undefined,
      variant: 'border',
    };
  }

  if (THINKING_EVENT_TYPES.has(event.type)) return thinkingMarker(base);

  if (event.type === 'message_update' || event.type === 'tool_execution_update') return undefined;

  if (event.type === 'tool_execution_start') {
    const toolArguments = payload.args !== undefined ? payload.args : payload.arguments;
    const filePath = extractFilePath(toolName, toolArguments);

    return {
      ...base,
      kind: 'marker',
      label: toolCompleted ? `Ran ${toolName ?? 'tool'}` : `Running ${toolName ?? 'tool'}`,
      tone: toolCompleted ? 'success' : 'active',
      variant: toolCompleted ? 'border' : 'default',
      shimmer: !toolCompleted,
      toolCall: true,
      toolArguments,
      ...(filePath ? { filePath } : {}),
    };
  }
  if (event.type === 'tool_execution_end') {
    if (payload.isError !== true) return undefined;

    return {
      ...base,
      kind: 'marker',
      label: `${toolName ?? 'Tool'} failed`,
      tone: 'neutral',
      variant: 'border',
    };
  }
  if (event.type === 'supervisor.prompt_accepted') {
    return {
      ...base,
      kind: 'marker',
      label: 'Prompt accepted',
      tone: 'success',
      variant: 'default',
    };
  }

  // The run status already communicates successful completion; avoid duplicating it in the transcript.
  if (event.type === 'supervisor.run_completed') return undefined;

  return {
    ...base,
    kind: 'marker',
    label: humanize(event.type),
    detail: toolName,
    tone: 'neutral',
    variant: 'default',
  };
}

function extractFilePath(
  toolName: string | undefined,
  value: JsonValue | undefined,
): string | undefined {
  if (!toolName || !['read', 'edit', 'write'].includes(toolName)) return undefined;

  const argumentsRecord = asRecord(value);
  for (const key of ['path', 'filePath', 'fileName', 'filename', 'file']) {
    const candidate = argumentsRecord[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }

  return undefined;
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function humanize(value: string): string {
  const words = value.replaceAll('.', ' ').replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
