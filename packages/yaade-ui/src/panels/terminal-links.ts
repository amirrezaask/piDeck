import { fileUriToPath } from "@yaade/shared"

export type TerminalPathLinkHandler = (path: string, line?: number, column?: number) => void

type ParsedPathLink = {
  startIndex: number
  length: number
  path: string
  line?: number
  column?: number
}

type ParsedUrlLink = {
  startIndex: number
  length: number
  url: string
}

export type TerminalLinkKind = "url" | "path"

export interface TerminalLinkMatch {
  kind: TerminalLinkKind
  text: string
  start: number
  end: number
}

export interface TerminalBufferLineLike {
  readonly isWrapped?: boolean
  translateToString(trimRight?: boolean): string
}

export interface WrappedTerminalLinkLineSegment {
  bufferLineNumber: number
  text: string
  startIndex: number
  endIndex: number
}

export interface WrappedTerminalLinkLine {
  text: string
  segments: ReadonlyArray<WrappedTerminalLinkLineSegment>
}

const FILE_URI_RE =
  /file:\/\/[^\s'")\]]+?(?::(\d+))?(?::(\d+))?(?=$|[\s'")\]])/g
const ABS_UNIX_PATH_RE =
  /(?:^|[\s('"])(\/(?:[^\s:']+\/)*[^\s:']+)(?::(\d+))?(?::(\d+))?/g
const REL_PATH_RE =
  /(?:^|[\s('"])((?:\.\/)?[\w][\w./-]*\.[A-Za-z0-9]+)(?::(\d+))?(?::(\d+))?/g

/** Match http(s) URLs without consuming common sentence punctuation. */
const URL_RE =
  /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/g
const URL_PATTERN = /https?:\/\/[^\s"'`<>]+/gi
const FILE_PATH_PATTERN =
  /(?:~\/|\.{1,2}\/|\/|[A-Za-z]:[\\/]|\\\\)[^\s"'`<>]+|[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?::\d+){0,2}/g
const TRAILING_PUNCTUATION_PATTERN = /[.,;!?]+$/

function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPod|iPad/i.test(navigator.platform)
}

/** VS Code convention: Cmd on macOS, Ctrl elsewhere. */
export function isTerminalLinkModifier(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey">,
): boolean {
  return isMacPlatform() ? event.metaKey : event.ctrlKey
}

export function openTerminalUrl(uri: string): void {
  let href: string
  try {
    const parsed = new URL(uri)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return
    href = parsed.href
  } catch {
    return
  }
  const win = window.open()
  if (!win) {
    console.warn("Opening terminal link blocked (window.open returned null)")
    return
  }
  try {
    win.opener = null
  } catch {
    // Browsers can throw when clearing opener.
  }
  win.location.href = href
}

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

function overlaps(
  a: { start: number; end: number },
  b: { start: number; end: number },
): boolean {
  return a.start < b.end && b.start < a.end
}

function collectMatches(
  line: string,
  kind: TerminalLinkKind,
  pattern: RegExp,
  existing: TerminalLinkMatch[],
): TerminalLinkMatch[] {
  const matches: TerminalLinkMatch[] = []
  pattern.lastIndex = 0

  for (const rawMatch of line.matchAll(pattern)) {
    const raw = rawMatch[0]
    const start = rawMatch.index ?? -1
    if (start < 0 || raw.length === 0) continue

    const trimmed = trimClosingDelimiters(raw)
    if (trimmed.length === 0) continue
    if (kind === "path" && /^https?:\/\//i.test(trimmed)) continue

    const candidate: TerminalLinkMatch = {
      kind,
      text: trimmed,
      start,
      end: start + trimmed.length,
    }

    const collides = [...existing, ...matches].some(other => overlaps(candidate, other))
    if (collides) continue
    matches.push(candidate)
  }

  return matches
}

export function extractTerminalLinks(line: string): TerminalLinkMatch[] {
  const urlMatches = collectMatches(line, "url", URL_PATTERN, [])
  const pathMatches = collectMatches(line, "path", FILE_PATH_PATTERN, urlMatches)
  return [...urlMatches, ...pathMatches].sort((a, b) => a.start - b.start)
}

export function collectWrappedTerminalLinkLine(
  bufferLineNumber: number,
  getLine: (bufferLineIndex: number) => TerminalBufferLineLike | null | undefined,
): WrappedTerminalLinkLine | null {
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

  const segments: WrappedTerminalLinkLineSegment[] = []
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
    text: segments.map(segment => segment.text).join(""),
    segments,
  }
}

function pushUniquePath(links: ParsedPathLink[], next: ParsedPathLink): void {
  const overlaps = links.some(
    link =>
      next.startIndex < link.startIndex + link.length &&
      next.startIndex + next.length > link.startIndex,
  )
  if (!overlaps) links.push(next)
}

export function scanTerminalPathLinks(text: string): ParsedPathLink[] {
  const links: ParsedPathLink[] = []

  for (const match of text.matchAll(FILE_URI_RE)) {
    const raw = match[0]
    const line = match[1] ? Number.parseInt(match[1], 10) : undefined
    const column = match[2] ? Number.parseInt(match[2], 10) : undefined
    const withoutSuffix = raw.replace(/:(\d+)(?::\d+)?$/, "")
    pushUniquePath(links, {
      startIndex: match.index ?? 0,
      length: raw.length,
      path: fileUriToPath(withoutSuffix),
      line: Number.isFinite(line) ? line : undefined,
      column: Number.isFinite(column) ? column : undefined,
    })
  }

  for (const match of text.matchAll(ABS_UNIX_PATH_RE)) {
    const path = match[1]
    if (!path) continue
    const line = match[2] ? Number.parseInt(match[2], 10) : undefined
    const column = match[3] ? Number.parseInt(match[3], 10) : undefined
    const startIndex = (match.index ?? 0) + match[0].indexOf(path)
    pushUniquePath(links, {
      startIndex,
      length: path.length + (match[2] ? `:${match[2]}${match[3] ? `:${match[3]}` : ""}`.length : 0),
      path,
      line: Number.isFinite(line) ? line : undefined,
      column: Number.isFinite(column) ? column : undefined,
    })
  }

  for (const match of text.matchAll(REL_PATH_RE)) {
    const path = match[1]
    if (!path || path.startsWith("file://")) continue
    const line = match[2] ? Number.parseInt(match[2], 10) : undefined
    const column = match[3] ? Number.parseInt(match[3], 10) : undefined
    const suffix = match[2]
      ? `:${match[2]}${match[3] ? `:${match[3]}` : ""}`
      : ""
    const startIndex = (match.index ?? 0) + match[0].indexOf(path)
    pushUniquePath(links, {
      startIndex,
      length: path.length + suffix.length,
      path,
      line: Number.isFinite(line) ? line : undefined,
      column: Number.isFinite(column) ? column : undefined,
    })
  }

  return links.sort((a, b) => a.startIndex - b.startIndex)
}

export function scanTerminalUrlLinks(text: string): ParsedUrlLink[] {
  const links: ParsedUrlLink[] = []
  for (const match of text.matchAll(URL_RE)) {
    const url = match[0]
    if (!url) continue
    links.push({
      startIndex: match.index ?? 0,
      length: url.length,
      url,
    })
  }
  return links
}
