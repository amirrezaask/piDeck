import type {
  GhosttyCell,
  GhosttyColor,
  GhosttyRow,
  GhosttySnapshot,
} from "./core.js";
import { GHOSTTY_CELL_WIDE } from "./render-model.js";
import {
  GHOSTTY_RENDER_ROW,
  GHOSTTY_RENDER_STYLE,
  type GhosttyRenderUpdate,
  unpackGhosttyColor,
  validateGhosttyRenderUpdate,
} from "./render-update.js";

const decoder = new TextDecoder();
const EMPTY_DIRTY_ROWS: ReadonlySet<number> = new Set();
const EMPTY_BYTES = new Uint8Array(0);

/**
 * Owned packed viewport retained on the main thread.
 *
 * Updates copy only dirty row slabs. Text and compatibility cell objects are
 * materialized lazily and cached by row version, keeping the accelerated
 * renderer on numeric typed arrays while preserving synchronous inspection.
 */
export class GhosttyViewportModel {
  private frameId = 0;
  private generation = 0;
  private colsValue = 0;
  private rowsValue = 0;
  private foregroundPacked = 0xe5e7eb;
  private backgroundPacked = 0;
  private cursorPacked = 0xe5e7eb;
  private cursorXValue = -1;
  private cursorYValue = -1;
  private cursorVisibleValue = false;
  private cursorBlinkingValue = false;
  private cursorStyleValue = 0;
  private stylesValue = new Uint16Array(0);
  private foregroundsValue = new Uint32Array(0);
  private backgroundsValue = new Uint32Array(0);
  private graphemeOffsetsValue = new Uint32Array(0);
  private graphemeLengthsValue = new Uint32Array(0);
  private rowFlagsValue = new Uint8Array(0);
  private rowVersionsValue = new Uint32Array(0);
  private rowGraphemes: Uint8Array[] = [];
  private decodedRows: ((string | undefined)[] | undefined)[] = [];
  private compatibilityRows: (GhosttyRow | undefined)[] = [];
  private compatibilityVersions = new Uint32Array(0);
  private dirtyRowsValue: ReadonlySet<number> = EMPTY_DIRTY_ROWS;
  private compatibilitySnapshotBuildsValue = 0;
  private decodedGraphemesValue = 0;

  get cols(): number { return this.colsValue; }
  get rows(): number { return this.rowsValue; }
  get currentFrameId(): number { return this.frameId; }
  get currentGeneration(): number { return this.generation; }
  get foreground(): GhosttyColor { return unpackGhosttyColor(this.foregroundPacked); }
  get background(): GhosttyColor { return unpackGhosttyColor(this.backgroundPacked); }
  get cursor(): GhosttyColor { return unpackGhosttyColor(this.cursorPacked); }
  get cursorX(): number { return this.cursorXValue; }
  get cursorY(): number { return this.cursorYValue; }
  get cursorVisible(): boolean { return this.cursorVisibleValue; }
  get cursorBlinking(): boolean { return this.cursorBlinkingValue; }
  get cursorStyle(): number { return this.cursorStyleValue; }
  get dirtyRows(): ReadonlySet<number> { return this.dirtyRowsValue; }
  get styles(): Uint16Array { return this.stylesValue; }
  get foregrounds(): Uint32Array { return this.foregroundsValue; }
  get backgrounds(): Uint32Array { return this.backgroundsValue; }
  get rowFlags(): Uint8Array { return this.rowFlagsValue; }
  get rowVersions(): Uint32Array { return this.rowVersionsValue; }
  get compatibilitySnapshotBuilds(): number { return this.compatibilitySnapshotBuildsValue; }
  get decodedGraphemes(): number { return this.decodedGraphemesValue; }

  /** Decode one complete terminal grapheme on demand. */
  textAt(row: number, column: number): string {
    if (row < 0 || row >= this.rowsValue || column < 0 || column >= this.colsValue) return "";
    let cache = this.decodedRows[row];
    if (cache === undefined) {
      cache = Array.from<string | undefined>({ length: this.colsValue });
      this.decodedRows[row] = cache;
    }
    const cached = cache[column];
    if (cached !== undefined) return cached;
    const index = row * this.colsValue + column;
    const offset = this.graphemeOffsetsValue[index] ?? 0;
    const length = this.graphemeLengthsValue[index] ?? 0;
    const bytes = this.rowGraphemes[row] ?? EMPTY_BYTES;
    const value = length === 0 ? "" : decoder.decode(bytes.subarray(offset, offset + length));
    cache[column] = value;
    this.decodedGraphemesValue += 1;
    return value;
  }

