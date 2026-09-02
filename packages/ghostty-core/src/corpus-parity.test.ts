import { strict as assert } from "node:assert"
import { readFile, stat } from "node:fs/promises"
import { test } from "vite-plus/test"
import {
  CORPUS_NORMALIZER_VERSION,
  CorpusResult,
  compareCorpusResults,
  encodeCorpusBytes,
  loadTerminalCorpus,
  validateCorpusResult,
  type CorpusRunnerResult,
} from "./corpus.js"

const nativePath = process.env.YAADE_GHOSTTY_NATIVE_OBSERVATION
const wasmPath = process.env.YAADE_GHOSTTY_WASM_OBSERVATION

async function readObservation(path: string, maximum: number): Promise<string> {
  const info = await stat(path)
  if (!info.isFile() || info.size > maximum) throw new Error(`observation file is oversized: ${path}`)
  return readFile(path, "utf8")
}

test.skipIf(!nativePath || !wasmPath)("native and WASM Ghostty observations match exactly", async () => {
  if (!nativePath || !wasmPath) throw new Error("parity paths disappeared after test registration")
  const corpus = await loadTerminalCorpus()
  const native = validateCorpusResult(
    await readObservation(nativePath, corpus.manifest.limits.maxObservationBytes),
    corpus.manifest,
  )
  const wasm = validateCorpusResult(
    await readObservation(wasmPath, corpus.manifest.limits.maxObservationBytes),
    corpus.manifest,
  )
  assert.equal(native.runner, "native")
  assert.equal(wasm.runner, "wasm")
  compareCorpusResults(native, wasm)
})

function comparatorFixture(options?: {
  readonly revision?: string
  readonly styleBold?: boolean
  readonly modeEnabled?: boolean
  readonly effectBytes?: Uint8Array
  readonly reverseEffects?: boolean
  readonly runner?: "native" | "wasm"
}): CorpusRunnerResult {
  const firstEffect = {
    eventIndex: 0,
    callbackIndex: 0,
    bytes: encodeCorpusBytes(options?.effectBytes ?? Uint8Array.of(0x1b, 0x5b, 0x30, 0x6e)),
  }
  const secondEffect = {
    eventIndex: 0,
    callbackIndex: 1,
    bytes: encodeCorpusBytes(Uint8Array.of(0x4f, 0x4b)),
  }
  const effects = options?.reverseEffects ? [secondEffect, firstEffect] : [firstEffect, secondEffect]
  return CorpusResult.make({
    normalizerVersion: CORPUS_NORMALIZER_VERSION,
    revision: options?.revision ?? "9f62873bf195e4d8a762d768a1405a5f2f7b1697",
    runner: options?.runner ?? "native",
    fixtures: [{
      id: "comparator-self-test",
      sourceLength: 1,
      sourceSha256: "00".repeat(32),
      observations: [{
        id: "final",
        eventIndex: 0,
        state: {
          columns: 1,
          rows: 1,
          widthPixels: 8,
          heightPixels: 16,
          activeScreen: "primary",
          alternateScreen: false,
          totalRows: 1,
          scrollbackRows: 0,
          viewportActive: true,
          scrollbar: { total: 1, offset: 0, length: 1 },
          kittyKeyboardFlags: 0,
          title: encodeCorpusBytes(new Uint8Array()),
          workingDirectory: encodeCorpusBytes(new Uint8Array()),
        },
        renderColors: {
          foreground: { r: 255, g: 255, b: 255 },
          background: { r: 0, g: 0, b: 0 },
          cursor: null,
          palette: Array.from({ length: 256 }, () => ({ r: 0, g: 0, b: 0 })),
        },
        cursor: {
          column: 0,
          row: 0,
          pendingWrap: false,
          visible: true,
          renderStyle: "block",
          blinking: true,
          passwordInput: false,
          viewportPosition: { column: 0, row: 0 },
          wideTail: false,
        },
        modes: [{ number: 2004, ansi: false, enabled: options?.modeEnabled ?? true }],
        rows: [{
          index: 0,
          wrapsToNext: false,
          isWrapContinuation: false,
          semanticPrompt: "none",
          selection: null,
          cells: [{
            column: 0,
            grapheme: encodeCorpusBytes(Uint8Array.of(0x41)),
            width: "narrow",
            semanticContent: "output",
            style: {
              foreground: { r: 255, g: 255, b: 255 },
              background: { r: 0, g: 0, b: 0 },
              foregroundSource: { kind: "none" },
              backgroundSource: { kind: "none" },
              underlineColorSource: { kind: "none" },
              bold: options?.styleBold ?? false,
              italic: false,
              faint: false,
              blink: false,
              inverse: false,
              invisible: false,
              strikethrough: false,
              overline: false,
              underline: "none",
            },
            selected: false,
          }],
        }],
        effects,
      }],
    }],
  })
}

test("comparator rejects revision, style, mode, response-byte, and callback-order mismatches", () => {
  const native = comparatorFixture()
  assert.throws(
    () => compareCorpusResults(native, comparatorFixture({ runner: "wasm", revision: "0".repeat(40) })),
    /revision mismatch.*native=.*wasm=/,
  )
  assert.throws(
    () => compareCorpusResults(native, comparatorFixture({ runner: "wasm", styleBold: true })),
    /fixture comparator-self-test observation final event 0 row 0 cell 0.*native=.*wasm=/,
  )
  assert.throws(
    () => compareCorpusResults(native, comparatorFixture({ runner: "wasm", modeEnabled: false })),
    /mode DEC 2004.*native=.*wasm=/,
  )
  assert.throws(
    () => compareCorpusResults(native, comparatorFixture({ runner: "wasm", effectBytes: Uint8Array.of(0x1b, 0x5b, 0x31, 0x6e) })),
    /effect 0 byte offset 2: native=48 wasm=49/,
  )
  assert.throws(
    () => compareCorpusResults(native, comparatorFixture({ runner: "wasm", reverseEffects: true })),
    /effect 0 metadata.*native=.*wasm=/,
  )
})
