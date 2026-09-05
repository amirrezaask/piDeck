/** Paced output never catches up with a burst after a delayed write. Input echo
 * bypasses the output cadence so the fixture does not add a frame of latency.
 */
export function terminalLoadProgram(
  rate: number,
  burstBytes: number,
  durationSeconds: number,
): string {
  if (
    !Number.isInteger(rate) ||
    rate < 0 ||
    !Number.isInteger(burstBytes) ||
    (burstBytes !== 0 && burstBytes < 32) ||
    burstBytes > 65536 ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  )
    throw new Error("Invalid terminal load fixture parameters")
  return [
    "import os, sys, time, tty, termios, select",
    "fd = sys.stdin.fileno()",
    "old = termios.tcgetattr(fd)",
    "echo = 'UF'",
    "seen = 0",
    "unit = '\\x1b[2;1H\\x1b[31m0123456789\\x1b[0m'",
    `block = unit * (${burstBytes} // len(unit))`,
    `rate = ${rate}`,
    "def emit(text):",
    "    sys.stdout.write(text)",
    "    sys.stdout.flush()",
    "try:",
    "    tty.setcbreak(fd)",
    `    end = time.monotonic() + ${durationSeconds}`,
    "    next_write = time.monotonic() if block else end",
    "    emit('\\x1b[2J\\x1b[1;1H' + echo)",
    "    while time.monotonic() < end:",
    "        wait = max(0, min(next_write, end) - time.monotonic()) if rate or not block else 0",
    "        if select.select([fd], [], [], wait)[0]:",
    "            for character in os.read(fd, 1024):",
    "                seen += 1",
    "                echo = 'UF' + str(seen) + ':' + chr(character)",
    "            emit('\\x1b[1;1H' + echo)",
    "        if block and time.monotonic() >= next_write:",
    "            emit(block + '\\x1b[1;1H' + echo)",
    "            next_write = time.monotonic() + len(block) / rate if rate else 0",
    "finally:",
    "    termios.tcsetattr(fd, termios.TCSADRAIN, old)",
    // Split the marker so shell command echo cannot satisfy the completion fence.
    "    emit('\\x1b[2J\\x1b[1;1H' + 'LOAD-' + 'DONE\\r\\n')",
  ].join("\n")
}
