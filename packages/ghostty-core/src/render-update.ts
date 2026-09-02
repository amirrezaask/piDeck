import type {
  GhosttyCell,
  GhosttyColor,
  GhosttySnapshot,
} from "./core.js";
import { shouldReclaimIdleCapacity } from "./idle-reclaim.js"

/** Increment whenever the packed layout or its semantics change. */
export const GHOSTTY_RENDER_UPDATE_VERSION = 1 as const;

/**
 * Cell style layout. Width occupies bits 0..1, underline occupies bits 8..10.
 * Keeping style in one u16 makes updates compact and directly uploadable.
 */
export const GHOSTTY_RENDER_STYLE = {
  widthMask: 0b11,
  bold: 1 << 2,
  italic: 1 << 3,
  invisible: 1 << 4,
  strikethrough: 1 << 5,
  overline: 1 << 6,
  selected: 1 << 7,
  underlineShift: 8,
  underlineMask: 0b111 << 8,
} as const;

export const GHOSTTY_RENDER_ROW = {
  wrapContinuation: 1 << 0,
  wrapsToNext: 1 << 1,
} as const;

export interface GhosttyRenderUpdate {
  readonly version: typeof GHOSTTY_RENDER_UPDATE_VERSION;
  readonly frameId: number;
  readonly generation: number;
  readonly cols: number;
  readonly rows: number;
  readonly full: boolean;
  readonly foreground: number;
  readonly background: number;
  readonly cursor: number;
  readonly cursorX: number;
  readonly cursorY: number;
  readonly cursorVisible: boolean;
  readonly cursorBlinking: boolean;
  readonly cursorStyle: number;
  /** Sorted, unique viewport row indices. */
  readonly dirtyRows: Uint32Array;
  /** One flag byte for each dirty row. */
  readonly rowFlags: Uint8Array;
  /** Dirty-row-major cell data; every included row contributes `cols` cells. */
  readonly graphemeOffsets: Uint32Array;
  readonly graphemeLengths: Uint32Array;
  readonly foregrounds: Uint32Array;
  readonly backgrounds: Uint32Array;
  readonly styles: Uint16Array;
  /** UTF-8 payload addressed by graphemeOffsets/graphemeLengths. */
  readonly graphemes: Uint8Array;
}

export function packGhosttyColor(color: GhosttyColor): number {
  return ((color.r & 0xff) << 16) | ((color.g & 0xff) << 8) | (color.b & 0xff);
}

export function unpackGhosttyColor(color: number): GhosttyColor {
  return {
    r: (color >>> 16) & 0xff,
    g: (color >>> 8) & 0xff,
    b: color & 0xff,
  };
}

export function packGhosttyCellStyle(cell: GhosttyCell): number {
  return (
    (cell.wide & GHOSTTY_RENDER_STYLE.widthMask) |
    (cell.bold ? GHOSTTY_RENDER_STYLE.bold : 0) |
    (cell.italic ? GHOSTTY_RENDER_STYLE.italic : 0) |
    (cell.invisible ? GHOSTTY_RENDER_STYLE.invisible : 0) |
    (cell.strikethrough ? GHOSTTY_RENDER_STYLE.strikethrough : 0) |
    (cell.overline ? GHOSTTY_RENDER_STYLE.overline : 0) |
    (cell.selected ? GHOSTTY_RENDER_STYLE.selected : 0) |
    ((cell.underline & 0b111) << GHOSTTY_RENDER_STYLE.underlineShift)
  );
}

export type GhosttyRenderUpdateBuffers = {
  readonly dirtyRows: ArrayBuffer;
  readonly rowFlags: ArrayBuffer;
  readonly graphemeOffsets: ArrayBuffer;
  readonly graphemeLengths: ArrayBuffer;
  readonly foregrounds: ArrayBuffer;
  readonly backgrounds: ArrayBuffer;
  readonly styles: ArrayBuffer;
  readonly graphemes: ArrayBuffer;
}

