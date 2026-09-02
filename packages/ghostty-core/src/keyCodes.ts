/// <reference lib="dom" />

// This order mirrors GhosttyKey in ghostty/vt/key/event.h. The values are
// intentionally derived from the official W3C-aligned enum instead of
// maintaining a second keyboard protocol.
const ghosttyKeyboardCodes = [
  "Unidentified",
  "Backquote",
  "Backslash",
  "BracketLeft",
  "BracketRight",
  "Comma",
  "Digit0",
  "Digit1",
  "Digit2",
  "Digit3",
  "Digit4",
  "Digit5",
  "Digit6",
  "Digit7",
  "Digit8",
  "Digit9",
  "Equal",
  "IntlBackslash",
  "IntlRo",
  "IntlYen",
  "KeyA",
  "KeyB",
  "KeyC",
  "KeyD",
  "KeyE",
  "KeyF",
  "KeyG",
  "KeyH",
  "KeyI",
  "KeyJ",
  "KeyK",
  "KeyL",
  "KeyM",
  "KeyN",
  "KeyO",
  "KeyP",
  "KeyQ",
  "KeyR",
  "KeyS",
  "KeyT",
  "KeyU",
  "KeyV",
  "KeyW",
  "KeyX",
  "KeyY",
  "KeyZ",
  "Minus",
  "Period",
  "Quote",
  "Semicolon",
  "Slash",
  "AltLeft",
  "AltRight",
  "Backspace",
  "CapsLock",
  "ContextMenu",
  "ControlLeft",
  "ControlRight",
  "Enter",
  "MetaLeft",
  "MetaRight",
  "ShiftLeft",
  "ShiftRight",
  "Space",
  "Tab",
  "Convert",
  "KanaMode",
  "NonConvert",
  "Delete",
  "End",
  "Help",
  "Home",
  "Insert",
  "PageDown",
  "PageUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "NumLock",
  "Numpad0",
  "Numpad1",
  "Numpad2",
  "Numpad3",
  "Numpad4",
  "Numpad5",
  "Numpad6",
  "Numpad7",
  "Numpad8",
  "Numpad9",
  "NumpadAdd",
  "NumpadBackspace",
  "NumpadClear",
  "NumpadClearEntry",
  "NumpadComma",
  "NumpadDecimal",
  "NumpadDivide",
  "NumpadEnter",
  "NumpadEqual",
  "NumpadMemoryAdd",
  "NumpadMemoryClear",
  "NumpadMemoryRecall",
  "NumpadMemoryStore",
  "NumpadMemorySubtract",
  "NumpadMultiply",
  "NumpadParenLeft",
  "NumpadParenRight",
  "NumpadSubtract",
  "NumpadSeparator",
  "NumpadArrowUp",
  "NumpadArrowDown",
  "NumpadArrowRight",
  "NumpadArrowLeft",
  "NumpadBegin",
  "NumpadHome",
  "NumpadEnd",
  "NumpadInsert",
  "NumpadDelete",
  "NumpadPageUp",
  "NumpadPageDown",
  "Escape",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
  "F13",
  "F14",
  "F15",
  "F16",
  "F17",
  "F18",
  "F19",
  "F20",
  "F21",
  "F22",
  "F23",
  "F24",
  "F25",
  "Fn",
  "FnLock",
  "PrintScreen",
  "ScrollLock",
  "Pause",
  "BrowserBack",
  "BrowserFavorites",
  "BrowserForward",
  "BrowserHome",
  "BrowserRefresh",
  "BrowserSearch",
  "BrowserStop",
  "Eject",
  "LaunchApp1",
  "LaunchApp2",
  "LaunchMail",
  "MediaPlayPause",
  "MediaSelect",
  "MediaStop",
  "MediaTrackNext",
  "MediaTrackPrevious",
  "Power",
  "Sleep",
  "AudioVolumeDown",
  "AudioVolumeMute",
  "AudioVolumeUp",
  "WakeUp",
  "Copy",
  "Cut",
  "Paste",
] as const;

const codeToGhosttyKey = new Map<string, number>(
  ghosttyKeyboardCodes.map((code, index) => [code, index]),
);

export function ghosttyKeyForCode(code: string): number {
  return codeToGhosttyKey.get(code) ?? 0;
}

export interface GhosttyKeyboardLayoutMap {
  get(code: string): string | undefined;
}

