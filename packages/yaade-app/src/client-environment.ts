const TAURI_APP_HOSTNAME = "tauri.localhost"
const LOCAL_HOST_URL = "http://127.0.0.1:7774"

type ClientLocation = Pick<Location, "hostname" | "origin" | "protocol">
type ClientNavigator = Pick<Navigator, "platform" | "userAgent">

export function isDesktopClient(location: ClientLocation): boolean {
  return location.protocol === "tauri:" || location.hostname === TAURI_APP_HOSTNAME
}

export function isMacDesktopClient(
  location: ClientLocation,
  navigator: ClientNavigator,
): boolean {
  if (!isDesktopClient(location)) return false
  return /Mac|iPhone|iPad|iPod/i.test(`${navigator.platform} ${navigator.userAgent}`)
}

export function resolveCurrentHostUrl(location: ClientLocation): string {
  if (isDesktopClient(location)) {
    return LOCAL_HOST_URL
  }
  return location.origin
}
