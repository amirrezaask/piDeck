import { Buffer } from "node:buffer"

/** Deterministic alternate-screen dashboard used by renderer and resize benches. */
export function terminalDashboardCommand(options: {
  readonly marker: string
  readonly hz: 10 | 30 | 60
  readonly seconds: number
  readonly fullRedraw?: boolean
  readonly synchronized?: boolean
}): string {
  const payload = JSON.stringify({
    hz: options.hz,
    seconds: options.seconds,
    full: options.fullRedraw ?? false,
    sync: options.synchronized ?? true,
  })
  const python = [
    "import json, os, sys, time",
    `o=json.loads(${JSON.stringify(payload)})`,
    `marker=${JSON.stringify(options.marker.slice(0, Math.floor(options.marker.length / 2)))}+${JSON.stringify(options.marker.slice(Math.floor(options.marker.length / 2)))}`,
    "hz=o['hz']; frames=max(1,int(hz*o['seconds']))",
    "sys.stdout.write('\\x1b[?1049h\\x1b[?25l')",
    "for i in range(frames):",
    "  if o['sync']: sys.stdout.write('\\x1b[?2026h')",
    "  if o['full']: sys.stdout.write('\\x1b[2J')",
    "  sys.stdout.write('\\x1b[H\\x1b[1;36m┌─ YAADE renderer corpus ───────────────┐\\x1b[0m')",
    "  sys.stdout.write('\\x1b[2;1H│ frame %06d  rate %02d Hz              │' % (i,hz))",
    "  sys.stdout.write('\\x1b[3;1H│ \\x1b[4munderline\\x1b[0m \\x1b[9mstrike\\x1b[0m 界 é 👩‍💻 │')",
    "  sys.stdout.write('\\x1b[4;1H│ \\x1b[38;2;255;120;80mtruecolor\\x1b[0m  █▓▒░ %03d%%           │' % (i%101))",
    "  sys.stdout.write('\\x1b[5;1H└───────────────────────────────────────┘')",
    "  if o['sync']: sys.stdout.write('\\x1b[?2026l')",
    "  sys.stdout.flush(); time.sleep(1/hz)",
    "sys.stdout.write('\\x1b[?25h\\x1b[?1049l\\r\\n'+marker+'\\r\\n'); sys.stdout.flush()",
  ].join("\n")
  const encoded = Buffer.from(python, "utf8").toString("base64")
  return `python3 -c "import base64;exec(base64.b64decode('${encoded}'))"\n`
}
