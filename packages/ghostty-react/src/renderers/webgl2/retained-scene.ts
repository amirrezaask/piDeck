import {
  WEBGL_GLYPH_FLOATS,
  WEBGL_RECT_FLOATS,
  type WebGlGlyphBatch,
  type WebGlRectBatch,
} from "./batches.js";

export type RetainedRowBatches = {
  readonly backgrounds: WebGlRectBatch;
  readonly decorations: WebGlRectBatch;
  readonly glyphs: WebGlGlyphBatch;
};

export type RetainedRowChange = {
  readonly row: number;
  readonly batches: RetainedRowBatches;
};

export type SceneFloatRange = {
  readonly offset: number;
  readonly data: Float32Array;
};

export type ScenePrimitivePlan =
  | { readonly kind: "none" }
  | { readonly kind: "partial"; readonly ranges: readonly SceneFloatRange[] }
  | { readonly kind: "full"; readonly data: Float32Array };

export type SceneSubmissionPlan = {
  readonly backgrounds: ScenePrimitivePlan;
  readonly decorations: ScenePrimitivePlan;
  readonly glyphs: ScenePrimitivePlan;
};

type RowRange = { readonly offset: number; readonly count: number };
type BatchView = { readonly count: number; readonly data: Float32Array };

const NONE: ScenePrimitivePlan = { kind: "none" };

function checkedLength(count: number, floatsPerInstance: number): number {
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("invalid scene instance count");
  const length = count * floatsPerInstance;
  if (!Number.isSafeInteger(length)) throw new RangeError("scene data exceeds safe integer bounds");
  return length;
}

class PrimitiveScene {
  private values = new Float32Array(0);
  private ranges: RowRange[] = [];
  private countValue = 0;

  constructor(
    private readonly floatsPerInstance: number,
    private readonly select: (row: RetainedRowBatches) => BatchView,
  ) {}

  get count(): number { return this.countValue; }
  get data(): Float32Array {
    return this.values.subarray(0, checkedLength(this.countValue, this.floatsPerInstance));
  }
  get allocatedBytes(): number { return this.values.byteLength }
  get targetAllocatedBytes(): number {
    return this.targetLength() * Float32Array.BYTES_PER_ELEMENT
  }

  clear(): void {
    this.ranges = [];
    this.countValue = 0;
  }

  replaceAll(rows: readonly RetainedRowBatches[]): ScenePrimitivePlan {
    let count = 0;
    const ranges: RowRange[] = [];
    for (const row of rows) {
      const batch = this.select(row);
      checkedLength(batch.count, this.floatsPerInstance);
      ranges.push({ offset: count, count: batch.count });
      count += batch.count;
      if (!Number.isSafeInteger(count)) throw new RangeError("scene instance count overflow");
    }
    const required = checkedLength(count, this.floatsPerInstance);
    if (required > this.values.length) {
      let capacity = Math.max(64 * this.floatsPerInstance, this.values.length);
      while (capacity < required) capacity *= 2;
      this.values = new Float32Array(capacity);
    }
    const values = this.values.subarray(0, required);
    for (let row = 0; row < rows.length; row += 1) {
      const range = ranges[row];
      if (!range || range.count === 0) continue;
      const batch = this.select(rows[row]!);
      if (batch.data.length !== checkedLength(batch.count, this.floatsPerInstance)) {
        throw new RangeError("scene batch data does not match its instance count");
      }
      values.set(batch.data, checkedLength(range.offset, this.floatsPerInstance));
    }
    this.ranges = ranges;
    this.countValue = count;
    return { kind: "full", data: values };
  }

  trimCapacity(): number {
    const targetLength = this.targetLength()
    if (targetLength >= this.values.length) return 0
    const previousBytes = this.values.byteLength
    const next = new Float32Array(targetLength)
    next.set(this.data)
    this.values = next
    return previousBytes - next.byteLength
  }

  private targetLength(): number {
    const required = checkedLength(this.countValue * 2, this.floatsPerInstance)
    let target = 64 * this.floatsPerInstance
    while (target < required) target *= 2
    return target
  }

