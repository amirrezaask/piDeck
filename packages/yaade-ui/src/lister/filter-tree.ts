import { fuzzyScore } from "./fuzzy.js"

export type TreeFilterRow = {
  searchText: string
  depth: number
  expanded: boolean
  isBranch: boolean
}

/**
 * Filter flattened tree rows while preserving expand/collapse.
 * Keeps: matches, ancestors of matches, and all descendants under
 * an expanded matching branch (so toggling open reveals children).
 * Preserves tree order (no score re-sort).
 */
export function filterTreeRows<T extends TreeFilterRow>(
  query: string,
  rows: readonly T[],
): T[] {
  const trimmed = query.trim()
  if (!trimmed || rows.length === 0) return rows.slice()

  const match = rows.map(r => fuzzyScore(trimmed, r.searchText) !== null)
  const keep = match.slice()
  const parent = new Int32Array(rows.length)
  parent.fill(-1)
  const depthStack: number[] = []

  // Build parent links once, then propagate matches upward in one reverse pass.
  // Scanning backward from every match is quadratic for broad directories.
  for (let i = 0; i < rows.length; i++) {
    const depth = rows[i]!.depth
    parent[i] = depth > 0 ? (depthStack[depth - 1] ?? -1) : -1
    depthStack[depth] = i
    depthStack.length = depth + 1
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!keep[i]) continue
    const parentIndex = parent[i]!
    if (parentIndex >= 0) keep[parentIndex] = true
  }

  // Descendants of expanded matching branches form contiguous ranges.
  let revealBelowDepth: number | null = null
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    if (revealBelowDepth !== null && row.depth <= revealBelowDepth) {
      revealBelowDepth = null
    }
    if (revealBelowDepth !== null) keep[i] = true
    if (match[i] && row.isBranch && row.expanded) {
      revealBelowDepth = revealBelowDepth === null
        ? row.depth
        : Math.min(revealBelowDepth, row.depth)
    }
  }

  return rows.filter((_, i) => keep[i])
}
