import type { YaadeTestAPI } from "./test-bridge.js"
import {
  findTerminalBufferMatch,
  focusRegisteredTerminal,
  maintainTerminalIdleCapacity,
  readTerminalBufferText,
  readTerminalCellHeight,
  readTerminalCellSize,
  readTerminalCursor,
  readTerminalDims,
  readTerminalLifecycle,
  readTerminalPixelStats,
  readTerminalViewportY,
  scrollTerminalLines,
} from "@yaade/ui/terminal-registry"

export function basicTestBridge(): YaadeTestAPI {
  return {
    getState: () => ({ route: "session" }),
    waitForReady: async () => undefined,
    getPerfMeasures: () => [],
    getTerminalText: id => readTerminalBufferText(id),
    getTerminalCellHeight: id => readTerminalCellHeight(id),
    getTerminalCellSize: id => readTerminalCellSize(id),
    getTerminalDims: id => readTerminalDims(id),
    getTerminalLifecycle: id => readTerminalLifecycle(id),
    maintainTerminalIdleCapacity: id => maintainTerminalIdleCapacity(id),
    getTerminalPixelStats: id => readTerminalPixelStats(id),
    getTerminalCursor: id => readTerminalCursor(id),
    getTerminalViewportY: id => readTerminalViewportY(id),
    scrollTerminalLines: (amount, id) => scrollTerminalLines(amount, id),
    focusTerminal: id => focusRegisteredTerminal(id),
    findTerminalText: (needle, id) => findTerminalBufferMatch(needle, id),
  }
}
