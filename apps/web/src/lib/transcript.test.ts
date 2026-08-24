import type { ManagedAgentEvent } from '@nextflow/contracts';
import { describe, expect, it } from 'vitest';

import { collapseThinkingMarkers, mapPiEvents } from './transcript';

const base = {
  agentId: '018bcfe4-7a4b-7000-8000-000000000111',
  runId: '018bcfe4-7a4b-7000-8000-000000000222',
  createdAt: '2026-08-23T20:00:00.000Z',
};

function event(
  sequence: number,
  type: string,
  payload: ManagedAgentEvent['payload'] = {},
): ManagedAgentEvent {
  return { ...base, sequence, type, payload };
}

describe('mapPiEvents', () => {
  it('sorts, deduplicates, and coalesces adjacent assistant text deltas', () => {
    const events = [
      event(2, 'message_update', {
        assistantMessageEvent: { type: 'text_delta', delta: ' world' },
      }),
      event(1, 'message_update', {
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
      }),
      event(2, 'message_update', {
        assistantMessageEvent: { type: 'text_delta', delta: ' world' },
      }),
    ];

    expect(mapPiEvents(events)).toEqual([
      expect.objectContaining({ kind: 'assistant', content: 'Hello world', sequence: 2 }),
    ]);
  });

  it('groups consecutive lifecycle and tool activity into a collapsible item', () => {
    expect(
      mapPiEvents([
        event(1, 'agent_start'),
        event(2, 'tool_execution_start', {
          toolName: 'bash',
          args: { command: 'pwd' },
        }),
        event(3, 'tool_execution_end', { toolName: 'bash', isError: false }),
        event(4, 'agent_end'),
      ]),
    ).toMatchObject([
      {
        kind: 'event-group',
        startSequence: 1,
        endSequence: 4,
        events: [
          { kind: 'marker', label: 'Thinking...', tone: 'active' },
          {
            kind: 'marker',
            label: 'Running bash',
            tone: 'active',
            toolCall: true,
            toolArguments: { command: 'pwd' },
          },
          { kind: 'marker', label: 'bash finished', tone: 'success' },
          { kind: 'marker', label: 'Thinking...', tone: 'active' },
        ],
      },
    ]);
  });

  it('maps lifecycle noise to shimmer thinking markers', () => {
    expect(
      mapPiEvents([
        event(1, 'message_start'),
        event(2, 'message_end'),
        event(3, 'turn_start'),
        event(4, 'turn_end'),
      ]),
    ).toMatchObject([
      {
        kind: 'event-group',
        events: [
          { kind: 'marker', label: 'Thinking...', variant: 'default', shimmer: true },
          { kind: 'marker', label: 'Thinking...', variant: 'default', shimmer: true },
          { kind: 'marker', label: 'Thinking...', variant: 'default', shimmer: true },
          { kind: 'marker', label: 'Thinking...', variant: 'default', shimmer: true },
        ],
      },
    ]);
  });

  it('collapses repeated thinking markers while keeping the raw event count', () => {
    const [item] = mapPiEvents([
      event(1, 'agent_start'),
      event(2, 'message_start'),
      event(3, 'message_end'),
      event(4, 'agent_end'),
    ]);

    expect(item.kind).toBe('event-group');
    if (item.kind !== 'event-group') throw new Error('Expected an event group');

    expect(item.events).toHaveLength(4);
    expect(collapseThinkingMarkers(item.events)).toMatchObject([
      { kind: 'marker', label: 'Thinking...', shimmer: true },
    ]);
  });

  it('keeps failures visible and maps unknown events instead of dropping them', () => {
    expect(
      mapPiEvents([
        event(1, 'supervisor.run_failed', { message: 'Model credentials are missing' }),
        event(2, 'context_compacted'),
      ]),
    ).toMatchObject([
      {
        kind: 'event-group',
        events: [
          { kind: 'error', label: 'Model credentials are missing' },
          { kind: 'marker', label: 'Context compacted' },
        ],
      },
    ]);
  });

  it('maps follow-up acceptance into a user transcript message', () => {
    expect(
      mapPiEvents([event(1, 'supervisor.follow_up_accepted', { message: 'Keep going.' })]),
    ).toMatchObject([{ kind: 'user', content: 'Keep going.' }]);
  });

  it('does not render non-text message update noise', () => {
    expect(
      mapPiEvents([
        event(1, 'message_update', {
          assistantMessageEvent: { type: 'text_end', content: 'Done' },
        }),
      ]),
    ).toEqual([]);
  });
});
