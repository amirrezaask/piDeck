import { createHash } from "node:crypto"
import { readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"

export const CORPUS_FORMAT_VERSION = 1
export const CORPUS_NORMALIZER_VERSION = 1
export const CORPUS_HARD_LIMITS = {
  fixtureBytes: 1_048_576,
  fixtures: 64,
  columns: 256,
  rows: 128,
  cellPixels: 4_096,
  scrollback: 100_000,
  events: 10_000,
  observations: 128,
  effectsBytes: 1_048_576,
  observationBytes: 16_777_216,
} as const

const RgbSchema = Schema.Struct({ r: Schema.Number, g: Schema.Number, b: Schema.Number })
const ThemeSchema = Schema.Struct({
  foreground: RgbSchema,
  background: RgbSchema,
  cursor: RgbSchema,
})
const DeviceAttributesSchema = Schema.Struct({
  primaryConformanceLevel: Schema.Number,
  primaryFeatures: Schema.Array(Schema.Number),
  secondaryDeviceType: Schema.Number,
  secondaryFirmwareVersion: Schema.Number,
  secondaryRomCartridge: Schema.Number,
  tertiaryUnitId: Schema.Number,
})
const HostOptionsSchema = Schema.Struct({
  enquiryBase64: Schema.String,
  xtversionBase64: Schema.String,
  colorScheme: Schema.NullOr(Schema.Literal("light", "dark")),
  deviceAttributes: Schema.NullOr(DeviceAttributesSchema),
})
const InitialOptionsSchema = Schema.Struct({
  columns: Schema.Number,
  rows: Schema.Number,
  cellWidth: Schema.Number,
  cellHeight: Schema.Number,
  scrollback: Schema.Number,
  defaultCursorBlink: Schema.Boolean,
  theme: ThemeSchema,
  host: HostOptionsSchema,
})
const WriteEventSchema = Schema.Struct({
  type: Schema.Literal("write"),
  offset: Schema.Number,
  length: Schema.Number,
})
const ResizeEventSchema = Schema.Struct({
  type: Schema.Literal("resize"),
  columns: Schema.Number,
  rows: Schema.Number,
  cellWidth: Schema.Number,
  cellHeight: Schema.Number,
})
const ResetEventSchema = Schema.Struct({ type: Schema.Literal("reset") })
const ThemeEventSchema = Schema.Struct({ type: Schema.Literal("theme"), theme: ThemeSchema })
const ScrollEventSchema = Schema.Struct({
  type: Schema.Literal("scroll"),
  position: Schema.Literal("top", "bottom"),
})
const ObserveEventSchema = Schema.Struct({ type: Schema.Literal("observe"), id: Schema.String })
export const CorpusEventSchema = Schema.Union(
  WriteEventSchema,
  ResizeEventSchema,
  ResetEventSchema,
  ThemeEventSchema,
  ScrollEventSchema,
  ObserveEventSchema,
)
const ModeSpecSchema = Schema.Struct({ number: Schema.Number, ansi: Schema.Boolean })
const FixtureSchema = Schema.Struct({
  id: Schema.String,
  purpose: Schema.String,
  bytes: Schema.Struct({ path: Schema.String, length: Schema.Number, sha256: Schema.String }),
  initial: InitialOptionsSchema,
  assertions: Schema.String,
  events: Schema.Array(CorpusEventSchema),
})
export class CorpusManifest extends Schema.Class<CorpusManifest>("CorpusManifest")({
  formatVersion: Schema.Literal(CORPUS_FORMAT_VERSION),
  normalizerVersion: Schema.Literal(CORPUS_NORMALIZER_VERSION),
  limits: Schema.Struct({
    maxFixtureBytes: Schema.Number,
    maxColumns: Schema.Number,
    maxRows: Schema.Number,
    maxEvents: Schema.Number,
    maxEffectsBytes: Schema.Number,
    maxObservationBytes: Schema.Number,
  }),
  modes: Schema.Array(ModeSpecSchema),
  fixtures: Schema.Array(FixtureSchema),
}) {}

const EncodedBytesSchema = Schema.Struct({
  base64: Schema.String,
  length: Schema.Number,
  sha256: Schema.String,
})
const StyleColorSchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("palette"), index: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("rgb"), color: RgbSchema }),
)
const StyleSchema = Schema.Struct({
  foreground: RgbSchema,
  background: RgbSchema,
  foregroundSource: StyleColorSchema,
  backgroundSource: StyleColorSchema,
  underlineColorSource: StyleColorSchema,
  bold: Schema.Boolean,
  italic: Schema.Boolean,
  faint: Schema.Boolean,
  blink: Schema.Boolean,
  inverse: Schema.Boolean,
  invisible: Schema.Boolean,
  strikethrough: Schema.Boolean,
  overline: Schema.Boolean,
  underline: Schema.Literal("none", "single", "double", "curly", "dotted", "dashed"),
})
const CellSchema = Schema.Struct({
  column: Schema.Number,
  grapheme: EncodedBytesSchema,
  width: Schema.Literal("narrow", "wide", "spacer-tail", "spacer-head"),
  semanticContent: Schema.Literal("output", "input", "prompt"),
  style: StyleSchema,
  selected: Schema.Boolean,
})
const RowSchema = Schema.Struct({
  index: Schema.Number,
  wrapsToNext: Schema.Boolean,
  isWrapContinuation: Schema.Boolean,
  semanticPrompt: Schema.Literal("none", "prompt", "continuation"),
  selection: Schema.NullOr(Schema.Struct({ start: Schema.Number, end: Schema.Number })),
  cells: Schema.Array(CellSchema),
})
const CursorSchema = Schema.Struct({
  column: Schema.Number,
  row: Schema.Number,
  pendingWrap: Schema.Boolean,
  visible: Schema.Boolean,
  renderStyle: Schema.Literal("bar", "block", "underline", "hollow-block"),
  blinking: Schema.Boolean,
  passwordInput: Schema.Boolean,
  viewportPosition: Schema.NullOr(Schema.Struct({ column: Schema.Number, row: Schema.Number })),
  wideTail: Schema.Boolean,
})
const TerminalStateSchema = Schema.Struct({
  columns: Schema.Number,
  rows: Schema.Number,
  widthPixels: Schema.Number,
  heightPixels: Schema.Number,
  activeScreen: Schema.Literal("primary", "alternate"),
  alternateScreen: Schema.Boolean,
  totalRows: Schema.Number,
  scrollbackRows: Schema.Number,
  viewportActive: Schema.Boolean,
  scrollbar: Schema.Struct({ total: Schema.Number, offset: Schema.Number, length: Schema.Number }),
  kittyKeyboardFlags: Schema.Number,
  title: EncodedBytesSchema,
  workingDirectory: EncodedBytesSchema,
})
const ModeObservationSchema = Schema.Struct({
  number: Schema.Number,
  ansi: Schema.Boolean,
  enabled: Schema.Boolean,
})
const EffectObservationSchema = Schema.Struct({
  eventIndex: Schema.Number,
  callbackIndex: Schema.Number,
  bytes: EncodedBytesSchema,
})
export const CorpusObservationSchema = Schema.Struct({
  id: Schema.String,
  eventIndex: Schema.Number,
  state: TerminalStateSchema,
  renderColors: Schema.Struct({
    foreground: RgbSchema,
    background: RgbSchema,
    cursor: Schema.NullOr(RgbSchema),
    palette: Schema.Array(RgbSchema),
  }),
  cursor: CursorSchema,
  modes: Schema.Array(ModeObservationSchema),
  rows: Schema.Array(RowSchema),
  effects: Schema.Array(EffectObservationSchema),
})
const FixtureResultSchema = Schema.Struct({
  id: Schema.String,
  sourceLength: Schema.Number,
  sourceSha256: Schema.String,
  observations: Schema.Array(CorpusObservationSchema),
})
export class CorpusResult extends Schema.Class<CorpusResult>("CorpusResult")({
  normalizerVersion: Schema.Literal(CORPUS_NORMALIZER_VERSION),
  revision: Schema.String,
  runner: Schema.Literal("native", "wasm"),
  fixtures: Schema.Array(FixtureResultSchema),
}) {}