export type GhosttyRenderUpdateLease = {
  readonly slotId: number
  readonly leaseToken: number
  readonly update: GhosttyRenderUpdate
}

export type GhosttyRenderUpdateBuilderDiagnostics = {
  readonly slotsCreated: number
  readonly backingBuffersAllocated: number
  readonly backingBytesAllocated: number
  readonly backingBytesUsed: number
  readonly leasesBuilt: number
  readonly leasesReclaimed: number
  readonly reclaimRejected: number
  readonly noFreeSlot: number
  readonly maxInFlight: number
  readonly idleTrims: number
  readonly idleBytesReclaimed: number
  readonly idleRegrows: number
}

interface BuilderSlot {
  readonly id: number
  inFlight: boolean
  leaseToken: number
  dirtyRows: Uint32Array
  rowFlags: Uint8Array
  graphemeOffsets: Uint32Array
  graphemeLengths: Uint32Array
  foregrounds: Uint32Array
  backgrounds: Uint32Array
  styles: Uint16Array
  graphemes: Uint8Array
  targetRows: number
  targetCells: number
  targetGraphemes: number
}

const textEncoder = new TextEncoder();

function nextCapacity(required: number): number {
  let capacity = 1;
  while (capacity < required) capacity *= 2;
  return capacity;
}

function ensureU8(value: Uint8Array, required: number): Uint8Array {
  return value.buffer.byteLength > 0 && value.length >= required
    ? value
    : new Uint8Array(nextCapacity(required));
}

function ensureU16(value: Uint16Array, required: number): Uint16Array {
  return value.buffer.byteLength > 0 && value.length >= required
    ? value
    : new Uint16Array(nextCapacity(required));
}

function ensureU32(value: Uint32Array, required: number): Uint32Array {
  return value.buffer.byteLength > 0 && value.length >= required
    ? value
    : new Uint32Array(nextCapacity(required));
}

function createSlot(id: number): BuilderSlot {
  return {
    id,
    inFlight: false,
    leaseToken: 0,
    dirtyRows: new Uint32Array(1),
    rowFlags: new Uint8Array(1),
    graphemeOffsets: new Uint32Array(1),
    graphemeLengths: new Uint32Array(1),
    foregrounds: new Uint32Array(1),
    backgrounds: new Uint32Array(1),
    styles: new Uint16Array(1),
    graphemes: new Uint8Array(1),
    targetRows: 1,
    targetCells: 1,
    targetGraphemes: 1,
  };
}

/** Three fixed ownership slots. Transferred storage is reclaimed explicitly. */
export class GhosttyRenderUpdateBuilder {
  private readonly slots: BuilderSlot[]
  private readonly owners = new WeakMap<GhosttyRenderUpdate, GhosttyRenderUpdateLease>()
  private mutableDiagnostics = {
    slotsCreated: 0,
    backingBuffersAllocated: 0,
    backingBytesAllocated: 0,
    leasesBuilt: 0,
    leasesReclaimed: 0,
    reclaimRejected: 0,
    noFreeSlot: 0,
    maxInFlight: 0,
    idleTrims: 0,
    idleBytesReclaimed: 0,
    idleRegrows: 0,
  }
  private lastCapacityChangeAt = 0
  private trimmedSinceGrowth = false

  constructor(slotCount = 3) {
    const count = Math.max(1, Math.min(3, Math.trunc(slotCount)))
    this.slots = Array.from({ length: count }, (_, id) => createSlot(id))
    this.mutableDiagnostics.slotsCreated = count
    this.mutableDiagnostics.backingBuffersAllocated = count * 8
    this.mutableDiagnostics.backingBytesAllocated = this.slots.reduce(
      (total, slot) => total + slotBytes(slot),
      0,
    )
  }

  get hasFreeSlot(): boolean {
    return this.slots.some(slot => !slot.inFlight)
  }

