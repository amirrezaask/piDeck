export type TerminalViewportActivityLabels = {
  readonly visual: string
  readonly accessible: string
}

export function terminalViewportActivityLabels(
  count: number | null,
): TerminalViewportActivityLabels {
  if (count === null) {
    return {
      visual: "New output",
      accessible: "New output. Jump to live",
    }
  }
  if (count === 0) {
    return {
      visual: "Jump to live",
      accessible: "Jump to live",
    }
  }
  const rows = `new row${count === 1 ? "" : "s"}`
  return {
    visual: `${count > 999 ? "999+" : count} ${rows}`,
    accessible: count <= 999_999
      ? `${count} ${rows}. Jump to live`
      : "More than 999,999 new rows. Jump to live",
  }
}
