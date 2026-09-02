const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform)

function formatKeyPart(part: string): string {
  const tokens = part.split("-")
  const key = tokens.pop() ?? part
  const mods = tokens.map(t => {
    switch (t) {
      case "Mod":
      case "Cmd":
        return isMac ? "⌘" : "Ctrl"
      case "Ctrl":
        return "Ctrl"
      case "Alt":
        return isMac ? "⌥" : "Alt"
      case "Shift":
        return isMac ? "⇧" : "Shift"
      default:
        return t === "Mod" ? (isMac ? "⌘" : "Ctrl") : t
    }
  })
  const label =
    key.length === 1
      ? key.toUpperCase()
      : key === "ArrowUp"
        ? "↑"
        : key === "ArrowDown"
          ? "↓"
          : key === "ArrowLeft"
            ? "←"
            : key === "ArrowRight"
              ? "→"
      : key === "`"
        ? "`"
        : key === "Enter"
          ? "↵"
          : key === "Mod"
            ? isMac
              ? "⌘"
              : "Ctrl"
            : key === "Cmd"
              ? isMac
                ? "⌘"
                : "Ctrl"
              : key
  // Never surface the abstract "Mod" token in UI.
  const cleaned = [...mods, label].map(token =>
    token === "Mod" ? (isMac ? "⌘" : "Ctrl") : token,
  )
  return cleaned.join(isMac ? "" : "+")
}

/** Human label for a binding chord (`Mod-p` → `⌘P` / `Ctrl+P`). Never leaves `Mod` in output. */
export function formatKeyBinding(key: string): string {
  return key
    .split(" ")
    .map(part => formatKeyPart(part.trim()))
    .filter(Boolean)
    .join(" ")
}
