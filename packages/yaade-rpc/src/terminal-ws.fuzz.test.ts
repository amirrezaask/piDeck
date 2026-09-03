import { describe, expect, test } from "vitest";
import { decodeTerminalDataFrame, encodeTerminalDataFrame } from "./terminal-ws.js";

function randomBytes(seed: number, length: number): Uint8Array {
  const output = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    output[index] = state >>> 24;
  }
  return output;
}

describe("terminal wire bounded mutation fuzz", () => {
  test("never throws or accepts a frame with inconsistent payload bounds", () => {
    const seed = 0x40_5044;
    for (let iteration = 0; iteration < 10_000; iteration += 1) {
      const bytes = randomBytes(seed ^ iteration, iteration % 257);
      expect(() => decodeTerminalDataFrame(bytes)).not.toThrow();
      const decoded = decodeTerminalDataFrame(bytes);
      if (decoded?.frameType === "pty-data") {
        expect(decoded.payload.byteLength).toBeGreaterThan(0);
        expect(decoded.terminalSequence).toBeGreaterThanOrEqual(decoded.payload.byteLength);
      }
    }
  });

  test("round trips bounded legacy binary frames", () => {
    const seed = 0x51_aa_77;
    for (let iteration = 1; iteration <= 1_000; iteration += 1) {
      const payload = randomBytes(seed ^ iteration, iteration % 1024);
      const encoded = encodeTerminalDataFrame(iteration, iteration * 2, `t-${iteration}`, payload);
      const decoded = decodeTerminalDataFrame(encoded);
      expect(decoded?.eventSequence).toBe(iteration);
      expect(decoded?.terminalSequence).toBe(iteration * 2);
      expect(decoded?.id).toBe(`t-${iteration}`);
      expect(decoded?.payload).toEqual(payload);
    }
  });
});
