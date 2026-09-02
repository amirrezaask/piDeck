import { strict as assert } from "node:assert";
import { test } from "vite-plus/test";
import { WebGlGlyphBatch, WebGlRectBatch } from "./batches.js";

test("rectangle batches reuse storage and enforce their bound", () => {
  const batch = new WebGlRectBatch(2);
  assert.equal(batch.push(1, 2, 3, 4, 0.1, 0.2, 0.3), true);
  const buffer = batch.data.buffer;
  assert.equal(batch.push(5, 6, 7, 8, 0.4, 0.5, 0.6), true);
  assert.equal(batch.push(9, 9, 9, 9, 1, 1, 1), false);
  assert.equal(batch.count, 2);
  assert.deepEqual(Array.from(batch.data.slice(0, 4)), [1, 2, 3, 4]);
  batch.clear();
  batch.push(0, 0, 1, 1, 1, 1, 1);
  assert.equal(batch.data.buffer, buffer);
});

test("packed rectangle colors expose exact used and allocated bytes", () => {
  const batch = new WebGlRectBatch(128);
  const allocated = batch.allocatedBytes;
  assert.equal(batch.pushPacked(1, 2, 3, 4, 0xff8040, 0.5), true);
  assert.equal(batch.usedBytes, 8 * Float32Array.BYTES_PER_ELEMENT);
  assert.equal(batch.allocatedBytes, allocated);
  assert.equal(batch.data[4], 1);
  assert.ok(Math.abs((batch.data[5] ?? 0) - 128 / 255) < 1e-6);
  assert.ok(Math.abs((batch.data[6] ?? 0) - 64 / 255) < 1e-6);
  assert.equal(batch.data[7], 0.5);
  batch.clear();
  assert.equal(batch.usedBytes, 0);
  assert.equal(batch.allocatedBytes, allocated);
});

test("idle batch trimming keeps current primitives and headroom", () => {
  const batch = new WebGlRectBatch(4_096)
  for (let index = 0; index < 2_048; index += 1) {
    assert.equal(batch.push(index, 2, 3, 4, 1, 1, 1), true)
  }
  const highWater = batch.allocatedBytes
  batch.clear()
  assert.equal(batch.push(7, 8, 9, 10, 1, 1, 1), true)
  const expected = Array.from(batch.data)
  const reclaimed = batch.trimCapacity()
  assert.ok(reclaimed > 0)
  assert.ok(batch.allocatedBytes < highWater)
  assert.ok(batch.allocatedBytes >= batch.usedBytes * 2)
  assert.deepEqual(Array.from(batch.data), expected)
})

test("glyph batches retain UV, tint, alpha, and color mode", () => {
  const batch = new WebGlGlyphBatch(1);
  assert.equal(batch.push(1, 2, 3, 4, 0.1, 0.2, 0.3, 0.4, 1, 0.5, 0.25, 0.75, 1), true);
  assert.equal(batch.data.length, 13);
  assert.equal(batch.data[12], 1);
  assert.equal(batch.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), false);
});