  diagnostics(): GhosttyRenderUpdateBuilderDiagnostics {
    return {
      ...this.mutableDiagnostics,
      backingBytesUsed: this.slots.reduce((total, slot) => total + usedSlotBytes(slot), 0),
    }
  }

  build(options: {
    readonly snapshot: GhosttySnapshot
    readonly frameId: number
    readonly generation: number
    readonly full: boolean
  }): GhosttyRenderUpdate {
    const lease = this.tryBuild(options)
    if (!lease) throw new Error("Ghostty render update ring is full")
    return lease.update
  }

  tryBuild(options: {
    readonly snapshot: GhosttySnapshot
    readonly frameId: number
    readonly generation: number
    readonly full: boolean
  }): GhosttyRenderUpdateLease | null {
    const slot = this.slots.find(candidate => !candidate.inFlight)
    if (!slot) {
      this.mutableDiagnostics.noFreeSlot += 1
      return null
    }
    const { snapshot, frameId, generation, full } = options;
    const rows = full
      ? Array.from({ length: snapshot.rows }, (_, row) => row)
      : [...snapshot.dirtyRows].sort((left, right) => left - right);
    const cellCount = rows.length * snapshot.cols;
    let graphemeCapacity = 0;
    for (const rowIndex of rows) {
      const row = snapshot.rowData[rowIndex];
      if (!row) continue;
      for (let column = 0; column < snapshot.cols; column += 1) {
        // UTF-8 needs at most three bytes per UTF-16 code unit (surrogate pairs
        // use four bytes for two units). Reserve once, then encode directly
        // into the reusable payload instead of allocating per-cell byte arrays.
        graphemeCapacity += (row.cells[column]?.text.length ?? 0) * 3;
      }
    }

    slot.inFlight = true
    slot.leaseToken += 1
    const beforeBytes = slotBytes(slot)
    const beforeBuffers = slotBuffers(slot)
    slot.dirtyRows = ensureU32(slot.dirtyRows, rows.length);
    slot.rowFlags = ensureU8(slot.rowFlags, rows.length);
    slot.graphemeOffsets = ensureU32(slot.graphemeOffsets, cellCount);
    slot.graphemeLengths = ensureU32(slot.graphemeLengths, cellCount);
    slot.foregrounds = ensureU32(slot.foregrounds, cellCount);
    slot.backgrounds = ensureU32(slot.backgrounds, cellCount);
    slot.styles = ensureU16(slot.styles, cellCount);
    slot.graphemes = ensureU8(slot.graphemes, graphemeCapacity);
    const afterBuffers = slotBuffers(slot)
    for (let index = 0; index < afterBuffers.length; index += 1) {
      if (afterBuffers[index] !== beforeBuffers[index]) {
        this.mutableDiagnostics.backingBuffersAllocated += 1
      }
    }
    const growth = slotBytes(slot) - beforeBytes
    this.mutableDiagnostics.backingBytesAllocated += growth
    if (growth > 0) {
      if (this.trimmedSinceGrowth) {
        this.mutableDiagnostics.idleRegrows += 1
        this.trimmedSinceGrowth = false
      }
      this.lastCapacityChangeAt = clockNow()
    }
    slot.targetRows = Math.max(1, rows.length)
    slot.targetCells = Math.max(1, cellCount)

    let cellIndex = 0;
    let graphemeOffset = 0;
    for (let includedRow = 0; includedRow < rows.length; includedRow += 1) {
      const rowIndex = rows[includedRow] ?? 0;
      const row = snapshot.rowData[rowIndex];
      slot.dirtyRows[includedRow] = rowIndex;
      slot.rowFlags[includedRow] =
        (row?.isWrapContinuation ? GHOSTTY_RENDER_ROW.wrapContinuation : 0) |
        (row?.wrapsToNext ? GHOSTTY_RENDER_ROW.wrapsToNext : 0);
      for (let column = 0; column < snapshot.cols; column += 1) {
        const cell = row?.cells[column];
        const text = cell?.text ?? "";
        const encoded = text.length === 0
          ? { read: 0, written: 0 }
          : textEncoder.encodeInto(text, slot.graphemes.subarray(graphemeOffset));
        slot.graphemeOffsets[cellIndex] = graphemeOffset;
        slot.graphemeLengths[cellIndex] = encoded.written;
        graphemeOffset += encoded.written;
        slot.foregrounds[cellIndex] = packGhosttyColor(cell?.foreground ?? snapshot.foreground);
        slot.backgrounds[cellIndex] = packGhosttyColor(cell?.background ?? snapshot.background);
        slot.styles[cellIndex] = cell ? packGhosttyCellStyle(cell) : 0;
        cellIndex += 1;
      }
    }

    const update: GhosttyRenderUpdate = {
      version: GHOSTTY_RENDER_UPDATE_VERSION,
      frameId,
      generation,
      cols: snapshot.cols,
      rows: snapshot.rows,
      full,
      foreground: packGhosttyColor(snapshot.foreground),
      background: packGhosttyColor(snapshot.background),
      cursor: packGhosttyColor(snapshot.cursor),
      cursorX: snapshot.cursorX,
      cursorY: snapshot.cursorY,
      cursorVisible: snapshot.cursorVisible,
      cursorBlinking: snapshot.cursorBlinking,
      cursorStyle: snapshot.cursorStyle,
      dirtyRows: slot.dirtyRows.subarray(0, rows.length),
      rowFlags: slot.rowFlags.subarray(0, rows.length),
      graphemeOffsets: slot.graphemeOffsets.subarray(0, cellCount),
      graphemeLengths: slot.graphemeLengths.subarray(0, cellCount),
      foregrounds: slot.foregrounds.subarray(0, cellCount),
      backgrounds: slot.backgrounds.subarray(0, cellCount),
      styles: slot.styles.subarray(0, cellCount),
      graphemes: slot.graphemes.subarray(0, graphemeOffset),
    };
    slot.targetGraphemes = Math.max(1, graphemeOffset)
    const lease = { slotId: slot.id, leaseToken: slot.leaseToken, update }
    this.owners.set(update, lease)
    this.mutableDiagnostics.leasesBuilt += 1
    const inFlight = this.slots.filter(candidate => candidate.inFlight).length
    this.mutableDiagnostics.maxInFlight = Math.max(this.mutableDiagnostics.maxInFlight, inFlight)
    return lease
  }