const CellAssertionSchema = Schema.Struct({
  row: Schema.Number,
  column: Schema.Number,
  graphemeBase64: Schema.String,
  width: Schema.optional(CellSchema.fields.width),
  style: Schema.optional(StyleSchema),
})
const RowAssertionSchema = Schema.Struct({
  row: Schema.Number,
  wrapsToNext: Schema.Boolean,
  isWrapContinuation: Schema.Boolean,
})
const PaletteAssertionSchema = Schema.Struct({
  index: Schema.Number,
  color: RgbSchema,
})
const ModeAssertionSchema = Schema.Struct({
  number: Schema.Number,
  ansi: Schema.Boolean,
  enabled: Schema.Boolean,
})
const EffectAssertionSchema = Schema.Struct({
  eventIndex: Schema.Number,
  callbackIndex: Schema.Number,
  base64: Schema.String,
})
const ObservationAssertionSchema = Schema.Struct({
  id: Schema.String,
  titleBase64: Schema.optional(Schema.String),
  workingDirectoryBase64: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.Struct({ column: Schema.Number, row: Schema.Number })),
  activeScreen: Schema.optional(Schema.Literal("primary", "alternate")),
  dimensions: Schema.optional(Schema.Struct({
    columns: Schema.Number,
    rows: Schema.Number,
    widthPixels: Schema.Number,
    heightPixels: Schema.Number,
  })),
  scrollbar: Schema.optional(Schema.Struct({ total: Schema.Number, offset: Schema.Number, length: Schema.Number })),
  kittyKeyboardFlags: Schema.optional(Schema.Number),
  rows: Schema.Array(RowAssertionSchema),
  cells: Schema.Array(CellAssertionSchema),
  palette: Schema.Array(PaletteAssertionSchema),
  modes: Schema.Array(ModeAssertionSchema),
  effects: Schema.Array(EffectAssertionSchema),
})
export class CorpusAssertions extends Schema.Class<CorpusAssertions>("CorpusAssertions")({
  fixtureId: Schema.String,
  observations: Schema.Array(ObservationAssertionSchema),
}) {}

