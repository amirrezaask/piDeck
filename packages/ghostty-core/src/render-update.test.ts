import { strict as assert } from "node:assert";
import { test } from "vite-plus/test";
import type { GhosttyCell, GhosttySnapshot } from "./core.js";
import {
  GHOSTTY_RENDER_STYLE,
  GhosttyRenderUpdateBuilder,
  ghosttyRenderUpdateBuffers,
  packGhosttyColor,
  unpackGhosttyColor,
  validateGhosttyRenderUpdate,
} from "./render-update.js";

const foreground = { r: 240, g: 241, b: 242 };
const background = { r: 3, g: 4, b: 5 };

function cell(text: string, overrides: Partial<GhosttyCell> = {}): GhosttyCell {
  return {
    text,
    wide: 0,
    foreground,
    background,
    bold: false,
    italic: false,
    invisible: false,
    strikethrough: false,
    overline: false,
    underline: 0,
    selected: false,
    ...overrides,
  };
}

function snapshot(rows: readonly (readonly GhosttyCell[])[], dirtyRows: number[]): GhosttySnapshot {
  return {
    cols: rows[0]?.length ?? 1,
    rows: rows.length,
    foreground,
    background,
    cursor: { r: 10, g: 20, b: 30 },
    cursorX: 1,
    cursorY: 0,
    cursorVisible: true,
    cursorBlinking: true,
    cursorStyle: 2,
    dirtyRows: new Set(dirtyRows),
    rowData: rows.map((cells, index) => ({
      cells,
      text: cells.map((value) => value.text || " ").join("").trimEnd(),
      isWrapContinuation: index === 1,
      wrapsToNext: index === 0,
    })),
  };
}

test("packs full rows, UTF-8 graphemes, cursor, colors, width, and every style", () => {
  const builder = new GhosttyRenderUpdateBuilder();
  const update = builder.build({
    snapshot: snapshot([
      [cell("A", { bold: true, italic: true, underline: 5 }), cell("界", { wide: 1 })],
      [cell("", { wide: 2 }), cell("e\u0301", {
        invisible: true,
        strikethrough: true,
        overline: true,
        selected: true,
      })],
    ], [0, 1]),
    frameId: 1,
    generation: 1,
    full: true,
  });

  assert.equal(validateGhosttyRenderUpdate(update), true);
  assert.deepEqual([...update.dirtyRows], [0, 1]);
  assert.equal(new TextDecoder().decode(update.graphemes), "A界e\u0301");
  assert.equal(update.cursorBlinking, true);
  assert.equal(update.cursorStyle, 2);
  assert.equal(update.styles[1]! & GHOSTTY_RENDER_STYLE.widthMask, 1);
  assert.equal(update.styles[2]! & GHOSTTY_RENDER_STYLE.widthMask, 2);
  assert.notEqual(update.styles[0]! & GHOSTTY_RENDER_STYLE.bold, 0);
  assert.notEqual(update.styles[0]! & GHOSTTY_RENDER_STYLE.italic, 0);
  assert.notEqual(update.styles[3]! & GHOSTTY_RENDER_STYLE.invisible, 0);
  assert.notEqual(update.styles[3]! & GHOSTTY_RENDER_STYLE.strikethrough, 0);
  assert.notEqual(update.styles[3]! & GHOSTTY_RENDER_STYLE.overline, 0);
  assert.notEqual(update.styles[3]! & GHOSTTY_RENDER_STYLE.selected, 0);
  assert.equal(unpackGhosttyColor(packGhosttyColor(foreground)).r, foreground.r);
  builder.release(update);
});

test("packs sorted partial rows and an empty update", () => {
  const builder = new GhosttyRenderUpdateBuilder();
  const source = snapshot([[cell("a")], [cell("b")], [cell("🙂")]], [2, 0]);
  const partial = builder.build({ snapshot: source, frameId: 2, generation: 1, full: false });
  assert.deepEqual([...partial.dirtyRows], [0, 2]);
  assert.equal(partial.graphemeOffsets.length, 2);
  assert.equal(validateGhosttyRenderUpdate(partial), true);
  builder.release(partial);

  const empty = builder.build({
    snapshot: snapshot([[cell("")]], []),
    frameId: 3,
    generation: 1,
    full: false,
  });
  assert.equal(empty.dirtyRows.length, 0);
  assert.equal(empty.graphemes.length, 0);
  assert.equal(validateGhosttyRenderUpdate(empty), true);
  builder.release(empty);
});

