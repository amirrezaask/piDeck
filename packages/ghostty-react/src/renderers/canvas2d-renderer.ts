import type {
  GhosttyRenderUpdate,
  GhosttyViewportModel,
} from "@yaade/ghostty-core";
import type { GhosttyColor } from "../core.js";
import {
  measureGhosttyCell,
  renderGhosttySnapshot,
} from "../renderer.js";
import type {
  TerminalRenderer,
  TerminalRenderFont,
  TerminalRenderOverlays,
  TerminalRenderViewport,
} from "./terminal-renderer.js";

export class Canvas2dTerminalRenderer implements TerminalRenderer {
  readonly kind = "canvas2d" as const;
  private disposed = false;
  private font: TerminalRenderFont;
  private viewport: TerminalRenderViewport;

  constructor(
    private readonly context: CanvasRenderingContext2D,
    font: TerminalRenderFont,
    viewport: TerminalRenderViewport,
  ) {
    this.font = font;
    this.viewport = viewport;
  }

  clear(background: GhosttyColor): void {
    if (this.disposed) return;
    this.context.save();
    this.context.resetTransform();
    this.context.fillStyle = `rgb(${background.r}, ${background.g}, ${background.b})`;
    this.context.fillRect(0, 0, this.context.canvas.width, this.context.canvas.height);
    this.context.restore();
  }

  resize(viewport: TerminalRenderViewport): void {
    if (this.disposed) return;
    this.viewport = viewport;
    this.context.setTransform(viewport.pixelRatio, 0, 0, viewport.pixelRatio, 0, 0);
  }

  setFont(font: TerminalRenderFont): Promise<ReturnType<typeof measureGhosttyCell>> {
    this.font = font;
    return Promise.resolve(measureGhosttyCell(this.context, font.size, font.family));
  }

  render(
    model: GhosttyViewportModel,
    _update: GhosttyRenderUpdate | null,
    overlays: TerminalRenderOverlays,
  ): void {
    if (this.disposed) return;
    const viewport = overlays.viewport ?? this.viewport;
    const font = overlays.font ?? this.font;
    renderGhosttySnapshot({
      context: this.context,
      snapshot: model.snapshot(),
      metrics: overlays.metrics,
      fontSize: font.size,
      fontFamily: font.family,
      padding: viewport.padding,
      forceFull: overlays.forceFull,
      cursorOn: overlays.cursorOn,
      previousCursorY: overlays.previousCursorY,
      focused: overlays.focused,
      selectionBackground: overlays.selectionBackground,
      hoveredLinkRange: overlays.hoveredLinkRange,
      dirtyRows: overlays.dirtyRows,
      originY: viewport.originY,
      pixelRatio: viewport.pixelRatio,
    });
  }

  capturePixels(): Promise<ImageData> {
    return Promise.resolve(
      this.context.getImageData(0, 0, this.context.canvas.width, this.context.canvas.height),
    );
  }

  dispose(): void {
    this.disposed = true;
  }
}
