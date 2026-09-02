export interface GhosttyTerminalLinkMatch {
  readonly text: string
  readonly start: number
  readonly end: number
}

export type GhosttyTerminalLinkMatcher = (
  line: string,
) => readonly GhosttyTerminalLinkMatch[]

export interface GhosttyTerminalBufferLineLike {
  readonly isWrapped?: boolean
  translateToString(trimRight?: boolean): string
}

export interface GhosttyWrappedTerminalLinkLineSegment {
  readonly bufferLineNumber: number
  readonly text: string
  readonly startIndex: number
  readonly endIndex: number
}

export interface GhosttyWrappedTerminalLinkLine {
  readonly text: string
  readonly segments: readonly GhosttyWrappedTerminalLinkLineSegment[]
}

const URL_PATTERN = /https?:\/\/[^\s"'`<>]+/gi
const TRAILING_PUNCTUATION_PATTERN = /[.,;!?]+$/

function trimClosingDelimiters(value: string): string {
  let output = value.replace(TRAILING_PUNCTUATION_PATTERN, "")
  if (output.length === 0) return output

  const trimUnbalanced = (open: string, close: string) => {
    while (output.endsWith(close)) {
      const opens = output.split(open).length - 1
      const closes = output.split(close).length - 1
      if (opens >= closes) return
      output = output.slice(0, -1)
    }
  }

  trimUnbalanced("(", ")")
  trimUnbalanced("[", "]")
  trimUnbalanced("{", "}")
  return output
}

/** Match URLs without consuming sentence punctuation or unbalanced delimiters. */
export function matchTerminalUrls(line: string): GhosttyTerminalLinkMatch[] {
  const matches: GhosttyTerminalLinkMatch[] = []
  for (const rawMatch of line.matchAll(URL_PATTERN)) {
    const raw = rawMatch[0]
    const start = rawMatch.index ?? -1
    if (!raw || start < 0) continue
    const text = trimClosingDelimiters(raw)
    if (!text) continue
    matches.push({ text, start, end: start + text.length })
  }
  return matches
}

export function collectWrappedTerminalLinkLine(
  bufferLineNumber: number,
  getLine: (bufferLineIndex: number) => GhosttyTerminalBufferLineLike | null | undefined,
): GhosttyWrappedTerminalLinkLine | null {
  const anchorLine = getLine(bufferLineNumber - 1)
  if (!anchorLine) return null

  let startBufferLineNumber = bufferLineNumber
  let startLine = anchorLine
  while (startBufferLineNumber > 1 && startLine.isWrapped) {
    const previousLine = getLine(startBufferLineNumber - 2)
    if (!previousLine) return null
    startBufferLineNumber -= 1
    startLine = previousLine
  }

  const segments: GhosttyWrappedTerminalLinkLineSegment[] = []
  let nextStartIndex = 0
  let currentBufferLineNumber = startBufferLineNumber
  while (true) {
    const currentLine = getLine(currentBufferLineNumber - 1)
    if (!currentLine) break
    const nextLine = getLine(currentBufferLineNumber)
    const hasWrappedContinuation = nextLine?.isWrapped === true
    const text = currentLine.translateToString(!hasWrappedContinuation)
    segments.push({
      bufferLineNumber: currentBufferLineNumber,
      text,
      startIndex: nextStartIndex,
      endIndex: nextStartIndex + text.length,
    })
    nextStartIndex += text.length
    if (!hasWrappedContinuation) break
    currentBufferLineNumber += 1
  }

  return {
    text: segments.map((segment) => segment.text).join(""),
    segments,
  }
}
