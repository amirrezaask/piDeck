/// <reference path="./vite-env.d.ts" />

import {
  collectWrappedTerminalLinkLine,
  matchTerminalUrls,
  type GhosttyTerminalLinkMatcher,
} from "./links.js";
import {
  GhosttyViewportModel,
  type GhosttyRenderUpdate,
  type GhosttyResponsePolicy,
  type GhosttyScrollbar,
  type GhosttySnapshot,
  type GhosttyTheme,
} from "./core.js";
import {
  TerminalViewportActivityPolicy,
  type TerminalViewportActivity,
} from "./viewport-activity.js";
import {
  measureGhosttyCell,
  terminalGridSize,
  terminalMouseCoordinate,
  type GhosttyCellRange,
  type GhosttyCellMetrics,
} from "./renderer.js";
import symbolsFontUrl from "./fonts/SymbolsNerdFontMono-Regular.woff2?url";
import {
  MainThreadTerminalCore,
  WorkerTerminalCore,
  type ParsedCallback,
  type TerminalCoreRuntime,
  type TerminalRuntimeKind,
} from "./worker/worker-terminal-core.js";
import { isBrowserZoomShortcut, isBrowserZoomWheel } from "./browser-zoom.js";
import {
  TERMINAL_SCHEDULER_BUDGETS,
  type TerminalPresentationSample,
} from "./scheduler/terminal-frame-scheduler.js";
import {
  TerminalGeometryCoordinator,
  type TerminalGeometryCommit,
} from "./geometry/terminal-geometry-coordinator.js";
import {
  createTerminalRenderer,
  parseTerminalRendererPreference,
  terminalRendererPreferenceFromSearch,
  type TerminalRendererPreference,
} from "./renderers/create-renderer.js";
import {
  RendererController,
  type ControlledTerminalRenderer,
} from "./renderers/renderer-controller.js";
import type {
  TerminalRenderer,
  TerminalRendererSubmissionDiagnostics,
} from "./renderers/terminal-renderer.js";

export const DEFAULT_TERMINAL_FONT_SIZE = 12;
const MIN_TERMINAL_FONT_SIZE = 6;
const MAX_TERMINAL_FONT_SIZE = 32;
// The glyph fallbacks only supply symbols the text faces are missing (powerline
// separators, devicons, and other private-use prompt symbols), so shells
// configured for a locally installed Nerd Font keep their prompt glyphs no
// matter which text face is active.
const TERMINAL_GLYPH_FALLBACKS = `"Symbols Nerd Font Mono", ui-monospace, monospace`;
// Keep the default stack independent from an application's font system. A
// consumer can provide any fixed-width face; the bundled symbols-only face
// remains available for prompt glyphs and devicons.
export const DEFAULT_TERMINAL_FONT_FAMILY = TERMINAL_GLYPH_FALLBACKS;
const CONTENT_PADDING = 4;
const MIN_SCROLLBAR_THUMB_HEIGHT = 18;
/** Half a blink cycle: the visible and hidden phases are equally long. */
const CURSOR_BLINK_INTERVAL_MS = 500;
/** DEC mode 2026 must not freeze a viewport forever when a producer crashes mid-update. */
const SYNCHRONIZED_OUTPUT_TIMEOUT_MS =
  TERMINAL_SCHEDULER_BUDGETS.synchronizedOutputTimeoutMs;
const TERMINAL_FONT_LOAD_TEXT = "iMW0@# .";
const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;
/** First-open flex/grid parents often report 0 until a later frame. */
const MAX_FIT_RETRIES = 60;
const TERMINAL_FONT_LOAD_VARIANTS = [
  "normal 400",
  "normal 700",
  "italic 400",
  "italic 700",
] as const;
const NO_DIRTY_ROWS: ReadonlySet<number> = new Set();

/** Requested terminal font; omitted fields fall back to the defaults. */
export interface GhosttyTerminalFont {
  readonly family?: string;
  readonly size?: number;
}

let symbolsFontLoad: Promise<void> | null = null;

function colorsEqual(left: GhosttyTheme["background"], right: GhosttyTheme["background"]): boolean {
  return left.r === right.r && left.g === right.g && left.b === right.b;
}

function themesEqual(left: GhosttyTheme, right: GhosttyTheme): boolean {
  if (left === right) return true;
  if (
    !colorsEqual(left.background, right.background) ||
    !colorsEqual(left.foreground, right.foreground) ||
    !colorsEqual(left.cursor, right.cursor) ||
    left.selectionBackground !== right.selectionBackground
  ) {
    return false;
  }
  if (left.palette === right.palette) return true;
  if (!left.palette || !right.palette || left.palette.length !== right.palette.length) return false;
  for (let index = 0; index < left.palette.length; index += 1) {
    const leftColor = left.palette[index];
    const rightColor = right.palette[index];
    if (!leftColor || !rightColor || !colorsEqual(leftColor, rightColor)) return false;
  }
  return true;
}

function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

function shouldSuppressMacMetaKey(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey">,
  platform: string,
): boolean {
  return (
    isMacPlatform(platform) &&
    event.metaKey &&
    !event.altKey &&
    !event.ctrlKey &&
    event.key !== "Meta"
  );
}

function isMonospaceFamily(family: string): boolean {
  if (typeof document === "undefined") return true;
  try {
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return true;
    context.font = `32px ${family}, monospace`;
    const widths = ["i", "M", "W", "0", "@", "#"].map(
      (glyph) => context.measureText(glyph).width,
    );
    const first = widths[0] ?? 0;
    return first <= 0 || widths.every((width) => Math.abs(width - first) < 0.75);
  } catch {
    return true;
  }
}

/**
 * Register the bundled symbols-only Nerd Font once per page. It loads lazily
 * with the first terminal, and because it carries no regular text glyphs it
 * composes with any text face without changing metrics — prompt symbols and
 * devicons render even on machines without a locally installed Nerd Font.
 */
function ensureTerminalSymbolsFont(): Promise<void> {
  if (symbolsFontLoad !== null) return symbolsFontLoad;
  symbolsFontLoad = (async () => {
    try {
      const face = new FontFace("Symbols Nerd Font Mono", `url(${symbolsFontUrl})`);
      document.fonts.add(await face.load());
    } catch {
      // Locally installed fallback faces still apply.
    }
  })();
  return symbolsFontLoad;
}

