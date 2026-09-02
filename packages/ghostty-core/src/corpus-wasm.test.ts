import { strict as assert } from "node:assert"
import { writeFile } from "node:fs/promises"
import { test } from "vite-plus/test"
import {
  CORPUS_NORMALIZER_VERSION,
  CorpusResult,
  assertHandAuthoredObservation,
  encodeCorpusBytes,
  loadTerminalCorpus,
  validateCorpusResult,
  type CorpusEvent,
  type CorpusFixture,
  type CorpusModeSpec,
  type CorpusObservation,
  type CorpusTheme,
} from "./corpus.js"
import { nodeGhosttyWasmSource } from "./loaders/node.js"
import { GhosttyRuntime } from "./runtime.js"

const SUCCESS = 0
const OUT_OF_SPACE = -3
const NO_VALUE = -4
const ROW_SELECTION_SIZE = 8
const STYLE_SIZE_FIELD = "size"

const TERMINAL_OPTION = {
  foreground: 11,
  background: 12,
  cursor: 13,
  palette: 14,
  apcMaxBytes: 19,
  defaultCursorBlink: 23,
} as const
const TERMINAL_DATA = {
  columns: 1,
  rows: 2,
  cursorColumn: 3,
  cursorRow: 4,
  cursorPendingWrap: 5,
  activeScreen: 6,
  cursorVisible: 7,
  kittyKeyboardFlags: 8,
  scrollbar: 9,
  title: 12,
  workingDirectory: 13,
  totalRows: 14,
  scrollbackRows: 15,
  widthPixels: 16,
  heightPixels: 17,
  viewportActive: 32,
} as const
const RENDER_DATA = {
  columns: 1,
  rows: 2,
  rowIterator: 4,
  background: 5,
  foreground: 6,
  cursor: 7,
  cursorHasValue: 8,
  palette: 9,
  cursorStyle: 10,
  cursorVisible: 11,
  cursorBlinking: 12,
  cursorPasswordInput: 13,
  cursorInViewport: 14,
  cursorColumn: 15,
  cursorRow: 16,
  cursorWideTail: 17,
} as const
const ROW_DATA = { raw: 2, cells: 3, selection: 4 } as const
const CELL_DATA = {
  raw: 1,
  style: 2,
  background: 5,
  foreground: 6,
  selected: 7,
  graphemeUtf8: 9,
} as const
const RAW_ROW_DATA = { wrapsToNext: 1, wrapContinuation: 2, semanticPrompt: 6 } as const
const RAW_CELL_DATA = { width: 3, semanticContent: 9 } as const

interface PendingEffect {
  readonly eventIndex: number
  readonly callbackIndex: number
  readonly bytes: ReturnType<typeof encodeCorpusBytes>
}

class WasmCorpusTerminal {
  private terminalSlot = 0
  private terminal = 0
  private renderStateSlot = 0
  private renderState = 0
  private rowIteratorSlot = 0
  private rowIterator = 0
  private cellsSlot = 0
  private cells = 0
  private writerId = 0
  private scratch = 0
  private style = 0
  private styleSize = 0
  private scrollbar = 0
  private graphemeStruct = 0
  private grapheme = 0
  private graphemeCapacity = 0
  private currentEventIndex = 0
  private currentCallbackIndex = 0
  private readonly effects: PendingEffect[] = []

  private constructor(private readonly runtime: GhosttyRuntime) {}

  static async create(fixture: CorpusFixture): Promise<WasmCorpusTerminal> {
    const runtime = await GhosttyRuntime.load(await nodeGhosttyWasmSource())
    const terminal = new WasmCorpusTerminal(runtime)
    try {
      terminal.initialize(fixture)
      return terminal
    } catch (error) {
      terminal.dispose()
      throw error
    }
  }

  revision(): string {
    const output = this.runtime.alloc(this.runtime.layout("GhosttyString").size)
    try {
      this.assertSuccess("ghostty_build_info", this.runtime.call("ghostty_build_info", 10, output))
      return this.readString(output)
    } finally {
      this.runtime.free(output, this.runtime.layout("GhosttyString").size)
    }
  }

