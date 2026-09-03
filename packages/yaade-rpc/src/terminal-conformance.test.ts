import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { Schema } from "effect";
import { decodeTerminalDataFrame } from "./terminal-ws.js";

const Vector = Schema.Struct({
  id: Schema.String,
  inputHex: Schema.String,
  expected: Schema.optional(
    Schema.Struct({
      type: Schema.String,
      streamId: Schema.Number,
      epoch: Schema.Number,
      offset: Schema.Number,
      payloadHex: Schema.String,
    }),
  ),
  expectedError: Schema.optional(Schema.String),
});
const Corpus = Schema.Struct({ version: Schema.Literal(1), vectors: Schema.Array(Vector) });
const corpus = Schema.decodeUnknownSync(Corpus)(
  JSON.parse(
    readFileSync(
      resolve(process.cwd(), "tests/conformance/vectors/terminal-protocol.json"),
      "utf8",
    ),
  ),
);

describe("cross-language terminal protocol vectors", () => {
  for (const vector of corpus.vectors) {
    test(vector.id, () => {
      const decoded = decodeTerminalDataFrame(new Uint8Array(Buffer.from(vector.inputHex, "hex")));
      if (vector.expectedError) {
        expect(decoded, vector.expectedError).toBeNull();
        return;
      }
      expect(decoded?.frameType).toBe(vector.expected?.type);
      expect(decoded?.streamId).toBe(vector.expected?.streamId);
      expect(decoded?.streamEpoch).toBe(vector.expected?.epoch);
      expect(decoded?.terminalSequence).toBe(vector.expected?.offset);
      expect(Buffer.from(decoded?.payload ?? []).toString("hex")).toBe(vector.expected?.payloadHex);
    });
  }
});
