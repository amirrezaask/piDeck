import { z } from 'zod';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);
export type JsonObject = z.infer<typeof JsonObjectSchema>;

export function encodeJson(value: JsonValue): string {
  return JSON.stringify(JsonValueSchema.parse(value));
}

export function decodeJson(value: string): JsonValue {
  return JsonValueSchema.parse(JSON.parse(value) as unknown);
}

export function decodeJsonObject(value: string): JsonObject {
  return JsonObjectSchema.parse(JSON.parse(value) as unknown);
}
