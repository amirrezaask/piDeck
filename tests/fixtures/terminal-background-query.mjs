const timeoutMs = 5_000
const escape = String.fromCodePoint(27)
const backgroundQuery = `${escape}]11;?\x07`
const statusQuery = `${escape}[5n`
const backgroundResponse = new RegExp(
  `${escape}\\]11;rgb:([\\da-f]{1,4}\\/[\\da-f]{1,4}\\/[\\da-f]{1,4})${escape}\\\\`,
  "i",
)

if (!process.stdin.isTTY) {
  process.stderr.write("YAADE_TERMINAL_QUERY_ERROR:not-a-tty\n")
  process.exit(1)
}

let received = Buffer.alloc(0)
let finished = false

function restoreInput() {
  if (process.stdin.isTTY) process.stdin.setRawMode(false)
  process.stdin.pause()
}

const timeout = setTimeout(() => {
  if (finished) return
  finished = true
  restoreInput()
  process.stderr.write(`\r\nYAADE_TERMINAL_QUERY_ERROR:timeout:${received.toString("hex")}\r\n`)
  process.exitCode = 1
}, timeoutMs)

timeout.unref()
process.stdin.setRawMode(true)
process.stdin.resume()
process.stdin.on("data", chunk => {
  if (finished) return
  received = Buffer.concat([received, chunk]).subarray(-4_096)
  const response = received.toString("latin1")
  const color = response.match(backgroundResponse)?.[1]
  if (!color || !response.includes("\x1b[0n")) return

  finished = true
  clearTimeout(timeout)
  restoreInput()
  process.stdout.write(`\r\nYAADE_TERMINAL_QUERY_RESPONSE:${color.toLowerCase()}\r\n`)
})

process.stdout.write(backgroundQuery + statusQuery)