  rowText(row: number, trimRight = true): string {
    if (row < 0 || row >= this.rowsValue) return "";
    let value = "";
    for (let column = 0; column < this.colsValue; column += 1) {
      value += this.textAt(row, column) || " ";
    }
    return trimRight ? value.trimEnd() : value;
  }

  styleAt(row: number, column: number): number {
    return this.stylesValue[row * this.colsValue + column] ?? 0;
  }

  foregroundAt(row: number, column: number): number {
    return this.foregroundsValue[row * this.colsValue + column] ?? this.foregroundPacked;
  }

  backgroundAt(row: number, column: number): number {
    return this.backgroundsValue[row * this.colsValue + column] ?? this.backgroundPacked;
  }

  apply(update: GhosttyRenderUpdate): boolean {
    if (!validateGhosttyRenderUpdate(update)) return false;
    if (update.generation < this.generation) return false;
    if (update.generation === this.generation && update.frameId <= this.frameId) return false;
    if (update.generation > this.generation && !update.full) return false;

    const dimensionsChanged =
      update.cols !== this.colsValue || update.rows !== this.rowsValue;
    if ((update.full || dimensionsChanged) && !update.full) return false;
    if (update.full || dimensionsChanged) this.allocate(update.cols, update.rows);

    this.frameId = update.frameId;
    this.generation = update.generation;
    this.foregroundPacked = update.foreground;
    this.backgroundPacked = update.background;
    this.cursorPacked = update.cursor;
    this.cursorXValue = update.cursorX;
    this.cursorYValue = update.cursorY;
    this.cursorVisibleValue = update.cursorVisible;
    this.cursorBlinkingValue = update.cursorBlinking;
    this.cursorStyleValue = update.cursorStyle;

    const dirty = new Set<number>();
    for (let includedRow = 0; includedRow < update.dirtyRows.length; includedRow += 1) {
      const row = update.dirtyRows[includedRow];
      if (row === undefined || row >= this.rowsValue) return false;
      const packedStart = includedRow * update.cols;
      const packedEnd = packedStart + update.cols;
      const targetStart = row * update.cols;
      this.stylesValue.set(update.styles.subarray(packedStart, packedEnd), targetStart);
      this.foregroundsValue.set(update.foregrounds.subarray(packedStart, packedEnd), targetStart);
      this.backgroundsValue.set(update.backgrounds.subarray(packedStart, packedEnd), targetStart);

      let byteLength = 0;
      for (let column = 0; column < update.cols; column += 1) {
        const sourceIndex = packedStart + column;
        const offset = update.graphemeOffsets[sourceIndex] ?? 0;
        const length = update.graphemeLengths[sourceIndex] ?? 0;
        byteLength += length;
        if (offset + length > update.graphemes.length) return false;
      }
      const rowBytes = new Uint8Array(byteLength);
      let targetOffset = 0;
      for (let column = 0; column < update.cols; column += 1) {
        const sourceIndex = packedStart + column;
        const targetIndex = targetStart + column;
        const offset = update.graphemeOffsets[sourceIndex] ?? 0;
        const length = update.graphemeLengths[sourceIndex] ?? 0;
        rowBytes.set(update.graphemes.subarray(offset, offset + length), targetOffset);
        this.graphemeOffsetsValue[targetIndex] = targetOffset;
        this.graphemeLengthsValue[targetIndex] = length;
        targetOffset += length;
      }
      this.rowGraphemes[row] = rowBytes;
      this.rowFlagsValue[row] = update.rowFlags[includedRow] ?? 0;
      this.rowVersionsValue[row] = (this.rowVersionsValue[row] ?? 0) + 1;
      this.decodedRows[row] = undefined;
      this.compatibilityRows[row] = undefined;
      dirty.add(row);
    }
    this.dirtyRowsValue = dirty;
    return true;
  }

