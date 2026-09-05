import { spawnSync } from "node:child_process"
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { terminalLoadProgram } from "./terminal-load-fixture.ts"

const pythonAvailable =
  process.platform !== "win32" && spawnSync("python3", ["--version"]).status === 0

it("rejects invalid fixture bounds", () => {
  for (const [rate, burst, duration] of [
    [-1, 32, 1],
    [1, 65537, 1],
    [1, 8, 1],
    [1, 32, 0],
  ])
    assert.throws(() => terminalLoadProgram(rate, burst, duration))
})

describe("real PTY fixture", { skip: !pythonAvailable }, () => {
  for (const [label, rate, burst] of [
    ["idle", 0, 0],
    ["paced", 524288, 16384],
    ["unpaced", 0, 65536],
  ]) {
    it(`${label} echoes a unique key and terminates with its completion marker`, () => {
      const harness = `
import errno, os, pty, select, subprocess, sys, time
program = sys.stdin.read()
master, slave = pty.openpty()
child = subprocess.Popen([sys.executable, '-c', program], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
output = bytearray()
total = 0
sent = False
echoed = False
try:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.1)[0]:
            continue
        try:
            data = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not data:
            break
        total += len(data)
        output.extend(data)
        del output[:-65536]
        echoed = echoed or b'UF1:q' in output
        if not sent and b'\\x1b[1;1HUF' in output:
            os.write(master, b'q')
            sent = True
        if b'LOAD-DONE' in output:
            break
    assert sent, 'fixture never became ready'
    assert echoed, 'missing unique key echo'
    assert b'LOAD-DONE' in output, 'missing completion marker'
    assert child.wait(timeout=1) == 0, output[-2048:]
    print(total)
finally:
    child.kill() if child.poll() is None else None
    child.wait()
    os.close(master)
`
      const result = spawnSync("python3", ["-c", harness], {
        input: terminalLoadProgram(rate, burst, 0.5),
        encoding: "utf8",
        timeout: 7000,
      })
      assert.equal(result.stderr, "")
      assert.equal(result.status, 0)
      if (rate > 0) {
        const bytes = Number(result.stdout.trim())
        assert.ok(bytes > rate * 0.5 * 0.8 - burst * 2)
        assert.ok(bytes < rate * 0.5 * 1.1 + burst * 2)
      }
    })
  }
})
