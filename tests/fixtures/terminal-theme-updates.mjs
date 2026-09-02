const timeoutMs = 10_000
const escape = String.fromCodePoint(27)
const modeQuery = `${escape}[?2031$p`
const enableUpdates = `${escape}[?2031h`
const backgroundQuery = `${escape}]11;?\x07${escape}[5n`
const modeResponse = new RegExp(`${escape}\\[\\?2031;([1-4])\\$y`)
const preferenceResponse = new RegExp(`${escape}\\[\\?997;([12])n`)
const backgroundResponse = new RegExp(
  `${escape}\\]11;rgb:([\\da-f]{1,4}\\/[\\da-f]{1,4}\\/[\\da-f]{1,4})${escape}\\\\`,
  "i",
)

if (!process.stdin.isTTY) {
  process.stderr.write("YAADE_TERMINAL_THEME_ERROR:not-a-tty\n")
  process.exit(1)
}

let received = Buffer.alloc(0)
let initialBackground
let notificationPreference
let finished = false

function restoreInput() {
  if (process.stdin.isTTY) process.stdin.setRawMode(false)
  process.stdin.pause()
}

function finishWithError(message) {
  if (finished) return
  finished = true
  restoreInput()
  process.stderr.write(`\r\nYAADE_TERMINAL_THEME_ERROR:${message}:${received.toString("hex")}\r\n`)
  process.exitCode = 1
}

const timeout = setTimeout(() => finishWithError("timeout"), timeoutMs)
timeout.unref()
process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.on("data", chunk => {
  if (finished) return
  received = Buffer.concat([received, chunk]).subarray(-8_192)
  const response = received.toString("latin1")

  if (initialBackground === undefined) {
    const mode = response.match(modeResponse)?.[1]
    const background = response.match(backgroundResponse)?.[1]
    if (!mode || !background || !response.includes("\x1b[0n")) return
    initialBackground = background.toLowerCase()
    received = Buffer.alloc(0)
    process.stdout.write(
      `\r\nYAADE_TERMINAL_THEME_READY:${mode}:${initialBackground}\r\n${enableUpdates}`,
    )
    return
  }

  if (notificationPreference === undefined) {
    const preference = response.match(preferenceResponse)?.[1]
    if (!preference) return
    notificationPreference = preference
    received = Buffer.alloc(0)
    process.stdout.write(backgroundQuery)
    return
  }

  const background = response.match(backgroundResponse)?.[1]
  if (!background || !response.includes("\x1b[0n")) return
  finished = true
  clearTimeout(timeout)
  restoreInput()
  process.stdout.write(
    `\r\nYAADE_TERMINAL_THEME_UPDATED:${notificationPreference}:${background.toLowerCase()}\r\n`,
  )
})

process.stdout.write(modeQuery + backgroundQuery)
