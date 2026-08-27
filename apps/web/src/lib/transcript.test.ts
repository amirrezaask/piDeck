import type { ManagedAgentEvent } from '@nextflow/contracts';
import { describe, expect, it } from 'vitest';

import {
  collapseThinkingMarkers,
  mapPiEvents,
  mergeTranscriptEvents,
  TRANSCRIPT_EVENT_WINDOW,
} from './transcript';

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
            label: 'Ran bash',
            tone: 'success',
            toolCall: true,
            toolArguments: { command: 'pwd' },
          },
          { kind: 'marker', label: 'Thinking...', tone: 'active' },
        ],
      },
    ]);
  });

  it('hides successful tool completion markers but keeps failures visible', () => {
    expect(
      mapPiEvents([event(1, 'tool_execution_end', { toolName: 'read', isError: false })]),
    ).toEqual([]);
    expect(
      mapPiEvents([event(2, 'tool_execution_end', { toolName: 'read', isError: true })]),
    ).toMatchObject([
      {
        kind: 'event-group',
        events: [{ kind: 'marker', label: 'read failed' }],
      },
    ]);
  });

  it('extracts file paths from file tool calls', () => {
    expect(
      mapPiEvents([
        event(1, 'tool_execution_start', {
          toolName: 'read',
          args: { path: '/workspace/src/App.tsx' },
        }),
      ]),
    ).toMatchObject([
      {
        kind: 'event-group',
        events: [
          {
            kind: 'marker',
            label: 'Running read',
            filePath: '/workspace/src/App.tsx',
          },
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

  it('omits the redundant successful supervisor completion marker', () => {
    expect(mapPiEvents([event(1, 'supervisor.run_completed')])).toEqual([]);
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

describe('mergeTranscriptEvents', () => {
  it('incrementally retains a bounded tail for a 10k-event fixture', () => {
    let retained: ManagedAgentEvent[] = [];
    let copiedEvents = 0;
    const started = performance.now();
    for (let sequence = 1; sequence <= 10_000; sequence += 1) {
      retained = mergeTranscriptEvents(retained, [event(sequence, 'agent_start')]);
      copiedEvents += Math.min(sequence, TRANSCRIPT_EVENT_WINDOW);
    }
    const elapsedMs = performance.now() - started;

    expect(retained).toHaveLength(TRANSCRIPT_EVENT_WINDOW);
    expect(retained[0]?.sequence).toBe(9_001);
    expect(retained.at(-1)?.sequence).toBe(10_000);
    expect({ retained: retained.length, elapsedMs, copiedEvents }).toMatchObject({
      retained: 1_000,
      copiedEvents: 9_500_500,
    });
  });

  it('replaces duplicates and inserts out-of-order events without changing sequence order', () => {
    const original = event(2, 'agent_start');
    const replacement = event(2, 'agent_end');
    const retained = mergeTranscriptEvents(
      [original, event(4, 'agent_end')],
      [replacement, event(3, 'message_start')],
    );

    expect(retained.map((item) => [item.sequence, item.type])).toEqual([
      [2, 'agent_end'],
      [3, 'message_start'],
      [4, 'agent_end'],
    ]);
  });
});
