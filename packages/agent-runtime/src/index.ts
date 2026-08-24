import type { JsonObject, JsonValue } from '@nextflow/contracts';

import { IdSchema, JsonObjectSchema, JsonValueSchema } from '@nextflow/contracts';
import { z } from 'zod';

export const AgentExecutionRequestSchema = z.object({
  executionId: IdSchema,
  agentType: z.string().min(1),
  input: JsonValueSchema,
  config: JsonObjectSchema,
});
export type AgentExecutionRequest = z.infer<typeof AgentExecutionRequestSchema>;

export const CreateAgentRequestSchema = AgentExecutionRequestSchema.omit({ executionId: true });
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

export const AgentEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('started') }),
  z.object({ type: z.literal('message'), message: z.string() }),
  z.object({ type: z.literal('output'), output: JsonValueSchema }),
  z.object({ type: z.literal('completed') }),
  z.object({ type: z.literal('failed'), code: z.string().min(1), message: z.string().min(1) }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export interface AgentInstance {
  readonly id: string;
  execute(request: AgentExecutionRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
  dispose(): Promise<void>;
}

export interface AgentFactory {
  create(request: CreateAgentRequest): Promise<AgentInstance>;
}

export type { JsonObject, JsonValue };
