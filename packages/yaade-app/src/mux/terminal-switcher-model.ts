import type { AppSession, MuxTerminal, SessionTab } from "@yaade/rpc"
import { fuzzyScore } from "@yaade/ui/fuzzy"
import {
  TerminalFocusHistory,
  terminalFocusIdentityKey,
  type TerminalFocusIdentity,
} from "./terminal-focus-history.js"

export type TerminalStatusPreview = {
  readonly label: string
  readonly tone: "running" | "waiting" | "failed" | "interrupted" | "exited" | "starting"
}

export type TerminalSwitcherSourceEntry = {
  readonly identity: TerminalFocusIdentity
  readonly terminal: MuxTerminal
  readonly session: AppSession
  readonly tab: SessionTab
  readonly serverName: string
  readonly serverPosition: number
  readonly title: string
}

export type RankedTerminalSwitcherEntry = TerminalSwitcherSourceEntry & {
  readonly statusPreview: TerminalStatusPreview
  readonly recent: boolean
  readonly section?: "Recent" | "Other terminals"
  readonly searchText: string
}

export type TerminalSwitcherContext = {
  readonly activeSessionId?: string
  readonly activeTabId?: string
}

function statusWithExitCode(prefix: string, exitCode: number | undefined): string {
  return exitCode === undefined ? prefix : `${prefix} (${exitCode})`
}

/** Derives concise status solely from typed host metadata. */
export function terminalStatusPreview(terminal: MuxTerminal): TerminalStatusPreview {
  const process = terminal.output.processState
  const activity = terminal.output.activityState
  if (process === "failed" || terminal.status === "failed" || activity === "failed") {
    return {
      label: statusWithExitCode("Failed", terminal.output.exitCode),
      tone: "failed",
    }
  }
  if (
    process === "interrupted" ||
    process === "orphaned" ||
    process === "disconnected" ||
    terminal.status === "disconnected"
  ) {
    return { label: "Interrupted", tone: "interrupted" }
  }
  if (process === "exited") {
    return {
      label: statusWithExitCode("Exited", terminal.output.exitCode),
      tone: "exited",
    }
  }
  if (activity === "waiting_for_input" || terminal.status === "waiting") {
    return { label: "Waiting", tone: "waiting" }
  }
  if (process === "starting" || process === "restoring" || terminal.status === "starting") {
    return { label: "Starting", tone: "starting" }
  }
  return { label: "Running", tone: "running" }
}

function stableFallbackOrder(
  entries: readonly TerminalSwitcherSourceEntry[],
  context: TerminalSwitcherContext,
): TerminalSwitcherSourceEntry[] {
  return [...entries].sort((left, right) => {
    const leftContext = left.session.id === context.activeSessionId
      ? left.tab.id === context.activeTabId ? 0 : 1
      : 2
    const rightContext = right.session.id === context.activeSessionId
      ? right.tab.id === context.activeTabId ? 0 : 1
      : 2
    return leftContext - rightContext ||
      left.serverPosition - right.serverPosition ||
      left.session.position - right.session.position ||
      left.tab.position - right.tab.position ||
      left.terminal.position - right.terminal.position ||
      left.identity.serverId.localeCompare(right.identity.serverId) ||
      left.terminal.id.localeCompare(right.terminal.id)
  })
}

function searchableEntry(
  entry: TerminalSwitcherSourceEntry,
  recent: boolean,
): RankedTerminalSwitcherEntry {
  const statusPreview = terminalStatusPreview(entry.terminal)
  return {
    ...entry,
    statusPreview,
    recent,
    searchText: [
      entry.title,
      entry.serverName,
      entry.session.title,
      entry.tab.title,
      statusPreview.label,
      entry.terminal.kind,
    ].join(" "),
  }
}

export function rankTerminalSwitcherEntries(
  entries: readonly TerminalSwitcherSourceEntry[],
  history: TerminalFocusHistory,
  context: TerminalSwitcherContext,
  query = "",
): readonly RankedTerminalSwitcherEntry[] {
  const fallback = stableFallbackOrder(entries, context)
  const byIdentity = new Map(
    fallback.map(entry => [terminalFocusIdentityKey(entry.identity), entry]),
  )
  const rankedIdentities = history.rank(fallback.map(entry => entry.identity))
  const ranked = rankedIdentities.flatMap(identity => {
    const entry = byIdentity.get(terminalFocusIdentityKey(identity))
    return entry ? [searchableEntry(entry, history.has(identity))] : []
  })
  const trimmedQuery = query.trim()
  if (trimmedQuery) {
    const mruPosition = new Map(ranked.map((entry, index) => [entry.terminal.id, index]))
    return ranked
      .flatMap(entry => {
        const score = fuzzyScore(trimmedQuery, entry.searchText)
        return score === null ? [] : [{ entry, score }]
      })
      .sort((left, right) =>
        left.score - right.score ||
        (mruPosition.get(left.entry.terminal.id) ?? Number.MAX_SAFE_INTEGER) -
          (mruPosition.get(right.entry.terminal.id) ?? Number.MAX_SAFE_INTEGER) ||
        left.entry.searchText.localeCompare(right.entry.searchText),
      )
      .map(item => item.entry)
  }

  let recentStarted = false
  let otherStarted = false
  return ranked.map(entry => {
    if (entry.recent && !recentStarted) {
      recentStarted = true
      return { ...entry, section: "Recent" }
    }
    if (!entry.recent && !otherStarted) {
      otherStarted = true
      return { ...entry, section: "Other terminals" }
    }
    return entry
  })
}
