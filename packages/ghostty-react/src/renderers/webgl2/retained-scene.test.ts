import { strict as assert } from "node:assert";
import { test } from "vite-plus/test";
import { WebGlGlyphBatch, WebGlRectBatch } from "./batches.js";
import {
  WebGlRetainedScene,
  type RetainedRowBatches,
  type ScenePrimitivePlan,
} from "./retained-scene.js";

function row(backgrounds: number, decorations: number, glyphs: number, seed: number): RetainedRowBatches {
  const backgroundBatch = new WebGlRectBatch(32);
  const decorationBatch = new WebGlRectBatch(32);
  const glyphBatch = new WebGlGlyphBatch(32);
  for (let index = 0; index < backgrounds; index += 1) {
    assert.equal(backgroundBatch.push(seed + index, 1, 2, 3, 0.1, 0.2, 0.3), true);
  }
  for (let index = 0; index < decorations; index += 1) {
    assert.equal(decorationBatch.push(seed + index, 4, 5, 6, 0.4, 0.5, 0.6), true);
  }
  for (let index = 0; index < glyphs; index += 1) {
    assert.equal(glyphBatch.push(seed + index, 7, 8, 9, 0, 0, 1, 1, 0.7, 0.8, 0.9), true);
  }
  return { backgrounds: backgroundBatch, decorations: decorationBatch, glyphs: glyphBatch };
}

function ranges(plan: ScenePrimitivePlan): readonly { readonly offset: number; readonly length: number }[] {
  return plan.kind === "partial"
    ? plan.ranges.map(range => ({ offset: range.offset, length: range.data.length }))
    : [];
}

test("retained scene distinguishes no-op, partial, and primitive topology updates", () => {
  const scene = new WebGlRetainedScene();
  const rows = [row(1, 1, 1, 10), row(1, 1, 1, 20), row(1, 1, 1, 30)];
  const initial = scene.replaceAll(rows);
  assert.equal(initial.backgrounds.kind, "full");
  assert.equal(initial.decorations.kind, "full");
  assert.equal(initial.glyphs.kind, "full");

  const noChange = scene.updateRows([]);
  assert.deepEqual([noChange.backgrounds.kind, noChange.decorations.kind, noChange.glyphs.kind], ["none", "none", "none"]);

  const stable = row(1, 1, 1, 40);
  const partial = scene.updateRows([{ row: 1, batches: stable }]);
  assert.deepEqual(ranges(partial.backgrounds), [{ offset: 8, length: 8 }]);
  assert.deepEqual(ranges(partial.glyphs), [{ offset: 13, length: 13 }]);

  const glyphGrowth = row(1, 1, 2, 50);
  const topology = scene.updateRows([{ row: 1, batches: glyphGrowth }]);
  assert.equal(topology.backgrounds.kind, "partial");
  assert.equal(topology.decorations.kind, "partial");
  assert.equal(topology.glyphs.kind, "full");
  assert.equal(scene.glyphCount, 4);
});

test("retained scene merges adjacent ranges and keeps sparse ranges separate", () => {
  const scene = new WebGlRetainedScene();
  scene.replaceAll([row(1, 0, 0, 1), row(1, 0, 0, 2), row(1, 0, 0, 3), row(1, 0, 0, 4)]);
  const plan = scene.updateRows([
    { row: 0, batches: row(1, 0, 0, 10) },
    { row: 1, batches: row(1, 0, 0, 20) },
    { row: 3, batches: row(1, 0, 0, 40) },
  ]);
  assert.deepEqual(ranges(plan.backgrounds), [
    { offset: 0, length: 16 },
    { offset: 24, length: 8 },
  ]);
});

test("retained scene trims transient high water without changing authoritative data", () => {
  const scene = new WebGlRetainedScene()
  const backgrounds = new WebGlRectBatch(131_072)
  for (let index = 0; index < 65_536; index += 1) {
    assert.equal(backgrounds.push(index, 0, 1, 1, 1, 1, 1), true)
  }
  scene.replaceAll([{
    backgrounds,
    decorations: new WebGlRectBatch(1),
    glyphs: new WebGlGlyphBatch(1),
  }])
  const highWater = scene.allocatedBytes
  const current = row(1, 1, 1, 42)
  scene.replaceAll([current])
  const expected = {
    backgrounds: Array.from(scene.backgroundData),
    decorations: Array.from(scene.decorationData),
    glyphs: Array.from(scene.glyphData),
  }
  const reclaimed = scene.trimCapacity()
  assert.ok(reclaimed >= 1024 * 1024)
  assert.ok(scene.allocatedBytes < highWater)
  assert.deepEqual(Array.from(scene.backgroundData), expected.backgrounds)
  assert.deepEqual(Array.from(scene.decorationData), expected.decorations)
  assert.deepEqual(Array.from(scene.glyphData), expected.glyphs)
})

test("mixed partial and topology updates equal a fresh full compaction", () => {
  const scene = new WebGlRetainedScene();
  const rows = [row(1, 0, 1, 1), row(2, 1, 1, 10), row(0, 2, 2, 20)];
  scene.replaceAll(rows);
  const backgroundBuffer = scene.backgroundData.buffer;
  rows[0] = row(1, 0, 1, 100);
  scene.updateRows([{ row: 0, batches: rows[0] }]);
  rows[2] = row(1, 1, 3, 200);
  scene.updateRows([{ row: 2, batches: rows[2] }]);
  assert.equal(scene.backgroundData.buffer, backgroundBuffer);

  const fresh = new WebGlRetainedScene();
  fresh.replaceAll(rows);
  assert.deepEqual([...scene.backgroundData], [...fresh.backgroundData]);
  assert.deepEqual([...scene.decorationData], [...fresh.decorationData]);
  assert.deepEqual([...scene.glyphData], [...fresh.glyphData]);
  assert.deepEqual(
    [scene.backgroundCount, scene.decorationCount, scene.glyphCount],
    [fresh.backgroundCount, fresh.decorationCount, fresh.glyphCount],
  );

  scene.clear();
  assert.equal(scene.usedBytes, 0);
  assert.equal(scene.replaceAll([]).glyphs.kind, "full");
});