  trimIdle(lastActivityAt: number, now = clockNow()): boolean {
    const allocatedBytes = this.slots.reduce((total, slot) => total + slotBytes(slot), 0)
    const targetBytes = this.slots.reduce((total, slot) => total + targetSlotBytes(slot), 0)
    const inFlight = this.slots.filter(slot => slot.inFlight).length
    if (!shouldReclaimIdleCapacity({
      now, allocatedBytes, targetBytes, inFlight, queued: 0,
      lastActivityAt, lastResizeAt: this.lastCapacityChangeAt,
    })) return false
    for (const slot of this.slots) trimSlot(slot)
    const afterBytes = this.slots.reduce((total, slot) => total + slotBytes(slot), 0)
    this.mutableDiagnostics.backingBytesAllocated -= allocatedBytes - afterBytes
    this.mutableDiagnostics.backingBuffersAllocated += this.slots.length * 8
    this.mutableDiagnostics.idleTrims += 1
    this.mutableDiagnostics.idleBytesReclaimed += allocatedBytes - afterBytes
    this.lastCapacityChangeAt = now
    this.trimmedSinceGrowth = true
    return true
  }

  release(update: GhosttyRenderUpdate): void {
    const lease = this.owners.get(update)
    if (!lease) return
    this.owners.delete(update)
    this.reclaim(lease.slotId, lease.leaseToken, ghosttyRenderUpdateBuffers(update))
  }