  updateRows(
    changes: readonly RetainedRowChange[],
    rows: readonly RetainedRowBatches[],
  ): ScenePrimitivePlan {
    if (changes.length === 0) return NONE;
    for (const change of changes) {
      const range = this.ranges[change.row];
      if (!range || range.count !== this.select(change.batches).count) {
        return this.replaceAll(rows);
      }
    }

    const touched: RowRange[] = [];
    const sorted = [...changes].sort((left, right) => left.row - right.row);
    let previousRow = -1;
    for (const change of sorted) {
      if (change.row === previousRow) continue;
      previousRow = change.row;
      const range = this.ranges[change.row]!;
      const batch = this.select(change.batches);
      const length = checkedLength(range.count, this.floatsPerInstance);
      if (batch.data.length !== length) {
        throw new RangeError("scene batch data does not match its instance count");
      }
      if (length === 0) continue;
      this.values.set(batch.data, checkedLength(range.offset, this.floatsPerInstance));
      touched.push(range);
    }
    if (touched.length === 0) return NONE;

    const merged: RowRange[] = [];
    for (const range of touched) {
      const previous = merged.at(-1);
      if (previous && previous.offset + previous.count === range.offset) {
        merged[merged.length - 1] = {
          offset: previous.offset,
          count: previous.count + range.count,
        };
      } else {
        merged.push(range);
      }
    }
    return {
      kind: "partial",
      ranges: merged.map(range => ({
        offset: checkedLength(range.offset, this.floatsPerInstance),
        data: this.values.subarray(
          checkedLength(range.offset, this.floatsPerInstance),
          checkedLength(range.offset + range.count, this.floatsPerInstance),
        ),
      })),
    };
  }
}

/** CPU-owned compact scene and conservative stable-cardinality upload planner. */
export class WebGlRetainedScene {
  private rows: RetainedRowBatches[] = [];
  private readonly backgroundScene = new PrimitiveScene(WEBGL_RECT_FLOATS, row => row.backgrounds);
  private readonly decorationScene = new PrimitiveScene(WEBGL_RECT_FLOATS, row => row.decorations);
  private readonly glyphScene = new PrimitiveScene(WEBGL_GLYPH_FLOATS, row => row.glyphs);

  get backgroundCount(): number { return this.backgroundScene.count; }
  get decorationCount(): number { return this.decorationScene.count; }
  get glyphCount(): number { return this.glyphScene.count; }
  get backgroundData(): Float32Array { return this.backgroundScene.data; }
  get decorationData(): Float32Array { return this.decorationScene.data; }
  get glyphData(): Float32Array { return this.glyphScene.data; }
  get usedBytes(): number {
    return this.backgroundData.byteLength + this.decorationData.byteLength + this.glyphData.byteLength;
  }
  get allocatedBytes(): number {
    return this.backgroundScene.allocatedBytes + this.decorationScene.allocatedBytes +
      this.glyphScene.allocatedBytes + this.rows.reduce(
        (total, row) => total + row.backgrounds.allocatedBytes +
          row.decorations.allocatedBytes + row.glyphs.allocatedBytes,
        0,
      )
  }
  get targetAllocatedBytes(): number {
    return this.backgroundScene.targetAllocatedBytes + this.decorationScene.targetAllocatedBytes +
      this.glyphScene.targetAllocatedBytes + this.rows.reduce(
        (total, row) => total + row.backgrounds.targetAllocatedBytes +
          row.decorations.targetAllocatedBytes + row.glyphs.targetAllocatedBytes,
        0,
      )
  }

  trimCapacity(): number {
    let reclaimed = this.backgroundScene.trimCapacity() + this.decorationScene.trimCapacity() +
      this.glyphScene.trimCapacity()
    for (const row of this.rows) {
      reclaimed += row.backgrounds.trimCapacity()
      reclaimed += row.decorations.trimCapacity()
      reclaimed += row.glyphs.trimCapacity()
    }
    return reclaimed
  }

  replaceAll(rows: readonly RetainedRowBatches[]): SceneSubmissionPlan {
    this.rows = [...rows];
    return {
      backgrounds: this.backgroundScene.replaceAll(this.rows),
      decorations: this.decorationScene.replaceAll(this.rows),
      glyphs: this.glyphScene.replaceAll(this.rows),
    };
  }

  updateRows(changes: readonly RetainedRowChange[]): SceneSubmissionPlan {
    if (changes.length === 0) {
      return { backgrounds: NONE, decorations: NONE, glyphs: NONE };
    }
    for (const change of changes) {
      if (!Number.isSafeInteger(change.row) || change.row < 0 || change.row >= this.rows.length) {
        throw new RangeError(`retained scene row ${change.row} is out of bounds`);
      }
      this.rows[change.row] = change.batches;
    }
    return {
      backgrounds: this.backgroundScene.updateRows(changes, this.rows),
      decorations: this.decorationScene.updateRows(changes, this.rows),
      glyphs: this.glyphScene.updateRows(changes, this.rows),
    };
  }

  clear(): void {
    this.rows = [];
    this.backgroundScene.clear();
    this.decorationScene.clear();
    this.glyphScene.clear();
  }
}