const shiftedToUnshiftedCharacter = new Map<string, string>([
  ["!", "1"],
  ["@", "2"],
  ["#", "3"],
  ["$", "4"],
  ["%", "5"],
  ["^", "6"],
  ["&", "7"],
  ["*", "8"],
  ["(", "9"],
  [")", "0"],
  ["~", "`"],
  ["_", "-"],
  ["+", "="],
  ["{", "["],
  ["}", "]"],
  ["|", "\\"],
  [":", ";"],
  ['"', "'"],
  ["<", ","],
  [">", "."],
  ["?", "/"],
]);

let keyboardLayoutMapPromise: Promise<GhosttyKeyboardLayoutMap | undefined> | undefined;

export function loadGhosttyKeyboardLayoutMap(): Promise<GhosttyKeyboardLayoutMap | undefined> {
  if (keyboardLayoutMapPromise) return keyboardLayoutMapPromise;
  // SAFETY: the optional keyboard API is feature-detected below; browsers
  // without it simply use the fallback keyboard encoding.
  const browserNavigator = globalThis.navigator as
    | (Navigator & {
        readonly keyboard?: {
          getLayoutMap(): Promise<GhosttyKeyboardLayoutMap>;
        };
      })
    | undefined;
  const keyboard = browserNavigator?.keyboard;
  const promise = keyboard?.getLayoutMap().catch(() => undefined) ?? Promise.resolve(undefined);
  keyboardLayoutMapPromise = promise;
  return promise;
}

export function ghosttyUnshiftedCodepoint(
  event: Pick<KeyboardEvent, "code" | "key" | "shiftKey">,
  layoutMap?: GhosttyKeyboardLayoutMap,
): number {
  if ([...event.key].length !== 1) return 0;
  const layoutCharacter = layoutMap?.get(event.code);
  if (layoutCharacter && [...layoutCharacter].length === 1) {
    return layoutCharacter.codePointAt(0) ?? 0;
  }
  if (/^[A-Z]$/u.test(event.key)) return event.key.charCodeAt(0) + 32;
  if (event.shiftKey) {
    const unshiftedCharacter = shiftedToUnshiftedCharacter.get(event.key);
    if (unshiftedCharacter) return unshiftedCharacter.codePointAt(0) ?? 0;
    const lowercase = event.key.toLowerCase();
    if (lowercase !== event.key && [...lowercase].length === 1) {
      return lowercase.codePointAt(0) ?? 0;
    }
    // Without layout data the unshifted form of a shifted key is unknowable;
    // reporting the shifted character as unshifted corrupts Kitty alternate keys.
    return 0;
  }
  return event.key.codePointAt(0) ?? 0;
}

const GHOSTTY_MOD_SHIFT = 1;
const GHOSTTY_MOD_CTRL = 1 << 1;
const GHOSTTY_MOD_ALT = 1 << 2;

function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * Browser KeyboardEvents already contain layout-generated text. Tell Ghostty
 * which modifiers produced that text so Kitty/CSI-u does not encode a second,
 * synthetic modifier on top of it.
 */
export function ghosttyConsumedModifierBits(
  event: Pick<KeyboardEvent, "altKey" | "code" | "getModifierState" | "key" | "shiftKey">,
  layoutMap?: GhosttyKeyboardLayoutMap,
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): number {
  if ([...event.key].length !== 1) return 0;

  const textCodepoint = event.key.codePointAt(0) ?? 0;
  const unshiftedCodepoint = ghosttyUnshiftedCodepoint(event, layoutMap);
  const layoutGeneratedText =
    unshiftedCodepoint !== 0 && unshiftedCodepoint !== textCodepoint;
  let consumed = 0;

  // Shift+A and shifted punctuation are already represented by event.key.
  if (event.shiftKey && layoutGeneratedText) consumed |= GHOSTTY_MOD_SHIFT;

  // AltGraph is exposed as Ctrl+Alt by browsers on many layouts. Both bits
  // were consumed to produce the printable event.key and must be removed.
  if (event.getModifierState("AltGraph")) {
    consumed |= GHOSTTY_MOD_CTRL | GHOSTTY_MOD_ALT;
  } else if (event.altKey && isMacPlatform(platform) && layoutGeneratedText) {
    // macOS Option is a text-producing layout modifier unless the user has
    // explicitly configured a terminal-level Option-as-Alt policy.
    consumed |= GHOSTTY_MOD_ALT;
  }

  return consumed;
}
