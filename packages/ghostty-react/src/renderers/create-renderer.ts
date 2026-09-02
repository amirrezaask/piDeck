import type { GhosttyColor } from "../core.js";
import { Canvas2dTerminalRenderer } from "./canvas2d-renderer.js";
import type {
  TerminalRenderer,
  TerminalRenderFont,
  TerminalRenderViewport,
} from "./terminal-renderer.js";
import { assertWebGlSelfTest } from "./webgl2/program.js";
import { WebGl2TerminalRenderer } from "./webgl2/webgl2-renderer.js";

export type TerminalRendererPreference = "auto" | "canvas2d" | "webgl2";

/** Auto mode prefers a validated WebGL2 context and falls back to Canvas 2D. */
export const AUTO_WEBGL2_ENABLED = true;

export function parseTerminalRendererPreference(value: string | null): TerminalRendererPreference {
  return value === "canvas2d" || value === "webgl2" ? value : "auto";
}

export function terminalRendererPreferenceFromSearch(search: string): TerminalRendererPreference {
  return parseTerminalRendererPreference(new URLSearchParams(search).get("terminalRenderer"));
}

export class RendererInitializationError extends Error {
  readonly name = "RendererInitializationError";

  constructor(
    readonly backend: "canvas2d" | "webgl2",
    readonly reason: "context-unavailable" | "self-test-failed" | "initialization-failed",
    message: string,
  ) {
    super(message);
  }
}

export interface CreatedTerminalRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: TerminalRenderer;
  readonly fallbackReason: RendererInitializationError | null;
}

function configureCanvas(canvas: HTMLCanvasElement): void {
  canvas.className = "ghostty-terminal__canvas";
  canvas.setAttribute("data-ghostty-terminal-canvas", "");
  canvas.setAttribute("aria-hidden", "true");
}

function createCanvasRenderer(
  font: TerminalRenderFont,
  viewport: TerminalRenderViewport,
  background: GhosttyColor,
): CreatedTerminalRenderer {
  const canvas = document.createElement("canvas");
  configureCanvas(canvas);
  const context = canvas.getContext("2d", { alpha: false });
  if (context === null) {
    throw new RendererInitializationError(
      "canvas2d",
      "context-unavailable",
      "Canvas 2D is unavailable",
    );
  }
  const renderer = new Canvas2dTerminalRenderer(context, font, viewport);
  renderer.clear(background);
  return { canvas, renderer, fallbackReason: null };
}

const webGlSupportByDocument = new WeakMap<Document, RendererInitializationError | null>();

function webGlSupported(): RendererInitializationError | null {
  if (webGlSupportByDocument.has(document)) {
    return webGlSupportByDocument.get(document) ?? null;
  }
  const probe = document.createElement("canvas");
  const gl = probe.getContext("webgl2");
  if (gl === null) {
    const failure = new RendererInitializationError(
      "webgl2",
      "context-unavailable",
      "WebGL2 context creation returned null",
    );
    webGlSupportByDocument.set(document, failure);
    return failure;
  }
  try {
    assertWebGlSelfTest(gl);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    webGlSupportByDocument.set(document, null);
    return null;
  } catch (error) {
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    const failure = new RendererInitializationError(
      "webgl2",
      "self-test-failed",
      error instanceof Error ? error.message : "WebGL2 self-test failed",
    );
    webGlSupportByDocument.set(document, failure);
    return failure;
  }
}

export function createTerminalRenderer(options: {
  readonly preference: TerminalRendererPreference;
  readonly font: TerminalRenderFont;
  readonly viewport: TerminalRenderViewport;
  readonly background: GhosttyColor;
}): CreatedTerminalRenderer {
  if (options.preference === "webgl2" || (options.preference === "auto" && AUTO_WEBGL2_ENABLED)) {
    const supportFailure = webGlSupported();
    if (supportFailure === null) {
      const canvas = document.createElement("canvas");
      configureCanvas(canvas);
      const gl = canvas.getContext("webgl2", {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
        premultipliedAlpha: true,
      });
      if (gl !== null) {
        try {
          const renderer = new WebGl2TerminalRenderer(gl, options.font, options.viewport);
          renderer.clear(options.background);
          return { canvas, renderer, fallbackReason: null };
        } catch (error) {
          const canvasFallback = createCanvasRenderer(
            options.font,
            options.viewport,
            options.background,
          );
          return {
            ...canvasFallback,
            fallbackReason: new RendererInitializationError(
              "webgl2",
              "initialization-failed",
              error instanceof Error ? error.message : "WebGL2 initialization failed",
            ),
          };
        }
      }
    }
    const canvasFallback = createCanvasRenderer(
      options.font,
      options.viewport,
      options.background,
    );
    return { ...canvasFallback, fallbackReason: supportFailure };
  }
  return createCanvasRenderer(options.font, options.viewport, options.background);
}