  /** Cold compatibility adapter. Accelerated render frames never call this. */
  snapshot(): GhosttySnapshot {
    this.compatibilitySnapshotBuildsValue += 1;
    const rows = Array.from<GhosttyRow>({ length: this.rowsValue });
    for (let row = 0; row < this.rowsValue; row += 1) rows[row] = this.materializeRow(row);
    return {
      cols: this.colsValue,
      rows: this.rowsValue,
      foreground: this.foreground,
      background: this.background,
      cursor: this.cursor,
      cursorX: this.cursorXValue,
      cursorY: this.cursorYValue,
      cursorVisible: this.cursorVisibleValue,
      cursorBlinking: this.cursorBlinkingValue,
      cursorStyle: this.cursorStyleValue,
      dirtyRows: this.dirtyRowsValue,
      rowData: rows,
    };
  }

  bufferText(): string {
    const rows = Array.from<string>({ length: this.rowsValue });
    for (let row = 0; row < this.rowsValue; row += 1) {
      let value = "";
      for (let column = 0; column < this.colsValue; column += 1) {
        if (
          (this.styleAt(row, column) & GHOSTTY_RENDER_STYLE.widthMask) ===
          GHOSTTY_CELL_WIDE.spacerTail
        ) continue;
        value += this.textAt(row, column) || " ";
      }
      rows[row] = value.trimEnd();
    }
    return rows.join("\n");
  }

  private allocate(cols: number, rows: number): void {
    const cells = cols * rows;
    this.colsValue = cols;
    this.rowsValue = rows;
    this.stylesValue = new Uint16Array(cells);
    this.foregroundsValue = new Uint32Array(cells);
    this.backgroundsValue = new Uint32Array(cells);
    this.graphemeOffsetsValue = new Uint32Array(cells);
    this.graphemeLengthsValue = new Uint32Array(cells);
    this.rowFlagsValue = new Uint8Array(rows);
    this.rowVersionsValue = new Uint32Array(rows);
    this.rowGraphemes = Array.from({ length: rows }, () => EMPTY_BYTES);
    this.decodedRows = Array.from({ length: rows });
    this.compatibilityRows = Array.from({ length: rows });
    this.compatibilityVersions = new Uint32Array(rows);
  }

  private materializeRow(row: number): GhosttyRow {
    const version = this.rowVersionsValue[row] ?? 0;
    const cached = this.compatibilityRows[row];
    if (cached !== undefined && this.compatibilityVersions[row] === version) return cached;
    const cells = Array.from<GhosttyCell>({ length: this.colsValue });
    for (let column = 0; column < this.colsValue; column += 1) {
      const style = this.styleAt(row, column);
      cells[column] = {
        text: this.textAt(row, column),
        wide: style & GHOSTTY_RENDER_STYLE.widthMask,
        foreground: unpackGhosttyColor(this.foregroundAt(row, column)),
        background: unpackGhosttyColor(this.backgroundAt(row, column)),
        bold: (style & GHOSTTY_RENDER_STYLE.bold) !== 0,
        italic: (style & GHOSTTY_RENDER_STYLE.italic) !== 0,
        invisible: (style & GHOSTTY_RENDER_STYLE.invisible) !== 0,
        strikethrough: (style & GHOSTTY_RENDER_STYLE.strikethrough) !== 0,
        overline: (style & GHOSTTY_RENDER_STYLE.overline) !== 0,
        underline:
          (style & GHOSTTY_RENDER_STYLE.underlineMask) >>> GHOSTTY_RENDER_STYLE.underlineShift,
        selected: (style & GHOSTTY_RENDER_STYLE.selected) !== 0,
      };
    }
    const flags = this.rowFlagsValue[row] ?? 0;
    const value: GhosttyRow = {
      cells,
      text: this.rowText(row),
      isWrapContinuation: (flags & GHOSTTY_RENDER_ROW.wrapContinuation) !== 0,
      wrapsToNext: (flags & GHOSTTY_RENDER_ROW.wrapsToNext) !== 0,
    };
    this.compatibilityRows[row] = value;
    this.compatibilityVersions[row] = version;
    return value;
  }
}
