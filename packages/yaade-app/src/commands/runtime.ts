import {
  commandDescriptor,
  type CommandAvailabilityKey,
  type CommandDescriptor,
  type CommandId,
} from "./catalog.js"

export type CommandAvailability =
  | { readonly status: "enabled" }
  | { readonly status: "disabled"; readonly reason: string }

export type CommandContext = {
  readonly hasActiveSession: boolean
  readonly hasActiveTab: boolean
  readonly hasActiveTerminal: boolean
  readonly availableTerminalCount: number
  readonly activeTabTerminalCount: number
  readonly tabCount: number
  readonly sidebarLayout: boolean
  readonly viewportMode: "live" | "inspecting" | "paused" | "unavailable"
  readonly viewportCanPause: boolean
}

export type CommandInvocation = {
  readonly source: "keyboard" | "palette" | "pointer" | "native-menu" | "which-key"
  readonly jumpIndex?: number
}

export type CommandHandler = (
  invocation: CommandInvocation,
) => void | Promise<void>

export type CommandHandlers = {
  readonly [Id in CommandId]: CommandHandler
}

export type CommandExecutionResult =
  | { readonly status: "executed" }
  | { readonly status: "disabled"; readonly reason: string }
  | { readonly status: "failed" }

export type CommandRuntime = {
  readonly availability: (id: CommandId) => CommandAvailability
  readonly execute: (
    id: CommandId,
    invocation: CommandInvocation,
  ) => Promise<CommandExecutionResult>
}

const ENABLED: CommandAvailability = { status: "enabled" }

function disabled(reason: string): CommandAvailability {
  return { status: "disabled", reason }
}

function availabilityFor(
  key: CommandAvailabilityKey,
  context: CommandContext,
): CommandAvailability {
  switch (key) {
    case "always":
      return ENABLED
    case "activeSession":
      return context.hasActiveSession ? ENABLED : disabled("Open or create a session first.")
    case "activeTab":
      return context.hasActiveTab ? ENABLED : disabled("Open or create a Window first.")
    case "activeTerminal":
      return context.hasActiveTerminal ? ENABLED : disabled("Focus a terminal first.")
    case "anyTerminal":
      return context.availableTerminalCount > 0
        ? ENABLED
        : disabled("No terminals are available.")
    case "multipleTabs":
      return context.tabCount > 1 ? ENABLED : disabled("No other Window is available.")
    case "multipleTerminals":
      return context.activeTabTerminalCount > 1
        ? ENABLED
        : disabled("No other terminal is available in this Window.")
    case "multipleAvailableTerminals":
      return context.availableTerminalCount > 1
        ? ENABLED
        : disabled("No other terminal is available.")
    case "sidebarLayout":
      return context.sidebarLayout
        ? ENABLED
        : disabled("Choose a sidebar layout in Settings first.")
    case "viewportNotLive":
      return context.viewportMode === "inspecting" || context.viewportMode === "paused"
        ? ENABLED
        : disabled("The focused terminal is already showing live output.")
    case "viewportPausable":
      return context.viewportCanPause
        ? ENABLED
        : disabled("The focused terminal has no scrollback to pause.")
  }
}

export function commandAvailability(
  descriptor: CommandDescriptor,
  context: CommandContext,
): CommandAvailability {
  return availabilityFor(descriptor.availability, context)
}

export function createCommandRuntime(options: {
  readonly context: () => CommandContext
  readonly handlers: CommandHandlers
  readonly onError?: (message: string) => void
}): CommandRuntime {
  const availability = (id: CommandId) =>
    commandAvailability(commandDescriptor(id), options.context())

  return {
    availability,
    execute: async (id, invocation) => {
      const current = availability(id)
      if (current.status === "disabled") return current
      try {
        await options.handlers[id](invocation)
        return { status: "executed" }
      } catch (error) {
        options.onError?.(
          error instanceof Error ? error.message : "The command could not be completed.",
        )
        return { status: "failed" }
      }
    },
  }
}
