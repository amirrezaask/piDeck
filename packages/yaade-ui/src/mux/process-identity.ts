/**
 * Process identity for terminal pane icons and titles.
 * Maps a foreground process basename to a glyph + tint.
 */

export type ProcessIdentity = {
  /** Short glyph shown inside the terminal pane (1–2 chars or emoji-like mark). */
  glyph: string
  /** oklch hue for the terminal pane background. */
  hue: number
  /** Display label override (defaults to process basename). */
  label?: string
}

const SHELLS = new Set([
  "zsh",
  "bash",
  "fish",
  "sh",
  "dash",
  "nu",
  "pwsh",
  "powershell",
  "cmd",
  "cmd.exe",
  "terminal",
])

interface ProcessIdentityMap {
  [processName: string]: ProcessIdentity
}

const IDENTITY: ProcessIdentityMap = {
  nvim: { glyph: "Nv", hue: 145, label: "Neovim" },
  neovim: { glyph: "Nv", hue: 145, label: "Neovim" },
  vim: { glyph: "Vi", hue: 145, label: "Vim" },
  btop: { glyph: "◈", hue: 230 },
  top: { glyph: "◈", hue: 220 },
  htop: { glyph: "◈", hue: 225 },
  node: { glyph: "js", hue: 130 },
  python: { glyph: "py", hue: 210 },
  python3: { glyph: "py", hue: 210 },
  ssh: { glyph: "⇄", hue: 195 },
  docker: { glyph: "🐳", hue: 210 },
}

const DEFAULT_SHELL: ProcessIdentity = { glyph: ">_", hue: 255 }
const DEFAULT_UNKNOWN: ProcessIdentity = { glyph: "·", hue: 255 }

export function processIdentity(processName: string | null | undefined): ProcessIdentity {
  if (!processName) return DEFAULT_SHELL
  const base = processName.trim().toLowerCase().split(/[/\\]/).pop() ?? ""
  if (!base) return DEFAULT_SHELL
  if (SHELLS.has(base)) return DEFAULT_SHELL
  return IDENTITY[base] ?? { ...DEFAULT_UNKNOWN, label: base }
}

/**
 * Format a pane/window title as `~/abbrev/path - process`.
 */
export function formatMuxTitle(options: {
  cwdPath: string | null | undefined
  homeDir: string | null | undefined
  processName: string | null | undefined
  fallback?: string
}): string {
  const identity = processIdentity(options.processName)
  const base =
    options.processName?.trim().toLowerCase().split(/[/\\]/).pop() ?? ""
  const isShell =
    !base ||
    ["zsh", "bash", "fish", "sh", "dash", "nu", "pwsh", "powershell", "cmd", "cmd.exe"].includes(
      base,
    )
  const processLabel =
    identity.label ?? (isShell ? "shell" : base || "shell")
  const abbrev = abbreviatePath(options.cwdPath, options.homeDir)
  if (!abbrev) return options.fallback ?? processLabel
  return `${abbrev} - ${processLabel}`
}

function abbreviatePath(
  cwdPath: string | null | undefined,
  homeDir: string | null | undefined,
): string {
  if (!cwdPath) return ""
  let path = cwdPath
  const home = homeDir?.replace(/\/+$/, "") ?? ""
  if (home && (path === home || path.startsWith(`${home}/`))) {
    path = `~${path.slice(home.length)}`
  }
  const parts = path.split("/").filter(Boolean)
  if (parts.length <= 3) return path.startsWith("~") ? path : path.startsWith("/") ? path : `/${path}`
  // Keep first + last two segments
  const head = path.startsWith("~") ? "~" : ""
  const rest = parts.slice(path.startsWith("~") ? 1 : 0)
  if (rest.length <= 3) return path
  return `${head}/${rest[0]}/…/${rest[rest.length - 2]}/${rest[rest.length - 1]}`
}
