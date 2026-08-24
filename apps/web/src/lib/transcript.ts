import type { JsonValue, ManagedAgentEvent } from '@nextflow/contracts';

export type TranscriptItem =
  | {
      kind: 'assistant';
      id: string;
      content: string;
      createdAt: string;
      sequence: number;
    }
  | {
      kind: 'marker';
      id: string;
      label: string;
      detail?: string;
      tone: 'neutral' | 'active' | 'success';
      createdAt: string;
      sequence: number;
    }
  | {
      kind: 'error';
      id: string;
      label: string;
      detail?: string;
      createdAt: string;
      sequence: number;
    };

export function mapPiEvents(events: readonly ManagedAgentEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const ordered = [...new Map(events.map((event) => [event.sequence, event])).values()].sort(
    (left, right) => left.sequence - right.sequence,
  );

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

    const mapped = mapEvent(event, payload);
    if (mapped) items.push(mapped);
  }

  return items;
}

function mapEvent(
  event: ManagedAgentEvent,
  payload: Record<string, JsonValue>,
): Exclude<TranscriptItem, { kind: 'assistant' }> | undefined {
  const base = {
    id: `event-${event.sequence}`,
    createdAt: event.createdAt,
    sequence: event.sequence,
  };
  const toolName = typeof payload.toolName === 'string' ? payload.toolName : undefined;

  if (event.type.includes('failed') || event.type.includes('rejected')) {
    return {
      ...base,
      kind: 'error',
      label: stringValue(payload.message) ?? humanize(event.type),
      detail: toolName ? `${toolName} failed` : undefined,
    };
  }

  if (event.type === 'tool_execution_start') {
    return { ...base, kind: 'marker', label: `Running ${toolName ?? 'tool'}`, tone: 'active' };
  }
  if (event.type === 'tool_execution_end') {
    return {
      ...base,
      kind: 'marker',
      label: `${toolName ?? 'Tool'} ${payload.isError === true ? 'failed' : 'finished'}`,
      tone: payload.isError === true ? 'neutral' : 'success',
    };
  }
  if (event.type === 'agent_start') {
    return { ...base, kind: 'marker', label: 'PI started the run', tone: 'active' };
  }
  if (event.type === 'supervisor.prompt_accepted') {
    return { ...base, kind: 'marker', label: 'Prompt accepted', tone: 'success' };
  }
  if (event.type === 'agent_end' || event.type === 'agent_settled') {
    return { ...base, kind: 'marker', label: 'Run finished', tone: 'success' };
  }
  if (event.type === 'message_update') return undefined;

  return {
    ...base,
    kind: 'marker',
    label: humanize(event.type),
    detail: toolName,
    tone: 'neutral',
  };
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