  reclaim(slotId: number, leaseToken: number, buffers: GhosttyRenderUpdateBuffers): boolean {
    const slot = this.slots[slotId]
    if (!slot || !slot.inFlight || slot.leaseToken !== leaseToken || !validReturnedBuffers(buffers)) {
      this.mutableDiagnostics.reclaimRejected += 1
      return false
    }
    slot.dirtyRows = new Uint32Array(buffers.dirtyRows)
    slot.rowFlags = new Uint8Array(buffers.rowFlags)
    slot.graphemeOffsets = new Uint32Array(buffers.graphemeOffsets)
    slot.graphemeLengths = new Uint32Array(buffers.graphemeLengths)
    slot.foregrounds = new Uint32Array(buffers.foregrounds)
    slot.backgrounds = new Uint32Array(buffers.backgrounds)
    slot.styles = new Uint16Array(buffers.styles)
    slot.graphemes = new Uint8Array(buffers.graphemes)
    slot.inFlight = false
    this.mutableDiagnostics.leasesReclaimed += 1
    return true
  }
}

function clockNow(): number {
  return globalThis.performance?.now() ?? Date.now()
}

function usedSlotBytes(slot: BuilderSlot): number {
  return slot.targetRows * 5 + slot.targetCells * 18 + slot.targetGraphemes
}

function targetSlotBytes(slot: BuilderSlot): number {
  const rows = nextCapacity(slot.targetRows * 2)
  const cells = nextCapacity(slot.targetCells * 2)
  const graphemes = nextCapacity(slot.targetGraphemes * 2)
  return rows * 5 + cells * 18 + graphemes
}

function trimSlot(slot: BuilderSlot): void {
  const rows = nextCapacity(slot.targetRows * 2)
  const cells = nextCapacity(slot.targetCells * 2)
  const graphemes = nextCapacity(slot.targetGraphemes * 2)
  slot.dirtyRows = new Uint32Array(rows)
  slot.rowFlags = new Uint8Array(rows)
  slot.graphemeOffsets = new Uint32Array(cells)
  slot.graphemeLengths = new Uint32Array(cells)
  slot.foregrounds = new Uint32Array(cells)
  slot.backgrounds = new Uint32Array(cells)
  slot.styles = new Uint16Array(cells)
  slot.graphemes = new Uint8Array(graphemes)
}

function slotBuffers(slot: BuilderSlot): readonly ArrayBufferLike[] {
  return [
    slot.dirtyRows.buffer, slot.rowFlags.buffer, slot.graphemeOffsets.buffer,
    slot.graphemeLengths.buffer, slot.foregrounds.buffer, slot.backgrounds.buffer,
    slot.styles.buffer, slot.graphemes.buffer,
  ]
}

function slotBytes(slot: BuilderSlot): number {
  return slotBuffers(slot).reduce((total, buffer) => total + buffer.byteLength, 0)
}

function transferableBuffer(view: ArrayBufferView): ArrayBuffer {
  if (!(view.buffer instanceof ArrayBuffer)) {
    throw new Error("Ghostty render updates require transferable ArrayBuffer storage")
  }
  return view.buffer
}

export function ghosttyRenderUpdateBuffers(update: GhosttyRenderUpdate): GhosttyRenderUpdateBuffers {
  return {
    dirtyRows: transferableBuffer(update.dirtyRows),
    rowFlags: transferableBuffer(update.rowFlags),
    graphemeOffsets: transferableBuffer(update.graphemeOffsets),
    graphemeLengths: transferableBuffer(update.graphemeLengths),
    foregrounds: transferableBuffer(update.foregrounds),
    backgrounds: transferableBuffer(update.backgrounds),
    styles: transferableBuffer(update.styles),
    graphemes: transferableBuffer(update.graphemes),
  }
}

