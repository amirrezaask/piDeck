import type { ManagedAgentEvent } from '@nextflow/contracts';
import * as React from 'react';
import type { SupervisorClient, StreamConnectionState } from './supervisor-client';
import { mapPiEvents, mergeTranscriptEvents } from './transcript';

interface RendererSoakProps {
  readonly client: SupervisorClient;
  readonly runId: string;
  readonly onConnectionState?: (state: StreamConnectionState) => void;
}

/**
 * Small production renderer probe used by the sustained event-stream test. It
 * deliberately uses the same client, bounded reducer, and mapped transcript
 * as the application rather than replacing them with a raw socket/array.
 */
export function RendererSoakProbe({ client, runId, onConnectionState }: RendererSoakProps) {
  const [events, setEvents] = React.useState<ManagedAgentEvent[]>([]);

  React.useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let lastSequence = 0;
    setEvents([]);

    void (async () => {
      try {
        const latest = await client.listRunEventPage(runId, {
          beforeSequence: Number.MAX_SAFE_INTEGER,
          limit: 500,
        });
        if (!active) return;
        lastSequence = latest.events.at(-1)?.sequence ?? 0;
        setEvents((current) => mergeTranscriptEvents(current, latest.events));
        for await (const event of client.streamRunEvents(runId, {
          afterSequence: lastSequence,
          signal: controller.signal,
          onConnectionState,
        })) {
          if (!active) return;
          lastSequence = Math.max(lastSequence, event.sequence);
          setEvents((current) => mergeTranscriptEvents(current, [event]));
        }
      } catch {
        // The soak records connection state and durable cursors separately.
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [client, onConnectionState, runId]);

  return (
    <output
      data-run-id={runId}
      data-event-count={events.length}
      data-rendered-items={mapPiEvents(events).length}
    >
      {runId}:{events.length}
    </output>
  );
}
