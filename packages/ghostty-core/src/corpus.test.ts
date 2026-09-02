import { strict as assert } from "node:assert"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "vite-plus/test"
import {
  CORPUS_FORMAT_VERSION,
  CORPUS_NORMALIZER_VERSION,
  corpusRoot,
  loadTerminalCorpus,
  validateCorpusResult,
} from "./corpus.js"

async function withCorpusCopy(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "yaade-ghostty-corpus-"))
  try {
    await cp(corpusRoot(), root, { recursive: true })
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function rewriteManifest(root: string, replace: (source: string) => string): Promise<void> {
  const manifestPath = path.join(root, "manifest.json")
  await writeFile(manifestPath, replace(await readFile(manifestPath, "utf8")))
}

test("loads one bounded deterministic binary corpus", async () => {
  const corpus = await loadTerminalCorpus()
  assert.equal(corpus.manifest.formatVersion, CORPUS_FORMAT_VERSION)
  assert.equal(corpus.manifest.normalizerVersion, CORPUS_NORMALIZER_VERSION)
  assert.equal(corpus.fixtures.length, 6)
  assert.deepEqual(corpus.fixtures.map((fixture) => fixture.definition.id), [
    "ascii-styles",
    "unicode-malformed",
    "modes-queries",
    "resize-reset-theme",
    "editing-reflow-scrollback",
    "complex-tui",
  ])
  for (const fixture of corpus.fixtures) {
    const writes = fixture.definition.events.filter((event) => event.type === "write")
    assert.ok(writes.length > 1, `${fixture.definition.id} preserves multiple write chunks`)
    assert.equal(writes.reduce((total, event) => total + event.length, 0), fixture.payload.byteLength)
  }
})

test("rejects traversal, invalid hashes, duplicate IDs, unbounded dimensions, and malformed schedules", async () => {
  const cases = [
    {
      name: "path traversal",
      replace: (source: string) => source.replace('"path": "ascii-styles.bin"', '"path": "../ascii-styles.bin"'),
      message: /invalid byte path|permitted corpus-relative path/,
    },
    {
      name: "invalid hash syntax",
      replace: (source: string) => source.replace(/"sha256": "[0-9a-f]{64}"/, '"sha256": "not-a-hash"'),
      message: /invalid SHA-256/,
    },
    {
      name: "wrong hash",
      replace: (source: string) => source.replace(/"sha256": "[0-9a-f]{64}"/, `"sha256": "${"0".repeat(64)}"`),
      message: /SHA-256 mismatch/,
    },
    {
      name: "duplicate ID",
      replace: (source: string) => source.replace('"id": "unicode-malformed"', '"id": "ascii-styles"'),
      message: /duplicate fixture id/,
    },
    {
      name: "unbounded dimensions",
      replace: (source: string) => source.replace('"columns": 40', '"columns": 4096'),
      message: /columns must be an integer/,
    },
    {
      name: "malformed chunk schedule",
      replace: (source: string) => source.replace('"offset": 0', '"offset": 1'),
      message: /malformed chunk schedule/,
    },
    {
      name: "unknown event",
      replace: (source: string) => source.replace('"type": "write"', '"type": "unknown"'),
      message: /type|union/,
    },
  ]
  for (const item of cases) {
    await withCorpusCopy(async (root) => {
      await rewriteManifest(root, item.replace)
      await assert.rejects(loadTerminalCorpus(root), item.message, item.name)
    })
  }
})

test("rejects oversized and malformed observations before comparison", async () => {
  const corpus = await loadTerminalCorpus()
  assert.throws(
    () => validateCorpusResult(" ".repeat(corpus.manifest.limits.maxObservationBytes + 1), corpus.manifest),
    /oversized/,
  )
  assert.throws(
    () => validateCorpusResult('{"normalizerVersion":1}', corpus.manifest),
    /revision|runner|fixtures/,
  )
})
