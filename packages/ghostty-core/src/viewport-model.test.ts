import { strict as assert } from "node:assert";
import { test } from "vite-plus/test";
import type { GhosttyCell, GhosttySnapshot } from "./core.js";
import { GhosttyRenderUpdateBuilder } from "./render-update.js";
import { GhosttyViewportModel } from "./viewport-model.js";

const foreground = { r: 250, g: 251, b: 252 };
const background = { r: 1, g: 2, b: 3 };

function cell(text: string, selected = false): GhosttyCell {
  return {
    text,
    wide: 0,
    foreground,
    background,
    bold: text === "B",
    italic: false,
    invisible: false,
    strikethrough: false,
    overline: false,
    underline: text === "u" ? 3 : 0,
    selected,
  };
}

function snapshot(lines: readonly string[], dirtyRows: number[]): GhosttySnapshot {
  const cols = lines[0]?.length ?? 1;
  return {
    cols,
    rows: lines.length,
    foreground,
    background,
    cursor: foreground,
    cursorX: 0,
    cursorY: 0,
    cursorVisible: true,
    cursorBlinking: false,
    cursorStyle: 1,
    dirtyRows: new Set(dirtyRows),
    rowData: lines.map((line, row) => ({
      cells: [...line].map((text, column) => cell(text, row === 1 && column === 0)),
      text: line,
      isWrapContinuation: row > 0,
      wrapsToNext: row < lines.length - 1,
    })),
  };
}

test("two partial updates reconstruct the same model as one full update", () => {
  const builder = new GhosttyRenderUpdateBuilder();
  const initial = builder.build({
    snapshot: snapshot(["aa", "bb"], [0, 1]),
    frameId: 1,
    generation: 1,
    full: true,
  });
  const partialModel = new GhosttyViewportModel();
  assert.equal(partialModel.apply(initial), true);
  builder.release(initial);

  const rowZero = builder.build({
    snapshot: snapshot(["BA", "bb"], [0]),
    frameId: 2,
    generation: 1,
    full: false,
  });
  assert.equal(partialModel.apply(rowZero), true);
  builder.release(rowZero);
  const rowOne = builder.build({
    snapshot: snapshot(["BA", "u界"], [1]),
    frameId: 3,
    generation: 1,
    full: false,
  });
  assert.equal(partialModel.apply(rowOne), true);
  builder.release(rowOne);

  const full = builder.build({
    snapshot: snapshot(["BA", "u界"], [0, 1]),
    frameId: 3,
    generation: 1,
    full: true,
  });
  const fullModel = new GhosttyViewportModel();
  assert.equal(fullModel.apply(full), true);
  builder.release(full);

  assert.deepEqual(partialModel.snapshot().rowData, fullModel.snapshot().rowData);
  assert.equal(partialModel.bufferText(), "BA\nu界");
});

test("keeps packed cells lazy until text or compatibility inspection", () => {
  const builder = new GhosttyRenderUpdateBuilder();
  const model = new GhosttyViewportModel();
  const update = builder.build({
    snapshot: snapshot(["ab", "cd"], [0, 1]),
    frameId: 1,
    generation: 1,
    full: true,
  });
  assert.equal(model.apply(update), true);
  builder.release(update);
  assert.equal(model.decodedGraphemes, 0);
  assert.equal(model.compatibilitySnapshotBuilds, 0);
  assert.equal(model.textAt(1, 0), "c");
  assert.equal(model.decodedGraphemes, 1);
  assert.equal(model.snapshot().rowData[0]?.text, "ab");
  assert.equal(model.compatibilitySnapshotBuilds, 1);
});

test("rejects stale frames and generation changes without a full frame", () => {
  const builder = new GhosttyRenderUpdateBuilder();
  const model = new GhosttyViewportModel();
  const first = builder.build({
    snapshot: snapshot(["x"], [0]),
    frameId: 5,
    generation: 1,
    full: true,
  });
  assert.equal(model.apply(first), true);
  assert.equal(model.apply(first), false);
  builder.release(first);

  const staleGeneration = builder.build({
    snapshot: snapshot(["z"], [0]),
    frameId: 6,
    generation: 0,
    full: true,
  });
  assert.equal(model.apply(staleGeneration), false);
  builder.release(staleGeneration);
  const partialGeneration = builder.build({
    snapshot: snapshot(["z"], [0]),
    frameId: 7,
    generation: 2,
    full: false,
  });
  assert.equal(model.apply(partialGeneration), false);
  builder.release(partialGeneration);
});

test("a full resize clears removed rows and cells", () => {
  const builder = new GhosttyRenderUpdateBuilder();
  const model = new GhosttyViewportModel();
  const large = builder.build({
    snapshot: snapshot(["abc", "def"], [0, 1]),
    frameId: 1,
    generation: 1,
    full: true,
  });
  assert.equal(model.apply(large), true);
  builder.release(large);
  const small = builder.build({
    snapshot: snapshot(["x"], [0]),
    frameId: 2,
    generation: 2,
    full: true,
  });
  assert.equal(model.apply(small), true);
  builder.release(small);
  assert.equal(model.rows, 1);
  assert.equal(model.cols, 1);
  assert.equal(model.bufferText(), "x");
});