export type CorpusFixture = CorpusManifest["fixtures"][number]
export type CorpusEvent = typeof CorpusEventSchema.Type
export type CorpusObservation = typeof CorpusObservationSchema.Type
export type CorpusModeSpec = CorpusManifest["modes"][number]
export type CorpusTheme = CorpusFixture["initial"]["theme"]
export type CorpusRunnerResult = CorpusResult

export interface LoadedCorpusFixture {
  readonly definition: CorpusFixture
  readonly payload: Uint8Array
  readonly assertions: CorpusAssertions
}

export interface LoadedCorpus {
  readonly root: string
  readonly manifest: CorpusManifest
  readonly fixtures: readonly LoadedCorpusFixture[]
}

const strictDecodeOptions = { onExcessProperty: "error" } as const
const fixtureIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const hashPattern = /^[0-9a-f]{64}$/
const revisionPattern = /^[0-9a-f]{40}$/
const binaryPathPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*\.bin$/
const assertionPathPattern = /^assertions\/[a-z0-9]+(?:-[a-z0-9]+)*\.json$/

function integer(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function validateRgb(value: typeof RgbSchema.Type, label: string): void {
  integer(value.r, `${label}.r`, 0, 255)
  integer(value.g, `${label}.g`, 0, 255)
  integer(value.b, `${label}.b`, 0, 255)
}

async function checkedCorpusPath(root: string, relative: string, pattern: RegExp, label: string): Promise<string> {
  if (!pattern.test(relative) || path.isAbsolute(relative)) {
    throw new Error(`${label} is not a permitted corpus-relative path: ${relative}`)
  }
  const resolved = path.resolve(root, relative)
  const withinRoot = path.relative(root, resolved)
  if (withinRoot.startsWith("..") || path.isAbsolute(withinRoot)) {
    throw new Error(`${label} escapes the corpus root: ${relative}`)
  }
  const canonical = await realpath(resolved)
  const canonicalWithinRoot = path.relative(root, canonical)
  if (canonicalWithinRoot.startsWith("..") || path.isAbsolute(canonicalWithinRoot)) {
    throw new Error(`${label} resolves outside the corpus root: ${relative}`)
  }
  return canonical
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

export function encodeCorpusBytes(bytes: Uint8Array): typeof EncodedBytesSchema.Type {
  return {
    base64: Buffer.from(bytes).toString("base64"),
    length: bytes.byteLength,
    sha256: sha256(bytes),
  }
}

export function decodeCorpusBytes(value: typeof EncodedBytesSchema.Type, label: string): Uint8Array {
  if (!hashPattern.test(value.sha256)) throw new Error(`${label} has an invalid SHA-256`)
  const bytes = Buffer.from(value.base64, "base64")
  if (bytes.toString("base64") !== value.base64) throw new Error(`${label} is not canonical base64`)
  if (bytes.byteLength !== value.length) throw new Error(`${label} length mismatch`)
  if (sha256(bytes) !== value.sha256) throw new Error(`${label} SHA-256 mismatch`)
  return bytes
}

export function corpusRoot(): string {
  return fileURLToPath(new URL("../../../tests/fixtures/terminal-corpus/", import.meta.url))
}

export async function loadTerminalCorpus(root = corpusRoot()): Promise<LoadedCorpus> {
  const canonicalRoot = await realpath(root)
  const manifestPath = await checkedCorpusPath(canonicalRoot, "manifest.json", /^manifest\.json$/, "manifest")
  const manifestInfo = await stat(manifestPath)
  if (!manifestInfo.isFile() || manifestInfo.size > CORPUS_HARD_LIMITS.observationBytes) {
    throw new Error("terminal corpus manifest is oversized or unavailable")
  }
  const manifestText = await readFile(manifestPath, "utf8")
  const manifest = Schema.decodeUnknownSync(Schema.parseJson(CorpusManifest), strictDecodeOptions)(manifestText)
  validateManifest(manifest)
  const loaded: LoadedCorpusFixture[] = []
  for (const fixture of manifest.fixtures) {
    const payloadPath = await checkedCorpusPath(canonicalRoot, fixture.bytes.path, binaryPathPattern, `${fixture.id}.bytes.path`)
    const payloadInfo = await stat(payloadPath)
    if (!payloadInfo.isFile() || payloadInfo.size !== fixture.bytes.length) {
      throw new Error(`${fixture.id} byte length mismatch`)
    }
    const payload = new Uint8Array(await readFile(payloadPath))
    if (sha256(payload) !== fixture.bytes.sha256) throw new Error(`${fixture.id} SHA-256 mismatch`)
    const assertionsPath = await checkedCorpusPath(canonicalRoot, fixture.assertions, assertionPathPattern, `${fixture.id}.assertions`)
    const assertionsInfo = await stat(assertionsPath)
    if (!assertionsInfo.isFile() || assertionsInfo.size > CORPUS_HARD_LIMITS.observationBytes) {
      throw new Error(`${fixture.id} assertions are oversized or unavailable`)
    }
    const assertions = Schema.decodeUnknownSync(Schema.parseJson(CorpusAssertions), strictDecodeOptions)(
      await readFile(assertionsPath, "utf8"),
    )
    validateAssertions(fixture, assertions)
    loaded.push({ definition: fixture, payload, assertions })
  }
  return { root: canonicalRoot, manifest, fixtures: loaded }
}

export function validateManifest(manifest: CorpusManifest): void {
  if (manifest.fixtures.length === 0 || manifest.fixtures.length > CORPUS_HARD_LIMITS.fixtures) {
    throw new Error("terminal corpus fixture count is out of bounds")
  }
  const limits = manifest.limits
  integer(limits.maxFixtureBytes, "limits.maxFixtureBytes", 1, CORPUS_HARD_LIMITS.fixtureBytes)
  integer(limits.maxColumns, "limits.maxColumns", 1, CORPUS_HARD_LIMITS.columns)
  integer(limits.maxRows, "limits.maxRows", 1, CORPUS_HARD_LIMITS.rows)
  integer(limits.maxEvents, "limits.maxEvents", 1, CORPUS_HARD_LIMITS.events)
  integer(limits.maxEffectsBytes, "limits.maxEffectsBytes", 1, CORPUS_HARD_LIMITS.effectsBytes)
  integer(limits.maxObservationBytes, "limits.maxObservationBytes", 1, CORPUS_HARD_LIMITS.observationBytes)
  const fixtureIds = new Set<string>()
  const modeIds = new Set<string>()
  for (const mode of manifest.modes) {
    integer(mode.number, "mode.number", 0, 0x7fff)
    const key = `${mode.ansi ? "ansi" : "dec"}:${mode.number}`
    if (modeIds.has(key)) throw new Error(`duplicate observed mode ${key}`)
    modeIds.add(key)
  }
  for (const fixture of manifest.fixtures) {
    if (!fixtureIdPattern.test(fixture.id) || fixtureIds.has(fixture.id)) {
      throw new Error(`invalid or duplicate fixture id: ${fixture.id}`)
    }
    fixtureIds.add(fixture.id)
    if (fixture.purpose.length === 0 || fixture.purpose.length > 512) {
      throw new Error(`${fixture.id} purpose is empty or oversized`)
    }
    if (!binaryPathPattern.test(fixture.bytes.path) || fixture.bytes.path !== `${fixture.id}.bin`) {
      throw new Error(`${fixture.id} has an invalid byte path`)
    }
    integer(fixture.bytes.length, `${fixture.id}.bytes.length`, 1, limits.maxFixtureBytes)
    if (!hashPattern.test(fixture.bytes.sha256)) throw new Error(`${fixture.id} has an invalid SHA-256`)
    if (!assertionPathPattern.test(fixture.assertions) || fixture.assertions !== `assertions/${fixture.id}.json`) {
      throw new Error(`${fixture.id} has an invalid assertions path`)
    }
    validateDimensions(fixture.id, fixture.initial, limits.maxColumns, limits.maxRows)
    integer(fixture.initial.scrollback, `${fixture.id}.scrollback`, 0, CORPUS_HARD_LIMITS.scrollback)
    validateRgb(fixture.initial.theme.foreground, `${fixture.id}.theme.foreground`)
    validateRgb(fixture.initial.theme.background, `${fixture.id}.theme.background`)
    validateRgb(fixture.initial.theme.cursor, `${fixture.id}.theme.cursor`)
    validateCanonicalBase64(fixture.initial.host.enquiryBase64, `${fixture.id}.host.enquiryBase64`, 4_096)
    validateCanonicalBase64(fixture.initial.host.xtversionBase64, `${fixture.id}.host.xtversionBase64`, 4_096)
    const device = fixture.initial.host.deviceAttributes
    if (device) {
      integer(device.primaryConformanceLevel, `${fixture.id}.host.device.primaryConformanceLevel`, 0, 65_535)
      integer(device.primaryFeatures.length, `${fixture.id}.host.device.primaryFeatures.length`, 0, 64)
      device.primaryFeatures.forEach((feature) => integer(feature, `${fixture.id}.host.device.primaryFeature`, 0, 65_535))
      integer(device.secondaryDeviceType, `${fixture.id}.host.device.secondaryDeviceType`, 0, 65_535)
      integer(device.secondaryFirmwareVersion, `${fixture.id}.host.device.secondaryFirmwareVersion`, 0, 65_535)
      integer(device.secondaryRomCartridge, `${fixture.id}.host.device.secondaryRomCartridge`, 0, 65_535)
      integer(device.tertiaryUnitId, `${fixture.id}.host.device.tertiaryUnitId`, 0, 0xffff_ffff)
    }
    integer(fixture.events.length, `${fixture.id}.events.length`, 1, limits.maxEvents)
    let consumed = 0
    let observationCount = 0
    const observationIds = new Set<string>()
    fixture.events.forEach((event, eventIndex) => {
      switch (event.type) {
        case "write":
          integer(event.offset, `${fixture.id}.events[${eventIndex}].offset`, 0, fixture.bytes.length)
          integer(event.length, `${fixture.id}.events[${eventIndex}].length`, 1, fixture.bytes.length)
          if (event.offset !== consumed || event.offset + event.length > fixture.bytes.length) {
            throw new Error(`${fixture.id} has a malformed chunk schedule at event ${eventIndex}`)
          }
          consumed += event.length
          break
        case "resize":
          validateDimensions(fixture.id, event, limits.maxColumns, limits.maxRows)
          break
        case "theme":
          validateRgb(event.theme.foreground, `${fixture.id}.events[${eventIndex}].theme.foreground`)
          validateRgb(event.theme.background, `${fixture.id}.events[${eventIndex}].theme.background`)
          validateRgb(event.theme.cursor, `${fixture.id}.events[${eventIndex}].theme.cursor`)
          break
        case "observe":
          if (!fixtureIdPattern.test(event.id) || observationIds.has(event.id) || consumed === 0) {
            throw new Error(`${fixture.id} has an invalid observation at event ${eventIndex}`)
          }
          observationIds.add(event.id)
          observationCount += 1
          break
        case "reset":
        case "scroll":
          break
      }
    })
    if (consumed !== fixture.bytes.length) throw new Error(`${fixture.id} chunk schedule does not cover its byte file`)
    integer(observationCount, `${fixture.id}.observations`, 1, CORPUS_HARD_LIMITS.observations)
  }
}

function validateDimensions(
  fixtureId: string,
  value: { readonly columns: number; readonly rows: number; readonly cellWidth: number; readonly cellHeight: number },
  maxColumns: number,
  maxRows: number,
): void {
  integer(value.columns, `${fixtureId}.columns`, 1, maxColumns)
  integer(value.rows, `${fixtureId}.rows`, 1, maxRows)
  integer(value.cellWidth, `${fixtureId}.cellWidth`, 1, CORPUS_HARD_LIMITS.cellPixels)
  integer(value.cellHeight, `${fixtureId}.cellHeight`, 1, CORPUS_HARD_LIMITS.cellPixels)
}

function validateCanonicalBase64(value: string, label: string, maximum: number): void {
  const bytes = Buffer.from(value, "base64")
  if (bytes.byteLength > maximum || bytes.toString("base64") !== value) {
    throw new Error(`${label} must be bounded canonical base64`)
  }
}

function validateAssertions(fixture: CorpusFixture, assertions: CorpusAssertions): void {
  if (assertions.fixtureId !== fixture.id) throw new Error(`${fixture.id} assertion fixture id mismatch`)
  const expectedIds = fixture.events.filter((event) => event.type === "observe").map((event) => event.id)
  const actualIds = assertions.observations.map((observation) => observation.id)
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    throw new Error(`${fixture.id} assertion observation ids do not match the schedule`)
  }
  for (const observation of assertions.observations) {
    const cells = new Set<string>()
    for (const row of observation.rows) {
      integer(row.row, `${fixture.id}.${observation.id}.row.row`, 0, CORPUS_HARD_LIMITS.rows - 1)
    }
    for (const cell of observation.cells) {
      integer(cell.row, `${fixture.id}.${observation.id}.cell.row`, 0, CORPUS_HARD_LIMITS.rows - 1)
      integer(cell.column, `${fixture.id}.${observation.id}.cell.column`, 0, CORPUS_HARD_LIMITS.columns - 1)
      validateCanonicalBase64(cell.graphemeBase64, `${fixture.id}.${observation.id}.cell.graphemeBase64`, 16_384)
      const key = `${cell.row}:${cell.column}`
      if (cells.has(key)) throw new Error(`${fixture.id}.${observation.id} has duplicate cell assertion ${key}`)
      cells.add(key)
    }
    for (const entry of observation.palette) {
      integer(entry.index, `${fixture.id}.${observation.id}.palette.index`, 0, 255)
      validateRgb(entry.color, `${fixture.id}.${observation.id}.palette.color`)
    }
    for (const effect of observation.effects) {
      integer(effect.eventIndex, `${fixture.id}.${observation.id}.effect.eventIndex`, 0, fixture.events.length - 1)
      integer(effect.callbackIndex, `${fixture.id}.${observation.id}.effect.callbackIndex`, 0, 4_095)
      validateCanonicalBase64(effect.base64, `${fixture.id}.${observation.id}.effect.base64`, CORPUS_HARD_LIMITS.effectsBytes)
    }
  }
}

export function validateCorpusResult(value: string, manifest: CorpusManifest): CorpusResult {
  if (Buffer.byteLength(value) > manifest.limits.maxObservationBytes) {
    throw new Error("Ghostty corpus observation is oversized")
  }
  const result = Schema.decodeUnknownSync(Schema.parseJson(CorpusResult), strictDecodeOptions)(value)
  if (!revisionPattern.test(result.revision)) throw new Error("Ghostty corpus result has an invalid revision")
  if (result.fixtures.length !== manifest.fixtures.length) throw new Error("Ghostty corpus result fixture count mismatch")
  let totalEffects = 0
  result.fixtures.forEach((fixture, fixtureIndex) => {
    const definition = manifest.fixtures[fixtureIndex]
    if (!definition || fixture.id !== definition.id) throw new Error(`Ghostty corpus result fixture order mismatch at ${fixtureIndex}`)
    if (fixture.sourceLength !== definition.bytes.length || fixture.sourceSha256 !== definition.bytes.sha256) {
      throw new Error(`${fixture.id} source identity mismatch`)
    }
    const expectedObservations = definition.events
      .map((event, eventIndex) => ({ event, eventIndex }))
      .filter((entry) => entry.event.type === "observe")
    if (fixture.observations.length !== expectedObservations.length || fixture.observations.length > CORPUS_HARD_LIMITS.observations) {
      throw new Error(`${fixture.id} observation count mismatch`)
    }
    for (const [observationIndex, observation] of fixture.observations.entries()) {
      const expected = expectedObservations[observationIndex]
      if (!expected || expected.event.type !== "observe" || observation.id !== expected.event.id || observation.eventIndex !== expected.eventIndex) {
        throw new Error(`${fixture.id} observation schedule mismatch at ${observationIndex}`)
      }
      if (observation.state.columns < 1 || observation.state.columns > manifest.limits.maxColumns || observation.state.rows < 1 || observation.state.rows > manifest.limits.maxRows) {
        throw new Error(`${fixture.id}.${observation.id} has unbounded dimensions`)
      }
      if (observation.rows.length !== observation.state.rows) throw new Error(`${fixture.id}.${observation.id} row count mismatch`)
      if (observation.renderColors.palette.length !== 256) throw new Error(`${fixture.id}.${observation.id} palette length mismatch`)
      observation.rows.forEach((row, rowIndex) => {
        if (row.index !== rowIndex || row.cells.length !== observation.state.columns) {
          throw new Error(`${fixture.id}.${observation.id} malformed row ${rowIndex}`)
        }
        row.cells.forEach((cell, column) => {
          if (cell.column !== column) throw new Error(`${fixture.id}.${observation.id} malformed cell ${rowIndex}:${column}`)
          decodeCorpusBytes(cell.grapheme, `${fixture.id}.${observation.id}.row${rowIndex}.cell${column}.grapheme`)
        })
      })
      for (const effect of observation.effects) {
        if (effect.eventIndex > observation.eventIndex || effect.eventIndex >= definition.events.length || effect.callbackIndex < 0 || effect.callbackIndex > 4_095) {
          throw new Error(`${fixture.id}.${observation.id} malformed effect schedule`)
        }
        totalEffects += decodeCorpusBytes(effect.bytes, `${fixture.id}.${observation.id}.effect`).byteLength
        if (totalEffects > manifest.limits.maxEffectsBytes) throw new Error("Ghostty corpus effects are oversized")
      }
    }
  })
  return result
}

export function assertHandAuthoredObservation(
  fixture: LoadedCorpusFixture,
  observation: CorpusObservation,
): void {
  const expected = fixture.assertions.observations.find((value) => value.id === observation.id)
  if (!expected) throw new Error(`${fixture.definition.id}.${observation.id} has no hand-authored assertion entry`)
  const location = `${fixture.definition.id}.${observation.id}`
  if (expected.titleBase64 !== undefined && observation.state.title.base64 !== expected.titleBase64) {
    throw new Error(`${location} title: expected ${expected.titleBase64}, got ${observation.state.title.base64}`)
  }
  if (expected.workingDirectoryBase64 !== undefined && observation.state.workingDirectory.base64 !== expected.workingDirectoryBase64) {
    throw new Error(`${location} cwd: expected ${expected.workingDirectoryBase64}, got ${observation.state.workingDirectory.base64}`)
  }
  if (expected.activeScreen !== undefined && observation.state.activeScreen !== expected.activeScreen) {
    throw new Error(`${location} active screen: expected ${expected.activeScreen}, got ${observation.state.activeScreen}`)
  }
  if (expected.cursor !== undefined && (observation.cursor.column !== expected.cursor.column || observation.cursor.row !== expected.cursor.row)) {
    throw new Error(`${location} cursor: expected ${expected.cursor.column},${expected.cursor.row}, got ${observation.cursor.column},${observation.cursor.row}`)
  }
  if (expected.dimensions !== undefined) {
    const actual = {
      columns: observation.state.columns,
      rows: observation.state.rows,
      widthPixels: observation.state.widthPixels,
      heightPixels: observation.state.heightPixels,
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected.dimensions)) {
      throw new Error(`${location} dimensions: expected ${JSON.stringify(expected.dimensions)}, got ${JSON.stringify(actual)}`)
    }
  }
  if (expected.scrollbar !== undefined && JSON.stringify(observation.state.scrollbar) !== JSON.stringify(expected.scrollbar)) {
    throw new Error(`${location} scrollbar: expected ${JSON.stringify(expected.scrollbar)}, got ${JSON.stringify(observation.state.scrollbar)}`)
  }
  if (expected.kittyKeyboardFlags !== undefined && observation.state.kittyKeyboardFlags !== expected.kittyKeyboardFlags) {
    throw new Error(`${location} Kitty keyboard flags: expected ${expected.kittyKeyboardFlags}, got ${observation.state.kittyKeyboardFlags}`)
  }
  for (const assertion of expected.rows) {
    const row = observation.rows[assertion.row]
    if (!row || row.wrapsToNext !== assertion.wrapsToNext || row.isWrapContinuation !== assertion.isWrapContinuation) {
      throw new Error(`${location} row ${assertion.row} wrap: expected ${JSON.stringify(assertion)}, got ${JSON.stringify(row)}`)
    }
  }
  for (const assertion of expected.cells) {
    const cell = observation.rows[assertion.row]?.cells[assertion.column]
    if (!cell) throw new Error(`${location} row ${assertion.row} cell ${assertion.column} is absent`)
    if (cell.grapheme.base64 !== assertion.graphemeBase64) {
      throw new Error(`${location} row ${assertion.row} cell ${assertion.column} grapheme: expected ${assertion.graphemeBase64}, got ${cell.grapheme.base64}`)
    }
    if (assertion.width !== undefined && cell.width !== assertion.width) {
      throw new Error(`${location} row ${assertion.row} cell ${assertion.column} width: expected ${assertion.width}, got ${cell.width}`)
    }
    if (assertion.style !== undefined && JSON.stringify(cell.style) !== JSON.stringify(assertion.style)) {
      throw new Error(`${location} row ${assertion.row} cell ${assertion.column} style: expected ${JSON.stringify(assertion.style)}, got ${JSON.stringify(cell.style)}`)
    }
  }
  for (const assertion of expected.palette) {
    const color = observation.renderColors.palette[assertion.index]
    if (JSON.stringify(color) !== JSON.stringify(assertion.color)) {
      throw new Error(`${location} palette ${assertion.index}: expected ${JSON.stringify(assertion.color)}, got ${JSON.stringify(color)}`)
    }
  }
  for (const assertion of expected.modes) {
    const mode = observation.modes.find((value) => value.number === assertion.number && value.ansi === assertion.ansi)
    if (!mode || mode.enabled !== assertion.enabled) {
      throw new Error(`${location} mode ${assertion.ansi ? "ANSI" : "DEC"} ${assertion.number}: expected ${assertion.enabled}, got ${mode?.enabled ?? "absent"}`)
    }
  }
  for (const assertion of expected.effects) {
    const effect = observation.effects.find((value) => value.eventIndex === assertion.eventIndex && value.callbackIndex === assertion.callbackIndex)
    if (!effect || effect.bytes.base64 !== assertion.base64) {
      throw new Error(`${location} event ${assertion.eventIndex} effect ${assertion.callbackIndex}: expected ${assertion.base64}, got ${effect?.bytes.base64 ?? "absent"}`)
    }
  }
}

