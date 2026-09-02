declare const FileUriBrand: unique symbol

/** Branded `file://` URI — use {@link pathToFileUri} to construct. */
export type FileUri = string & { readonly [FileUriBrand]: true }

export function isFileUri(uri: string): uri is FileUri {
  return uri.startsWith("file://")
}

/**
 * Collapse `.` / `..` and duplicate separators. Preserves a leading `/` or
 * Windows drive root. Language tooling often emits `../`-laden or encoded variants
 * of the same on-disk file; normalizing keeps tab identity stable.
 */
export function normalizeFsPath(path: string): string {
  const windows = /^([A-Za-z]:)([\\/].*)$/.exec(path)
  let root = ""
  let rest = path.replace(/\\/g, "/")
  if (windows) {
    root = `${windows[1]!}/`
    rest = windows[2]!.replace(/\\/g, "/").replace(/^\//, "")
  } else if (rest.startsWith("/")) {
    root = "/"
    rest = rest.slice(1)
  }
  const parts: string[] = []
  for (const seg of rest.split("/")) {
    if (!seg || seg === ".") continue
    if (seg === "..") {
      if (parts.length > 0) parts.pop()
      continue
    }
    parts.push(seg)
  }
  if (windows) return root + parts.join("/")
  if (root === "/") return `/${parts.join("/")}`
  return parts.join("/")
}

export function pathToFileUri(path: string): FileUri {
  const normalized = normalizeFsPath(path.replace(/\\/g, "/"))
  if (normalized.startsWith("/")) return `file://${normalized}` as FileUri
  // Windows drive: C:/foo → file:///C:/foo
  if (/^[A-Za-z]:\//.test(normalized)) return `file:///${normalized}` as FileUri
  return `file:///${normalized}` as FileUri
}

export function fileUriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri
  let path = decodeURIComponent(uri.slice(7))
  // file:///C:/... on Windows
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1)
  return normalizeFsPath(path)
}

/** Decode + re-encode so LSP/host URIs match Yaade `pathToFileUri` form. */
export function canonicalizeFileUri(uri: string): FileUri {
  if (!uri.startsWith("file://")) return uri as FileUri
  return pathToFileUri(fileUriToPath(uri))
}