function validReturnedBuffers(buffers: GhosttyRenderUpdateBuffers): boolean {
  const entries = Object.values(buffers)
  return entries.length === 8 && entries.every(buffer => buffer instanceof ArrayBuffer && buffer.byteLength > 0) &&
    buffers.dirtyRows.byteLength % 4 === 0 && buffers.graphemeOffsets.byteLength % 4 === 0 &&
    buffers.graphemeLengths.byteLength % 4 === 0 && buffers.foregrounds.byteLength % 4 === 0 &&
    buffers.backgrounds.byteLength % 4 === 0 && buffers.styles.byteLength % 2 === 0
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isColor(value: unknown): value is number {
  return isSafeInteger(value) && value >= 0 && value <= 0xffffff;
}

/** Validate packed data before it crosses into a viewport model or renderer. */
export function validateGhosttyRenderUpdate(value: unknown): value is GhosttyRenderUpdate {
  if (typeof value !== "object" || value === null) return false;
  if (
    !("version" in value) || value.version !== GHOSTTY_RENDER_UPDATE_VERSION ||
    !("frameId" in value) || !isSafeInteger(value.frameId) || value.frameId < 1 ||
    !("generation" in value) || !isSafeInteger(value.generation) || value.generation < 1 ||
    !("cols" in value) || !isSafeInteger(value.cols) || value.cols < 1 || value.cols > 65_535 ||
    !("rows" in value) || !isSafeInteger(value.rows) || value.rows < 1 || value.rows > 65_535 ||
    !("full" in value) || typeof value.full !== "boolean" ||
    !("foreground" in value) || !isColor(value.foreground) ||
    !("background" in value) || !isColor(value.background) ||
    !("cursor" in value) || !isColor(value.cursor) ||
    !("cursorX" in value) || !isSafeInteger(value.cursorX) ||
    !("cursorY" in value) || !isSafeInteger(value.cursorY) ||
    !("cursorVisible" in value) || typeof value.cursorVisible !== "boolean" ||
    !("cursorBlinking" in value) || typeof value.cursorBlinking !== "boolean" ||
    !("cursorStyle" in value) || !isSafeInteger(value.cursorStyle) ||
    !("dirtyRows" in value) || !(value.dirtyRows instanceof Uint32Array) ||
    !("rowFlags" in value) || !(value.rowFlags instanceof Uint8Array) ||
    !("graphemeOffsets" in value) || !(value.graphemeOffsets instanceof Uint32Array) ||
    !("graphemeLengths" in value) || !(value.graphemeLengths instanceof Uint32Array) ||
    !("foregrounds" in value) || !(value.foregrounds instanceof Uint32Array) ||
    !("backgrounds" in value) || !(value.backgrounds instanceof Uint32Array) ||
    !("styles" in value) || !(value.styles instanceof Uint16Array) ||
    !("graphemes" in value) || !(value.graphemes instanceof Uint8Array)
  ) return false;

  const rowCount = value.dirtyRows.length;
  const cellCount = rowCount * value.cols;
  if (
    value.rowFlags.length !== rowCount ||
    value.graphemeOffsets.length !== cellCount ||
    value.graphemeLengths.length !== cellCount ||
    value.foregrounds.length !== cellCount ||
    value.backgrounds.length !== cellCount ||
    value.styles.length !== cellCount ||
    (value.full && rowCount !== value.rows)
  ) return false;
  let previousRow = -1;
  for (const row of value.dirtyRows) {
    if (row <= previousRow || row >= value.rows) return false;
    previousRow = row;
  }
  for (let index = 0; index < cellCount; index += 1) {
    const offset = value.graphemeOffsets[index];
    const length = value.graphemeLengths[index];
    if (offset === undefined || length === undefined || offset + length > value.graphemes.length) {
      return false;
    }
    if (!isColor(value.foregrounds[index]) || !isColor(value.backgrounds[index])) return false;
  }
  return true;
}