export function compareCorpusResults(native: CorpusRunnerResult, wasm: CorpusRunnerResult): void {
  if (native.revision !== wasm.revision) {
    throw new Error(`Ghostty revision mismatch: native=${native.revision} wasm=${wasm.revision}`)
  }
  if (native.normalizerVersion !== wasm.normalizerVersion) {
    throw new Error(`Ghostty normalizer mismatch: native=${native.normalizerVersion} wasm=${wasm.normalizerVersion}`)
  }
  compareScalar("fixture count", native.fixtures.length, wasm.fixtures.length)
  native.fixtures.forEach((nativeFixture, fixtureIndex) => {
    const wasmFixture = wasm.fixtures[fixtureIndex]
    if (!wasmFixture) throw new Error(`fixture ${nativeFixture.id}: absent from WASM result`)
    compareScalar(`fixture ${nativeFixture.id} id`, nativeFixture.id, wasmFixture.id)
    compareScalar(`fixture ${nativeFixture.id} source length`, nativeFixture.sourceLength, wasmFixture.sourceLength)
    compareScalar(`fixture ${nativeFixture.id} source hash`, nativeFixture.sourceSha256, wasmFixture.sourceSha256)
    compareScalar(`fixture ${nativeFixture.id} observation count`, nativeFixture.observations.length, wasmFixture.observations.length)
    nativeFixture.observations.forEach((nativeObservation, observationIndex) => {
      const wasmObservation = wasmFixture.observations[observationIndex]
      if (!wasmObservation) throw new Error(`fixture ${nativeFixture.id} observation ${nativeObservation.id}: absent from WASM result`)
      const at = `fixture ${nativeFixture.id} observation ${nativeObservation.id} event ${nativeObservation.eventIndex}`
      compareScalar(`${at} id`, nativeObservation.id, wasmObservation.id)
      compareScalar(`${at} event index`, nativeObservation.eventIndex, wasmObservation.eventIndex)
      compareJson(`${at} state`, nativeObservation.state, wasmObservation.state)
      compareColors(`${at} render colors`, nativeObservation.renderColors, wasmObservation.renderColors)
      compareJson(`${at} cursor`, nativeObservation.cursor, wasmObservation.cursor)
      compareScalar(`${at} mode count`, nativeObservation.modes.length, wasmObservation.modes.length)
      nativeObservation.modes.forEach((nativeMode, modeIndex) => {
        compareJson(`${at} mode ${nativeMode.ansi ? "ANSI" : "DEC"} ${nativeMode.number}`, nativeMode, wasmObservation.modes[modeIndex])
      })
      compareScalar(`${at} row count`, nativeObservation.rows.length, wasmObservation.rows.length)
      nativeObservation.rows.forEach((nativeRow, rowIndex) => {
        const wasmRow = wasmObservation.rows[rowIndex]
        if (!wasmRow) throw new Error(`${at} row ${rowIndex}: absent from WASM result`)
        compareJson(`${at} row ${rowIndex} metadata`, {
          index: nativeRow.index,
          wrapsToNext: nativeRow.wrapsToNext,
          isWrapContinuation: nativeRow.isWrapContinuation,
          semanticPrompt: nativeRow.semanticPrompt,
          selection: nativeRow.selection,
        }, {
          index: wasmRow.index,
          wrapsToNext: wasmRow.wrapsToNext,
          isWrapContinuation: wasmRow.isWrapContinuation,
          semanticPrompt: wasmRow.semanticPrompt,
          selection: wasmRow.selection,
        })
        compareScalar(`${at} row ${rowIndex} cell count`, nativeRow.cells.length, wasmRow.cells.length)
        nativeRow.cells.forEach((nativeCell, column) => {
          const wasmCell = wasmRow.cells[column]
          if (!wasmCell) throw new Error(`${at} row ${rowIndex} cell ${column}: absent from WASM result`)
          compareEncodedBytes(`${at} row ${rowIndex} cell ${column} grapheme`, nativeCell.grapheme, wasmCell.grapheme)
          compareJson(`${at} row ${rowIndex} cell ${column}`, {
            column: nativeCell.column,
            width: nativeCell.width,
            semanticContent: nativeCell.semanticContent,
            style: nativeCell.style,
            selected: nativeCell.selected,
          }, {
            column: wasmCell.column,
            width: wasmCell.width,
            semanticContent: wasmCell.semanticContent,
            style: wasmCell.style,
            selected: wasmCell.selected,
          })
        })
      })
      compareScalar(`${at} effect count`, nativeObservation.effects.length, wasmObservation.effects.length)
      nativeObservation.effects.forEach((nativeEffect, effectIndex) => {
        const wasmEffect = wasmObservation.effects[effectIndex]
        if (!wasmEffect) throw new Error(`${at} effect ${effectIndex}: absent from WASM result`)
        compareJson(`${at} effect ${effectIndex} metadata`, {
          eventIndex: nativeEffect.eventIndex,
          callbackIndex: nativeEffect.callbackIndex,
        }, {
          eventIndex: wasmEffect.eventIndex,
          callbackIndex: wasmEffect.callbackIndex,
        })
        compareEncodedBytes(`${at} effect ${effectIndex}`, nativeEffect.bytes, wasmEffect.bytes)
      })
    })
  })
}

