export interface TerminalPrimitiveRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Snap a shared CSS edge to a physical pixel without creating row gaps. */
export function snapTerminalEdge(value: number, pixelRatio: number): number {
  const ratio = Math.max(0.25, pixelRatio);
  return Math.round(value * ratio) / ratio;
}

export interface TerminalRowEdges {
  readonly top: number;
  readonly bottom: number;
}

export function terminalRowEdges(
  originY: number,
  row: number,
  cellHeight: number,
  pixelRatio: number,
): TerminalRowEdges {
  return {
    top: snapTerminalEdge(originY + row * cellHeight, pixelRatio),
    bottom: snapTerminalEdge(originY + (row + 1) * cellHeight, pixelRatio),
  };
}

/**
 * Backend-neutral underline geometry. Ghostty values are: 1 single, 2 double,
 * 3 curly, 4 dotted, 5 dashed. Geometry is expressed in CSS pixels and snapped
 * by the caller's viewport transform.
 */
export function terminalUnderlineRects(
  style: number,
  x: number,
  baselineBottom: number,
  width: number,
  pixelRatio: number,
): readonly TerminalPrimitiveRect[] {
  if (style <= 0 || width <= 0) return [];
  const line = Math.max(1 / Math.max(1, pixelRatio), 1);
  const y = snapTerminalEdge(baselineBottom - line, pixelRatio);
  if (style === 1) return [{ x, y, width, height: line }];
  if (style === 2) {
    return [
      { x, y: snapTerminalEdge(y - line * 2, pixelRatio), width, height: line },
      { x, y, width, height: line },
    ];
  }
  const result: TerminalPrimitiveRect[] = [];
  if (style === 3) {
    const step = Math.max(line * 2, 2);
    for (let offset = 0, index = 0; offset < width; offset += step, index += 1) {
      result.push({
        x: x + offset,
        y: snapTerminalEdge(y - (index % 2 === 0 ? line : 0), pixelRatio),
        width: Math.min(step, width - offset),
        height: line,
      });
    }
    return result;
  }
  const segment = style === 4 ? line : Math.max(line * 3, 3);
  const gap = style === 4 ? line * 2 : Math.max(line * 2, 2);
  for (let offset = 0; offset < width; offset += segment + gap) {
    result.push({ x: x + offset, y, width: Math.min(segment, width - offset), height: line });
  }
  return result;
}
