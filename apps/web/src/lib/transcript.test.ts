import type { ManagedAgentEvent } from '@nextflow/contracts';
import { describe, expect, it } from 'vitest';

import { mapPiEvents } from './transcript';

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

  it('maps lifecycle and tool activity to markers', () => {
    expect(
      mapPiEvents([
        event(1, 'agent_start'),
        event(2, 'tool_execution_start', { toolName: 'bash' }),
        event(3, 'tool_execution_end', { toolName: 'bash', isError: false }),
        event(4, 'agent_end'),
      ]),
    ).toMatchObject([
      { kind: 'marker', label: 'PI started the run', tone: 'active' },
      { kind: 'marker', label: 'Running bash', tone: 'active' },
      { kind: 'marker', label: 'bash finished', tone: 'success' },
      { kind: 'marker', label: 'Run finished', tone: 'success' },
    ]);
  });

  it('keeps failures visible and maps unknown events instead of dropping them', () => {
    expect(
      mapPiEvents([
        event(1, 'supervisor.run_failed', { message: 'Model credentials are missing' }),
        event(2, 'context_compacted'),
      ]),
    ).toMatchObject([
      { kind: 'error', label: 'Model credentials are missing' },
      { kind: 'marker', label: 'Context compacted' },
    ]);
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