  apply(event: CorpusEvent, payload: Uint8Array, eventIndex: number): void {
    this.currentEventIndex = eventIndex
    this.currentCallbackIndex = 0
    switch (event.type) {
      case "write": {
        const chunk = payload.subarray(event.offset, event.offset + event.length)
        const pointer = this.runtime.alloc(chunk.byteLength)
        try {
          this.runtime.bytes(pointer, chunk.byteLength).set(chunk)
          this.runtime.call("ghostty_terminal_vt_write", this.terminal, pointer, chunk.byteLength)
        } finally {
          this.runtime.free(pointer, chunk.byteLength)
        }
        return
      }
      case "resize":
        this.resize(event.columns, event.rows, event.cellWidth, event.cellHeight)
        return
      case "reset":
        this.runtime.call("ghostty_terminal_reset", this.terminal)
        return
      case "theme":
        this.setTheme(event.theme)
        return
      case "scroll":
        this.scroll(event.position)
        return
      case "observe":
        return
    }
  }

  observe(id: string, eventIndex: number, modes: readonly CorpusModeSpec[]): CorpusObservation {
    const columns = this.getTerminalU16(TERMINAL_DATA.columns)
    const rows = this.getTerminalU16(TERMINAL_DATA.rows)
    const cursorColumn = this.getTerminalU16(TERMINAL_DATA.cursorColumn)
    const cursorRow = this.getTerminalU16(TERMINAL_DATA.cursorRow)
    const cursorPendingWrap = this.getTerminalBool(TERMINAL_DATA.cursorPendingWrap)
    const cursorVisible = this.getTerminalBool(TERMINAL_DATA.cursorVisible)
    const activeScreenValue = this.getTerminalU32(TERMINAL_DATA.activeScreen)
    const activeScreen = activeScreenValue === 0 ? "primary" : activeScreenValue === 1 ? "alternate" : this.invalidEnum("active screen", activeScreenValue)
    const scrollbar = this.readScrollbar()
    const state: CorpusObservation["state"] = {
      columns,
      rows,
      widthPixels: this.getTerminalU32(TERMINAL_DATA.widthPixels),
      heightPixels: this.getTerminalU32(TERMINAL_DATA.heightPixels),
      activeScreen,
      alternateScreen: activeScreen === "alternate",
      totalRows: this.getTerminalUsize(TERMINAL_DATA.totalRows),
      scrollbackRows: this.getTerminalUsize(TERMINAL_DATA.scrollbackRows),
      viewportActive: this.getTerminalBool(TERMINAL_DATA.viewportActive),
      scrollbar,
      kittyKeyboardFlags: this.getTerminalU8(TERMINAL_DATA.kittyKeyboardFlags),
      title: encodeCorpusBytes(this.getTerminalString(TERMINAL_DATA.title)),
      workingDirectory: encodeCorpusBytes(this.getTerminalString(TERMINAL_DATA.workingDirectory)),
    }
    const modeValues = modes.map((mode) => ({
      number: mode.number,
      ansi: mode.ansi,
      enabled: this.mode(mode.number, mode.ansi),
    }))
    this.assertSuccess(
      "ghostty_render_state_update",
      this.runtime.call("ghostty_render_state_update", this.renderState, this.terminal),
    )
    const renderColumns = this.renderU16(RENDER_DATA.columns)
    const renderRows = this.renderU16(RENDER_DATA.rows)
    if (renderColumns !== columns || renderRows !== rows) {
      throw new Error(`render/state dimensions disagree: ${renderColumns}x${renderRows} vs ${columns}x${rows}`)
    }
    const foreground = this.renderColor(RENDER_DATA.foreground)
    const background = this.renderColor(RENDER_DATA.background)
    const cursorHasValue = this.renderBool(RENDER_DATA.cursorHasValue)
    const cursor = cursorHasValue ? this.renderColor(RENDER_DATA.cursor) : null
    const palette = this.renderPalette()
    const cursorInViewport = this.renderBool(RENDER_DATA.cursorInViewport)
    const viewportPosition = cursorInViewport
      ? { column: this.renderU16(RENDER_DATA.cursorColumn), row: this.renderU16(RENDER_DATA.cursorRow) }
      : null
    const renderStyleValue = this.renderU32(RENDER_DATA.cursorStyle)
    const renderStyle = renderStyleValue === 0
      ? "bar"
      : renderStyleValue === 1
        ? "block"
        : renderStyleValue === 2
          ? "underline"
          : renderStyleValue === 3
            ? "hollow-block"
            : this.invalidEnum("cursor style", renderStyleValue)
    this.assertSuccess(
      "ghostty_render_state_get(row iterator)",
      this.runtime.call("ghostty_render_state_get", this.renderState, RENDER_DATA.rowIterator, this.rowIteratorSlot),
    )
    if (this.runtime.readPointer(this.rowIteratorSlot) !== this.rowIterator) {
      throw new Error("Ghostty replaced the preallocated row iterator")
    }
    const rowValues: CorpusObservation["rows"][number][] = []
    for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
      if (this.runtime.call("ghostty_render_state_row_iterator_next", this.rowIterator) === 0) {
        throw new Error(`Ghostty row iterator ended at row ${rowIndex}`)
      }
      const rawRow = this.getRawHandle("ghostty_render_state_row_get", this.rowIterator, ROW_DATA.raw)
      const selection = this.rowSelection()
      this.assertSuccess(
        "ghostty_render_state_row_get(cells)",
        this.runtime.call("ghostty_render_state_row_get", this.rowIterator, ROW_DATA.cells, this.cellsSlot),
      )
      if (this.runtime.readPointer(this.cellsSlot) !== this.cells) {
        throw new Error(`Ghostty replaced the preallocated cell iterator at row ${rowIndex}`)
      }
      const cellValues: CorpusObservation["rows"][number]["cells"][number][] = []
      for (let column = 0; column < columns; column += 1) {
        if (this.runtime.call("ghostty_render_state_row_cells_next", this.cells) === 0) {
          throw new Error(`Ghostty cell iterator ended at row ${rowIndex} cell ${column}`)
        }
        const rawCell = this.getRawHandle("ghostty_render_state_row_cells_get", this.cells, CELL_DATA.raw)
        const widthValue = this.rawU32("ghostty_cell_get", rawCell, RAW_CELL_DATA.width)
        const semanticValue = this.rawU32("ghostty_cell_get", rawCell, RAW_CELL_DATA.semanticContent)
        const style = this.cellStyle(foreground, background)
        cellValues.push({
          column,
          grapheme: encodeCorpusBytes(this.cellGrapheme()),
          width: widthValue === 0
            ? "narrow"
            : widthValue === 1
              ? "wide"
              : widthValue === 2
                ? "spacer-tail"
                : widthValue === 3
                  ? "spacer-head"
                  : this.invalidEnum("cell width", widthValue),
          semanticContent: semanticValue === 0
            ? "output"
            : semanticValue === 1
              ? "input"
              : semanticValue === 2
                ? "prompt"
                : this.invalidEnum("semantic content", semanticValue),
          style,
          selected: this.cellBool(CELL_DATA.selected),
        })
      }
      const promptValue = this.rawU32("ghostty_row_get", rawRow, RAW_ROW_DATA.semanticPrompt)
      rowValues.push({
        index: rowIndex,
        wrapsToNext: this.rawBool("ghostty_row_get", rawRow, RAW_ROW_DATA.wrapsToNext),
        isWrapContinuation: this.rawBool("ghostty_row_get", rawRow, RAW_ROW_DATA.wrapContinuation),
        semanticPrompt: promptValue === 0
          ? "none"
          : promptValue === 1
            ? "prompt"
            : promptValue === 2
              ? "continuation"
              : this.invalidEnum("semantic prompt", promptValue),
        selection,
        cells: cellValues,
      })
    }
    return {
      id,
      eventIndex,
      state,
      renderColors: { foreground, background, cursor, palette },
      cursor: {
        column: cursorColumn,
        row: cursorRow,
        pendingWrap: cursorPendingWrap,
        visible: cursorVisible,
        renderStyle,
        blinking: this.renderBool(RENDER_DATA.cursorBlinking),
        passwordInput: this.renderBool(RENDER_DATA.cursorPasswordInput),
        viewportPosition,
        wideTail: cursorInViewport && this.renderBool(RENDER_DATA.cursorWideTail),
      },
      modes: modeValues,
      rows: rowValues,
      effects: this.effects.map((effect) => ({ ...effect })),
    }
  }

  dispose(): void {
    if (this.writerId !== 0 && this.terminal !== 0) this.runtime.detachPtyWriter(this.terminal, this.writerId)
    if (this.cells !== 0) this.runtime.call("ghostty_render_state_row_cells_free", this.cells)
    if (this.rowIterator !== 0) this.runtime.call("ghostty_render_state_row_iterator_free", this.rowIterator)
    if (this.renderState !== 0) this.runtime.call("ghostty_render_state_free", this.renderState)
    if (this.terminal !== 0) this.runtime.call("ghostty_terminal_free", this.terminal)
    this.runtime.free(this.style, this.styleSize)
    this.runtime.free(this.scrollbar, this.runtime.layout("GhosttyTerminalScrollbar").size)
    this.runtime.free(this.graphemeStruct, this.runtime.layout("GhosttyBuffer").size)
    this.runtime.free(this.grapheme, this.graphemeCapacity)
    this.runtime.free(this.scratch, 128)
    for (const slot of [this.cellsSlot, this.rowIteratorSlot, this.renderStateSlot, this.terminalSlot]) {
      this.runtime.freeOpaque(slot)
    }
    this.terminal = 0
  }

  private initialize(fixture: CorpusFixture): void {
    const { initial } = fixture
    if (
      initial.host.enquiryBase64 !== "" ||
      initial.host.xtversionBase64 !== "" ||
      initial.host.colorScheme !== null ||
      initial.host.deviceAttributes !== null
    ) {
      throw new Error(`${fixture.id} requests host callbacks not installed by the shipped WASM core`)
    }
    const terminalOptions = this.runtime.layout("GhosttyTerminalOptions")
    const options = this.runtime.alloc(terminalOptions.size)
    this.runtime.setField(options, "GhosttyTerminalOptions", "cols", initial.columns)
    this.runtime.setField(options, "GhosttyTerminalOptions", "rows", initial.rows)
    this.runtime.setField(options, "GhosttyTerminalOptions", "max_scrollback", initial.scrollback)
    this.terminalSlot = this.runtime.allocOpaque()
    this.assertSuccess("ghostty_terminal_new", this.runtime.call("ghostty_terminal_new", 0, this.terminalSlot, options))
    this.runtime.free(options, terminalOptions.size)
    this.terminal = this.runtime.readPointer(this.terminalSlot)
    this.writerId = this.runtime.attachPtyByteWriter(this.terminal, (bytes) => {
      this.effects.push({
        eventIndex: this.currentEventIndex,
        callbackIndex: this.currentCallbackIndex,
        bytes: encodeCorpusBytes(bytes),
      })
      this.currentCallbackIndex += 1
    })

    this.renderStateSlot = this.runtime.allocOpaque()
    this.assertSuccess("ghostty_render_state_new", this.runtime.call("ghostty_render_state_new", 0, this.renderStateSlot))
    this.renderState = this.runtime.readPointer(this.renderStateSlot)
    this.rowIteratorSlot = this.runtime.allocOpaque()
    this.assertSuccess(
      "ghostty_render_state_row_iterator_new",
      this.runtime.call("ghostty_render_state_row_iterator_new", 0, this.rowIteratorSlot),
    )
    this.rowIterator = this.runtime.readPointer(this.rowIteratorSlot)
    this.cellsSlot = this.runtime.allocOpaque()
    this.assertSuccess(
      "ghostty_render_state_row_cells_new",
      this.runtime.call("ghostty_render_state_row_cells_new", 0, this.cellsSlot),
    )
    this.cells = this.runtime.readPointer(this.cellsSlot)
    this.scratch = this.runtime.alloc(128)
    this.styleSize = this.runtime.layout("GhosttyStyle").size
    this.style = this.runtime.alloc(this.styleSize)
    this.scrollbar = this.runtime.alloc(this.runtime.layout("GhosttyTerminalScrollbar").size)
    this.graphemeStruct = this.runtime.alloc(this.runtime.layout("GhosttyBuffer").size)
    this.ensureGraphemeCapacity(64)
    this.runtime.view(this.scratch, 4).setUint32(0, 1_048_576, true)
    this.assertSuccess(
      "ghostty_terminal_set(APC bound)",
      this.runtime.call("ghostty_terminal_set", this.terminal, TERMINAL_OPTION.apcMaxBytes, this.scratch),
    )
    this.runtime.bytes(this.scratch, 1)[0] = initial.defaultCursorBlink ? 1 : 0
    this.assertSuccess(
      "ghostty_terminal_set(default cursor blink)",
      this.runtime.call("ghostty_terminal_set", this.terminal, TERMINAL_OPTION.defaultCursorBlink, this.scratch),
    )
    this.setTheme(initial.theme)
    this.resize(initial.columns, initial.rows, initial.cellWidth, initial.cellHeight)
  }

  private resize(columns: number, rows: number, cellWidth: number, cellHeight: number): void {
    this.assertSuccess(
      "ghostty_terminal_resize",
      this.runtime.call("ghostty_terminal_resize", this.terminal, columns, rows, cellWidth, cellHeight),
    )
  }

  private setTheme(theme: CorpusTheme): void {
    const color = this.runtime.alloc(3)
    try {
      for (const [option, value] of [
        [TERMINAL_OPTION.foreground, theme.foreground],
        [TERMINAL_OPTION.background, theme.background],
        [TERMINAL_OPTION.cursor, theme.cursor],
      ] as const) {
        this.runtime.bytes(color, 3).set([value.r, value.g, value.b])
        this.assertSuccess("ghostty_terminal_set(theme)", this.runtime.call("ghostty_terminal_set", this.terminal, option, color))
      }
      this.assertSuccess(
        "ghostty_terminal_set(palette)",
        this.runtime.call("ghostty_terminal_set", this.terminal, TERMINAL_OPTION.palette, 0),
      )
    } finally {
      this.runtime.free(color, 3)
    }
  }

  private scroll(position: "top" | "bottom"): void {
    const layout = this.runtime.layout("GhosttyTerminalScrollViewport")
    const behavior = this.runtime.alloc(layout.size)
    try {
      this.runtime.setField(behavior, "GhosttyTerminalScrollViewport", "tag", position === "top" ? 0 : 1)
      this.runtime.call("ghostty_terminal_scroll_viewport", this.terminal, behavior)
    } finally {
      this.runtime.free(behavior, layout.size)
    }
  }

  private mode(number: number, ansi: boolean): boolean {
    const packed = number | (ansi ? 0x8000 : 0)
    this.runtime.bytes(this.scratch, 1)[0] = 0
    this.assertSuccess("ghostty_terminal_mode_get", this.runtime.call("ghostty_terminal_mode_get", this.terminal, packed, this.scratch))
    return this.runtime.bytes(this.scratch, 1)[0] !== 0
  }

  private readScrollbar(): CorpusObservation["state"]["scrollbar"] {
    const layout = this.runtime.layout("GhosttyTerminalScrollbar")
    this.runtime.bytes(this.scrollbar, layout.size).fill(0)
    this.assertSuccess(
      "ghostty_terminal_get(scrollbar)",
      this.runtime.call("ghostty_terminal_get", this.terminal, TERMINAL_DATA.scrollbar, this.scrollbar),
    )
    return {
      total: this.runtime.readField(this.scrollbar, "GhosttyTerminalScrollbar", "total"),
      offset: this.runtime.readField(this.scrollbar, "GhosttyTerminalScrollbar", "offset"),
      length: this.runtime.readField(this.scrollbar, "GhosttyTerminalScrollbar", "len"),
    }
  }

  private getTerminalString(data: number): Uint8Array {
    const layout = this.runtime.layout("GhosttyString")
    this.runtime.bytes(this.scratch, layout.size).fill(0)
    this.assertSuccess("ghostty_terminal_get(string)", this.runtime.call("ghostty_terminal_get", this.terminal, data, this.scratch))
    const pointer = this.runtime.readField(this.scratch, "GhosttyString", "ptr")
    const length = this.runtime.readField(this.scratch, "GhosttyString", "len")
    return pointer === 0 || length === 0 ? new Uint8Array() : Uint8Array.from(this.runtime.bytes(pointer, length))
  }

  private getTerminalBool(data: number): boolean {
    return this.getTerminalU8(data) !== 0
  }

  private getTerminalU8(data: number): number {
    this.runtime.bytes(this.scratch, 1)[0] = 0
    this.assertSuccess("ghostty_terminal_get(u8)", this.runtime.call("ghostty_terminal_get", this.terminal, data, this.scratch))
    return this.runtime.bytes(this.scratch, 1)[0] ?? 0
  }

  private getTerminalU16(data: number): number {
    this.runtime.bytes(this.scratch, 2).fill(0)
    this.assertSuccess("ghostty_terminal_get(u16)", this.runtime.call("ghostty_terminal_get", this.terminal, data, this.scratch))
    return this.runtime.view(this.scratch, 2).getUint16(0, true)
  }

  private getTerminalU32(data: number): number {
    this.runtime.bytes(this.scratch, 4).fill(0)
    this.assertSuccess("ghostty_terminal_get(u32)", this.runtime.call("ghostty_terminal_get", this.terminal, data, this.scratch))
    return this.runtime.view(this.scratch, 4).getUint32(0, true)
  }

  private getTerminalUsize(data: number): number {
    return this.getTerminalU32(data)
  }

  private renderBool(data: number): boolean {
    this.runtime.bytes(this.scratch, 1)[0] = 0
    this.assertSuccess("ghostty_render_state_get(bool)", this.runtime.call("ghostty_render_state_get", this.renderState, data, this.scratch))
    return this.runtime.bytes(this.scratch, 1)[0] !== 0
  }

  private renderU16(data: number): number {
    this.runtime.bytes(this.scratch, 2).fill(0)
    this.assertSuccess("ghostty_render_state_get(u16)", this.runtime.call("ghostty_render_state_get", this.renderState, data, this.scratch))
    return this.runtime.view(this.scratch, 2).getUint16(0, true)
  }

  private renderU32(data: number): number {
    this.runtime.bytes(this.scratch, 4).fill(0)
    this.assertSuccess("ghostty_render_state_get(u32)", this.runtime.call("ghostty_render_state_get", this.renderState, data, this.scratch))
    return this.runtime.view(this.scratch, 4).getUint32(0, true)
  }

  private renderColor(data: number): CorpusObservation["renderColors"]["foreground"] {
    this.runtime.bytes(this.scratch, 3).fill(0)
    this.assertSuccess("ghostty_render_state_get(color)", this.runtime.call("ghostty_render_state_get", this.renderState, data, this.scratch))
    return this.readColor(this.scratch)
  }

  private renderPalette(): CorpusObservation["renderColors"]["palette"] {
    const size = 256 * 3
    const palette = this.runtime.alloc(size)
    try {
      this.assertSuccess(
        "ghostty_render_state_get(palette)",
        this.runtime.call("ghostty_render_state_get", this.renderState, RENDER_DATA.palette, palette),
      )
      return Array.from({ length: 256 }, (_, index) => this.readColor(palette + index * 3))
    } finally {
      this.runtime.free(palette, size)
    }
  }

  private rowSelection(): CorpusObservation["rows"][number]["selection"] {
    this.runtime.bytes(this.scratch, ROW_SELECTION_SIZE).fill(0)
    this.runtime.view(this.scratch, ROW_SELECTION_SIZE).setUint32(0, ROW_SELECTION_SIZE, true)
    const result = this.runtime.call("ghostty_render_state_row_get", this.rowIterator, ROW_DATA.selection, this.scratch)
    if (result === NO_VALUE) return null
    this.assertSuccess("ghostty_render_state_row_get(selection)", result)
    return {
      start: this.runtime.view(this.scratch, ROW_SELECTION_SIZE).getUint16(4, true),
      end: this.runtime.view(this.scratch, ROW_SELECTION_SIZE).getUint16(6, true),
    }
  }

  private cellStyle(
    defaultForeground: CorpusObservation["renderColors"]["foreground"],
    defaultBackground: CorpusObservation["renderColors"]["background"],
  ): CorpusObservation["rows"][number]["cells"][number]["style"] {
    this.runtime.bytes(this.style, this.styleSize).fill(0)
    this.runtime.setField(this.style, "GhosttyStyle", STYLE_SIZE_FIELD, this.styleSize)
    this.assertSuccess(
      "ghostty_render_state_row_cells_get(style)",
      this.runtime.call("ghostty_render_state_row_cells_get", this.cells, CELL_DATA.style, this.style),
    )
    let foreground = this.cellColor(CELL_DATA.foreground) ?? defaultForeground
    let background = this.cellColor(CELL_DATA.background) ?? defaultBackground
    const inverse = this.runtime.readField(this.style, "GhosttyStyle", "inverse") !== 0
    const faint = this.runtime.readField(this.style, "GhosttyStyle", "faint") !== 0
    if (inverse) [foreground, background] = [background, foreground]
    if (faint) {
      foreground = {
        r: Math.round((foreground.r + background.r) / 2),
        g: Math.round((foreground.g + background.g) / 2),
        b: Math.round((foreground.b + background.b) / 2),
      }
    }
    const underlineValue = this.runtime.readField(this.style, "GhosttyStyle", "underline")
    const underline = underlineValue === 0
      ? "none"
      : underlineValue === 1
        ? "single"
        : underlineValue === 2
          ? "double"
          : underlineValue === 3
            ? "curly"
            : underlineValue === 4
              ? "dotted"
              : underlineValue === 5
                ? "dashed"
                : this.invalidEnum("underline", underlineValue)
    return {
      foreground,
      background,
      foregroundSource: this.styleColor("fg_color"),
      backgroundSource: this.styleColor("bg_color"),
      underlineColorSource: this.styleColor("underline_color"),
      bold: this.runtime.readField(this.style, "GhosttyStyle", "bold") !== 0,
      italic: this.runtime.readField(this.style, "GhosttyStyle", "italic") !== 0,
      faint,
      blink: this.runtime.readField(this.style, "GhosttyStyle", "blink") !== 0,
      inverse,
      invisible: this.runtime.readField(this.style, "GhosttyStyle", "invisible") !== 0,
      strikethrough: this.runtime.readField(this.style, "GhosttyStyle", "strikethrough") !== 0,
      overline: this.runtime.readField(this.style, "GhosttyStyle", "overline") !== 0,
      underline,
    }
  }

  private styleColor(fieldName: "fg_color" | "bg_color" | "underline_color"): CorpusObservation["rows"][number]["cells"][number]["style"]["foregroundSource"] {
    const styleField = this.runtime.layout("GhosttyStyle").fields[fieldName]
    const valueField = this.runtime.layout("GhosttyStyleColor").fields.value
    if (!styleField || !valueField) throw new Error(`Ghostty style color layout is incomplete: ${fieldName}`)
    const pointer = this.style + styleField.offset
    const tag = this.runtime.readField(pointer, "GhosttyStyleColor", "tag")
    if (tag === 0) return { kind: "none" }
    if (tag === 1) return { kind: "palette", index: this.runtime.bytes(pointer + valueField.offset, 1)[0] ?? 0 }
    if (tag === 2) return { kind: "rgb", color: this.readColor(pointer + valueField.offset) }
    return this.invalidEnum("style color", tag)
  }

  private cellColor(data: number): CorpusObservation["renderColors"]["foreground"] | null {
    this.runtime.bytes(this.scratch, 3).fill(0)
    const result = this.runtime.call("ghostty_render_state_row_cells_get", this.cells, data, this.scratch)
    if (result === SUCCESS) return this.readColor(this.scratch)
    if (result === NO_VALUE || result === -2) return null
    this.assertSuccess("ghostty_render_state_row_cells_get(color)", result)
    return null
  }

  private cellBool(data: number): boolean {
    this.runtime.bytes(this.scratch, 1)[0] = 0
    this.assertSuccess(
      "ghostty_render_state_row_cells_get(bool)",
      this.runtime.call("ghostty_render_state_row_cells_get", this.cells, data, this.scratch),
    )
    return this.runtime.bytes(this.scratch, 1)[0] !== 0
  }

  private cellGrapheme(): Uint8Array {
    const layout = this.runtime.layout("GhosttyBuffer")
    const pointerField = layout.fields.ptr
    const capacityField = layout.fields.cap
    const lengthField = layout.fields.len
    if (!pointerField || !capacityField || !lengthField) {
      throw new Error("GhosttyBuffer public layout is incomplete")
    }
    const writeBuffer = () => {
      const view = this.runtime.view(this.graphemeStruct, layout.size)
      view.setUint32(pointerField.offset, this.grapheme, true)
      view.setUint32(capacityField.offset, this.graphemeCapacity, true)
      view.setUint32(lengthField.offset, 0, true)
    }
    writeBuffer()
    let result = this.runtime.call("ghostty_render_state_row_cells_get", this.cells, CELL_DATA.graphemeUtf8, this.graphemeStruct)
    let length = this.runtime.readField(this.graphemeStruct, "GhosttyBuffer", "len")
    if (result === OUT_OF_SPACE) {
      if (length > 16_384) throw new Error(`cell grapheme exceeds 16384 bytes: ${length}`)
      this.ensureGraphemeCapacity(length)
      writeBuffer()
      result = this.runtime.call("ghostty_render_state_row_cells_get", this.cells, CELL_DATA.graphemeUtf8, this.graphemeStruct)
      length = this.runtime.readField(this.graphemeStruct, "GhosttyBuffer", "len")
    }
    this.assertSuccess("ghostty_render_state_row_cells_get(grapheme)", result)
    if (length > this.graphemeCapacity) throw new Error(`cell grapheme returned invalid length ${length}`)
    return Uint8Array.from(this.runtime.bytes(this.grapheme, length))
  }

  private ensureGraphemeCapacity(required: number): void {
    if (required <= this.graphemeCapacity) return
    let capacity = 64
    while (capacity < required) capacity *= 2
    this.runtime.free(this.grapheme, this.graphemeCapacity)
    this.grapheme = this.runtime.alloc(capacity)
    this.graphemeCapacity = capacity
  }

  private getRawHandle(operation: string, owner: number, data: number): bigint {
    this.runtime.bytes(this.scratch, 8).fill(0)
    this.assertSuccess(operation, this.runtime.call(operation, owner, data, this.scratch))
    return this.runtime.view(this.scratch, 8).getBigUint64(0, true)
  }

  private rawBool(operation: string, owner: bigint, data: number): boolean {
    this.runtime.bytes(this.scratch, 1)[0] = 0
    this.assertSuccess(operation, this.runtime.call(operation, owner, data, this.scratch))
    return this.runtime.bytes(this.scratch, 1)[0] !== 0
  }

  private rawU32(operation: string, owner: bigint, data: number): number {
    this.runtime.bytes(this.scratch, 4).fill(0)
    this.assertSuccess(operation, this.runtime.call(operation, owner, data, this.scratch))
    return this.runtime.view(this.scratch, 4).getUint32(0, true)
  }

  private readString(pointer: number): string {
    const data = this.runtime.readField(pointer, "GhosttyString", "ptr")
    const length = this.runtime.readField(pointer, "GhosttyString", "len")
    return data === 0 || length === 0 ? "" : new TextDecoder().decode(this.runtime.bytes(data, length))
  }

  private readColor(pointer: number): CorpusObservation["renderColors"]["foreground"] {
    const bytes = this.runtime.bytes(pointer, 3)
    return { r: bytes[0] ?? 0, g: bytes[1] ?? 0, b: bytes[2] ?? 0 }
  }

  private invalidEnum(label: string, value: number): never {
    throw new Error(`Ghostty returned unknown ${label} value ${value}`)
  }

  private assertSuccess(operation: string, result: number): void {
    if (result !== SUCCESS) throw new Error(`${operation} failed with result ${result}`)
  }
}

