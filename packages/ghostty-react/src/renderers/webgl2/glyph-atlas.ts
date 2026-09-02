import type { GhosttyCellMetrics } from "../../renderer.js";
import type { TerminalRenderFont } from "../terminal-renderer.js";

export interface WebGlGlyphAtlasEntry {
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
  readonly colorGlyph: boolean;
}

const PADDING = 2;
const COLOR_GLYPH = /\p{Extended_Pictographic}/u;
const DEFAULT_ATLAS_SIZE = 1024;
const MAX_SCRATCH_CANVASES = 4;

type GlyphScratchCanvas = {
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;
};

/**
 * A bounded stable-cluster atlas. Normal entries are complete graphemes rather
 * than volatile row strings. Capacity pressure resets the cache at a frame
 * boundary and is reported to the scene as ordinary repaint work, never as a
 * renderer failure.
 */
export class WebGlGlyphAtlas {
  readonly texture: WebGLTexture;
  readonly size: number;
  private readonly entries = new Map<string, WebGlGlyphAtlasEntry>();
  private readonly scratch = new Map<number, GlyphScratchCanvas>();
  private nextX = 0;
  private nextY = 0;
  private shelfHeight = 0;
  private generationValue = 1;
  private uploadsValue = 0;
  private resetsValue = 0;
  private allocatedBytesValue = 0;

  constructor(private readonly gl: WebGL2RenderingContext, maximumSize = DEFAULT_ATLAS_SIZE) {
    this.size = Math.max(256, Math.min(maximumSize, gl.getParameter(gl.MAX_TEXTURE_SIZE)));
    const texture = gl.createTexture();
    if (texture === null) throw new Error("WebGL glyph atlas initialization failed");
    this.texture = texture;
    this.allocateTexture();
  }

  get generation(): number { return this.generationValue; }
  get uploads(): number { return this.uploadsValue; }
  get resets(): number { return this.resetsValue; }
  get allocatedBytes(): number { return this.allocatedBytesValue; }
  get scratchAllocatedBytes(): number {
    let bytes = 0
    for (const { canvas } of this.scratch.values()) {
      bytes += canvas.width * canvas.height * 4
    }
    return bytes
  }
  get occupancy(): number {
    return (this.nextY * this.size + this.nextX * Math.max(1, this.shelfHeight)) /
      (this.size * this.size);
  }

  get(options: {
    readonly text: string;
    readonly cellSpan: number;
    readonly metrics: GhosttyCellMetrics;
    readonly font: TerminalRenderFont;
    readonly bold: boolean;
    readonly italic: boolean;
    readonly pixelRatio: number;
  }): WebGlGlyphAtlasEntry {
    const colorGlyph = COLOR_GLYPH.test(options.text);
    const key = [
      options.font.family,
      options.font.size,
      options.bold ? 700 : 400,
      options.italic ? "italic" : "normal",
      options.pixelRatio,
      options.cellSpan,
      colorGlyph ? "color" : "mask",
      options.text,
    ].join("\u0000");
    const cached = this.entries.get(key);
    if (cached !== undefined) {
      // Map insertion order is a cheap bounded LRU signal.
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }

    const ratio = options.pixelRatio;
    const width = Math.max(1, Math.ceil(options.metrics.width * options.cellSpan * ratio));
    const height = Math.max(1, Math.ceil(options.metrics.height * ratio));
    const atlasWidth = width + PADDING * 2;
    const atlasHeight = height + PADDING * 2;
    if (atlasWidth > this.size || atlasHeight > this.size) {
      throw new Error("Glyph exceeds the bounded WebGL atlas");
    }
    const scratch = this.scratchFor(atlasWidth, atlasHeight);
    const canvas = scratch.canvas;
    const context = scratch.context;
    if (this.nextX + canvas.width > this.size) {
      this.nextX = 0;
      this.nextY += this.shelfHeight;
      this.shelfHeight = 0;
    }
    if (this.nextY + canvas.height > this.size) this.resetForPressure();
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.restore();
    context.save();
    context.setTransform(ratio, 0, 0, ratio, PADDING, PADDING);
    context.textBaseline = "alphabetic";
    context.font = `${options.italic ? "italic" : "normal"} ${options.bold ? 700 : 400} ${options.font.size}px ${options.font.family}`;
    context.fillStyle = "rgb(255, 255, 255)";
    context.beginPath();
    context.rect(0, 0, options.metrics.width * options.cellSpan, options.metrics.height);
    context.clip();
    context.fillText(options.text, 0, options.metrics.baseline);
    context.restore();

    const x = this.nextX;
    const y = this.nextY;
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
    this.gl.pixelStorei(this.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    this.gl.texSubImage2D(
      this.gl.TEXTURE_2D,
      0,
      x,
      y,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      canvas,
    );
    this.uploadsValue += 1;
    const entry = {
      u0: (x + PADDING) / this.size,
      v0: (y + PADDING) / this.size,
      u1: (x + PADDING + width) / this.size,
      v1: (y + PADDING + height) / this.size,
      colorGlyph,
    };
    this.entries.set(key, entry);
    this.nextX += canvas.width;
    this.shelfHeight = Math.max(this.shelfHeight, canvas.height);
    return entry;
  }

  trimScratch(): number {
    const reclaimed = this.scratchAllocatedBytes
    this.scratch.clear()
    return reclaimed
  }

  clear(): void {
    this.entries.clear();
    this.nextX = 0;
    this.nextY = 0;
    this.shelfHeight = 0;
    this.generationValue += 1;
    this.allocateTexture();
  }

  dispose(): void {
    this.entries.clear();
    this.scratch.clear();
    this.allocatedBytesValue = 0;
    this.gl.deleteTexture(this.texture);
  }

  private resetForPressure(): void {
    this.resetsValue += 1;
    this.clear();
  }

  private allocateTexture(): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      this.size,
      this.size,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    this.allocatedBytesValue = this.size * this.size * 4;
  }

  private scratchFor(width: number, height: number): GlyphScratchCanvas {
    const bucket = Math.min(MAX_SCRATCH_CANVASES - 1, Math.max(0, Math.ceil(Math.log2(width)) - 4));
    const cached = this.scratch.get(bucket);
    if (cached !== undefined && cached.canvas.width >= width && cached.canvas.height >= height) {
      return cached;
    }
    const canvas = cached?.canvas ?? document.createElement("canvas");
    canvas.width = Math.max(width, cached?.canvas.width ?? 0);
    canvas.height = Math.max(height, cached?.canvas.height ?? 0);
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("WebGL glyph scratch canvas is unavailable");
    const value = { canvas, context };
    this.scratch.set(bucket, value);
    return value;
  }
}
