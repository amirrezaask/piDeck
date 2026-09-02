type TerminalKeyboardEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "isComposing" | "key" | "metaKey" | "shiftKey" | "type"
>

function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform)
}

export function terminalKeybindingData(
  event: TerminalKeyboardEvent,
  platform: string,
): string | null {
  if (event.type !== "keydown" || event.isComposing) return null

  if (
    event.key === "Enter" &&
    event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey
  ) {
    return "\n"
  }

  // Ghostty correctly follows Kitty keyboard mode when a shell enables it,
  // but older readline/fish builds still expect a literal ESC for this key.
  // Keep the universal Escape gesture compatible with both kinds of shell.
  if (
    event.key === "Escape" &&
    !event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey
  ) {
    return "\u001b"
  }

  if (!isMacPlatform(platform) || event.shiftKey || event.ctrlKey) return null

  if (event.key === "ArrowLeft") {
    if (event.altKey && !event.metaKey) return "\u001bb"
    if (event.metaKey && !event.altKey) return "\u0001"
  }
  if (event.key === "ArrowRight") {
    if (event.altKey && !event.metaKey) return "\u001bf"
    if (event.metaKey && !event.altKey) return "\u0005"
  }
  if (event.key === "Backspace") {
    if (event.altKey && !event.metaKey) return "\u001b\u007f"
    if (event.metaKey && !event.altKey) return "\u0015"
  }
  return null
}

/**
 * The freestanding WASM build cannot compile Ghostty's native macOS policy.
 * Apple reserves Command for app actions, so an unhandled Command key must
 * not fall through to the terminal encoder as literal text.
 */
export function shouldSuppressMacMetaKey(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey">,
  platform: string,
): boolean {
  return (
    isMacPlatform(platform) &&
    event.metaKey &&
    !event.altKey &&
    !event.ctrlKey &&
    event.key !== "Meta"
  )
}
