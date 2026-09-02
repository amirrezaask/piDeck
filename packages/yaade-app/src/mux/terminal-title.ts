import type { MuxTerminal } from "@yaade/rpc";

export type RuntimeTerminalTitle = {
  readonly title: string;
  readonly source: "prompt" | "terminal";
};

export function compactTerminalTitle(value: string, maxLength = 72): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

export function muxTerminalWorkTitle(
  terminal: MuxTerminal,
  runtimeTitle?: RuntimeTerminalTitle,
): string {
  return (
    runtimeTitle?.title ||
    compactTerminalTitle(terminal.title) ||
    "Terminal"
  );
}

export function muxTerminalDisplayTitle(
  terminal: MuxTerminal,
  runtimeTitle?: RuntimeTerminalTitle,
): string {
  return muxTerminalWorkTitle(terminal, runtimeTitle);
}

function isWorkingDirectoryTitle(value: string): boolean {
  return value === "~" || value.startsWith("~/") || value.startsWith("/");
}

/** Pane chrome omits terminal working-directory titles while keeping process names. */
export function muxTerminalPaneTitle(
  terminal: MuxTerminal,
  runtimeTitle?: RuntimeTerminalTitle,
): string {
  const title = muxTerminalWorkTitle(terminal, runtimeTitle);
  if (runtimeTitle?.source !== "terminal") return title;
  return title
    .split(" · ")
    .filter((part) => !isWorkingDirectoryTitle(part))
    .join(" · ");
}

export function nextRuntimeTerminalTitle(
  terminal: MuxTerminal,
  current: RuntimeTerminalTitle | undefined,
  title: string,
  source: RuntimeTerminalTitle["source"],
): RuntimeTerminalTitle | undefined {
  const next = compactTerminalTitle(title);
  if (!next) return current;

  if (source === "prompt") {
    return current?.source === "terminal" ? current : { title: next, source };
  }

  const normalized = next.toLowerCase();
  const stored = compactTerminalTitle(terminal.title).toLowerCase();
  if (
    terminal.kind === "terminal" &&
    (normalized === "terminal" || normalized === stored)
  ) {
    return current;
  }
  return { title: next, source };
}