async function runWasmCorpus() {
  const corpus = await loadTerminalCorpus()
  const fixtureResults: CorpusResult["fixtures"][number][] = []
  let revision: string | undefined
  for (const fixture of corpus.fixtures) {
    const terminal = await WasmCorpusTerminal.create(fixture.definition)
    try {
      const fixtureRevision = terminal.revision()
      revision ??= fixtureRevision
      if (fixtureRevision !== revision) throw new Error(`${fixture.definition.id} WASM revision changed during the corpus`)
      const observations: CorpusObservation[] = []
      fixture.definition.events.forEach((event, eventIndex) => {
        terminal.apply(event, fixture.payload, eventIndex)
        if (event.type === "observe") {
          const observation = terminal.observe(event.id, eventIndex, corpus.manifest.modes)
          assertHandAuthoredObservation(fixture, observation)
          observations.push(observation)
        }
      })
      fixtureResults.push({
        id: fixture.definition.id,
        sourceLength: fixture.payload.byteLength,
        sourceSha256: fixture.definition.bytes.sha256,
        observations,
      })
    } finally {
      terminal.dispose()
    }
  }
  if (revision === undefined) throw new Error("terminal corpus contains no fixtures")
  const output = CorpusResult.make({
    normalizerVersion: CORPUS_NORMALIZER_VERSION,
    revision,
    runner: "wasm",
    fixtures: fixtureResults,
  })
  const json = JSON.stringify(output, null, 2)
  validateCorpusResult(json, corpus.manifest)
  return { corpus, output, json }
}

test("WASM Ghostty satisfies the deterministic corpus and hand-authored assertions", async () => {
  const { corpus, output, json } = await runWasmCorpus()
  assert.equal(output.fixtures.length, corpus.fixtures.length)
  const outputPath = process.env.YAADE_GHOSTTY_CORPUS_OUTPUT
  if (outputPath) await writeFile(outputPath, json)
}, 30_000)
