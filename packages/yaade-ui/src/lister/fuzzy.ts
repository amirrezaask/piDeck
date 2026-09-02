/** Tokenized subsequence fuzzy rank — lower score = better. */

function subsequenceScore(query: string, text: string): number | null {
  let qi = 0
  let score = 0
  let last = -1
  for (let ti = 0; ti < text.length && qi < query.length; ti++) {
    if (text[ti] !== query[qi]) continue
    if (last >= 0) score += ti - last
    const prev = text[ti - 1]
    if (ti === 0 || prev === "/" || prev === "-" || prev === "_" || prev === "." || prev === " ") {
      score -= 1
    }
    last = ti
    qi++
  }
  if (qi !== query.length) return null
  return score + Math.min(64, text.length - query.length)
}

function scoreTerm(term: string, haystack: string): number | null {
  const idx = haystack.indexOf(term)
  if (idx >= 0) {
    let score = idx
    if (haystack.startsWith(term)) score -= 100
    if (haystack === term) score -= 200
    return score
  }
  return subsequenceScore(term, haystack)
}

export function fuzzyScore(query: string, searchText: string): number | null {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return 0
  const hay = searchText.toLowerCase()
  const terms = trimmed.split(/\s+/).filter(Boolean)
  let total = 0
  for (const term of terms) {
    const s = scoreTerm(term, hay)
    if (s === null) return null
    total += s
  }
  return total
}

export function fuzzyFilter<T extends { searchText: string }>(
  query: string,
  items: readonly T[],
): T[] {
  const trimmed = query.trim()
  if (!trimmed) return items.slice()

  const scored: { item: T; score: number }[] = []
  for (const item of items) {
    const score = fuzzyScore(trimmed, item.searchText)
    if (score === null) continue
    scored.push({ item, score })
  }
  scored.sort(
    (a, b) =>
      a.score - b.score || a.item.searchText.localeCompare(b.item.searchText),
  )
  return scored.map(s => s.item)
}
