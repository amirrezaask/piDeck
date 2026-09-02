export const WEBGL_RECT_FLOATS = 8;
export const WEBGL_GLYPH_FLOATS = 13;

function nextCapacity(required: number, maximum: number): number {
  let capacity = Math.min(64, maximum);
  while (capacity < required && capacity < maximum) capacity *= 2;
  return Math.min(capacity, maximum);
}

function red(packed: number): number { return ((packed >>> 16) & 0xff) / 255; }
function green(packed: number): number { return ((packed >>> 8) & 0xff) / 255; }
function blue(packed: number): number { return (packed & 0xff) / 255; }

export class WebGlRectBatch {
  private values: Float32Array;
  private countValue = 0;

  constructor(private readonly maximumInstances: number) {
    if (!Number.isSafeInteger(maximumInstances) || maximumInstances < 0) {
      throw new RangeError("invalid rectangle batch bound");
    }
    this.values = new Float32Array(WEBGL_RECT_FLOATS * Math.min(64, maximumInstances));
  }

  get count(): number { return this.countValue; }
  get data(): Float32Array { return this.values.subarray(0, this.countValue * WEBGL_RECT_FLOATS); }
  get usedBytes(): number { return this.countValue * WEBGL_RECT_FLOATS * Float32Array.BYTES_PER_ELEMENT; }
  get allocatedBytes(): number { return this.values.byteLength; }
  get targetAllocatedBytes(): number {
    return nextCapacity(this.countValue * 2, this.maximumInstances) *
      WEBGL_RECT_FLOATS * Float32Array.BYTES_PER_ELEMENT
  }

  clear(): void { this.countValue = 0; }

  trimCapacity(): number {
    const targetLength = this.targetAllocatedBytes / Float32Array.BYTES_PER_ELEMENT
    if (targetLength >= this.values.length) return 0
    const previousBytes = this.values.byteLength
    const next = new Float32Array(targetLength)
    next.set(this.data)
    this.values = next
    return previousBytes - next.byteLength
  }

  append(other: WebGlRectBatch): boolean {
    if (!this.reserve(other.count)) return false;
    this.values.set(other.data, this.countValue * WEBGL_RECT_FLOATS);
    this.countValue += other.count;
    return true;
  }

  push(
    x: number,
    y: number,
    width: number,
    height: number,
    redValue: number,
    greenValue: number,
    blueValue: number,
    alpha = 1,
  ): boolean {
    if (!this.reserve(1)) return false;
    const offset = this.countValue * WEBGL_RECT_FLOATS;
    this.values[offset] = x;
    this.values[offset + 1] = y;
    this.values[offset + 2] = width;
    this.values[offset + 3] = height;
    this.values[offset + 4] = redValue;
    this.values[offset + 5] = greenValue;
    this.values[offset + 6] = blueValue;
    this.values[offset + 7] = alpha;
    this.countValue += 1;
    return true;
  }

  pushPacked(
    x: number,
    y: number,
    width: number,
    height: number,
    color: number,
    alpha = 1,
  ): boolean {
    return this.push(x, y, width, height, red(color), green(color), blue(color), alpha);
  }

  private reserve(additional: number): boolean {
    const requiredInstances = this.countValue + additional;
    if (requiredInstances > this.maximumInstances) return false;
    const required = requiredInstances * WEBGL_RECT_FLOATS;
    if (required <= this.values.length) return true;
    const next = new Float32Array(
      nextCapacity(requiredInstances, this.maximumInstances) * WEBGL_RECT_FLOATS,
    );
    next.set(this.values.subarray(0, this.countValue * WEBGL_RECT_FLOATS));
    this.values = next;
    return true;
  }
}

export class WebGlGlyphBatch {
  private values: Float32Array;
  private countValue = 0;

  constructor(private readonly maximumInstances: number) {
    if (!Number.isSafeInteger(maximumInstances) || maximumInstances < 0) {
      throw new RangeError("invalid glyph batch bound");
    }
    this.values = new Float32Array(WEBGL_GLYPH_FLOATS * Math.min(64, maximumInstances));
  }

  get count(): number { return this.countValue; }
  get data(): Float32Array { return this.values.subarray(0, this.countValue * WEBGL_GLYPH_FLOATS); }
  get usedBytes(): number { return this.countValue * WEBGL_GLYPH_FLOATS * Float32Array.BYTES_PER_ELEMENT; }
  get allocatedBytes(): number { return this.values.byteLength; }
  get targetAllocatedBytes(): number {
    return nextCapacity(this.countValue * 2, this.maximumInstances) *
      WEBGL_GLYPH_FLOATS * Float32Array.BYTES_PER_ELEMENT
  }

  clear(): void { this.countValue = 0; }

  trimCapacity(): number {
    const targetLength = this.targetAllocatedBytes / Float32Array.BYTES_PER_ELEMENT
    if (targetLength >= this.values.length) return 0
    const previousBytes = this.values.byteLength
    const next = new Float32Array(targetLength)
    next.set(this.data)
    this.values = next
    return previousBytes - next.byteLength
  }

  append(other: WebGlGlyphBatch): boolean {
    if (!this.reserve(other.count)) return false;
    this.values.set(other.data, this.countValue * WEBGL_GLYPH_FLOATS);
    this.countValue += other.count;
    return true;
  }

  push(
    x: number,
    y: number,
    width: number,
    height: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    redValue: number,
    greenValue: number,
    blueValue: number,
    alpha = 1,
    colorGlyph = 0,
  ): boolean {
    if (!this.reserve(1)) return false;
    const offset = this.countValue * WEBGL_GLYPH_FLOATS;
    this.values[offset] = x;
    this.values[offset + 1] = y;
    this.values[offset + 2] = width;
    this.values[offset + 3] = height;
    this.values[offset + 4] = u0;
    this.values[offset + 5] = v0;
    this.values[offset + 6] = u1;
    this.values[offset + 7] = v1;
    this.values[offset + 8] = redValue;
    this.values[offset + 9] = greenValue;
    this.values[offset + 10] = blueValue;
    this.values[offset + 11] = alpha;
    this.values[offset + 12] = colorGlyph;
    this.countValue += 1;
    return true;
  }

  pushPacked(
    x: number,
    y: number,
    width: number,
    height: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    color: number,
    alpha = 1,
    colorGlyph = 0,
  ): boolean {
    return this.push(
      x, y, width, height, u0, v0, u1, v1,
      red(color), green(color), blue(color), alpha, colorGlyph,
    );
  }

  private reserve(additional: number): boolean {
    const requiredInstances = this.countValue + additional;
    if (requiredInstances > this.maximumInstances) return false;
    const required = requiredInstances * WEBGL_GLYPH_FLOATS;
    if (required <= this.values.length) return true;
    const next = new Float32Array(
      nextCapacity(requiredInstances, this.maximumInstances) * WEBGL_GLYPH_FLOATS,
    );
    next.set(this.values.subarray(0, this.countValue * WEBGL_GLYPH_FLOATS));
    this.values = next;
    return true;
  }
}
