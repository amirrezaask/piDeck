import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../tests/fixtures/terminal-corpus/", import.meta.url))
const encoder = new TextEncoder()
const text = (value) => encoder.encode(value)
const bytes = (...values) => Uint8Array.from(values)
const join = (...parts) => {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

const theme = (foreground, background, cursor) => ({ foreground, background, cursor })
const dark = theme(
  { r: 226, g: 232, b: 240 },
  { r: 15, g: 23, b: 42 },
  { r: 251, g: 191, b: 36 },
)
const light = theme(
  { r: 30, g: 41, b: 59 },
  { r: 248, g: 250, b: 252 },
  { r: 190, g: 24, b: 93 },
)

const fixtures = [
  {
    id: "ascii-styles",
    purpose: "ASCII shell output, long runs, SGR colors and decorations, OSC metadata, hyperlinks, and safe clipboard policy",
    initial: { columns: 40, rows: 10, cellWidth: 8, cellHeight: 16, scrollback: 128, defaultCursorBlink: true, theme: dark },
    schedule: [
      text("build: start\r\n"),
      text("\u001b[1;3;4;9;53;38;2;12;34;56;48;5;196mstyled"),
      text("\u001b[0m plain\r\n"),
      text("0123456789".repeat(9)),
      text("\r\n"),
      text("\u001b]2;YAADE corpus\u0007"),
      text("\u001b]7;file:///tmp/yaade\u001b\\"),
      text("\u001b]8;;https://example.invalid/corpus\u001b\\link\u001b]8;;\u001b\\"),
      text("\u001b]52;c;bm90LXNlY3JldA==\u0007"),
      text("\r\ndone"),
      { observe: "final" },
    ],
  },
  {
    id: "unicode-malformed",
    purpose: "Split UTF-8, malformed bytes, NUL/C0/C1 controls, wide and combining grapheme clusters, ZWJ, and variation selectors",
    initial: { columns: 24, rows: 8, cellWidth: 9, cellHeight: 18, scrollback: 64, defaultCursorBlink: true, theme: dark },
    schedule: [
      text("split:"),
      bytes(0xf0), bytes(0x9f), bytes(0x98), bytes(0x80),
      text(" invalid:"), bytes(0xff, 0xfe),
      bytes(0x00), text(" c0:"), bytes(0x07),
      text(" c1:"), bytes(0x9b), text("31mR\u001b[0m"),
      text("\r\nwide:界 e\u0301 \u2764\ufe0f \ud83d\udc69\u200d\ud83d\udcbb"),
      { observe: "final" },
    ],
  },
  {
    id: "modes-queries",
    purpose: "Primary and alternate screens, DEC modes, mouse/focus/paste/Kitty keyboard flags, synchronized output, and terminal queries",
    initial: { columns: 36, rows: 9, cellWidth: 8, cellHeight: 17, scrollback: 96, defaultCursorBlink: true, theme: dark },
    schedule: [
      text("primary\r\n"),
      text("\u001b[?1h\u001b[?25l\u001b[?1000h\u001b[?1003h\u001b[?1004h\u001b[?1006h\u001b[?2004h"),
      text("\u001b[>1u\u001b[?2026hSYNC\u001b[?2026l"),
      text("\u001b[c\u001b[>c\u001b[6n\u001b[?2004$p"),
      text("\u001b[14t\u001b[18t\u001b]10;?\u0007\u001b]11;?\u0007\u001b]4;1;?\u0007"),
      text("\u001b[?1049hALT\u001b[2;3Hscreen"),
      { observe: "alternate" },
      text("\u001b[?1049lback"),
      { observe: "final" },
    ],
  },
  {
    id: "resize-reset-theme",
    purpose: "Resize, reset, and theme mutations interleaved with deliberately split escape sequences",
    initial: { columns: 18, rows: 6, cellWidth: 8, cellHeight: 16, scrollback: 32, defaultCursorBlink: true, theme: dark },
    schedule: [
      text("before \u001b[38;2;"),
      { resize: { columns: 26, rows: 7, cellWidth: 10, cellHeight: 20 } },
      text("120;80;40mcolor\u001b[0m"),
      { theme: light },
      text("\r\nafter-theme"),
      { observe: "before-reset" },
      { reset: true },
      text("reset-ok\u001b[4m!\u001b[0m"),
      { observe: "final" },
    ],
  },
  {
    id: "editing-reflow-scrollback",
    purpose: "Scroll regions, insert/delete operations, wrapping, reflow, and explicit viewport scroll metadata",
    initial: { columns: 16, rows: 5, cellWidth: 8, cellHeight: 16, scrollback: 64, defaultCursorBlink: true, theme: dark },
    schedule: [
      text("one two three four five six seven\r\n"),
      text("line-2\r\nline-3\r\nline-4\r\nline-5\r\nline-6\r\n"),
      text("\u001b[2;4r\u001b[3;1Hregion\u001b[LINS\u001b[M\u001b[r"),
      text("\u001b[2;2H\u001b[@X\u001b[P"),
      { resize: { columns: 12, rows: 6, cellWidth: 8, cellHeight: 16 } },
      { scroll: "top" },
      { observe: "history-top" },
      { scroll: "bottom" },
      { observe: "final" },
    ],
  },
  {
    id: "complex-tui",
    purpose: "Deterministic full-screen TUI rewrites with borders, progress updates, cursor moves, and alternate-screen lifecycle",
    initial: { columns: 42, rows: 12, cellWidth: 8, cellHeight: 16, scrollback: 128, defaultCursorBlink: true, theme: dark },
    schedule: [
      text("\u001b[?1049h\u001b[2J\u001b[H"),
      text("┌────────────────────────────────────────┐"),
      text("\u001b[2;1H│ YAADE deterministic dashboard          │"),
      text("\u001b[3;1H│ task-a  [#####-----]  50%             │"),
      text("\u001b[4;1H│ task-b  [##--------]  20%             │"),
      text("\u001b[5;1H│ status: running                       │"),
      text("\u001b[6;1H└────────────────────────────────────────┘"),
      text("\u001b[3;12H########--\u001b[3;25H80%"),
      text("\u001b[4;12H######----\u001b[4;25H60%"),
      text("\u001b[5;11Hcomplete"),
      { observe: "alternate" },
      text("\u001b[?1049lTUI exited"),
      { observe: "final" },
    ],
  },
]

const modes = [
  { number: 1, ansi: false },
  { number: 4, ansi: true },
  { number: 25, ansi: false },
  { number: 1000, ansi: false },
  { number: 1002, ansi: false },
  { number: 1003, ansi: false },
  { number: 1004, ansi: false },
  { number: 1006, ansi: false },
  { number: 1049, ansi: false },
  { number: 2004, ansi: false },
  { number: 2026, ansi: false },
  { number: 2048, ansi: false },
]

await mkdir(root, { recursive: true })
await mkdir(`${root}/assertions`, { recursive: true })
const manifestFixtures = []
for (const fixture of fixtures) {
  const parts = []
  const events = []
  let offset = 0
  for (const item of fixture.schedule) {
    if (item instanceof Uint8Array) {
      parts.push(item)
      events.push({ type: "write", offset, length: item.length })
      offset += item.length
    } else if ("observe" in item) {
      events.push({ type: "observe", id: item.observe })
    } else if ("resize" in item) {
      events.push({ type: "resize", ...item.resize })
    } else if ("theme" in item) {
      events.push({ type: "theme", theme: item.theme })
    } else if ("reset" in item) {
      events.push({ type: "reset" })
    } else if ("scroll" in item) {
      events.push({ type: "scroll", position: item.scroll })
    }
  }
  const payload = join(...parts)
  const file = `${fixture.id}.bin`
  await writeFile(`${root}/${file}`, payload)
  manifestFixtures.push({
    id: fixture.id,
    purpose: fixture.purpose,
    bytes: {
      path: file,
      length: payload.length,
      sha256: createHash("sha256").update(payload).digest("hex"),
    },
    initial: {
      ...fixture.initial,
      host: {
        enquiryBase64: "",
        xtversionBase64: "",
        colorScheme: null,
        deviceAttributes: null,
      },
    },
    assertions: `assertions/${fixture.id}.json`,
    events,
  })
}

const manifest = {
  formatVersion: 1,
  normalizerVersion: 1,
  limits: {
    maxFixtureBytes: 1_048_576,
    maxColumns: 256,
    maxRows: 128,
    maxEvents: 10_000,
    maxEffectsBytes: 1_048_576,
    maxObservationBytes: 16_777_216,
  },
  modes,
  fixtures: manifestFixtures,
}
await writeFile(`${root}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`generated ${manifestFixtures.length} Ghostty corpus fixtures in ${root}`)
