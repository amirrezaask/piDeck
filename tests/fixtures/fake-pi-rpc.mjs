#!/usr/bin/env node

if (process.argv.includes("--list-models")) {
  process.stdout.write(
    "provider model context max-out thinking images\n" +
      "fake fake-model 128K 32K yes yes\n",
  )
  process.exit(0)
}

let buffered = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", chunk => {
  buffered += chunk
  while (true) {
    const newline = buffered.indexOf("\n")
    if (newline < 0) break
    const line = buffered.slice(0, newline).replace(/\r$/, "")
    buffered = buffered.slice(newline + 1)
    if (!line) continue

    let command
    try {
      command = JSON.parse(line)
    } catch {
      process.stdout.write(
        `${JSON.stringify({ type: "response", command: "parse", success: false, error: "invalid JSON" })}\n`,
      )
      continue
    }

    process.stdout.write(
      `${JSON.stringify({ id: command.id, type: "response", command: command.type, success: true })}\n`,
    )
    if (command.type === "prompt") {
      for (const event of [
        { type: "agent_start" },
        { type: "message_start", message: { role: "assistant", content: [] } },
        {
          type: "message_update",
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "Live unified server reply.",
          },
        },
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Live unified server reply." }],
          },
        },
        { type: "agent_end", messages: [], willRetry: false },
        { type: "agent_settled" },
      ]) {
        process.stdout.write(`${JSON.stringify(event)}\n`)
      }
    }
  }
})
