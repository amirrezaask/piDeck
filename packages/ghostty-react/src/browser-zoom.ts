type BrowserZoomKeyEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "key" | "metaKey"
>;

const BROWSER_ZOOM_KEYS = new Set([
  "0",
  "+",
  "=",
  "-",
  "Add",
  "Equal",
  "Minus",
  "Subtract",
]);

function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** Let the browser own its page-zoom accelerators while the terminal has focus. */
export function isBrowserZoomShortcut(
  event: BrowserZoomKeyEvent,
  platform: string,
): boolean {
  const primaryModifier = isMacPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;

  return primaryModifier && !event.altKey && BROWSER_ZOOM_KEYS.has(event.key);
}

/** Chromium exposes trackpad pinch and Ctrl-wheel page zoom as Ctrl+wheel. */
export function isBrowserZoomWheel(event: Pick<WheelEvent, "ctrlKey">): boolean {
  return event.ctrlKey;
}
