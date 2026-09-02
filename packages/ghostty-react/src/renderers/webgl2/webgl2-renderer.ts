import {
  GHOSTTY_RENDER_STYLE,
  IDLE_RECLAIM_POLICY,
  shouldReclaimIdleCapacity,
  type GhosttyRenderUpdate,
  type GhosttyViewportModel,
} from "@yaade/ghostty-core";
import type { GhosttyColor } from "../../core.js";
import type {
  TerminalRenderer,
  TerminalRenderFont,
  TerminalRenderOverlays,
  TerminalRenderViewport,
  TerminalRendererSubmissionDiagnostics,
  TerminalRendererSubmissionFrame,
} from "../terminal-renderer.js";
import { terminalRowEdges, terminalUnderlineRects } from "../render-semantics.js";
import { WebGlGlyphBatch, WebGlRectBatch } from "./batches.js";
import { WebGlGlyphAtlas } from "./glyph-atlas.js";
import {
  WebGlRetainedScene,
  type RetainedRowChange,
  type ScenePrimitivePlan,
  type SceneSubmissionPlan,
} from "./retained-scene.js";
import { assertWebGlSelfTest, createWebGlProgram } from "./program.js";

const RECT_VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec4 rect;
layout(location=1) in vec4 color;
uniform vec2 viewport;
out vec4 instanceColor;
const vec2 corners[6] = vec2[6](
  vec2(0,0), vec2(1,0), vec2(0,1), vec2(0,1), vec2(1,0), vec2(1,1)
);
void main() {
  vec2 point = rect.xy + corners[gl_VertexID] * rect.zw;
  vec2 clip = vec2(point.x / viewport.x * 2.0 - 1.0, 1.0 - point.y / viewport.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  instanceColor = color;
}`;
const RECT_FRAGMENT = `#version 300 es
precision mediump float;
in vec4 instanceColor;
out vec4 outColor;
void main() { outColor = instanceColor; }`;
const GLYPH_VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec4 rect;
layout(location=1) in vec4 uvRect;
layout(location=2) in vec4 color;
layout(location=3) in float colorGlyph;
uniform vec2 viewport;
out vec2 uv;
out vec4 instanceColor;
flat out float useTextureColor;
const vec2 corners[6] = vec2[6](
  vec2(0,0), vec2(1,0), vec2(0,1), vec2(0,1), vec2(1,0), vec2(1,1)
);
void main() {
  vec2 corner = corners[gl_VertexID];
  vec2 point = rect.xy + corner * rect.zw;
  vec2 clip = vec2(point.x / viewport.x * 2.0 - 1.0, 1.0 - point.y / viewport.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  uv = mix(uvRect.xy, uvRect.zw, corner);
  instanceColor = color;
  useTextureColor = colorGlyph;
}`;
const GLYPH_FRAGMENT = `#version 300 es
precision mediump float;
in vec2 uv;
in vec4 instanceColor;
flat in float useTextureColor;
uniform sampler2D atlas;
out vec4 outColor;
void main() {
  vec4 sampleColor = texture(atlas, uv);
  vec3 rgb = mix(instanceColor.rgb, sampleColor.rgb, useTextureColor);
  outColor = vec4(rgb, sampleColor.a * instanceColor.a);
}`;

export interface WebGlTerminalDebugCounters {
  readonly dirtyRows: number;
  readonly retainedRows: number;
  readonly glyphInstances: number;
  readonly rectangleInstances: number;
  readonly textureUploads: number;
  readonly atlasResets: number;
  readonly atlasBytes: number;
  readonly bufferBytes: number;
  readonly drawCalls: number;
  readonly atlasOccupancy: number;
}

type RetainedRow = {
  readonly backgrounds: WebGlRectBatch;
  readonly decorations: WebGlRectBatch;
  readonly glyphs: WebGlGlyphBatch;
  version: number;
};

type BufferState = { readonly buffer: WebGLBuffer; capacity: number };

const WEBGL_IDLE_RECLAIM_POLICY = {
  ...IDLE_RECLAIM_POLICY,
  shrinkRatio: 2,
} as const

const EMPTY_SUBMISSION_FRAME: TerminalRendererSubmissionFrame = {
  dirtyRowsBuilt: 0,
  sceneCopyBytes: 0,
  sceneUploadBytes: 0,
  sceneUploadCalls: 0,
  fullPrimitiveUploads: 0,
  partialPrimitiveUploads: 0,
  overlayUploadBytes: 0,
  drawCalls: 0,
};

function colorValues(packed: number): readonly [number, number, number] {
  return [((packed >>> 16) & 0xff) / 255, ((packed >>> 8) & 0xff) / 255, (packed & 0xff) / 255];
}

function packedColor(color: GhosttyColor): number {
  return ((color.r & 0xff) << 16) | ((color.g & 0xff) << 8) | (color.b & 0xff);
}

function selectionColor(value: string | undefined): readonly [number, number, number, number] {
  if (value === undefined) return [72 / 255, 122 / 255, 191 / 255, 0.35];
  const match = /^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i.exec(value);
  if (!match) return [72 / 255, 122 / 255, 191 / 255, 0.35];
  return [
    Number(match[1]) / 255,
    Number(match[2]) / 255,
    Number(match[3]) / 255,
    match[4] === undefined ? 1 : Number(match[4]),
  ];
}

function createBuffer(gl: WebGL2RenderingContext): BufferState {
  const buffer = gl.createBuffer();
  if (buffer === null) throw new Error("WebGL buffer allocation failed");
  return { buffer, capacity: 0 };
}

export class WebGl2TerminalRenderer implements TerminalRenderer {
  readonly kind = "webgl2" as const;
  private readonly rectProgram: WebGLProgram;
  private readonly glyphProgram: WebGLProgram;
  private readonly rectVao: WebGLVertexArrayObject;
  private readonly glyphVao: WebGLVertexArrayObject;
  private readonly backgroundBuffer: BufferState;
  private readonly decorationBuffer: BufferState;
  private readonly cursorBuffer: BufferState;
  private readonly glyphBuffer: BufferState;
  private readonly cursorGlyphBuffer: BufferState;
  private readonly retainedScene = new WebGlRetainedScene();
  private readonly cursors = new WebGlRectBatch(8);
  private readonly cursorGlyphs = new WebGlGlyphBatch(2);
  private readonly atlas: WebGlGlyphAtlas;
  private readonly rows: RetainedRow[] = [];
  private readonly rectViewportUniform: WebGLUniformLocation;
  private readonly glyphViewportUniform: WebGLUniformLocation;
  private readonly atlasUniform: WebGLUniformLocation;
  private viewport: TerminalRenderViewport;
  private font: TerminalRenderFont;
  private sceneGeneration = 0;
  private hoverKey = "";
  private disposed = false;
  private debugValidation = false;
  private lastSubmission: TerminalRendererSubmissionFrame = EMPTY_SUBMISSION_FRAME;
  private cumulativeSubmission = {
    ...EMPTY_SUBMISSION_FRAME,
    frames: 0,
    rowRebuilds: 0,
    sceneCompactions: 0,
    atlasTextureUploads: 0,
    atlasResets: 0,
    rowBatchAllocations: 0,
    currentUsedSceneBytes: 0,
    currentAllocatedBufferBytes: 0,
    currentAllocatedCpuBytes: 0,
    currentTargetTransientBytes: 0,
    currentAtlasBytes: 0,
    currentGlyphScratchBytes: 0,
    idleTrims: 0,
    idleBytesReclaimed: 0,
    idleRegrows: 0,
  };
  private frameRowBatchAllocations = 0;
  private frameRowRebuilds = 0;
  private lastCapacityChangeAt = 0
  private trimmedSinceGrowth = false
  private debug: WebGlTerminalDebugCounters = {
    dirtyRows: 0,
    retainedRows: 0,
    glyphInstances: 0,
    rectangleInstances: 0,
    textureUploads: 0,
    atlasResets: 0,
    atlasBytes: 0,
    bufferBytes: 0,
    drawCalls: 0,
    atlasOccupancy: 0,
  };

  constructor(
    readonly gl: WebGL2RenderingContext,
    font: TerminalRenderFont,
    viewport: TerminalRenderViewport,
  ) {
    assertWebGlSelfTest(gl);
    this.font = font;
    this.viewport = viewport;
    this.rectProgram = createWebGlProgram(gl, RECT_VERTEX, RECT_FRAGMENT);
    this.glyphProgram = createWebGlProgram(gl, GLYPH_VERTEX, GLYPH_FRAGMENT);
    const rectVao = gl.createVertexArray();
    const glyphVao = gl.createVertexArray();
    if (rectVao === null || glyphVao === null) throw new Error("WebGL VAO allocation failed");
    this.rectVao = rectVao;
    this.glyphVao = glyphVao;
    this.backgroundBuffer = createBuffer(gl);
    this.decorationBuffer = createBuffer(gl);
    this.cursorBuffer = createBuffer(gl);
    this.glyphBuffer = createBuffer(gl);
    this.cursorGlyphBuffer = createBuffer(gl);
    const rectViewportUniform = gl.getUniformLocation(this.rectProgram, "viewport");
    const glyphViewportUniform = gl.getUniformLocation(this.glyphProgram, "viewport");
    const atlasUniform = gl.getUniformLocation(this.glyphProgram, "atlas");
    if (rectViewportUniform === null || glyphViewportUniform === null || atlasUniform === null) {
      throw new Error("WebGL terminal uniforms are unavailable");
    }
    this.rectViewportUniform = rectViewportUniform;
    this.glyphViewportUniform = glyphViewportUniform;
    this.atlasUniform = atlasUniform;
    this.atlas = new WebGlGlyphAtlas(gl);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  get debugCounters(): WebGlTerminalDebugCounters { return this.debug; }

  get submissionDiagnostics(): TerminalRendererSubmissionDiagnostics {
    return {
      backend: "webgl2",
      lastFrame: this.lastSubmission,
      cumulative: this.cumulativeSubmission,
    };
  }

  setDebugValidation(enabled: boolean): void { this.debugValidation = enabled; }

  clear(background: GhosttyColor): void {
    if (this.disposed) return;
    const color = colorValues(packedColor(background));
    this.gl.clearColor(color[0], color[1], color[2], 1);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  resize(viewport: TerminalRenderViewport): void {
    if (viewport.pixelRatio !== this.viewport.pixelRatio) {
      this.atlas.clear();
      this.invalidateScene();
    }
    if (viewport.originY !== this.viewport.originY || viewport.padding !== this.viewport.padding) {
      this.invalidateScene();
    }
    this.viewport = viewport;
    this.gl.viewport(0, 0, this.gl.drawingBufferWidth, this.gl.drawingBufferHeight);
  }

  setFont(font: TerminalRenderFont): Promise<TerminalRenderOverlays["metrics"]> {
    this.font = font;
    this.atlas.clear();
    this.invalidateScene();
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (context === null) return Promise.reject(new Error("Canvas text measurement unavailable"));
    context.font = `normal 400 ${font.size}px ${font.family}`;
    const width = Math.max(1, context.measureText("M").width);
    const vertical = context.measureText("Mg");
    const ascent = vertical.actualBoundingBoxAscent || font.size;
    const descent = vertical.actualBoundingBoxDescent;
    const height = Math.max(1, Math.round(font.size * 1.35), Math.ceil(ascent + descent));
    return Promise.resolve({ width, height, baseline: Math.round((height - ascent - descent) / 2 + ascent) });
  }

  render(
    model: GhosttyViewportModel,
    update: GhosttyRenderUpdate | null,
    overlays: TerminalRenderOverlays,
  ): void {
    if (this.disposed) return;
    const capacityBefore = this.transientAllocatedBytes()
    const uploadStart = this.atlas.uploads;
    const resetStart = this.atlas.resets;
    const nextHoverKey = overlays.hoveredLinkRange === null || overlays.hoveredLinkRange === undefined
      ? ""
      : `${overlays.hoveredLinkRange.start.x}:${overlays.hoveredLinkRange.start.y}:${overlays.hoveredLinkRange.end.x}:${overlays.hoveredLinkRange.end.y}`;
    const overlayChanged = nextHoverKey !== this.hoverKey;
    this.hoverKey = nextHoverKey;
    const full = overlays.forceFull || update?.full === true || overlayChanged ||
      this.rows.length !== model.rows || this.sceneGeneration !== model.currentGeneration;
    const dirty = full
      ? Array.from({ length: model.rows }, (_, row) => row)
      : [...(overlays.dirtyRows ?? model.dirtyRows)];

    this.frameRowBatchAllocations = 0;
    this.frameRowRebuilds = 0;
    let atlasGeneration = this.atlas.generation;
    let submission = this.updateRows(model, overlays, dirty, full);
    if (atlasGeneration !== this.atlas.generation) {
      // Pressure reset invalidated retained UVs. Rebuild once against the fresh
      // bounded atlas; this is normal cache policy, not renderer recovery.
      atlasGeneration = this.atlas.generation;
      submission = this.updateRows(
        model,
        overlays,
        Array.from({ length: model.rows }, (_, row) => row),
        true,
      );
      if (atlasGeneration !== this.atlas.generation) {
        throw new Error("WebGL glyph atlas cannot retain the complete scene");
      }
    }
    this.sceneGeneration = model.currentGeneration;

    const cursorAtlasGeneration = this.atlas.generation;
    this.buildCursor(model, overlays);
    if (cursorAtlasGeneration !== this.atlas.generation) {
      const rebuildGeneration = this.atlas.generation;
      submission = this.updateRows(
        model,
        overlays,
        Array.from({ length: model.rows }, (_, row) => row),
        true,
      );
      this.buildCursor(model, overlays);
      if (rebuildGeneration !== this.atlas.generation) {
        throw new Error("WebGL glyph atlas cannot retain the complete scene and cursor");
      }
    }
    const sceneStats = this.submitScene(submission);
    const gl = this.gl;
    this.clear(model.background);
    let drawCalls = 0;
    drawCalls += this.drawRects(this.backgroundBuffer, this.retainedScene.backgroundCount, false);
    drawCalls += this.drawGlyphs(this.glyphBuffer, this.retainedScene.glyphCount, false);
    drawCalls += this.drawRects(this.decorationBuffer, this.retainedScene.decorationCount, false);
    drawCalls += this.drawRects(this.cursorBuffer, this.cursors.count, true, this.cursors.data);
    drawCalls += this.drawGlyphs(this.cursorGlyphBuffer, this.cursorGlyphs.count, true, this.cursorGlyphs.data);
    if (this.debugValidation) {
      const error = gl.getError();
      if (error !== gl.NO_ERROR) throw new Error(`WebGL render failed with error ${error}`);
    }
    this.debug = {
      dirtyRows: dirty.length,
      retainedRows: this.rows.length,
      glyphInstances: this.retainedScene.glyphCount + this.cursorGlyphs.count,
      rectangleInstances:
        this.retainedScene.backgroundCount + this.retainedScene.decorationCount + this.cursors.count,
      textureUploads: this.atlas.uploads - uploadStart,
      atlasResets: this.atlas.resets - resetStart,
      atlasBytes: this.atlas.allocatedBytes,
      bufferBytes: this.retainedScene.usedBytes + this.cursors.usedBytes + this.cursorGlyphs.usedBytes,
      drawCalls,
      atlasOccupancy: this.atlas.occupancy,
    };
    const overlayUploadBytes = this.cursors.usedBytes + this.cursorGlyphs.usedBytes;
    this.lastSubmission = {
      dirtyRowsBuilt: this.frameRowRebuilds,
      sceneCopyBytes: sceneStats.copyBytes,
      sceneUploadBytes: sceneStats.uploadBytes,
      sceneUploadCalls: sceneStats.uploadCalls,
      fullPrimitiveUploads: sceneStats.fullUploads,
      partialPrimitiveUploads: sceneStats.partialUploads,
      overlayUploadBytes,
      drawCalls,
    };
    const allocatedCpuBytes = this.cpuAllocatedBytes()
    const allocatedBufferBytes = this.gpuAllocatedBytes()
    const capacityAfter = allocatedCpuBytes + allocatedBufferBytes
    if (capacityAfter > capacityBefore) {
      if (this.trimmedSinceGrowth) {
        this.cumulativeSubmission.idleRegrows += 1
        this.trimmedSinceGrowth = false
      }
      this.lastCapacityChangeAt = performance.now()
    }
    this.cumulativeSubmission = {
      dirtyRowsBuilt: this.cumulativeSubmission.dirtyRowsBuilt + this.frameRowRebuilds,
      sceneCopyBytes: this.cumulativeSubmission.sceneCopyBytes + sceneStats.copyBytes,
      sceneUploadBytes: this.cumulativeSubmission.sceneUploadBytes + sceneStats.uploadBytes,
      sceneUploadCalls: this.cumulativeSubmission.sceneUploadCalls + sceneStats.uploadCalls,
      fullPrimitiveUploads: this.cumulativeSubmission.fullPrimitiveUploads + sceneStats.fullUploads,
      partialPrimitiveUploads: this.cumulativeSubmission.partialPrimitiveUploads + sceneStats.partialUploads,
      overlayUploadBytes: this.cumulativeSubmission.overlayUploadBytes + overlayUploadBytes,
      drawCalls: this.cumulativeSubmission.drawCalls + drawCalls,
      frames: this.cumulativeSubmission.frames + 1,
      rowRebuilds: this.cumulativeSubmission.rowRebuilds + this.frameRowRebuilds,
      sceneCompactions: this.cumulativeSubmission.sceneCompactions + sceneStats.compactions,
      atlasTextureUploads: this.cumulativeSubmission.atlasTextureUploads + this.atlas.uploads - uploadStart,
      atlasResets: this.cumulativeSubmission.atlasResets + this.atlas.resets - resetStart,
      rowBatchAllocations: this.cumulativeSubmission.rowBatchAllocations + this.frameRowBatchAllocations,
      currentUsedSceneBytes: this.retainedScene.usedBytes,
      currentAllocatedBufferBytes: allocatedBufferBytes,
      currentAllocatedCpuBytes: allocatedCpuBytes,
      currentTargetTransientBytes: this.transientTargetBytes(),
      currentAtlasBytes: this.atlas.allocatedBytes,
      currentGlyphScratchBytes: this.atlas.scratchAllocatedBytes,
      idleTrims: this.cumulativeSubmission.idleTrims,
      idleBytesReclaimed: this.cumulativeSubmission.idleBytesReclaimed,
      idleRegrows: this.cumulativeSubmission.idleRegrows,
    };
  }

  trimIdle(lastActivityAt: number, now = performance.now()): boolean {
    if (this.disposed) return false
    const allocatedBytes = this.transientAllocatedBytes()
    const targetBytes = this.transientTargetBytes()
    if (!shouldReclaimIdleCapacity({
      now,
      allocatedBytes,
      targetBytes,
      inFlight: 0,
      queued: 0,
      lastActivityAt,
      lastResizeAt: this.lastCapacityChangeAt,
    }, WEBGL_IDLE_RECLAIM_POLICY)) return false

    this.retainedScene.trimCapacity()
    this.atlas.trimScratch()
    this.trimGpuBuffer(this.backgroundBuffer, this.retainedScene.backgroundData)
    this.trimGpuBuffer(this.decorationBuffer, this.retainedScene.decorationData)
    this.trimGpuBuffer(this.glyphBuffer, this.retainedScene.glyphData)
    this.trimGpuBuffer(this.cursorBuffer, this.cursors.data)
    this.trimGpuBuffer(this.cursorGlyphBuffer, this.cursorGlyphs.data)
    const afterBytes = this.transientAllocatedBytes()
    const reclaimedBytes = allocatedBytes - afterBytes
    if (reclaimedBytes <= 0) return false
    this.lastCapacityChangeAt = now
    this.trimmedSinceGrowth = true
    this.cumulativeSubmission = {
      ...this.cumulativeSubmission,
      currentUsedSceneBytes: this.retainedScene.usedBytes,
      currentAllocatedBufferBytes: this.gpuAllocatedBytes(),
      currentAllocatedCpuBytes: this.cpuAllocatedBytes(),
      currentTargetTransientBytes: this.transientTargetBytes(),
      currentAtlasBytes: this.atlas.allocatedBytes,
      currentGlyphScratchBytes: this.atlas.scratchAllocatedBytes,
      idleTrims: this.cumulativeSubmission.idleTrims + 1,
      idleBytesReclaimed: this.cumulativeSubmission.idleBytesReclaimed + reclaimedBytes,
    }
    return true
  }

  capturePixels(): Promise<ImageData> {
    const gl = this.gl;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (texture === null || framebuffer === null) {
      if (texture !== null) gl.deleteTexture(texture);
      if (framebuffer !== null) gl.deleteFramebuffer(framebuffer);
      return Promise.reject(new Error("WebGL capture framebuffer allocation failed"));
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, null,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    gl.viewport(0, 0, width, height);
    const background = colorValues(this.rows.length > 0 ? 0 : 0);
    gl.clearColor(background[0], background[1], background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawRects(this.backgroundBuffer, this.retainedScene.backgroundCount, false);
    this.drawGlyphs(this.glyphBuffer, this.retainedScene.glyphCount, false);
    this.drawRects(this.decorationBuffer, this.retainedScene.decorationCount, false);
    this.drawRects(this.cursorBuffer, this.cursors.count, false);
    this.drawGlyphs(this.cursorGlyphBuffer, this.cursorGlyphs.count, false);
    const source = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    const normalized = new Uint8ClampedArray(source.length);
    const stride = width * 4;
    for (let row = 0; row < height; row += 1) {
      normalized.set(source.subarray(row * stride, (row + 1) * stride), (height - row - 1) * stride);
    }
    return Promise.resolve(new ImageData(normalized, width, height));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const gl = this.gl;
    this.atlas.dispose();
    for (const state of [
      this.backgroundBuffer,
      this.decorationBuffer,
      this.cursorBuffer,
      this.glyphBuffer,
      this.cursorGlyphBuffer,
    ]) gl.deleteBuffer(state.buffer);
    gl.deleteVertexArray(this.rectVao);
    gl.deleteVertexArray(this.glyphVao);
    gl.deleteProgram(this.rectProgram);
    gl.deleteProgram(this.glyphProgram);
  }

  private updateRows(
    model: GhosttyViewportModel,
    overlays: TerminalRenderOverlays,
    rows: readonly number[],
    full: boolean,
  ): SceneSubmissionPlan {
    if (full) {
      for (let row = 0; row < model.rows; row += 1) {
        this.rows[row] = this.buildRow(model, overlays, row, this.rows[row]);
      }
      this.rows.length = model.rows;
      return this.retainedScene.replaceAll(this.rows);
    }
    const changes: RetainedRowChange[] = [];
    for (const row of rows) {
      if (row < 0 || row >= model.rows) continue;
      const batches = this.buildRow(model, overlays, row, this.rows[row]);
      this.rows[row] = batches;
      changes.push({ row, batches });
    }
    return this.retainedScene.updateRows(changes);
  }

  private buildRow(
    model: GhosttyViewportModel,
    overlays: TerminalRenderOverlays,
    row: number,
    existing: RetainedRow | undefined,
  ): RetainedRow {
    this.frameRowRebuilds += 1;
    const retained = existing ?? {
      backgrounds: new WebGlRectBatch(262_144),
      decorations: new WebGlRectBatch(262_144),
      glyphs: new WebGlGlyphBatch(131_072),
      version: 0,
    };
    if (existing === undefined) this.frameRowBatchAllocations += 3;
    const { backgrounds, decorations, glyphs } = retained;
    backgrounds.clear();
    decorations.clear();
    glyphs.clear();
    const edges = terminalRowEdges(
      overlays.viewport.originY,
      row,
      overlays.metrics.height,
      overlays.viewport.pixelRatio,
    );
    const top = edges.top;
    const height = Math.max(0, edges.bottom - edges.top);
    const selection = selectionColor(overlays.selectionBackground);
    const defaultBackgroundPacked = packedColor(model.background);
    for (let column = 0; column < model.cols; column += 1) {
      const style = model.styleAt(row, column);
      const left = overlays.viewport.padding + column * overlays.metrics.width;
      const backgroundPacked = model.backgroundAt(row, column);
      if (
        backgroundPacked !== defaultBackgroundPacked &&
        !backgrounds.pushPacked(left, top, overlays.metrics.width, height, backgroundPacked)
      ) throw new RangeError("WebGL background row exceeded its instance bound");
      if (
        (style & GHOSTTY_RENDER_STYLE.selected) !== 0 &&
        !backgrounds.push(
          left, top, overlays.metrics.width, height,
          selection[0], selection[1], selection[2], selection[3],
        )
      ) throw new RangeError("WebGL selection row exceeded its instance bound");
      const foregroundPacked = model.foregroundAt(row, column);
      const explicitUnderline =
        (style & GHOSTTY_RENDER_STYLE.underlineMask) >>> GHOSTTY_RENDER_STYLE.underlineShift;
      const hoverUnderline = explicitUnderline === 0 &&
        overlays.hoveredLinkRange !== null && overlays.hoveredLinkRange !== undefined &&
        row >= overlays.hoveredLinkRange.start.y && row <= overlays.hoveredLinkRange.end.y &&
        (row > overlays.hoveredLinkRange.start.y || column >= overlays.hoveredLinkRange.start.x) &&
        (row < overlays.hoveredLinkRange.end.y || column <= overlays.hoveredLinkRange.end.x);
      const underline = explicitUnderline || (hoverUnderline ? 1 : 0);
      if (underline !== 0) {
        for (const rect of terminalUnderlineRects(
          underline,
          left,
          edges.bottom - 1,
          overlays.metrics.width,
          overlays.viewport.pixelRatio,
        )) {
          if (!decorations.pushPacked(rect.x, rect.y, rect.width, rect.height, foregroundPacked)) {
            throw new RangeError("WebGL decoration row exceeded its instance bound");
          }
        }
      }
      if (
        (style & GHOSTTY_RENDER_STYLE.strikethrough) !== 0 &&
        !decorations.pushPacked(
          left,
          top + Math.floor(height * 0.55),
          overlays.metrics.width,
          Math.max(1 / overlays.viewport.pixelRatio, 1),
          foregroundPacked,
        )
      ) throw new RangeError("WebGL decoration row exceeded its instance bound");
      if (
        (style & GHOSTTY_RENDER_STYLE.overline) !== 0 &&
        !decorations.pushPacked(
          left, top, overlays.metrics.width, Math.max(1 / overlays.viewport.pixelRatio, 1),
          foregroundPacked,
        )
      ) throw new RangeError("WebGL decoration row exceeded its instance bound");
      const text = model.textAt(row, column);
      const invisible = (style & GHOSTTY_RENDER_STYLE.invisible) !== 0;
      if (text.length === 0 || text === " " || invisible) continue;
      const width = style & GHOSTTY_RENDER_STYLE.widthMask;
      const span = width === 1 ? 2 : 1;
      const entry = this.atlas.get({
        text,
        cellSpan: span,
        metrics: overlays.metrics,
        font: overlays.font,
        bold: (style & GHOSTTY_RENDER_STYLE.bold) !== 0,
        italic: (style & GHOSTTY_RENDER_STYLE.italic) !== 0,
        pixelRatio: overlays.viewport.pixelRatio,
      });
      if (!glyphs.pushPacked(
        left, top, overlays.metrics.width * span, height,
        entry.u0, entry.v0, entry.u1, entry.v1,
        foregroundPacked, 1, entry.colorGlyph ? 1 : 0,
      )) throw new RangeError("WebGL glyph row exceeded its instance bound");
    }
    retained.version = model.rowVersions[row] ?? 0;
    return retained;
  }

  private submitScene(plan: SceneSubmissionPlan): {
    readonly copyBytes: number;
    readonly uploadBytes: number;
    readonly uploadCalls: number;
    readonly fullUploads: number;
    readonly partialUploads: number;
    readonly compactions: number;
  } {
    const background = this.submitPrimitive(this.backgroundBuffer, plan.backgrounds);
    const decoration = this.submitPrimitive(this.decorationBuffer, plan.decorations);
    const glyph = this.submitPrimitive(this.glyphBuffer, plan.glyphs);
    return {
      copyBytes: background.copyBytes + decoration.copyBytes + glyph.copyBytes,
      uploadBytes: background.uploadBytes + decoration.uploadBytes + glyph.uploadBytes,
      uploadCalls: background.uploadCalls + decoration.uploadCalls + glyph.uploadCalls,
      fullUploads: background.fullUploads + decoration.fullUploads + glyph.fullUploads,
      partialUploads: background.partialUploads + decoration.partialUploads + glyph.partialUploads,
      compactions: background.compactions + decoration.compactions + glyph.compactions,
    };
  }

  private submitPrimitive(state: BufferState, plan: ScenePrimitivePlan): {
    readonly copyBytes: number;
    readonly uploadBytes: number;
    readonly uploadCalls: number;
    readonly fullUploads: number;
    readonly partialUploads: number;
    readonly compactions: number;
  } {
    if (plan.kind === "none") {
      return { copyBytes: 0, uploadBytes: 0, uploadCalls: 0, fullUploads: 0, partialUploads: 0, compactions: 0 };
    }
    if (plan.kind === "full") {
      this.uploadFull(state, plan.data);
      return {
        copyBytes: plan.data.byteLength,
        uploadBytes: plan.data.byteLength,
        uploadCalls: plan.data.byteLength > 0 ? 1 : 0,
        fullUploads: plan.data.byteLength > 0 ? 1 : 0,
        partialUploads: 0,
        compactions: 1,
      };
    }
    let bytes = 0;
    for (const range of plan.ranges) {
      this.uploadRange(state, range.offset * Float32Array.BYTES_PER_ELEMENT, range.data);
      bytes += range.data.byteLength;
    }
    return {
      copyBytes: bytes,
      uploadBytes: bytes,
      uploadCalls: plan.ranges.length,
      fullUploads: 0,
      partialUploads: plan.ranges.length,
      compactions: 0,
    };
  }

  private buildCursor(model: GhosttyViewportModel, overlays: TerminalRenderOverlays): void {
    this.cursors.clear();
    this.cursorGlyphs.clear();
    if (!overlays.cursorOn || !model.cursorVisible || model.cursorX < 0 || model.cursorY < 0) return;
    const left = overlays.viewport.padding + model.cursorX * overlays.metrics.width;
    const edges = terminalRowEdges(
      overlays.viewport.originY,
      model.cursorY,
      overlays.metrics.height,
      overlays.viewport.pixelRatio,
    );
    const top = edges.top;
    const height = edges.bottom - edges.top;
    const cursor = colorValues(packedColor(model.cursor));
    if (!overlays.focused || model.cursorStyle === 3) {
      const line = Math.max(1 / overlays.viewport.pixelRatio, 1);
      this.cursors.push(left, top, overlays.metrics.width, line, cursor[0], cursor[1], cursor[2]);
      this.cursors.push(left, edges.bottom - line, overlays.metrics.width, line, cursor[0], cursor[1], cursor[2]);
      this.cursors.push(left, top, line, height, cursor[0], cursor[1], cursor[2]);
      this.cursors.push(left + overlays.metrics.width - line, top, line, height, cursor[0], cursor[1], cursor[2]);
      return;
    }
    if (model.cursorStyle === 0) {
      this.cursors.push(left, top, 2, height, cursor[0], cursor[1], cursor[2]);
      return;
    }
    if (model.cursorStyle === 2) {
      this.cursors.push(left, edges.bottom - 2, overlays.metrics.width, 2, cursor[0], cursor[1], cursor[2]);
      return;
    }
    this.cursors.push(left, top, overlays.metrics.width, height, cursor[0], cursor[1], cursor[2]);
    const text = model.textAt(model.cursorY, model.cursorX);
    const style = model.styleAt(model.cursorY, model.cursorX);
    if (text.length === 0 || text === " " || (style & GHOSTTY_RENDER_STYLE.invisible) !== 0) return;
    const span = (style & GHOSTTY_RENDER_STYLE.widthMask) === 1 ? 2 : 1;
    const entry = this.atlas.get({
      text,
      cellSpan: span,
      metrics: overlays.metrics,
      font: overlays.font,
      bold: (style & GHOSTTY_RENDER_STYLE.bold) !== 0,
      italic: (style & GHOSTTY_RENDER_STYLE.italic) !== 0,
      pixelRatio: overlays.viewport.pixelRatio,
    });
    const inverse = colorValues(model.backgroundAt(model.cursorY, model.cursorX));
    this.cursorGlyphs.push(
      left, top, overlays.metrics.width * span, height,
      entry.u0, entry.v0, entry.u1, entry.v1,
      inverse[0], inverse[1], inverse[2], 1,
      entry.colorGlyph ? 1 : 0,
    );
  }

  private invalidateScene(): void {
    this.rows.length = 0;
    this.retainedScene.clear();
    this.sceneGeneration = 0;
  }

  private cpuAllocatedBytes(): number {
    return this.retainedScene.allocatedBytes + this.cursors.allocatedBytes +
      this.cursorGlyphs.allocatedBytes + this.atlas.scratchAllocatedBytes
  }

  private gpuAllocatedBytes(): number {
    return this.backgroundBuffer.capacity + this.decorationBuffer.capacity +
      this.glyphBuffer.capacity + this.cursorBuffer.capacity + this.cursorGlyphBuffer.capacity
  }

  private transientAllocatedBytes(): number {
    return this.cpuAllocatedBytes() + this.gpuAllocatedBytes()
  }

  private transientTargetBytes(): number {
    return this.retainedScene.targetAllocatedBytes + this.cursors.targetAllocatedBytes +
      this.cursorGlyphs.targetAllocatedBytes + targetBufferCapacity(this.retainedScene.backgroundData) +
      targetBufferCapacity(this.retainedScene.decorationData) +
      targetBufferCapacity(this.retainedScene.glyphData) + targetBufferCapacity(this.cursors.data) +
      targetBufferCapacity(this.cursorGlyphs.data)
  }

  private trimGpuBuffer(state: BufferState, data: Float32Array): void {
    const target = targetBufferCapacity(data)
    if (target >= state.capacity) return
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, state.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, target, gl.DYNAMIC_DRAW)
    state.capacity = target
    if (data.byteLength > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, data)
  }

  private uploadFull(state: BufferState, data: Float32Array): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, state.buffer);
    if (data.byteLength > state.capacity) {
      let capacity = 1024;
      while (capacity < data.byteLength) capacity *= 2;
      gl.bufferData(gl.ARRAY_BUFFER, capacity, gl.DYNAMIC_DRAW);
      state.capacity = capacity;
    }
    if (data.byteLength > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
  }

  private uploadRange(state: BufferState, byteOffset: number, data: Float32Array): void {
    if (byteOffset < 0 || byteOffset + data.byteLength > state.capacity) {
      throw new RangeError("WebGL partial upload exceeds allocated scene buffer");
    }
    if (data.byteLength === 0) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, state.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, byteOffset, data);
  }

  private configureRectVao(buffer: WebGLBuffer): void {
    const gl = this.gl;
    gl.bindVertexArray(this.rectVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    for (let location = 0; location < 2; location += 1) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 4, gl.FLOAT, false, 8 * 4, location * 4 * 4);
      gl.vertexAttribDivisor(location, 1);
    }
  }

  private configureGlyphVao(buffer: WebGLBuffer): void {
    const gl = this.gl;
    gl.bindVertexArray(this.glyphVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    for (let location = 0; location < 3; location += 1) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 4, gl.FLOAT, false, 13 * 4, location * 4 * 4);
      gl.vertexAttribDivisor(location, 1);
    }
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 13 * 4, 12 * 4);
    gl.vertexAttribDivisor(3, 1);
  }

  private drawRects(
    state: BufferState,
    count: number,
    update: boolean,
    data?: Float32Array,
  ): number {
    if (count === 0) return 0;
    if (update && data !== undefined) this.uploadFull(state, data);
    const gl = this.gl;
    this.configureRectVao(state.buffer);
    gl.useProgram(this.rectProgram);
    gl.uniform2f(this.rectViewportUniform, this.viewport.cssWidth, this.viewport.cssHeight);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    return 1;
  }

  private drawGlyphs(
    state: BufferState,
    count: number,
    update: boolean,
    data?: Float32Array,
  ): number {
    if (count === 0) return 0;
    if (update && data !== undefined) this.uploadFull(state, data);
    const gl = this.gl;
    this.configureGlyphVao(state.buffer);
    gl.useProgram(this.glyphProgram);
    gl.uniform2f(this.glyphViewportUniform, this.viewport.cssWidth, this.viewport.cssHeight);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlas.texture);
    gl.uniform1i(this.atlasUniform, 0);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
    return 1;
  }
}

function targetBufferCapacity(data: Float32Array): number {
  if (data.byteLength === 0) return 0
  let capacity = 1024
  const target = data.byteLength * 2
  while (capacity < target) capacity *= 2
  return capacity
}
