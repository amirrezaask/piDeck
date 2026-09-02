import assert from "node:assert/strict"
import { describe, it } from "vite-plus/test"
import {
  isDesktopClient,
  isMacDesktopClient,
  resolveCurrentHostUrl,
} from "./client-environment.js"

describe("client environment", () => {
  it("distinguishes browser and desktop locations", () => {
    assert.equal(
      isDesktopClient({
        hostname: "yaade.example",
        origin: "https://yaade.example",
        protocol: "https:",
      }),
      false,
    )
    assert.equal(
      isDesktopClient({
        hostname: "tauri.localhost",
        origin: "http://tauri.localhost",
        protocol: "http:",
      }),
      true,
    )
  })

  it("identifies a macOS Tauri shell without treating browser tabs as native", () => {
    const mac = { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)" }
    const linux = { platform: "Linux x86_64", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }
    assert.equal(
      isMacDesktopClient(
        { hostname: "tauri.localhost", origin: "http://tauri.localhost", protocol: "http:" },
        mac,
      ),
      true,
    )
    assert.equal(
      isMacDesktopClient(
        { hostname: "tauri.localhost", origin: "http://tauri.localhost", protocol: "http:" },
        linux,
      ),
      false,
    )
    assert.equal(
      isMacDesktopClient(
        { hostname: "yaade.example", origin: "https://yaade.example", protocol: "https:" },
        mac,
      ),
      false,
    )
  })

  it("uses the serving origin in a browser", () => {
    assert.equal(
      resolveCurrentHostUrl({
        hostname: "yaade.example",
        origin: "https://yaade.example",
        protocol: "https:",
      }),
      "https://yaade.example",
    )
  })

  it("connects production Tauri clients to the local host", () => {
    assert.equal(
      resolveCurrentHostUrl({
        hostname: "localhost",
        origin: "tauri://localhost",
        protocol: "tauri:",
      }),
      "http://127.0.0.1:7774",
    )
    assert.equal(
      resolveCurrentHostUrl({
        hostname: "tauri.localhost",
        origin: "http://tauri.localhost",
        protocol: "http:",
      }),
      "http://127.0.0.1:7774",
    )
  })
})