function compareColors(
  location: string,
  native: CorpusObservation["renderColors"],
  wasm: CorpusObservation["renderColors"],
): void {
  compareJson(`${location} defaults`, {
    foreground: native.foreground,
    background: native.background,
    cursor: native.cursor,
  }, {
    foreground: wasm.foreground,
    background: wasm.background,
    cursor: wasm.cursor,
  })
  compareScalar(`${location} palette length`, native.palette.length, wasm.palette.length)
  native.palette.forEach((color, index) => compareJson(`${location} palette ${index}`, color, wasm.palette[index]))
}

function compareEncodedBytes(
  location: string,
  native: typeof EncodedBytesSchema.Type,
  wasm: typeof EncodedBytesSchema.Type,
): void {
  const nativeBytes = decodeCorpusBytes(native, `${location} native`)
  const wasmBytes = decodeCorpusBytes(wasm, `${location} wasm`)
  const limit = Math.min(nativeBytes.byteLength, wasmBytes.byteLength)
  for (let offset = 0; offset < limit; offset += 1) {
    if (nativeBytes[offset] !== wasmBytes[offset]) {
      throw new Error(`${location} byte offset ${offset}: native=${nativeBytes[offset]} wasm=${wasmBytes[offset]}`)
    }
  }
  if (nativeBytes.byteLength !== wasmBytes.byteLength) {
    throw new Error(`${location} byte offset ${limit}: native=${nativeBytes[limit] ?? "EOF"} wasm=${wasmBytes[limit] ?? "EOF"}`)
  }
}

function compareJson<Value>(location: string, native: Value, wasm: Value | undefined): void {
  const nativeJson = JSON.stringify(native)
  const wasmJson = JSON.stringify(wasm)
  if (nativeJson !== wasmJson) throw new Error(`${location}: native=${nativeJson} wasm=${wasmJson}`)
}

function compareScalar(location: string, native: string | number, wasm: string | number): void {
  if (native !== wasm) throw new Error(`${location}: native=${native} wasm=${wasm}`)
}