test("does not mutate a borrowed update and reuses a released buffer", () => {
  const builder = new GhosttyRenderUpdateBuilder();
  const first = builder.build({
    snapshot: snapshot([[cell("first")]], [0]),
    frameId: 1,
    generation: 1,
    full: true,
  });
  const firstText = new TextDecoder().decode(first.graphemes);
  const second = builder.build({
    snapshot: snapshot([[cell("second")]], [0]),
    frameId: 2,
    generation: 1,
    full: true,
  });
  assert.equal(new TextDecoder().decode(first.graphemes), firstText);
  builder.release(first);
  const firstBuffer = first.graphemes.buffer;
  const third = builder.build({
    snapshot: snapshot([[cell("third")]], [0]),
    frameId: 3,
    generation: 1,
    full: true,
  });
  assert.equal(third.graphemes.buffer, firstBuffer);
  builder.release(second);
  builder.release(third);
});

test("recycles exactly three transferred slots without steady replacement", () => {
  const builder = new GhosttyRenderUpdateBuilder()
  const source = snapshot([[cell("recycle")]], [0])
  const leases = [1, 2, 3].map(frameId => builder.tryBuild({
    snapshot: source,
    frameId,
    generation: 1,
    full: true,
  }))
  assert.ok(leases.every(lease => lease !== null))
  assert.equal(builder.tryBuild({ snapshot: source, frameId: 4, generation: 1, full: true }), null)
  const lease = leases[0]!
  assert.ok(lease)
  const transferred = structuredClone(lease.update, {
    transfer: Object.values(ghosttyRenderUpdateBuffers(lease.update)),
  })
  assert.equal(lease.update.graphemes.buffer.byteLength, 0)
  const returned = ghosttyRenderUpdateBuffers(transferred)
  const mainReleased = structuredClone(returned, {
    transfer: Object.values(returned),
  })
  assert.equal(returned.graphemes.byteLength, 0)
  assert.equal(builder.reclaim(lease.slotId, lease.leaseToken, mainReleased), true)
  assert.equal(builder.reclaim(lease.slotId, lease.leaseToken, mainReleased), false)
  const before = builder.diagnostics().backingBuffersAllocated
  const next = builder.tryBuild({ snapshot: source, frameId: 5, generation: 1, full: true })
  assert.ok(next)
  assert.equal(builder.diagnostics().backingBuffersAllocated, before)
})

test("reclaims oversized returned slots only after idle hysteresis", () => {
  const builder = new GhosttyRenderUpdateBuilder()
  const wideRow = Array.from({ length: 100_000 }, () => cell("x"))
  const large = builder.build({
    snapshot: snapshot([wideRow], [0]), frameId: 1, generation: 1, full: true,
  })
  assert.equal(builder.trimIdle(0, 120_000), false, "leased storage is owner-ineligible")
  builder.release(large)
  const small = builder.build({
    snapshot: snapshot([[cell("x")]], [0]), frameId: 2, generation: 1, full: true,
  })
  builder.release(small)
  const before = builder.diagnostics()
  assert.ok(before.backingBytesAllocated > before.backingBytesUsed)
  assert.equal(builder.trimIdle(0, 30_000), false, "cooldown still active")
  assert.equal(builder.trimIdle(0, 120_000), true)
  const after = builder.diagnostics()
  assert.ok(after.backingBytesAllocated < before.backingBytesAllocated)
  assert.equal(after.idleTrims, 1)
  assert.ok(after.idleBytesReclaimed >= 1024 * 1024)

  const resumed = builder.build({
    snapshot: snapshot([wideRow], [0]), frameId: 3, generation: 1, full: true,
  })
  assert.equal(resumed.graphemeLengths.length, 100_000)
  assert.equal(builder.diagnostics().idleRegrows, 1)
  builder.release(resumed)
  assert.equal(builder.trimIdle(120_000, 150_000), false, "resume resets idle eligibility")
})

test("rejects malformed versions, lengths, row order, and grapheme offsets", () => {
  const builder = new GhosttyRenderUpdateBuilder();
  const update = builder.build({
    snapshot: snapshot([[cell("x")], [cell("y")]], [0, 1]),
    frameId: 1,
    generation: 1,
    full: true,
  });
  assert.equal(validateGhosttyRenderUpdate({ ...update, version: 2 }), false);
  assert.equal(validateGhosttyRenderUpdate({ ...update, styles: new Uint16Array(1) }), false);
  assert.equal(validateGhosttyRenderUpdate({ ...update, dirtyRows: new Uint32Array([1, 0]) }), false);
  assert.equal(
    validateGhosttyRenderUpdate({ ...update, graphemeOffsets: new Uint32Array([99, 0]) }),
    false,
  );
  assert.equal(validateGhosttyRenderUpdate({ ...update, frameId: 0 }), false);
  builder.release(update);
});