function quoteTerminalFontFamilies(list: string): string {
  return list
    .split(",")
    .map((name) => {
      const bare = name.trim();
      if (bare.length === 0) return "";
      if (/^(['"]).*\1$/.test(bare)) return bare;
      if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(bare)) return bare;
      return `"${bare.replaceAll('"', "")}"`;
    })
    .filter((name) => name.length > 0)
    .join(", ");
}

function uncheckedTerminalFontFamily(family?: string): string {
  const custom = family === undefined ? "" : quoteTerminalFontFamilies(family);
  return custom.length === 0
    ? DEFAULT_TERMINAL_FONT_FAMILY
    : `${custom}, ${TERMINAL_GLYPH_FALLBACKS}`;
}

export function terminalFontFamily(family?: string): string {
  // Quote non-ident names ("3270 Nerd Font", "M+ 1m"): an unquoted one makes
  // the whole canvas font string invalid and the assignment silently no-ops.
  const custom = family === undefined ? "" : quoteTerminalFontFamilies(family);
  if (custom.length === 0) return DEFAULT_TERMINAL_FONT_FAMILY;
  // The grid places the cursor and selection on one cell advance, so a
  // proportional face would draw its text narrower than its own cells. Refuse
  // it here rather than render a ragged grid with a stranded cursor.
  if (!isMonospaceFamily(custom)) return DEFAULT_TERMINAL_FONT_FAMILY;
  // A custom face keeps the glyph fallbacks so prompt symbols stay covered.
  return uncheckedTerminalFontFamily(custom);
}

/** Load every style the renderer can request, then validate the actual face. */
export async function loadTerminalFontFamily(
  family: string | undefined,
  size: number,
  environment?: {
    readonly load: (font: string, text: string) => Promise<unknown>;
    readonly resolve: (family: string | undefined) => string;
  },
): Promise<string> {
  const candidate = uncheckedTerminalFontFamily(family);
  const load =
    environment?.load ??
    ((font: string, text: string) =>
      typeof document !== "undefined" && document.fonts
        ? document.fonts.load(font, text)
        : Promise.resolve([]));
  try {
    await Promise.all(
      TERMINAL_FONT_LOAD_VARIANTS.map((variant) =>
        load(`${variant} ${size}px ${candidate}`, TERMINAL_FONT_LOAD_TEXT),
      ),
    );
  } catch {
    // The fixed-width fallback stack remains available if a face cannot load.
  }
  return (environment?.resolve ?? terminalFontFamily)(family);
}

export function terminalFontSize(size?: number): number {
  if (size === undefined || !Number.isFinite(size)) return DEFAULT_TERMINAL_FONT_SIZE;
  return Math.max(MIN_TERMINAL_FONT_SIZE, Math.min(MAX_TERMINAL_FONT_SIZE, Math.round(size)));
}

/**
 * Whether the cursor should keep toggling. An unfocused surface draws a steady
 * hollow cursor instead of blinking, and a reduced-motion reader gets a steady
 * cursor too rather than a permanently animating element.
 */
export function shouldBlinkTerminalCursor(state: {
  readonly focused: boolean;
  readonly cursorBlinking: boolean;
  readonly cursorVisible: boolean;
  readonly reducedMotion: boolean;
}): boolean {
  return state.focused && state.cursorBlinking && state.cursorVisible && !state.reducedMotion;
}

/**
 * Vertical origin of the grid inside the mount. While content is shorter than
 * the viewport the grid sits at the top like a fresh terminal. Once scrollback
 * exists the prompt lives on the bottom row, so the grid anchors to the bottom
 * edge instead: the sub-row remainder moves above row 0 and resizing within a
 * row boundary keeps the prompt pinned instead of snapping up and down.
 */
export function terminalContentOriginY(
  mountHeight: number,
  padding: number,
  rows: number,
  cellHeight: number,
  anchorBottom: boolean,
): number {
  if (!anchorBottom) return padding;
  const slack = mountHeight - padding * 2 - rows * cellHeight;
  return padding + Math.max(0, slack);
}

export interface TerminalScrollbarGeometry {
  readonly thumbHeight: number;
  readonly thumbTop: number;
  readonly maxOffset: number;
}

export function terminalScrollbarGeometry(
  state: GhosttyScrollbar,
  trackHeight: number,
): TerminalScrollbarGeometry | null {
  const total = Math.max(0, state.total);
  const len = Math.max(0, Math.min(state.len, total));
  const maxOffset = Math.max(0, total - len);
  if (trackHeight <= 0 || len <= 0 || maxOffset === 0) return null;
  const thumbHeight = Math.min(
    trackHeight,
    Math.max(MIN_SCROLLBAR_THUMB_HEIGHT, (trackHeight * len) / total),
  );
  const travel = Math.max(0, trackHeight - thumbHeight);
  const offset = Math.max(0, Math.min(state.offset, maxOffset));
  return {
    thumbHeight,
    thumbTop: travel * (offset / maxOffset),
    maxOffset,
  };
}

export function terminalScrollbarOffsetAtPointer(
  state: GhosttyScrollbar,
  trackHeight: number,
  pointerY: number,
  pointerOffset: number,
): number {
  const geometry = terminalScrollbarGeometry(state, trackHeight);
  if (geometry === null) return 0;
  const travel = Math.max(0, trackHeight - geometry.thumbHeight);
  if (travel === 0) return 0;
  const thumbTop = Math.max(0, Math.min(pointerY - pointerOffset, travel));
  return Math.round((thumbTop / travel) * geometry.maxOffset);
}

function terminalMeasuredGrid(
  width: number,
  height: number,
  metrics: GhosttyCellMetrics,
): { cols: number; rows: number } | null {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= CONTENT_PADDING * 2 + metrics.width ||
    height <= CONTENT_PADDING * 2 + metrics.height
  ) {
    return null;
  }
  return terminalGridSize(width, height, metrics, CONTENT_PADDING);
}

export function terminalGridCellAt(options: {
  bounds: { left: number; top: number };
  clientX: number;
  clientY: number;
  cols: number;
  rows: number;
  metrics: Pick<GhosttyCellMetrics, "width" | "height">;
  padding: number;
  originY: number;
}): { x: number; y: number } | null {
  const { bounds, clientX, clientY, cols, rows, metrics, padding, originY } = options;
  const gridX = clientX - bounds.left - padding;
  const gridY = clientY - bounds.top - originY;
  if (gridX < 0 || gridY < 0 || gridX >= cols * metrics.width || gridY >= rows * metrics.height) {
    return null;
  }
  return {
    x: Math.floor(gridX / metrics.width),
    y: Math.floor(gridY / metrics.height),
  };
}

function terminalRowText(row: GhosttySnapshot["rowData"][number], trimRight: boolean): string {
  const text = row.cells.map((cell) => cell.text || " ").join("");
  return trimRight ? text.trimEnd() : text;
}

function terminalColumnOffset(row: GhosttySnapshot["rowData"][number], column: number): number {
  let offset = 0;
  for (let cellIndex = 0; cellIndex < column; cellIndex += 1) {
    offset += row.cells[cellIndex]?.text.length || 1;
  }
  return offset;
}

export function terminalLinkAtPosition(
  rows: GhosttySnapshot["rowData"],
  rowIndex: number,
  column: number,
): string | null {
  return terminalLinkAtPositionWithRange(rows, rowIndex, column)?.text ?? null;
}

export interface TerminalLinkWithRange {
  readonly text: string;
  readonly range: GhosttyCellRange;
}

function terminalColumnAtOffset(row: GhosttySnapshot["rowData"][number], offset: number): number {
  for (let column = 0; column < row.cells.length; column += 1) {
    const nextOffset = terminalColumnOffset(row, column + 1);
    if (offset < nextOffset) return column;
  }
  return Math.max(0, row.cells.length - 1);
}

export function terminalLinkAtPositionWithRange(
  rows: GhosttySnapshot["rowData"],
  rowIndex: number,
  column: number,
  linkMatcher: GhosttyTerminalLinkMatcher = matchTerminalUrls,
): TerminalLinkWithRange | null {
  const wrappedLine = collectWrappedTerminalLinkLine(rowIndex + 1, (index) => {
    const row = rows[index];
    if (!row) return null;
    return {
      isWrapped: row.isWrapContinuation,
      translateToString: (trimRight = false) => terminalRowText(row, trimRight),
    };
  });
  if (!wrappedLine) return null;
  // Only viewport rows are available: a wrapped line whose head scrolled above
  // the viewport would resolve a truncated match into a wrong link.
  const firstSegment = wrappedLine.segments[0];
  if (firstSegment && rows[firstSegment.bufferLineNumber - 1]?.isWrapContinuation) {
    return null;
  }
  const segment = wrappedLine.segments.find((value) => value.bufferLineNumber === rowIndex + 1);
  const row = rows[rowIndex];
  if (!segment || !row) return null;
  const lastSegment = wrappedLine.segments.at(-1);
  const lastRow = lastSegment ? rows[lastSegment.bufferLineNumber - 1] : undefined;
  // Ghostty's soft-wrap flag is authoritative: when the last collected row
  // still wraps onward, its continuation is outside the viewport.
  const continuesBelowViewport = lastRow !== undefined && lastRow.wrapsToNext;
  const offset = segment.startIndex + terminalColumnOffset(row, column);
  const matches = linkMatcher(wrappedLine.text);
  for (const match of matches) {
    if (offset >= match.start && offset < match.end) {
      // A truncated tail must not activate as a complete link.
      if (match.end === wrappedLine.text.length && continuesBelowViewport) return null;
      const startSegment = wrappedLine.segments.find(
        (value) => match.start >= value.startIndex && match.start < value.endIndex,
      );
      const endSegment = wrappedLine.segments.find(
        (value) => match.end - 1 >= value.startIndex && match.end - 1 < value.endIndex,
      );
      const startRow = startSegment ? rows[startSegment.bufferLineNumber - 1] : undefined;
      const endRow = endSegment ? rows[endSegment.bufferLineNumber - 1] : undefined;
      if (!startSegment || !endSegment || !startRow || !endRow) return null;
      return {
        text: match.text,
        range: {
          start: {
            x: terminalColumnAtOffset(startRow, match.start - startSegment.startIndex),
            y: startSegment.bufferLineNumber - 1,
          },
          end: {
            x: terminalColumnAtOffset(endRow, match.end - 1 - endSegment.startIndex),
            y: endSegment.bufferLineNumber - 1,
          },
        },
      };
    }
  }
  return null;
}

export function terminalLinkAtColumn(row: GhosttySnapshot["rowData"][number], column: number) {
  return terminalLinkAtPosition([row], 0, column);
}

export function isTerminalCopyShortcut(
  event: Pick<KeyboardEvent, "ctrlKey" | "key" | "metaKey" | "shiftKey">,
  platform = navigator.platform,
) {
  if (event.key.toLowerCase() !== "c") return false;
  return isMacPlatform(platform) ? event.metaKey : event.ctrlKey;
}

export function isTerminalPasteShortcut(
  event: Pick<KeyboardEvent, "ctrlKey" | "key" | "metaKey" | "shiftKey">,
  platform = navigator.platform,
) {
  if (event.key.toLowerCase() !== "v") return false;
  return isMacPlatform(platform) ? event.metaKey : event.ctrlKey && event.shiftKey;
}

export function isTerminalCompositionCommitInput(event: Pick<InputEvent, "inputType">): boolean {
  return (
    event.inputType === "" ||
    event.inputType === "insertCompositionText" ||
    event.inputType === "insertFromComposition"
  );
}

export function isTerminalAltGraphText(
  event: Pick<KeyboardEvent, "getModifierState" | "key">,
): boolean {
  return event.getModifierState("AltGraph") && [...event.key].length === 1;
}

export function shouldReportTerminalMouse(
  tracking: boolean,
  event: Pick<MouseEvent, "ctrlKey" | "metaKey" | "shiftKey">,
): boolean {
  return tracking && !event.shiftKey && !event.ctrlKey && !event.metaKey;
}

export function terminalWheelDeltaRows(
  event: Pick<WheelEvent, "deltaY" | "deltaMode">,
  cellHeight: number,
  viewportRows: number,
  remainder: number,
): { readonly rows: number; readonly remainder: number } {
  // deltaMode: 0 pixels, 1 lines, 2 pages.
  const pixels =
    event.deltaMode === 1
      ? event.deltaY * cellHeight
      : event.deltaMode === 2
        ? event.deltaY * viewportRows * cellHeight
        : event.deltaY;
  const total = remainder + pixels / cellHeight;
  const rows = Math.trunc(total);
  return { rows, remainder: total - rows };
}

export function terminalWheelArrowData(rows: number, applicationCursorKeys: boolean): string {
  if (rows === 0) return "";
  const sequence =
    rows < 0
      ? applicationCursorKeys
        ? "\u001bOA"
        : "\u001b[A"
      : applicationCursorKeys
        ? "\u001bOB"
        : "\u001b[B";
  return sequence.repeat(Math.abs(rows));
}

export function isTerminalLinkPointerGesture(
  event: Pick<MouseEvent, "ctrlKey" | "metaKey">,
  platform = navigator.platform,
): boolean {
  return isMacPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

export function shouldShowTerminalLinkHover(
  mouseTracking: boolean,
  linkModifierActive: boolean,
): boolean {
  return !mouseTracking || linkModifierActive;
}

export function ghosttyMouseButton(button: number): number | null {
  switch (button) {
    case 0:
      return 1;
    case 1:
      return 3;
    case 2:
      return 2;
    case 3:
      return 4;
    case 4:
      return 5;
    default:
      return null;
  }
}

export interface TerminalSelectionClickSequence {
  readonly count: number;
  readonly time: number;
  readonly x: number;
  readonly y: number;
}

export function advanceTerminalSelectionClickSequence(
  previous: TerminalSelectionClickSequence | null,
  event: Pick<PointerEvent, "clientX" | "clientY" | "timeStamp">,
): TerminalSelectionClickSequence {
  const repeats =
    previous !== null &&
    event.timeStamp - previous.time <= 500 &&
    Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= 4;
  return {
    count: repeats ? (previous.count >= 3 ? 1 : previous.count + 1) : 1,
    time: event.timeStamp,
    x: event.clientX,
    y: event.clientY,
  };
}

export interface GhosttySelectionPosition {
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
}

export interface GhosttyTerminalSurfaceOptions {
  readonly theme: GhosttyTheme;
  readonly font?: GhosttyTerminalFont;
  readonly onData?: (data: string) => void;
  readonly onResize?: (cols: number, rows: number) => void;
  readonly onSelectionChange?: () => void;
  /** Return false to consume a key before Ghostty encodes it. */
  readonly beforeKey?: (event: KeyboardEvent) => boolean;
  readonly onLinkActivate?: (text: string, event: MouseEvent) => void;
  /** Match links in a wrapped terminal line for hover and activation. */
  readonly linkMatcher?: GhosttyTerminalLinkMatcher;
  /** Keep parsing live output, but skip canvas work while the pane is hidden. */
  readonly visible?: boolean;
  /** Whether this parser or the server-side owner answers terminal queries. */
  readonly responsePolicy?: GhosttyResponsePolicy;
  readonly onTitleChange?: (title: string) => void;
  /** Presentation telemetry only; transport ACK must not depend on this callback. */
  readonly onPresented?: (sample: TerminalPresentationSample) => void;
  /** Renderer selection for tests/operators; auto prefers a validated WebGL2 context. */
  readonly renderer?: TerminalRendererPreference;
  /** Parser placement. Worker is default with automatic main-thread initialization fallback. */
  readonly runtime?: TerminalRuntimeKind;
  /** Worker failures require the host to replay into a fresh runtime generation. */
  readonly onRuntimeError?: (error: Error) => void;
  /** Request an authoritative host replay after worker generation recovery. */
  readonly onRuntimeRecoveryRequired?: () => void;
}

export interface TerminalRendererCpuPercentiles {
  readonly samples: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export interface GhosttyTerminalLifecycleSnapshot {
  readonly surfaceInstanceId: number;
  readonly runtimeKind: TerminalRuntimeKind;
  readonly runtimeGeneration: number;
  readonly rendererBackend: TerminalRenderer["kind"];
  readonly rendererGeneration: number;
  readonly rendererRecoveries: number;
  readonly rendererSubmission: TerminalRendererSubmissionDiagnostics | null;
  readonly rendererCpuMs: TerminalRendererCpuPercentiles;
  readonly attachCount: number;
  readonly resizeCount: number;
  readonly geometryGeneration: number;
  readonly lastSubmittedModelFrame: number;
  readonly lastNextPaintObservedFrame: number;
  readonly compatibilitySnapshotBuilds: number;
  readonly decodedGraphemes: number;
  readonly workerDiagnostics: ReturnType<TerminalCoreRuntime["workerDiagnostics"]>;
}

let nextSurfaceInstanceId = 1;
const MAX_RENDERER_CPU_SAMPLES = 256;
const IDLE_MAINTENANCE_INTERVAL_MS = 10_000
const rendererIdleMaintainers = new Set<(now: number) => void>()
let rendererIdleMaintenanceTimer: number | null = null

function registerRendererIdleMaintenance(maintain: (now: number) => void): () => void {
  rendererIdleMaintainers.add(maintain)
  if (rendererIdleMaintenanceTimer === null) {
    rendererIdleMaintenanceTimer = window.setInterval(() => {
      const now = performance.now()
      for (const callback of rendererIdleMaintainers) callback(now)
    }, IDLE_MAINTENANCE_INTERVAL_MS)
  }
  return () => {
    rendererIdleMaintainers.delete(maintain)
    if (rendererIdleMaintainers.size > 0 || rendererIdleMaintenanceTimer === null) return
    window.clearInterval(rendererIdleMaintenanceTimer)
    rendererIdleMaintenanceTimer = null
  }
}

function rendererCpuPercentiles(samples: readonly number[]): TerminalRendererCpuPercentiles {
  if (samples.length === 0) return { samples: 0, p50: 0, p95: 0, p99: 0 };
  const sorted = [...samples].sort((left, right) => left - right);
  const valueAt = (percentile: number): number => {
    const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1);
    return sorted[index] ?? 0;
  };
  return {
    samples: samples.length,
    p50: valueAt(0.5),
    p95: valueAt(0.95),
    p99: valueAt(0.99),
  };
}

export class GhosttyTerminalSurface {
  readonly surfaceInstanceId = nextSurfaceInstanceId++;
  canvas: HTMLCanvasElement;
  readonly input: HTMLTextAreaElement;
  readonly scrollbar: HTMLDivElement;
  cols = DEFAULT_TERMINAL_COLS;
  rows = DEFAULT_TERMINAL_ROWS;

  private readonly mount: HTMLElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly core: TerminalCoreRuntime;
  private readonly viewportModel = new GhosttyViewportModel();
  private readonly rendererController: RendererController;
  private readonly renderViewport = {
    cssWidth: 0,
    cssHeight: 0,
    pixelRatio: 1,
    padding: CONTENT_PADDING,
    originY: CONTENT_PADDING,
  };
  private readonly options: GhosttyTerminalSurfaceOptions;
  private lastTitle = "";
  private metrics: GhosttyCellMetrics;
  private fontFamily: string;
  private requestedFontFamily: string | undefined;
  private fontSize: number;
  private fontEpoch = 0;
  private pendingFontEpoch: number | null = null;
  private pendingFontFamily: string | undefined;
  private pendingFontSize = 0;
  private readonly resizeObserver: ResizeObserver;
  private readonly geometryCoordinator: TerminalGeometryCoordinator;
  private readonly scrollbarThumb: HTMLDivElement;
  private snapshot: GhosttySnapshot | null = null;
  private terminalStateDirty = true;
  private visible: boolean;
  private frame = 0;
  private cursorTimer: number | null = null;
  private synchronizedOutputTimer: number | null = null;
  private synchronizedOutputActive = false;
  private compositionInputToSuppress: string | null = null;
  private compositionSuppressionTimer: number | null = null;
  private cursorOn = true;
  private renderedCursorY: number | null = null;
  private forceFullRender = true;
  private scrollbarDirty = true;
  private scrollbarState: GhosttyScrollbar | null = null;
  private scrollbarStateKnown = false;
  private scrollbarPointerId: number | null = null;
  private scrollbarPointerOffset = 0;
  private readonly viewportActivity = new TerminalViewportActivityPolicy();
  private contentGeneration = 0;
  private disposed = false;
  private originY = CONTENT_PADDING;
  private mountHeight = 0;
  private selectionEnd: { x: number; y: number } | null = null;
  private selectionAnchorScreen: { x: number; y: number } | null = null;
  private selectionEndScreen: { x: number; y: number } | null = null;
  private selectionMode: "cell" | "word" | "line" = "cell";
  // Word/line selection base in screen coordinates so streaming output cannot
  // shift the origin of a drag selection.
  private selectionBase: {
    start: { x: number; y: number };
    end: { x: number; y: number };
  } | null = null;
  private selectionScrollTimer: number | null = null;
  private selectionScrollDelta = 0;
  private selectionPointer: { x: number; y: number } | null = null;
  private mouseReportingPointerId: number | null = null;
  private mouseReportingButton: number | null = null;
  private linkActivationPointerId: number | null = null;
  private hoveredLink: TerminalLinkWithRange | null = null;
  private hoverPointer: { x: number; y: number } | null = null;
  private linkModifierActive = false;
  private selectionClickSequence: TerminalSelectionClickSequence | null = null;
  private selectionMoved = false;
  private composing = false;
  private focused = false;
  private resizeNotified = false;
  private measuredSize = false;
  private canvasConfigured = false;
  private fitRetryFrame = 0;
  private fitRetries = 0;
  private theme: GhosttyTheme;
  private readonly suppressedKeyCodes = new Set<string>();
  private pasteShortcutToken = 0;
  private copyShortcutToken = 0;
  private clearSelectionAfterCopy = false;
  private wheelRemainder = 0;
  private touchGesture: {
    pointerId: number;
    startX: number;
    startY: number;
    lastY: number;
    rowRemainder: number;
    selecting: boolean;
  } | null = null;
  private touchHoldTimer: number | null = null;
  private virtualCtrl = false;
  private virtualAlt = false;
  private dprMedia: MediaQueryList | null = null;
  // Read live on every blink decision, and watched so that dropping the
  // preference restarts a blink cycle that has no timer left to notice it.
  private readonly reducedMotionMedia = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  private inputLeft = -1;
  private inputTop = -1;
  private attachCount = 0;
  private resizeCount = 0;
  private geometryGeneration = 0;
  private lastSubmittedModelFrame = 0;
  private lastNextPaintObservedFrame = 0;
  private pendingPresentationFrame = 0;
  private readonly rendererCpuSamples: number[] = [];
  private lastRendererActivityAt = performance.now()
  private lastObservedWorkerBytes = 0
  private unregisterIdleMaintenance: (() => void) | null = null

  private constructor(
    mount: HTMLElement,
    canvas: HTMLCanvasElement,
    input: HTMLTextAreaElement,
    scrollbar: HTMLDivElement,
    scrollbarThumb: HTMLDivElement,
    context: CanvasRenderingContext2D,
    renderer: TerminalRenderer,
    core: TerminalCoreRuntime,
    metrics: GhosttyCellMetrics,
    fontFamily: string,
    options: GhosttyTerminalSurfaceOptions,
  ) {
    this.mount = mount;
    this.canvas = canvas;
    this.input = input;
    this.scrollbar = scrollbar;
    this.scrollbarThumb = scrollbarThumb;
    this.context = context;
    this.core = core;
    this.metrics = metrics;
    this.options = options;
    this.theme = options.theme;
    this.visible = options.visible ?? true;
    mount.dataset.ghosttyTerminalRuntime = core.kind;
    this.fontFamily = fontFamily;
    this.requestedFontFamily = options.font?.family;
    this.fontSize = terminalFontSize(options.font?.size);
    mount.dataset.ghosttyTerminalRenderBackend = renderer.kind;
    canvas.dataset.ghosttyTerminalRenderBackend = renderer.kind;
    this.rendererController = new RendererController(
      { canvas, renderer },
      async (backend) => {
        const created = createTerminalRenderer({
          preference: backend,
          font: { family: this.fontFamily, size: this.fontSize },
          viewport: this.renderViewport,
          background: this.theme.background,
        });
        if (created.renderer.kind !== backend) {
          created.renderer.dispose();
          throw new Error(`${backend} recovery initialization failed`);
        }
        return { canvas: created.canvas, renderer: created.renderer };
      },
      (next, previous) => this.activateRenderer(next, previous),
      () => {
        this.forceFullRender = true;
        this.requestRender();
      },
    );
    this.unregisterIdleMaintenance = registerRendererIdleMaintenance(now => {
      this.maintainIdleCapacity(now)
    })
    this.updateRendererDiagnostics();
    this.geometryCoordinator = new TerminalGeometryCoordinator({
      padding: CONTENT_PADDING,
      onCommit: commit => this.commitGeometry(commit),
    });
    this.resizeObserver = new ResizeObserver(entries => {
      const entry = entries.find(candidate => candidate.target === this.mount);
      const width = entry?.contentRect.width ?? this.mount.clientWidth;
      const height = entry?.contentRect.height ?? this.mount.clientHeight;
      this.observeGeometry(width, height);
    });
    this.installEvents();
    this.watchDevicePixelRatio();
    this.reducedMotionMedia?.addEventListener("change", this.onReducedMotionChange);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    document.fonts.addEventListener("loadingdone", this.onFontsLoaded);
    this.resizeObserver.observe(mount);
    mount.dataset.ghosttyTerminalSurfaceInstance = String(this.surfaceInstanceId);
  }

  get runtimeKind(): TerminalRuntimeKind {
    return this.core.kind;
  }

  get renderBackend(): TerminalRenderer["kind"] {
    const backend = this.rendererController.backend;
    return backend === "unavailable" ? "canvas2d" : backend;
  }

  lifecycleSnapshot(): GhosttyTerminalLifecycleSnapshot {
    const renderer = this.rendererController.diagnostics;
    return {
      surfaceInstanceId: this.surfaceInstanceId,
      runtimeKind: this.core.kind,
      runtimeGeneration: this.core.runtimeGeneration,
      rendererBackend: this.renderBackend,
      rendererGeneration: renderer.generation,
      rendererRecoveries: renderer.recoveryCount,
      rendererSubmission: renderer.submission,
      rendererCpuMs: rendererCpuPercentiles(this.rendererCpuSamples),
      attachCount: this.attachCount,
      resizeCount: this.resizeCount,
      geometryGeneration: this.geometryGeneration,
      lastSubmittedModelFrame: this.lastSubmittedModelFrame,
      lastNextPaintObservedFrame: this.lastNextPaintObservedFrame,
      compatibilitySnapshotBuilds: this.viewportModel.compatibilitySnapshotBuilds,
      decodedGraphemes: this.viewportModel.decodedGraphemes,
      workerDiagnostics: this.core.workerDiagnostics(),
    };
  }

  recordAttach(): void {
    if (this.disposed) return;
    this.attachCount += 1;
    this.mount.dataset.ghosttyTerminalAttachCount = String(this.attachCount);
  }

  static async create(
    mount: HTMLElement,
    options: GhosttyTerminalSurfaceOptions,
  ): Promise<GhosttyTerminalSurface> {
    mount.classList.add("ghostty-terminal");
    mount.setAttribute("data-ghostty-terminal", "");
    const input = document.createElement("textarea");
    input.className = "ghostty-terminal__input";
    input.setAttribute("data-ghostty-terminal-input", "");
    input.setAttribute("aria-label", "Terminal input");
    input.autocapitalize = "off";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.style.cssText =
      "position:absolute;left:4px;top:4px;width:1px;height:1px;opacity:0;padding:0;border:0;resize:none;pointer-events:none;";

    const scrollbar = document.createElement("div");
    scrollbar.className = "ghostty-terminal__scrollbar";
    scrollbar.setAttribute("role", "scrollbar");
    scrollbar.setAttribute("aria-label", "Terminal scrollback");
    scrollbar.setAttribute("aria-orientation", "vertical");
    scrollbar.tabIndex = 0;
    scrollbar.hidden = true;
    const scrollbarThumb = document.createElement("div");
    scrollbarThumb.className = "ghostty-terminal__scrollbar-thumb";
    scrollbar.append(scrollbarThumb);

    const measurementCanvas = document.createElement("canvas");
    const context = measurementCanvas.getContext("2d");
    if (!context) throw new Error("Canvas text measurement is unavailable");
    const fontSize = terminalFontSize(options.font?.size);
    try {
      // Cell metrics must come from the faces that will render; measuring before
      // the bundled webfonts load would size the grid from a fallback font.
      await ensureTerminalSymbolsFont();
    } catch {
      // Metrics fall back to whichever faces are already available.
    }
    const fontFamily = await loadTerminalFontFamily(options.font?.family, fontSize);
    const metrics = measureGhosttyCell(context, fontSize, fontFamily);
    const ratio = window.devicePixelRatio || 1;
    const searchPreference = terminalRendererPreferenceFromSearch(window.location.search);
    const storedPreference = parseTerminalRendererPreference(
      window.localStorage.getItem("yaade:terminal-renderer"),
    );
    const createdRenderer = createTerminalRenderer({
      preference: options.renderer ?? (searchPreference === "auto" ? storedPreference : searchPreference),
      font: { family: fontFamily, size: fontSize },
      viewport: {
        cssWidth: mount.clientWidth,
        cssHeight: mount.clientHeight,
        pixelRatio: ratio,
        padding: CONTENT_PADDING,
        originY: CONTENT_PADDING,
      },
      background: options.theme.background,
    });
    const { canvas, renderer } = createdRenderer;
    canvas.dataset.ghosttyTerminalPadding = String(CONTENT_PADDING);
    mount.replaceChildren(canvas, input, scrollbar);
    if (createdRenderer.fallbackReason !== null) {
      mount.dataset.ghosttyTerminalRenderFallback = createdRenderer.fallbackReason.reason;
    }
    const measuredGrid = terminalMeasuredGrid(
      mount.clientWidth,
      mount.clientHeight,
      metrics,
    );
    const grid = measuredGrid ?? {
      cols: DEFAULT_TERMINAL_COLS,
      rows: DEFAULT_TERMINAL_ROWS,
    };
    const runtimeFromSearch = new URLSearchParams(window.location.search).get("runtime");
    const runtimeFromStorage = window.localStorage.getItem("yaade:terminal-runtime");
    const runtimePreference = options.runtime ??
      (runtimeFromSearch === "main" || runtimeFromSearch === "worker" ? runtimeFromSearch : null) ??
      (runtimeFromStorage === "main" || runtimeFromStorage === "worker" ? runtimeFromStorage : "worker");
    let surface: GhosttyTerminalSurface | null = null;
    const runtimeOptions = {
      cols: grid.cols,
      rows: grid.rows,
      cellWidth: metrics.width,
      cellHeight: metrics.height,
      theme: options.theme,
      visible: options.visible ?? true,
      focused: false,
      responsePolicy: options.responsePolicy,
      onData: options.onData ?? (() => undefined),
      onUpdate: () => surface?.afterRuntimeUpdate(),
      onError: (error: Error) => {
        mount.dataset.ghosttyTerminalRuntimeState = "recovering";
        options.onRuntimeError?.(error);
      },
      onRecoveryRequired: () => {
        mount.dataset.ghosttyTerminalRuntimeState = "replay-required";
        options.onRuntimeRecoveryRequired?.();
      },
    };
    let core: TerminalCoreRuntime;
    if (runtimePreference === "worker" && typeof Worker === "function") {
      try {
        core = await WorkerTerminalCore.create(runtimeOptions);
      } catch (error) {
        mount.dataset.ghosttyTerminalRuntimeFallback =
          error instanceof Error ? error.message : String(error);
        core = await MainThreadTerminalCore.create(runtimeOptions);
      }
    } else {
      core = await MainThreadTerminalCore.create(runtimeOptions);
    }
    surface = new GhosttyTerminalSurface(
      mount,
      canvas,
      input,
      scrollbar,
      scrollbarThumb,
      context,
      renderer,
      core,
      metrics,
      fontFamily,
      options,
    );
    surface.ensureFitted();
    surface.requestRender();
    return surface;
  }

  /**
   * Hidden panes keep their PTY and parser alive, but do not schedule canvas
   * snapshots. Showing a pane forces one authoritative full repaint.
   */
  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    this.core.setPresentationState(visible, this.focused);
    if (!visible) {
      if (this.frame !== 0) {
        window.cancelAnimationFrame(this.frame);
        this.frame = 0;
      }
      if (this.cursorTimer !== null) {
        window.clearTimeout(this.cursorTimer);
        this.cursorTimer = null;
      }
      return;
    }
    this.forceFullRender = true;
    this.scrollbarDirty = true;
    this.cursorOn = true;
    this.core.requestFullFrame();
    this.ensureFitted();
    this.requestRender();
  }

  write(data: string | Uint8Array, onParsed?: ParsedCallback): void {
    if (this.disposed) return;
    this.contentGeneration += 1;
    this.core.write(data, onParsed);
    if (this.core.kind === "main") this.afterTerminalWrite();
  }

  /** Feed attach/reconnect output with Ghostty's PTY callback detached. */
  writeReplay(chunks: readonly Uint8Array[], onParsed?: ParsedCallback): void {
    if (this.disposed || chunks.length === 0) return;
    this.contentGeneration += 1;
    this.core.writeReplay(chunks, onParsed);
    if (this.core.kind === "main") this.afterTerminalWrite();
  }

  resetAndWrite(data: string | Uint8Array, onParsed?: ParsedCallback): void {
    if (this.disposed) return;
    this.contentGeneration += 1;
    this.core.resetAndWrite(data, onParsed);
    if (this.core.kind === "main") this.afterTerminalWrite(true);
  }

  private afterRuntimeUpdate(): void {
    if (this.disposed) return;
    // Worker updates have already passed hidden/DEC-2026 suppression and its
    // safety deadline. Do not suppress the authoritative catch-up a second time.
    this.afterTerminalWrite(false, true);
  }

  private afterTerminalWrite(forceFullRender = false, workerPrepared = false): void {
    this.lastRendererActivityAt = performance.now()
    this.terminalStateDirty = true;
    this.syncTitle();
    // Restart the blink cycle from the visible phase so the cursor never sits
    // invisible through a stream of output or a burst of typing echo.
    this.cursorOn = true;
    this.scrollbarDirty = true;
    if (forceFullRender) this.forceFullRender = true;

    // TUI redraws such as Pi bracket a multi-write update with DEC mode 2026.
    // Parsing must continue, but painting a fragment exposes cleared and moved
    // rows as corruption. Paint once the producer closes the transaction.
    if (!workerPrepared && this.core.isModeEnabled(2026)) {
      this.synchronizedOutputActive = true;
      if (this.frame !== 0) {
        window.cancelAnimationFrame(this.frame);
        this.frame = 0;
      }
      if (this.synchronizedOutputTimer === null) {
        this.synchronizedOutputTimer = window.setTimeout(() => {
          this.synchronizedOutputTimer = null;
          // Bypass synchronized-output suppression for the safety timeout.
          if (!this.disposed && this.visible) this.renderFrame();
        }, SYNCHRONIZED_OUTPUT_TIMEOUT_MS);
      }
      return;
    }

    this.synchronizedOutputActive = false;
    if (this.synchronizedOutputTimer !== null) {
      window.clearTimeout(this.synchronizedOutputTimer);
      this.synchronizedOutputTimer = null;
    }
    this.requestRender();
  }

  setTheme(theme: GhosttyTheme): void {
    if (this.disposed || themesEqual(this.theme, theme)) return;
    this.theme = theme;
    this.core.setTheme(theme);
    this.terminalStateDirty = true;
    this.forceFullRender = true;
    this.requestRender();
  }

  async setFont(font: GhosttyTerminalFont): Promise<void> {
    if (this.disposed) return;
    const fontSize = terminalFontSize(font.size);
    if (
      this.pendingFontEpoch !== null &&
      this.pendingFontFamily === font.family &&
      this.pendingFontSize === fontSize
    ) {
      return;
    }
    if (this.requestedFontFamily === font.family && this.fontSize === fontSize) {
      if (this.pendingFontEpoch !== null) {
        this.fontEpoch += 1;
        this.pendingFontEpoch = null;
        this.pendingFontFamily = undefined;
        this.pendingFontSize = 0;
      }
      return;
    }
    // The fields only change together with their metrics after the load, and
    // the epoch lets the newest overlapping call win regardless of load order.
    const epoch = ++this.fontEpoch;
    this.pendingFontEpoch = epoch;
    this.pendingFontFamily = font.family;
    this.pendingFontSize = fontSize;
    const fontFamily = await loadTerminalFontFamily(font.family, fontSize);
    if (this.disposed || epoch !== this.fontEpoch) return;
    this.pendingFontEpoch = null;
    this.pendingFontFamily = undefined;
    this.pendingFontSize = 0;
    this.fontFamily = fontFamily;
    this.requestedFontFamily = font.family;
    this.fontSize = fontSize;
    this.applyFontMetrics();
  }

  private applyFontMetrics(): void {
    this.metrics = measureGhosttyCell(this.context, this.fontSize, this.fontFamily);
    void this.rendererController.setFont({ family: this.fontFamily, size: this.fontSize });
    this.core.resize(this.cols, this.rows, this.metrics.width, this.metrics.height);
    this.terminalStateDirty = true;
    // Cached IME textarea coordinates are stale in the new cell geometry.
    this.inputLeft = -1;
    this.inputTop = -1;
    this.forceFullRender = true;
    this.scrollbarDirty = true;
    this.fit();
    this.requestRender();
  }

  private readonly onReducedMotionChange = () => {
    if (this.disposed) return;
    // Nothing else wakes an idle steady cursor: the blink timer only reschedules
    // from a render, and reduced motion is exactly the state that stopped it.
    this.cursorOn = true;
    this.requestRender();
  };

  private readonly onVisibilityChange = () => {
    if (this.disposed || document.visibilityState !== "visible") return;
    // Chromium can drop a pending rAF while the page is hidden, leaving
    // `frame` set so later writes parse but never paint.
    if (this.frame !== 0) {
      window.cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    this.forceFullRender = true;
    this.scrollbarDirty = true;
    this.requestRender();
  };

  private readonly onFontsLoaded = () => {
    if (this.disposed) return;
    // The explicit load validates every style and applies the newest request.
    // Its own loading events must not revalidate the previously applied face.
    if (this.pendingFontEpoch !== null) return;
    // A face may become available after an earlier fallback measurement. Run
    // the fixed-width guard again before using its newly loaded metrics.
    const fontFamily = terminalFontFamily(this.requestedFontFamily);
    if (fontFamily !== this.fontFamily) {
      this.fontFamily = fontFamily;
      this.applyFontMetrics();
      return;
    }
    // A face that finished loading after the initial measurement changes glyph
    // advances; re-measure and refit so the grid matches what actually renders.
    const metrics = measureGhosttyCell(this.context, this.fontSize, this.fontFamily);
    if (
      metrics.width === this.metrics.width &&
      metrics.height === this.metrics.height &&
      metrics.baseline === this.metrics.baseline
    ) {
      return;
    }
    this.applyFontMetrics();
  };

  fit(): boolean {
    if (this.disposed) return false;
    const width = this.mount.clientWidth;
    const height = this.mount.clientHeight;
    if (terminalMeasuredGrid(width, height, this.metrics) === null) return false;
    this.geometryCoordinator.commitNow({
      cssWidth: width,
      cssHeight: height,
      pixelRatio: window.devicePixelRatio || 1,
      cellWidth: this.metrics.width,
      cellHeight: this.metrics.height,
    });
    return true;
  }

  private observeGeometry(width = this.mount.clientWidth, height = this.mount.clientHeight): boolean {
    if (this.disposed || terminalMeasuredGrid(width, height, this.metrics) === null) return false;
    return this.geometryCoordinator.observe({
      cssWidth: width,
      cssHeight: height,
      pixelRatio: window.devicePixelRatio || 1,
      cellWidth: this.metrics.width,
      cellHeight: this.metrics.height,
    });
  }

  private commitGeometry(commit: TerminalGeometryCommit): void {
    if (this.disposed || commit.generation < this.geometryGeneration) return;
    const pixelWidth = Math.max(1, Math.round(commit.cssWidth * commit.pixelRatio));
    const pixelHeight = Math.max(1, Math.round(commit.cssHeight * commit.pixelRatio));
    const backingChanged =
      this.canvas.width !== pixelWidth ||
      this.canvas.height !== pixelHeight ||
      !this.canvasConfigured;
    const gridChanged =
      commit.cols !== this.cols || commit.rows !== this.rows || !this.resizeNotified;
    this.geometryGeneration = commit.generation;
    this.measuredSize = true;
    this.mountHeight = commit.cssHeight;
    this.renderViewport.cssWidth = commit.cssWidth;
    this.renderViewport.cssHeight = commit.cssHeight;
    this.renderViewport.pixelRatio = commit.pixelRatio;
    if (backingChanged) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
      this.canvasConfigured = true;
    }
    // A backing-store resize clears the canvas before the next paint. Refill it
    // immediately, then composite the retained model in this same frame while
    // runtime/host geometry catches up.
    this.rendererController.resize(this.renderViewport);
    if (backingChanged) this.rendererController.clear(this.theme.background);
    this.forceFullRender = this.forceFullRender || backingChanged || gridChanged;
    this.scrollbarDirty = this.scrollbarDirty || backingChanged || gridChanged;
    if (gridChanged) {
      this.cols = commit.cols;
      this.rows = commit.rows;
      this.core.resize(commit.cols, commit.rows, this.metrics.width, this.metrics.height);
      this.terminalStateDirty = true;
      this.notifyResize();
    }
    const repaintedBacking = backingChanged && this.viewportModel.currentFrameId !== 0;
    if (repaintedBacking) {
      // Main-thread geometry is already authoritative; workers present their
      // update asynchronously and retain the previous model until then.
      this.renderFrame(this.core.kind === "main");
    }
    if (!repaintedBacking && (backingChanged || gridChanged)) this.requestRender();
    this.fitRetries = 0;
    this.mount.dataset.ghosttyTerminalGeometryGeneration = String(this.geometryGeneration);
  }

  /**
   * Flex/grid parents often report 0 on the first open. Keep fitting across
   * subsequent frames until the mount has a real box — otherwise the canvas
   * stays blank until an unrelated layout (split, sidebar) happens to resize it.
   */
  ensureFitted(): boolean {
    if (this.fit()) return true;
    this.scheduleFitRetry();
    return false;
  }

  private scheduleFitRetry(): void {
    if (this.disposed || this.measuredSize || this.fitRetryFrame !== 0) return;
    if (this.fitRetries >= MAX_FIT_RETRIES) return;
    this.fitRetries += 1;
    this.fitRetryFrame = window.requestAnimationFrame(() => {
      this.fitRetryFrame = 0;
      this.ensureFitted();
    });
  }

  /** Keep the PTY and parser grids in lockstep. The host adapter already
   * coalesces resize RPCs while one is in flight, so delaying here only exposes
   * users to stale TUI geometry and visibly incorrect wrapping. */
  private notifyResize(): void {
    this.resizeNotified = true;
    this.resizeCount += 1;
    this.mount.dataset.ghosttyTerminalResizeCount = String(this.resizeCount);
    this.options.onResize?.(this.cols, this.rows);
  }

  focus(): void {
    this.input.focus({ preventScroll: true });
  }

  hasSelection(): boolean {
    return this.core.selectionText().length > 0;
  }

  getSelection(): string {
    return this.core.selectionText();
  }

  getSelectionPosition(): GhosttySelectionPosition | null {
    if (!this.selectionAnchorScreen || !this.selectionEndScreen || !this.hasSelection())
      return null;
    const before =
      this.selectionAnchorScreen.y < this.selectionEndScreen.y ||
      (this.selectionAnchorScreen.y === this.selectionEndScreen.y &&
        this.selectionAnchorScreen.x <= this.selectionEndScreen.x);
    return before
      ? { start: this.selectionAnchorScreen, end: this.selectionEndScreen }
      : { start: this.selectionEndScreen, end: this.selectionAnchorScreen };
  }

  getSelectionEndClientRect(): { readonly right: number; readonly bottom: number } | null {
    const position = this.getSelectionPosition();
    if (!position) return null;
    const viewportEnd = this.core.screenPointToViewport(position.end.x, position.end.y);
    if (!viewportEnd) return null;
    const bounds = this.canvas.getBoundingClientRect();
    return {
      right: bounds.left + CONTENT_PADDING + (viewportEnd.x + 1) * this.metrics.width,
      bottom: bounds.top + this.originY + (viewportEnd.y + 1) * this.metrics.height,
    };
  }

  clearSelection(): void {
    this.core.clearSelection();
    this.terminalStateDirty = true;
    this.selectionEnd = null;
    this.selectionAnchorScreen = null;
    this.selectionEndScreen = null;
    this.selectionMode = "cell";
    this.selectionBase = null;
    this.setSelectionAutoscroll(0);
    this.options.onSelectionChange?.();
    // Selection highlights span rows Ghostty may not mark dirty for this change.
    this.forceFullRender = true;
    this.requestRender();
  }

  scrollToBottom(): void {
    this.core.scrollToBottom();
    this.viewportActivity.jumpToLive();
    this.terminalStateDirty = true;
    this.forceFullRender = true;
    this.scrollbarDirty = true;
    this.requestRender();
  }

  jumpToLive(): void {
    this.scrollToBottom();
    this.focus();
  }

  toggleInspectionPause(): void {
    if (this.viewportActivity.current.mode === "paused") {
      this.viewportActivity.resume();
      this.focus();
      return;
    }
    if (this.viewportActivity.current.mode === "live") {
      const state = this.readScrollbarState();
      if (state === null || state.total <= state.len) return;
      this.scrollViewport(-1);
    }
    this.viewportActivity.pause();
    this.focus();
  }

  getViewportActivity(): TerminalViewportActivity {
    return this.viewportActivity.current;
  }

  canToggleInspectionPause(): boolean {
    if (this.viewportActivity.current.mode !== "live") return true;
    const state = this.core.scrollbarState();
    return state !== null && state.total > state.len;
  }

  subscribeViewportActivity(
    listener: (activity: TerminalViewportActivity) => void,
  ): () => void {
    return this.viewportActivity.subscribe(listener);
  }

  isAtBottom(): boolean {
    return this.core.isViewportActive();
  }

  getSnapshot(): GhosttySnapshot | null {
    // Inspection is a synchronous cold adapter over the retained packed
    // viewport. It never traverses Ghostty state or acknowledges dirty rows.
    if (this.viewportModel.currentFrameId === 0) return null;
    this.snapshot ??= this.viewportModel.snapshot();
    return this.snapshot;
  }

  getBufferText(): string {
    if (this.disposed) return "";
    return this.viewportModel.bufferText();
  }

  async capturePixelStats(): Promise<{
    readonly width: number;
    readonly height: number;
    readonly nonBackgroundPixels: number;
  } | null> {
    const pixels = await this.rendererController.capturePixels();
    if (pixels === null) return null;
    const data = pixels.data;
    const red = data[0] ?? 0;
    const green = data[1] ?? 0;
    const blue = data[2] ?? 0;
    let nonBackgroundPixels = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] !== red || data[index + 1] !== green || data[index + 2] !== blue) {
        nonBackgroundPixels += 1;
      }
    }
    return { width: pixels.width, height: pixels.height, nonBackgroundPixels };
  }

  getCellSize(): { width: number; height: number } {
    return { width: this.metrics.width, height: this.metrics.height };
  }

  /** False while a hidden mount only has the safe 80×24 fallback geometry. */
  hasMeasuredSize(): boolean {
    return !this.disposed && this.measuredSize;
  }

  getViewportY(): number {
    return this.core.scrollbarState()?.offset ?? 0;
  }

  scrollLines(amount: number): void {
    this.scrollViewport(amount);
  }

  setVirtualModifier(modifier: "ctrl" | "alt", active: boolean): void {
    if (modifier === "ctrl") this.virtualCtrl = active;
    else this.virtualAlt = active;
    this.focus();
  }

  sendVirtualKey(key: string, code: string): void {
    const event = new KeyboardEvent("keydown", {
      key,
      code,
      ctrlKey: this.virtualCtrl,
      altKey: this.virtualAlt,
    });
    const data = this.core.encodeKey(event);
    this.consumeVirtualModifiers();
    if (data.length > 0) this.options.onData?.(data);
    this.focus();
  }

  pasteText(text: string): void {
    if (text.length === 0) return;
    this.options.onData?.(this.core.encodePaste(text));
    this.focus();
  }

  private consumeVirtualModifiers(): void {
    this.virtualCtrl = false;
    this.virtualAlt = false;
  }

  private sendText(data: string): void {
    const encoded = this.core.sendText(this.applyVirtualModifiers(data));
    if (encoded.length > 0) this.options.onData?.(encoded);
  }

  private applyVirtualModifiers(data: string): string {
    if (!this.virtualCtrl && !this.virtualAlt) return data;
    let next = data;
    if (this.virtualCtrl && data.length === 1) {
      const code = data.codePointAt(0) ?? 0;
      if (code >= 0x40 && code <= 0x7f) next = String.fromCodePoint(code & 0x1f);
    }
    if (this.virtualAlt) next = `\x1b${next}`;
    this.consumeVirtualModifiers();
    return next;
  }

  private syncTitle(): void {
    const title = this.core.title().trim();
    if (!title || title === this.lastTitle) return;
    this.lastTitle = title;
    this.options.onTitleChange?.(title);
  }

  maintainIdleCapacity(now = performance.now()): boolean {
    if (this.disposed) return false
    const worker = this.core.workerDiagnostics()
    if (
      worker.bytesParsed !== this.lastObservedWorkerBytes ||
      worker.pendingPresentation ||
      worker.schedulerQueueCommands > 0 ||
      worker.schedulerInFlight > 0
    ) {
      this.lastObservedWorkerBytes = worker.bytesParsed
      this.lastRendererActivityAt = now
      return false
    }
    return this.rendererController.trimIdle(this.lastRendererActivityAt, now)
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unregisterIdleMaintenance?.()
    this.unregisterIdleMaintenance = null
    this.resizeObserver.disconnect();
    this.geometryCoordinator.dispose();
    document.fonts.removeEventListener("loadingdone", this.onFontsLoaded);
    this.dprMedia?.removeEventListener("change", this.onDevicePixelRatioChange);
    this.dprMedia = null;
    this.reducedMotionMedia?.removeEventListener("change", this.onReducedMotionChange);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    if (this.selectionScrollTimer !== null) window.clearInterval(this.selectionScrollTimer);
    if (this.touchHoldTimer !== null) window.clearTimeout(this.touchHoldTimer);
    if (this.frame !== 0) window.cancelAnimationFrame(this.frame);
    if (this.pendingPresentationFrame !== 0) {
      window.cancelAnimationFrame(this.pendingPresentationFrame);
      this.pendingPresentationFrame = 0;
    }
    if (this.fitRetryFrame !== 0) window.cancelAnimationFrame(this.fitRetryFrame);
    if (this.cursorTimer !== null) window.clearTimeout(this.cursorTimer);
    if (this.synchronizedOutputTimer !== null) {
      window.clearTimeout(this.synchronizedOutputTimer);
      this.synchronizedOutputTimer = null;
    }
    if (this.compositionSuppressionTimer !== null) {
      window.clearTimeout(this.compositionSuppressionTimer);
    }
    this.removeEvents();
    this.viewportActivity.dispose();
    this.rendererController.dispose();
    this.core.dispose();
    if (
      this.canvas.parentElement === this.mount ||
      this.input.parentElement === this.mount ||
      this.scrollbar.parentElement === this.mount
    ) {
      this.canvas.remove();
      this.input.remove();
      this.scrollbar.remove();
    }
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    this.updateLinkModifier(event);
    // Browser page zoom must remain available while the hidden terminal input
    // has focus. Do not prevent the default, but suppress a Kitty key release
    // because the corresponding press never reached the PTY.
    if (isBrowserZoomShortcut(event, navigator.platform)) {
      this.suppressedKeyCodes.add(event.code);
      return;
    }
    // Presses handled outside the terminal must also swallow their release:
    // beforeKey runs side effects (keybindings, navigation sends), so it cannot
    // be consulted again on keyup, and Kitty report-event-types sessions would
    // otherwise receive a release for a press the shell never saw.
    if (isTerminalAltGraphText(event) || this.options.beforeKey?.(event) === false) {
      this.suppressedKeyCodes.add(event.code);
      return;
    }
    if (isTerminalCopyShortcut(event) && this.hasSelection()) {
      // A plain Ctrl+C/Cmd+C fires the browser's native copy event, caught in
      // onCopyEvent; not preventing the default keeps that path alive. WebKit
      // omits the keyboard copy event without a DOM selection, so race the
      // clipboard write against it the same way paste races its read. The
      // Shift variant has no native event (Chrome binds Ctrl+Shift+C to
      // inspect), so synthesize one with execCommand("copy").
      if (event.shiftKey) {
        event.preventDefault();
        document.execCommand("copy");
      } else {
        // A plain Ctrl+C is also SIGINT on non-mac: clear the selection once
        // it copies so the next Ctrl+C reaches the shell. The Shift chord and
        // Cmd+C are copy-only, so they keep the selection; resetting the flag
        // up front also drops any clear owed by an earlier gesture that never
        // completed.
        this.clearSelectionAfterCopy = !event.shiftKey && !isMacPlatform(navigator.platform);
        const clipboard = navigator.clipboard;
        if (typeof clipboard?.writeText === "function") {
          // Defer the write past the default action: the native copy event
          // (dispatched synchronously with the default action) claims the
          // token first when it fires, and the write covers browsers whose
          // shortcut produces no copy event. Skipping a write the native
          // event already handled stops a stale resolution from clobbering a
          // clipboard the user filled after this copy.
          const token = ++this.copyShortcutToken;
          const selection = this.getSelection();
          void Promise.resolve().then(() => {
            if (this.disposed || this.copyShortcutToken !== token) return;
            void clipboard.writeText(selection).then(
              () => {
                // The write may have been superseded while in flight; only
                // touch the selection if this gesture still owns the token.
                if (this.disposed || this.copyShortcutToken !== token) return;
                if (this.clearSelectionAfterCopy) {
                  this.clearSelectionAfterCopy = false;
                  this.clearSelection();
                }
              },
              () => {
                // The write failed and the native event has already had its
                // chance, so nothing copied and no clear is owed by this
                // gesture; a newer one may have just set the flag, so only
                // drop it if this gesture still owns the token.
                if (this.copyShortcutToken === token) {
                  this.clearSelectionAfterCopy = false;
                }
              },
            );
          });
        }
      }
      this.suppressedKeyCodes.add(event.code);
      return;
    }
    if (isTerminalPasteShortcut(event)) {
      this.suppressedKeyCodes.add(event.code);
      const clipboard = navigator.clipboard;
      if (typeof clipboard?.readText === "function") {
        // Race the async clipboard read against the browser's own paste event:
        // the native event (dispatched synchronously with the default action)
        // always claims the token first when it fires, and the read covers
        // browsers whose paste shortcut produces no paste event. Not preventing
        // the default keeps the native path alive when the read is denied.
        const token = ++this.pasteShortcutToken;
        void clipboard.readText().then(
          (text) => {
            if (this.disposed || this.pasteShortcutToken !== token) return;
            this.pasteShortcutToken += 1;
            if (text.length > 0) this.options.onData?.(this.core.encodePaste(text));
          },
          () => {
            // Clipboard read denied; the native paste event remains the path.
          },
        );
      }
      return;
    }
    if (shouldSuppressMacMetaKey(event, navigator.platform)) {
      event.preventDefault();
      event.stopPropagation();
      this.suppressedKeyCodes.add(event.code);
      return;
    }
    // keyCode 229 is Safari's only signal that this keydown opens an IME
    // composition; encoding it would double the committed text.
    if (event.isComposing || this.composing || event.key === "Process" || event.keyCode === 229) {
      return;
    }
    const encodedEvent =
      this.virtualCtrl || this.virtualAlt
        ? new KeyboardEvent("keydown", {
            key: event.key,
            code: event.code,
            location: event.location,
            repeat: event.repeat,
            ctrlKey: event.ctrlKey || this.virtualCtrl,
            altKey: event.altKey || this.virtualAlt,
            shiftKey: event.shiftKey,
            metaKey: event.metaKey,
          })
        : event;
    const data = this.core.encodeKey(encodedEvent);
    if (data.length === 0 && this.core.kind === "main") return;
    this.consumeVirtualModifiers();
    this.suppressedKeyCodes.delete(event.code);
    event.preventDefault();
    event.stopPropagation();
    if (data.length > 0) this.options.onData?.(data);
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    this.updateLinkModifier(event);
    if (this.suppressedKeyCodes.delete(event.code)) return;
    if (event.isComposing || this.composing || event.key === "Process" || event.keyCode === 229) {
      return;
    }
    // Ghostty's encoder only emits release codes when the terminal enabled the
    // Kitty report-event-types flag, so legacy sessions send nothing here.
    const data = this.core.encodeKey(event, "release");
    if (data.length === 0 && this.core.kind === "main") return;
    event.preventDefault();
    event.stopPropagation();
    if (data.length > 0) this.options.onData?.(data);
  };

  private readonly onFocus = () => {
    this.focused = true;
    this.core.setPresentationState(this.visible, true);
    this.cursorOn = true;
    this.requestRender();
  };

  private readonly onBlur = () => {
    this.focused = false;
    this.core.setPresentationState(this.visible, false);
    this.linkModifierActive = false;
    this.refreshHoveredLink();
    // Suppressions survive blur deliberately: a shortcut that moves focus (for
    // example terminal-toggle) must still swallow its own keyup if focus comes
    // back before release. Stale entries are harmless — an encoding keydown
    // always removes its code first.
    // The steady unfocused hollow cursor must not inherit an off blink phase.
    this.cursorOn = true;
    this.requestRender();
  };

  private readonly onDevicePixelRatioChange = () => {
    this.watchDevicePixelRatio();
    this.observeGeometry();
  };

  private watchDevicePixelRatio(): void {
    this.dprMedia?.removeEventListener("change", this.onDevicePixelRatioChange);
    // A resolution media query only fires once for the ratio it was created at,
    // so re-arm it after every change (monitor moves, browser zoom).
    this.dprMedia = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    this.dprMedia.addEventListener("change", this.onDevicePixelRatioChange);
  }

  private readonly onCopyEvent = (event: ClipboardEvent) => {
    if (!this.hasSelection()) return;
    event.preventDefault();
    event.clipboardData?.setData("text/plain", this.getSelection());
    // The native event beat any deferred write; drop the in-flight fallback.
    this.copyShortcutToken += 1;
    if (this.clearSelectionAfterCopy) {
      this.clearSelectionAfterCopy = false;
      this.clearSelection();
    }
  };

  private readonly onPaste = (event: ClipboardEvent) => {
    // Always suppress the browser's default insertion: content the textarea
    // would receive (for example an html-only clipboard converted to text)
    // leaks through onInput without bracketed-paste encoding.
    event.preventDefault();
    const data = event.clipboardData?.getData("text/plain") ?? "";
    if (data.length === 0) return;
    // The native paste won the race with actual text; a pending clipboard read
    // must not double. An empty native paste leaves the read as the only path.
    this.pasteShortcutToken += 1;
    this.options.onData?.(this.core.encodePaste(data));
  };

  private readonly onCompositionStart = () => {
    this.clearCompositionInputSuppression();
    this.composing = true;
  };

  private readonly onCompositionEnd = (event: CompositionEvent) => {
    this.composing = false;
    const data = this.input.value || event.data;
    if (data.length > 0) this.sendText(data);
    this.input.value = "";
    this.compositionInputToSuppress = data;
    this.compositionSuppressionTimer = window.setTimeout(() => {
      this.compositionInputToSuppress = null;
      this.compositionSuppressionTimer = null;
    }, 100);
  };

  private readonly onInput = (event: Event) => {
    const inputEvent = event as InputEvent;
    if (this.composing || inputEvent.isComposing) return;
    const data = this.input.value || inputEvent.data || "";
    if (data === this.compositionInputToSuppress && isTerminalCompositionCommitInput(inputEvent)) {
      this.clearCompositionInputSuppression();
      this.input.value = "";
      return;
    }
    this.clearCompositionInputSuppression();
    if (data.length > 0) this.sendText(data);
    this.input.value = "";
  };

  private clearCompositionInputSuppression(): void {
    if (this.compositionSuppressionTimer !== null) {
      window.clearTimeout(this.compositionSuppressionTimer);
      this.compositionSuppressionTimer = null;
    }
    this.compositionInputToSuppress = null;
  }

  private clearTouchHold(): void {
    if (this.touchHoldTimer === null) return;
    window.clearTimeout(this.touchHoldTimer);
    this.touchHoldTimer = null;
  }

  private beginTouchSelection(clientX: number, clientY: number): void {
    const gesture = this.touchGesture;
    if (!gesture) return;
    const cell = this.cellAt(clientX, clientY);
    const range = this.core.selectWord(cell.x, cell.y);
    gesture.selecting = true;
    this.selectionMoved = false;
    this.selectionMode = "word";
    this.selectionPointer = { x: clientX, y: clientY };
    if (range) {
      this.selectionBase = range.screen;
      this.selectionEnd = range.viewport.end;
      this.selectionAnchorScreen = range.screen.start;
      this.selectionEndScreen = range.screen.end;
    } else {
      const screen = this.core.viewportPointToScreen(cell.x, cell.y);
      this.selectionMode = "cell";
      this.selectionBase = null;
      this.selectionEnd = cell;
      this.selectionAnchorScreen = screen;
      this.selectionEndScreen = screen;
      if (screen) this.core.setSelection({ ...screen, tag: 2 }, { ...screen, tag: 2 });
    }
    this.terminalStateDirty = true;
    navigator.vibrate?.(8);
    this.options.onSelectionChange?.();
    this.forceFullRender = true;
    this.requestRender();
  }

  private scrollFromTouch(rows: number): void {
    if (rows === 0) return;
    if (this.core.isAlternateScreen()) {
      this.options.onData?.(terminalWheelArrowData(rows, this.core.isApplicationCursorKeys()));
      return;
    }
    this.scrollViewport(rows);
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    this.focus();
    if (event.pointerType === "touch") {
      if (event.button !== 0 || this.touchGesture !== null) return;
      event.preventDefault();
      event.stopPropagation();
      this.clearHoveredLink("default");
      this.clearSelection();
      this.touchGesture = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastY: event.clientY,
        rowRemainder: 0,
        selecting: false,
      };
      this.canvas.setPointerCapture(event.pointerId);
      this.touchHoldTimer = window.setTimeout(() => {
        this.touchHoldTimer = null;
        this.beginTouchSelection(event.clientX, event.clientY);
      }, 450);
      return;
    }
    if (shouldReportTerminalMouse(this.core.isMouseTracking(), event)) {
      const button = ghosttyMouseButton(event.button);
      if (button === null) return;
      event.preventDefault();
      event.stopPropagation();
      this.clearHoveredLink("default");
      this.mouseReportingPointerId = event.pointerId;
      this.mouseReportingButton = button;
      this.sendMouse("press", button, event);
      this.canvas.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    if (isTerminalLinkPointerGesture(event)) {
      event.preventDefault();
      event.stopPropagation();
      this.linkActivationPointerId = event.pointerId;
      this.canvas.setPointerCapture(event.pointerId);
      return;
    }
    this.clearHoveredLink();
    const cell = this.cellAt(event.clientX, event.clientY);
    this.selectionMoved = false;
    this.selectionClickSequence = advanceTerminalSelectionClickSequence(
      this.selectionClickSequence,
      event,
    );
    const clickCount = this.selectionClickSequence.count;
    this.selectionMode = clickCount >= 3 ? "line" : clickCount === 2 ? "word" : "cell";
    const range =
      this.selectionMode === "line"
        ? this.core.selectLine(cell.x, cell.y)
        : this.selectionMode === "word"
          ? this.core.selectWord(cell.x, cell.y)
          : null;
    if (range) {
      this.selectionBase = range.screen;
      this.selectionEnd = range.viewport.end;
      this.selectionAnchorScreen = range.screen.start;
      this.selectionEndScreen = range.screen.end;
      this.options.onSelectionChange?.();
    } else {
      this.selectionMode = "cell";
      this.selectionBase = null;
      this.selectionEnd = cell;
      const screen = this.core.viewportPointToScreen(cell.x, cell.y);
      this.selectionAnchorScreen = screen;
      this.selectionEndScreen = screen;
      if (screen) {
        this.core.setSelection({ ...screen, tag: 2 }, { ...screen, tag: 2 });
      } else {
        this.core.setSelection(cell, cell);
      }
    }
    this.terminalStateDirty = true;
    this.forceFullRender = true;
    this.canvas.setPointerCapture(event.pointerId);
    this.requestRender();
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    const touch = this.touchGesture;
    if (touch?.pointerId === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      if (touch.selecting) {
        this.selectionPointer = { x: event.clientX, y: event.clientY };
        this.extendSelectionTo(event.clientX, event.clientY);
        return;
      }
      const distance = Math.hypot(
        event.clientX - touch.startX,
        event.clientY - touch.startY,
      );
      if (distance >= 8) this.clearTouchHold();
      const rows = (touch.lastY - event.clientY) / this.metrics.height + touch.rowRemainder;
      const wholeRows = Math.trunc(rows);
      touch.lastY = event.clientY;
      touch.rowRemainder = rows - wholeRows;
      this.scrollFromTouch(wholeRows);
      return;
    }
    if (this.linkActivationPointerId === event.pointerId) return;
    // Hover motion is only reportable in any-event tracking (DEC 1003); normal and
    // button-event tracking never report motion without a captured pressed button.
    if (
      this.mouseReportingPointerId === event.pointerId ||
      shouldReportTerminalMouse(this.core.isMouseAnyEventTracking(), event)
    ) {
      event.preventDefault();
      this.hoverPointer = { x: event.clientX, y: event.clientY };
      this.linkModifierActive = isTerminalLinkPointerGesture(event);
      // A drag whose press was already sent to the terminal application cannot
      // turn into link activation midway through, so link feedback would lie.
      this.setHoveredLink(null);
      this.canvas.style.cursor = "default";
      this.sendMouse("motion", this.buttonFromButtons(event.buttons), event);
      return;
    }
    if (!this.selectionAnchorScreen || !this.canvas.hasPointerCapture(event.pointerId)) {
      this.updateHoverCursor(event);
      return;
    }
    this.clearHoveredLink();
    this.selectionPointer = { x: event.clientX, y: event.clientY };
    const bounds = this.canvas.getBoundingClientRect();
    this.setSelectionAutoscroll(
      event.clientY < bounds.top ? -1 : event.clientY > bounds.bottom ? 1 : 0,
    );
    const cell = this.cellAt(event.clientX, event.clientY);
    if (cell.x === this.selectionEnd?.x && cell.y === this.selectionEnd.y) return;
    this.extendSelectionTo(event.clientX, event.clientY);
  };

  private extendSelectionTo(clientX: number, clientY: number): void {
    const anchorScreen = this.selectionAnchorScreen;
    if (anchorScreen === null) return;
    const cell = this.cellAt(clientX, clientY);
    this.selectionMoved = true;
    this.selectionEnd = cell;
    const range =
      this.selectionMode === "line"
        ? this.core.selectLine(cell.x, cell.y)
        : this.selectionMode === "word"
          ? this.core.selectWord(cell.x, cell.y)
          : null;
    const cellScreen = this.core.viewportPointToScreen(cell.x, cell.y);
    if (cellScreen === null) return;
    const base = this.selectionBase;
    const beforeBase =
      base !== null &&
      (cellScreen.y < base.start.y ||
        (cellScreen.y === base.start.y && cellScreen.x < base.start.x));
    const anchor = base === null ? anchorScreen : beforeBase ? base.end : base.start;
    const end = range === null ? cellScreen : beforeBase ? range.screen.start : range.screen.end;
    this.selectionAnchorScreen = anchor;
    this.selectionEndScreen = end;
    this.core.setSelection({ ...anchor, tag: 2 }, { ...end, tag: 2 });
    this.terminalStateDirty = true;
    this.options.onSelectionChange?.();
    this.forceFullRender = true;
    this.requestRender();
  }

  private setSelectionAutoscroll(delta: number): void {
    this.selectionScrollDelta = delta;
    if (delta === 0) {
      if (this.selectionScrollTimer !== null) {
        window.clearInterval(this.selectionScrollTimer);
        this.selectionScrollTimer = null;
      }
      return;
    }
    if (this.selectionScrollTimer !== null) return;
    // Dragging past the edge scrolls the viewport and keeps extending the
    // selection into the newly revealed rows.
    this.selectionScrollTimer = window.setInterval(() => {
      if (this.disposed || this.selectionScrollDelta === 0) return;
      this.scrollViewport(this.selectionScrollDelta);
      const pointer = this.selectionPointer;
      if (pointer) this.extendSelectionTo(pointer.x, pointer.y);
    }, 80);
  }

  private updateHoverCursor(event: PointerEvent): void {
    this.hoverPointer = { x: event.clientX, y: event.clientY };
    this.linkModifierActive = isTerminalLinkPointerGesture(event);
    this.refreshHoveredLink();
  }

  private updateLinkModifier(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey">): void {
    const active = isTerminalLinkPointerGesture(event);
    if (active === this.linkModifierActive) return;
    this.linkModifierActive = active;
    this.refreshHoveredLink();
  }

  private readonly onPointerLeave = () => {
    this.clearHoveredLink();
  };

  private clearHoveredLink(cursor = ""): void {
    this.hoverPointer = null;
    this.setHoveredLink(null);
    this.canvas.style.cursor = cursor;
  }

  private refreshHoveredLink(): void {
    const pointer = this.hoverPointer;
    const link =
      pointer && shouldShowTerminalLinkHover(this.core.isMouseTracking(), this.linkModifierActive)
        ? this.linkAt(pointer.x, pointer.y)
        : null;
    this.setHoveredLink(link);
  }

  private setHoveredLink(link: TerminalLinkWithRange | null): void {
    const previous = this.hoveredLink;
    const unchanged =
      previous?.text === link?.text &&
      previous?.range.start.x === link?.range.start.x &&
      previous?.range.start.y === link?.range.start.y &&
      previous?.range.end.x === link?.range.end.x &&
      previous?.range.end.y === link?.range.end.y;
    this.canvas.style.cursor = link ? "pointer" : "";
    if (unchanged) return;
    this.hoveredLink = link;
    this.forceFullRender = true;
    this.requestRender();
  }

  private readonly onPointerUp = (event: PointerEvent) => {
    this.setSelectionAutoscroll(0);
    const touch = this.touchGesture;
    if (touch?.pointerId === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      this.clearTouchHold();
      this.touchGesture = null;
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
      if (touch.selecting) this.options.onSelectionChange?.();
      return;
    }
    if (this.linkActivationPointerId === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      this.linkActivationPointerId = null;
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
      if (event.type !== "pointercancel") {
        const link = this.linkAt(event.clientX, event.clientY);
        if (link) this.options.onLinkActivate?.(link.text, event);
      }
      return;
    }
    if (this.mouseReportingPointerId === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      this.sendMouse("release", this.mouseReportingButton, event);
      this.mouseReportingPointerId = null;
      this.mouseReportingButton = null;
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
      if (event.type === "pointercancel") {
        this.clearHoveredLink();
      } else {
        this.hoverPointer = { x: event.clientX, y: event.clientY };
        this.linkModifierActive = isTerminalLinkPointerGesture(event);
        this.refreshHoveredLink();
      }
      return;
    }
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    if (event.button !== 0) return;
    if (!this.selectionMoved && this.selectionMode === "cell") {
      this.clearSelection();
    }
    this.options.onSelectionChange?.();
  };
  private readonly onWheel = (event: WheelEvent) => {
    if (event.deltaY === 0 || isBrowserZoomWheel(event)) return;
    event.preventDefault();
    const delta = terminalWheelDeltaRows(
      event,
      this.metrics.height,
      this.rows,
      this.wheelRemainder,
    );
    this.wheelRemainder = delta.remainder;
    if (delta.rows === 0) return;
    const magnitude = Math.abs(delta.rows);
    if (shouldReportTerminalMouse(this.core.isMouseTracking(), event)) {
      const button = delta.rows < 0 ? 4 : 5;
      for (let index = 0; index < magnitude; index += 1) {
        this.sendMouse("press", button, event);
      }
      return;
    }
    if (this.core.isAlternateScreen()) {
      // The alternate screen has no scrollback: translate wheel motion into
      // arrow keys so full-screen apps like vim and less scroll naturally.
      this.options.onData?.(terminalWheelArrowData(delta.rows, this.core.isApplicationCursorKeys()));
      return;
    }
    this.scrollViewport(delta.rows);
  };

  private readonly onMouseDown = (event: MouseEvent) => {
    if (event.button === 0) event.preventDefault();
    this.focus();
  };

  private readonly onContextMenu = (event: MouseEvent) => {
    if (shouldReportTerminalMouse(this.core.isMouseTracking(), event)) {
      event.preventDefault();
    }
  };

  private readonly onScrollbarPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const state = this.readScrollbarState();
    if (state === null) return;
    const bounds = this.scrollbar.getBoundingClientRect();
    const geometry = terminalScrollbarGeometry(state, bounds.height);
    if (geometry === null) return;
    event.preventDefault();
    event.stopPropagation();
    this.scrollbarPointerId = event.pointerId;
    this.scrollbarPointerOffset =
      event.target === this.scrollbarThumb
        ? event.clientY - bounds.top - geometry.thumbTop
        : geometry.thumbHeight / 2;
    this.scrollbar.setPointerCapture(event.pointerId);
    this.scrollbarToPointer(event.clientY, bounds);
  };

  private readonly onScrollbarPointerMove = (event: PointerEvent) => {
    if (event.pointerId !== this.scrollbarPointerId || this.scrollbarState === null) return;
    event.preventDefault();
    this.scrollbarToPointer(event.clientY, this.scrollbar.getBoundingClientRect());
  };

  private readonly onScrollbarPointerUp = (event: PointerEvent) => {
    if (event.pointerId !== this.scrollbarPointerId) return;
    event.preventDefault();
    this.scrollbarPointerId = null;
    if (this.scrollbar.hasPointerCapture(event.pointerId)) {
      this.scrollbar.releasePointerCapture(event.pointerId);
    }
  };

  private readonly onScrollbarKeyDown = (event: KeyboardEvent) => {
    const state = this.readScrollbarState();
    if (state === null) return;
    let delta = 0;
    switch (event.key) {
      case "ArrowUp":
        delta = -1;
        break;
      case "ArrowDown":
        delta = 1;
        break;
      case "PageUp":
        delta = -Math.max(1, state.len);
        break;
      case "PageDown":
        delta = Math.max(1, state.len);
        break;
      case "Home":
        delta = -state.offset;
        break;
      case "End":
        delta = state.total - state.len - state.offset;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.scrollViewport(delta);
  };

  private activateRenderer(
    next: ControlledTerminalRenderer,
    previous: ControlledTerminalRenderer | null,
  ): void {
    const oldCanvas = previous?.canvas ?? this.canvas;
    this.removeCanvasEvents(oldCanvas);
    next.canvas.dataset.ghosttyTerminalPadding = String(CONTENT_PADDING);
    next.canvas.dataset.ghosttyTerminalRenderBackend = next.renderer.kind;
    next.canvas.width = oldCanvas.width;
    next.canvas.height = oldCanvas.height;
    oldCanvas.replaceWith(next.canvas);
    this.canvas = next.canvas;
    this.installCanvasEvents(next.canvas);
    next.renderer.resize(this.renderViewport);
    next.renderer.clear(this.theme.background);
    this.mount.dataset.ghosttyTerminalRenderBackend = next.renderer.kind;
    const panel = this.mount.closest<HTMLElement>("[data-yaade-terminal-panel]");
    if (panel !== null) panel.dataset.yaadeTerminalRenderBackend = next.renderer.kind;
    this.updateRendererDiagnostics();
  }

  private updateRendererDiagnostics(): void {
    const diagnostics = this.rendererController.diagnostics;
    this.mount.dataset.ghosttyTerminalRendererState = diagnostics.state;
    this.mount.dataset.ghosttyTerminalRendererGeneration = String(diagnostics.generation);
    this.mount.dataset.ghosttyTerminalRendererRecoveries = String(diagnostics.recoveryCount);
    if (diagnostics.fallbackReason === null) {
      delete this.mount.dataset.ghosttyTerminalRendererFallback;
    } else {
      this.mount.dataset.ghosttyTerminalRendererFallback = diagnostics.fallbackReason;
    }
  }

  private installCanvasEvents(canvas: HTMLCanvasElement): void {
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("mousedown", this.onMouseDown);
    canvas.addEventListener("contextmenu", this.onContextMenu);
  }

  private removeCanvasEvents(canvas: HTMLCanvasElement): void {
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerleave", this.onPointerLeave);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("pointercancel", this.onPointerUp);
    canvas.removeEventListener("wheel", this.onWheel);
    canvas.removeEventListener("mousedown", this.onMouseDown);
    canvas.removeEventListener("contextmenu", this.onContextMenu);
  }

  private installEvents(): void {
    this.input.addEventListener("keydown", this.onKeyDown);
    this.input.addEventListener("keyup", this.onKeyUp);
    this.input.addEventListener("focus", this.onFocus);
    this.input.addEventListener("blur", this.onBlur);
    this.input.addEventListener("input", this.onInput);
    this.input.addEventListener("paste", this.onPaste);
    this.input.addEventListener("copy", this.onCopyEvent);
    this.input.addEventListener("compositionstart", this.onCompositionStart);
    this.input.addEventListener("compositionend", this.onCompositionEnd);
    this.installCanvasEvents(this.canvas);
    this.scrollbar.addEventListener("pointerdown", this.onScrollbarPointerDown);
    this.scrollbar.addEventListener("pointermove", this.onScrollbarPointerMove);
    this.scrollbar.addEventListener("pointerup", this.onScrollbarPointerUp);
    this.scrollbar.addEventListener("pointercancel", this.onScrollbarPointerUp);
    this.scrollbar.addEventListener("keydown", this.onScrollbarKeyDown);
  }

  private removeEvents(): void {
    this.input.removeEventListener("keydown", this.onKeyDown);
    this.input.removeEventListener("keyup", this.onKeyUp);
    this.input.removeEventListener("focus", this.onFocus);
    this.input.removeEventListener("blur", this.onBlur);
    this.input.removeEventListener("input", this.onInput);
    this.input.removeEventListener("paste", this.onPaste);
    this.input.removeEventListener("copy", this.onCopyEvent);
    this.input.removeEventListener("compositionstart", this.onCompositionStart);
    this.input.removeEventListener("compositionend", this.onCompositionEnd);
    this.removeCanvasEvents(this.canvas);
    this.scrollbar.removeEventListener("pointerdown", this.onScrollbarPointerDown);
    this.scrollbar.removeEventListener("pointermove", this.onScrollbarPointerMove);
    this.scrollbar.removeEventListener("pointerup", this.onScrollbarPointerUp);
    this.scrollbar.removeEventListener("pointercancel", this.onScrollbarPointerUp);
    this.scrollbar.removeEventListener("keydown", this.onScrollbarKeyDown);
  }

  private scrollViewport(deltaRows: number): void {
    let delta = Math.trunc(deltaRows);
    const state = this.readScrollbarState();
    let nextState = state;
    if (state !== null) {
      const maxOffset = Math.max(0, state.total - state.len);
      const offset = Math.max(0, Math.min(state.offset + delta, maxOffset));
      delta = offset - state.offset;
      nextState = { ...state, offset };
      this.scrollbarState = nextState;
    }
    if (delta === 0) return;
    this.core.scroll(delta);
    if (nextState !== null) {
      const maxOffset = Math.max(0, nextState.total - nextState.len);
      this.observeViewportActivity(nextState, nextState.offset >= maxOffset);
    }
    this.terminalStateDirty = true;
    this.forceFullRender = true;
    this.scrollbarDirty = true;
    this.requestRender();
  }

  private scrollbarToPointer(clientY: number, bounds: DOMRect): void {
    const state = this.scrollbarState;
    if (state === null) return;
    const offset = terminalScrollbarOffsetAtPointer(
      state,
      bounds.height,
      clientY - bounds.top,
      this.scrollbarPointerOffset,
    );
    this.scrollViewport(offset - state.offset);
  }

  private updateScrollbar(state: GhosttyScrollbar | null): void {
    const geometry =
      state === null
        ? null
        : terminalScrollbarGeometry(
            state,
            Math.max(0, this.mount.clientHeight - CONTENT_PADDING * 2),
          );
    this.scrollbar.hidden = geometry === null;
    if (state === null || geometry === null) return;
    this.scrollbar.setAttribute("aria-valuemin", "0");
    this.scrollbar.setAttribute("aria-valuemax", String(geometry.maxOffset));
    this.scrollbar.setAttribute(
      "aria-valuenow",
      String(Math.max(0, Math.min(state.offset, geometry.maxOffset))),
    );
    this.scrollbarThumb.style.height = `${geometry.thumbHeight}px`;
    this.scrollbarThumb.style.transform = `translateY(${geometry.thumbTop}px)`;
  }

  private readScrollbarState(): GhosttyScrollbar | null {
    const state = this.core.scrollbarState();
    this.scrollbarState = state;
    this.scrollbarStateKnown = true;
    return state;
  }

  private observeViewportActivity(
    state: GhosttyScrollbar | null,
    viewportActive = this.core.isViewportActive(),
  ): void {
    this.viewportActivity.observe({
      viewportActive,
      totalRows: state?.total ?? null,
      viewportOffset: state?.offset ?? null,
      geometryGeneration: this.geometryGeneration,
      contentGeneration: this.contentGeneration,
      alternateScreen: this.core.isAlternateScreen(),
    });
  }

  private requestRender(): void {
    if (
      this.disposed ||
      !this.visible ||
      this.synchronizedOutputActive ||
      this.frame !== 0
    ) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0;
      this.renderFrame();
    });
  }

  private renderFrame(drainRuntimeUpdates = true): void {
    if (this.disposed || !this.visible) return;
    if (this.frame !== 0) {
      window.cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    const runtimeUpdatePending =
      this.terminalStateDirty || this.viewportModel.currentFrameId === 0;
    let modelUpdated = false;
    let modelAppliedAt = performance.now();
    let update: GhosttyRenderUpdate | null = null;
    const consumedUpdates: GhosttyRenderUpdate[] = [];
    if (drainRuntimeUpdates && runtimeUpdatePending) {
      const updates = this.core.drainRenderUpdates();
      if (updates.length === 0) return;
      if (updates.length > 1) this.forceFullRender = true;
      for (const next of updates) {
        consumedUpdates.push(next);
        if (!this.viewportModel.apply(next)) {
          for (const consumed of consumedUpdates) this.core.releaseRenderUpdate(consumed);
          throw new Error("Ghostty packed render update was rejected");
        }
        update = next;
      }
      this.snapshot = null;
      this.terminalStateDirty = false;
      modelUpdated = true;
      modelAppliedAt = performance.now();
    }
    if (this.viewportModel.currentFrameId === 0) return;
    // A cursor that is not blinking right now must be drawn, never caught in an
    // off phase left behind by a blink that has since been turned off.
    if (!this.blinkEnabled()) this.cursorOn = true;
    // The origin only moves together with a forced full repaint: partial
    // dirty-row redraws must never composite rows at a shifted origin over
    // rows painted at the previous one. Bottom anchoring starts once
    // scrollback exists, i.e. when the prompt actually lives at the bottom.
    const scrollState =
      modelUpdated || this.scrollbarDirty || !this.scrollbarStateKnown
        ? this.readScrollbarState()
        : this.scrollbarState;
    this.observeViewportActivity(scrollState);
    const anchorBottom = scrollState !== null && scrollState.total > scrollState.len;
    const nextOriginY = terminalContentOriginY(
      this.mountHeight,
      CONTENT_PADDING,
      this.rows,
      this.metrics.height,
      anchorBottom,
    );
    if (nextOriginY !== this.originY) {
      this.originY = nextOriginY;
      this.renderViewport.originY = nextOriginY;
      this.forceFullRender = true;
    }
    this.refreshHoveredLink();
    const renderStartedAt = performance.now();
    try {
      this.rendererController.render(this.viewportModel, update, {
        metrics: this.metrics,
        font: { family: this.fontFamily, size: this.fontSize },
        viewport: this.renderViewport,
        forceFull: this.forceFullRender,
        cursorOn: this.cursorOn,
        previousCursorY: this.renderedCursorY,
        focused: this.focused,
        hoveredLinkRange: this.hoveredLink?.range ?? null,
        dirtyRows: modelUpdated ? this.viewportModel.dirtyRows : NO_DIRTY_ROWS,
        ...(this.theme.selectionBackground !== undefined
          ? { selectionBackground: this.theme.selectionBackground }
          : {}),
      });
    } finally {
      for (const consumed of consumedUpdates) this.core.releaseRenderUpdate(consumed);
    }
    const submittedAt = performance.now();
    this.lastRendererActivityAt = submittedAt
    this.lastObservedWorkerBytes = this.core.workerDiagnostics().bytesParsed
    this.rendererCpuSamples.push(submittedAt - renderStartedAt);
    if (this.rendererCpuSamples.length > MAX_RENDERER_CPU_SAMPLES) this.rendererCpuSamples.shift();
    const modelFrameId = this.viewportModel.currentFrameId;
    this.lastSubmittedModelFrame = Math.max(this.lastSubmittedModelFrame, modelFrameId);
    this.observeNextPaint({
      surfaceInstanceId: this.surfaceInstanceId,
      runtimeGeneration: this.core.runtimeGeneration,
      rendererGeneration: this.rendererController.generation,
      modelFrameId,
      geometryGeneration: this.geometryGeneration,
      modelAppliedAt,
      renderStartedAt,
      submittedAt,
    });
    this.positionInput();
    this.renderedCursorY =
      this.cursorOn && this.viewportModel.cursorVisible && this.viewportModel.cursorY >= 0
        ? this.viewportModel.cursorY
        : null;
    if (this.scrollbarDirty) {
      this.scrollbarDirty = false;
      this.updateScrollbar(scrollState);
    }
    this.forceFullRender = false;
    this.scheduleCursorBlink();
  }

  private observeNextPaint(
    sample: Omit<TerminalPresentationSample, "nextPaintObservedAt">,
  ): void {
    if (this.pendingPresentationFrame !== 0) {
      window.cancelAnimationFrame(this.pendingPresentationFrame);
    }
    this.pendingPresentationFrame = window.requestAnimationFrame(timestamp => {
      this.pendingPresentationFrame = 0;
      if (this.disposed) return;
      this.lastNextPaintObservedFrame = Math.max(
        this.lastNextPaintObservedFrame,
        sample.modelFrameId,
      );
      this.mount.dataset.ghosttyTerminalLastSubmittedFrame = String(
        this.lastSubmittedModelFrame,
      );
      this.mount.dataset.ghosttyTerminalLastPresentedFrame = String(
        this.lastNextPaintObservedFrame,
      );
      this.options.onPresented?.({ ...sample, nextPaintObservedAt: timestamp });
    });
  }

  private scheduleCursorBlink(): void {
    if (this.cursorTimer !== null) window.clearTimeout(this.cursorTimer);
    this.cursorTimer = null;
    if (!this.blinkEnabled()) return;
    this.cursorTimer = window.setTimeout(() => {
      this.cursorTimer = null;
      this.cursorOn = !this.cursorOn;
      this.requestRender();
    }, CURSOR_BLINK_INTERVAL_MS);
  }

  private blinkEnabled(): boolean {
    if (this.viewportModel.currentFrameId === 0) return false;
    return shouldBlinkTerminalCursor({
      focused: this.focused,
      cursorBlinking: this.viewportModel.cursorBlinking,
      cursorVisible: this.viewportModel.cursorVisible,
      reducedMotion: this.reducedMotionMedia?.matches ?? false,
    });
  }

  private positionInput(): void {
    if (
      this.viewportModel.currentFrameId === 0 ||
      !this.viewportModel.cursorVisible ||
      this.viewportModel.cursorX < 0 ||
      this.viewportModel.cursorY < 0
    ) return;
    // The IME candidate window anchors to the textarea, so it must follow the
    // terminal cursor for composition to appear where the user is typing.
    const left = CONTENT_PADDING + this.viewportModel.cursorX * this.metrics.width;
    const top = this.originY + this.viewportModel.cursorY * this.metrics.height;
    if (left === this.inputLeft && top === this.inputTop) return;
    this.inputLeft = left;
    this.inputTop = top;
    this.input.style.left = `${left}px`;
    this.input.style.top = `${top}px`;
    this.input.style.height = `${this.metrics.height}px`;
  }

  private cellAt(clientX: number, clientY: number): { x: number; y: number } {
    const bounds = this.canvas.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(
          this.cols - 1,
          Math.floor((clientX - bounds.left - CONTENT_PADDING) / this.metrics.width),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          this.rows - 1,
          Math.floor((clientY - bounds.top - this.originY) / this.metrics.height),
        ),
      ),
    };
  }

  private linkAt(clientX: number, clientY: number): TerminalLinkWithRange | null {
    const snapshot = this.getSnapshot();
    if (!snapshot) return null;
    const cell = terminalGridCellAt({
      bounds: this.canvas.getBoundingClientRect(),
      clientX,
      clientY,
      cols: this.cols,
      rows: this.rows,
      metrics: this.metrics,
      padding: CONTENT_PADDING,
      originY: this.originY,
    });
    if (!cell) return null;
    const explicitHyperlink = this.core.hyperlinkAt(cell.x, cell.y);
    if (explicitHyperlink) {
      const start = { ...cell };
      const end = { ...cell };
      while (true) {
        const previous =
          start.x > 0
            ? { x: start.x - 1, y: start.y }
            : start.y > 0 && snapshot.rowData[start.y]?.isWrapContinuation
              ? { x: this.cols - 1, y: start.y - 1 }
              : null;
        if (!previous || this.core.hyperlinkAt(previous.x, previous.y) !== explicitHyperlink) break;
        start.x = previous.x;
        start.y = previous.y;
      }
      while (true) {
        const next =
          end.x + 1 < this.cols
            ? { x: end.x + 1, y: end.y }
            : end.y + 1 < this.rows && snapshot.rowData[end.y]?.wrapsToNext
              ? { x: 0, y: end.y + 1 }
              : null;
        if (!next || this.core.hyperlinkAt(next.x, next.y) !== explicitHyperlink) break;
        end.x = next.x;
        end.y = next.y;
      }
      return {
        text: explicitHyperlink,
        range: { start, end },
      };
    }
    return terminalLinkAtPositionWithRange(
      snapshot.rowData,
      cell.y,
      cell.x,
      this.options.linkMatcher,
    );
  }

  private sendMouse(
    action: "press" | "release" | "motion",
    button: number | null,
    event: MouseEvent,
  ): void {
    const bounds = this.canvas.getBoundingClientRect();
    const cellWidth = Math.max(1, Math.round(this.metrics.width));
    const cellHeight = Math.max(1, Math.round(this.metrics.height));
    // Ghostty's C ABI takes integer geometry while Canvas lays out fractional
    // cells. Scale the pointer and every size/padding field into that same
    // integer coordinate space; otherwise the error grows with each column.
    const xScale = cellWidth / this.metrics.width;
    const yScale = cellHeight / this.metrics.height;
    const screenWidth = Math.max(1, Math.round(bounds.width * xScale));
    const screenHeight = Math.max(1, Math.round(bounds.height * yScale));
    const localX = Math.max(0, event.clientX - bounds.left);
    const localY = Math.max(0, event.clientY - bounds.top);
    const paddingBottom = Math.max(
      0,
      bounds.height - this.originY - this.rows * this.metrics.height,
    );
    const data = this.core.encodeMouse({
      action,
      button,
      mods:
        (event.shiftKey ? 1 : 0) |
        (event.ctrlKey ? 1 << 1 : 0) |
        (event.altKey ? 1 << 2 : 0) |
        (event.metaKey ? 1 << 3 : 0),
      x: terminalMouseCoordinate(localX, bounds.width, screenWidth),
      y: terminalMouseCoordinate(localY, bounds.height, screenHeight),
      screenWidth,
      screenHeight,
      cellWidth,
      cellHeight,
      paddingLeft: Math.max(0, Math.round(CONTENT_PADDING * xScale)),
      paddingRight: Math.max(0, Math.round(CONTENT_PADDING * xScale)),
      paddingTop: Math.max(0, Math.round(this.originY * yScale)),
      paddingBottom: Math.max(0, Math.round(paddingBottom * yScale)),
      anyButtonPressed: event.buttons !== 0,
    });
    if (data.length > 0) this.options.onData?.(data);
  }

  private buttonFromButtons(buttons: number): number | null {
    if ((buttons & 1) !== 0) return 1;
    if ((buttons & 4) !== 0) return 3;
    if ((buttons & 2) !== 0) return 2;
    if ((buttons & 8) !== 0) return 4;
    if ((buttons & 16) !== 0) return 5;
    return null;
  }
}
