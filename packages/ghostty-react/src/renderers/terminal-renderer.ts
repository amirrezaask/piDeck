import type {
  GhosttyRenderUpdate,
  GhosttyViewportModel,
} from "@yaade/ghostty-core";
import type { GhosttyColor } from "../core.js";
import type { GhosttyCellMetrics, GhosttyCellRange } from "../renderer.js";

export interface TerminalRenderViewport {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly pixelRatio: number;
  readonly padding: number;
  readonly originY: number;
}

export interface TerminalRenderFont {
  readonly family: string;
  readonly size: number;
}

export interface TerminalRenderOverlays {
  readonly forceFull: boolean;
  readonly cursorOn: boolean;
  readonly previousCursorY?: number | null;
  readonly focused: boolean;
  readonly selectionBackground?: string;
  readonly hoveredLinkRange?: GhosttyCellRange | null;
  readonly dirtyRows?: ReadonlySet<number>;
  readonly metrics: GhosttyCellMetrics;
  readonly font: TerminalRenderFont;
  readonly viewport: TerminalRenderViewport;
}

export interface TerminalRendererSubmissionFrame {
  readonly dirtyRowsBuilt: number;
  readonly sceneCopyBytes: number;
  readonly sceneUploadBytes: number;
  readonly sceneUploadCalls: number;
  readonly fullPrimitiveUploads: number;
  readonly partialPrimitiveUploads: number;
  readonly overlayUploadBytes: number;
  readonly drawCalls: number;
}

export interface TerminalRendererSubmissionCumulative extends TerminalRendererSubmissionFrame {
  readonly frames: number;
  readonly rowRebuilds: number;
  readonly sceneCompactions: number;
  readonly atlasTextureUploads: number;
  readonly atlasResets: number;
  readonly rowBatchAllocations: number;
  readonly currentUsedSceneBytes: number;
  readonly currentAllocatedBufferBytes: number;
  readonly currentAllocatedCpuBytes: number;
  readonly currentTargetTransientBytes: number;
  readonly currentAtlasBytes: number;
  readonly currentGlyphScratchBytes: number;
  readonly idleTrims: number;
  readonly idleBytesReclaimed: number;
  readonly idleRegrows: number;
}

export interface TerminalRendererSubmissionDiagnostics {
  readonly backend: "webgl2";
  readonly lastFrame: TerminalRendererSubmissionFrame;
  readonly cumulative: TerminalRendererSubmissionCumulative;
}

export interface TerminalRenderer {
  readonly kind: "canvas2d" | "webgl2";
  readonly submissionDiagnostics?: TerminalRendererSubmissionDiagnostics;
  clear(background: GhosttyColor): void;
  resize(viewport: TerminalRenderViewport): void;
  setFont(font: TerminalRenderFont): Promise<GhosttyCellMetrics>;
  render(
    model: GhosttyViewportModel,
    update: GhosttyRenderUpdate | null,
    overlays: TerminalRenderOverlays,
  ): void;
  capturePixels?(): Promise<ImageData>;
  trimIdle?(lastActivityAt: number, now?: number): boolean;
  dispose(): void;
}
