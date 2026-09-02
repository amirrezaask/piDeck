#!/usr/bin/env node
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export const LOCAL_HOSTNAME = "ide.local"
export const LOCAL_HOST_ADDRESS = "127.0.0.1"

function defaultHostsFile() {
  if (process.platform === "win32") {
    return path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "drivers",
      "etc",
      "hosts",
    )
  }
  return "/etc/hosts"
}

function hostLineState(contents, hostname, address) {
  let found = false
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.split("#", 1)[0].trim()
    if (!line) continue
    const fields = line.split(/\s+/)
    if (!fields.slice(1).includes(hostname)) continue
    found = true
    if (fields[0] === address) return "registered"
  }
  return found ? "conflict" : "missing"
}

export function hasLocalHostEntry(
  contents,
  hostname = LOCAL_HOSTNAME,
  address = LOCAL_HOST_ADDRESS,
) {
  return hostLineState(contents, hostname, address) === "registered"
}

export function addLocalHostEntry(
  contents,
  hostname = LOCAL_HOSTNAME,
  address = LOCAL_HOST_ADDRESS,
) {
  const state = hostLineState(contents, hostname, address)
  if (state === "registered") return contents
  if (state === "conflict") {
    throw new Error(
      `Hosts file already maps ${hostname} to a non-loopback address`,
    )
  }
  const separator = contents.length > 0 && !contents.endsWith("\n") ? "\n" : ""
  return `${contents}${separator}${address}\t${hostname}\n`
}

function isPermissionError(error) {
  return (
    error &&
    typeof error === "object" &&
    (error.code === "EACCES" || error.code === "EPERM")
  )
}

function writeWithSudo(hostsFile, entry) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yaade-host-"))
  const tempFile = path.join(tempDir, "hosts-entry")
  try {
    fs.writeFileSync(tempFile, entry, { encoding: "utf8", mode: 0o600 })
    const result = spawnSync(
      "sudo",
      [
        "sh",
        "-c",
        'cat "$1" >> "$2"',
        "yaade-register-host",
        tempFile,
        hostsFile,
      ],
      { stdio: "inherit" },
    )
    if (result.error) throw result.error
    if (result.status !== 0) {
      throw new Error(`sudo exited with status ${result.status ?? "unknown"}`)
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

export function ensureLocalHostRegistration(options = {}) {
  const hostsFile = options.hostsFile ?? defaultHostsFile()
  const hostname = options.hostname ?? LOCAL_HOSTNAME
  const address = options.address ?? LOCAL_HOST_ADDRESS
  const elevate = options.elevate ?? true

  let contents = ""
  try {
    contents = fs.readFileSync(hostsFile, "utf8")
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") {
      throw error
    }
  }

  const next = addLocalHostEntry(contents, hostname, address)
  if (next === contents) return { changed: false, hostsFile }

  try {
    fs.writeFileSync(hostsFile, next, "utf8")
  } catch (error) {
    if (!elevate || !isPermissionError(error)) throw error
    writeWithSudo(hostsFile, next.slice(contents.length))
  }
  return { changed: true, hostsFile }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    ensureLocalHostRegistration()
  } catch (error) {
    console.error(
      `[local-host] ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  }
}
