import { createHash } from "node:crypto"

export type TerminalCorpus = {
  readonly id: string
  readonly bytes: Uint8Array
  readonly sha256: string
  readonly scenarioEvents: number
}

type CorpusSpec = {
  readonly id: string
  readonly size: number
  readonly unit: string
  readonly sha256: string
  readonly scenarioEvents: number
}

const CORPUS_SPECS: readonly CorpusSpec[] = [
  {
    id: "ascii-log-512k-v1",
    size: 512 * 1024,
    unit: "INFO worker=3 phase=parse elapsed=12ms status=ok\r\n",
    sha256: "d27304cf241718eace862dc8396c6cff2f10541bb68b381576882f3f09985d35",
    scenarioEvents: 10_486,
  },
  {
    id: "unicode-wide-512k-v1",
    size: 512 * 1024,
    unit: "cafe\u0301 · 東京 · 👩🏽‍💻 · مرحبا · Ελληνικά\r\n",
    sha256: "f59ed322238b9c6b7982d0f4cb9fa7ddfef326f53d6b6ff11262de7241885d4e",
    scenarioEvents: 7_385,
  },
  {
    id: "ansi-control-512k-v1",
    size: 512 * 1024,
    unit: "\u001b[38;2;80;160;240mrow\u001b[0m\u001b[2K\rprogress 0042\n",
    sha256: "9e58dd789cc55d18d5c7e960b69d48e0d9711f80b22513eeed407750bce3a4ba",
    scenarioEvents: 11_916,
  },
  {
    id: "synchronized-tui-256k-v1",
    size: 256 * 1024,
    unit: "\u001b[?2026h\u001b[H\u001b[2Jcpu 42%\r\nmem 512M\u001b[?2026l",
    sha256: "f01a41d0bfa439e768a04f07687e231efe48c1a47bfe9732019fdfd7a8ab2489",
    scenarioEvents: 6_554,
  },
  {
    id: "replay-16m-v1",
    size: 16 * 1024 * 1024,
    unit: "replay-sequence=0000000000000000 payload=xxxxxxxxxxxxxxxx\r\n",
    sha256: "f4043d3515efc896136e9f56b593f54ab7a28055266579e0ef33d3d8132e5ba3",
    scenarioEvents: 284_360,
  },
  {
    id: "contention-background-1m-v1",
    size: 1024 * 1024,
    unit: "background-build-output xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\r\n",
    sha256: "973ed099840bcd9202e035d0b2e674beb4965e75b18e3a5577919292e059e713",
    scenarioEvents: 15_888,
  },
]

function materialize(spec: CorpusSpec): Uint8Array {
  const unit = Buffer.from(spec.unit, "utf8")
  if (spec.scenarioEvents !== Math.ceil(spec.size / unit.length)) {
    throw new Error(`terminal corpus ${spec.id} event count is stale`)
  }
  const bytes = Buffer.allocUnsafe(spec.size)
  for (let offset = 0; offset < bytes.length; offset += unit.length) {
    unit.copy(bytes, offset, 0, Math.min(unit.length, bytes.length - offset))
  }
  return bytes
}

export const TERMINAL_CORPORA: readonly TerminalCorpus[] = CORPUS_SPECS.map(spec => ({
  id: spec.id,
  bytes: materialize(spec),
  sha256: spec.sha256,
  scenarioEvents: spec.scenarioEvents,
}))

export type TerminalCorpusManifestEntry = Omit<TerminalCorpus, "bytes"> & {
  readonly size: number
}

export function validateTerminalCorpora(): readonly TerminalCorpusManifestEntry[] {
  return TERMINAL_CORPORA.map(corpus => {
    const digest = createHash("sha256").update(corpus.bytes).digest("hex")
    if (digest !== corpus.sha256) {
      throw new Error(`terminal corpus ${corpus.id} hash mismatch: ${digest}`)
    }
    return {
      id: corpus.id,
      size: corpus.bytes.byteLength,
      sha256: corpus.sha256,
      scenarioEvents: corpus.scenarioEvents,
    }
  })
}
