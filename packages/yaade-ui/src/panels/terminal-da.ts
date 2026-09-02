/**
 * Ghostty answers DA1 when it parses a query. The host already replies the
 * moment the query leaves the PTY, so a second Ghostty reply would show up as
 * typed input after fish has moved on. Strip DA1 *responses* only.
 */
export function stripDa1Responses(data: string): string {
  if (!data.includes("\x1b[?")) return data
  return data.replace(/\x1b\[\?[\d;]*c/g, "")
}
