export const COMMAND_IDS = [
  "commandPalette.show",
  "terminal.newTerminal",
  "terminal.next",
  "terminal.previous",
  "tab.next",
  "tab.previous",
  "pane.zoom",
  "pane.splitRight",
  "pane.splitDown",
  "terminal.switch",
  "terminal.switchPrevious",
  "sidebar.toggle",
  "session.switch",
  "terminal.jump",
  "terminal.jumpLive",
  "terminal.toggleInspectionPause",
  "session.new",
  "tab.new",
  "tab.close",
  "terminal.close",
  "session.close",
  "settings.show",
  "keymap.reset",
] as const

export type CommandId = (typeof COMMAND_IDS)[number]

export type CommandCategoryId =
  | "navigation"
  | "terminal"
  | "window"
  | "session"
  | "workspace"

export type CommandIconKey =
  | "command"
  | "terminal"
  | "arrowRight"
  | "arrowLeft"
  | "arrowDown"
  | "pause"
  | "windowNext"
  | "windowPrevious"
  | "maximize"
  | "splitRight"
  | "splitDown"
  | "search"
  | "sidebar"
  | "sessions"
  | "plus"
  | "close"
  | "settings"

export type CommandAvailabilityKey =
  | "always"
  | "activeSession"
  | "activeTab"
  | "activeTerminal"
  | "anyTerminal"
  | "multipleTabs"
  | "multipleTerminals"
  | "multipleAvailableTerminals"
  | "sidebarLayout"
  | "viewportNotLive"
  | "viewportPausable"

export type CommandDescriptor = {
  readonly id: CommandId
  readonly title: string
  readonly category: CommandCategoryId
  readonly aliases: readonly string[]
  readonly icon: CommandIconKey
  readonly availability: CommandAvailabilityKey
  readonly repeat: "allow" | "suppress"
  readonly bindingId?: string
  readonly palette?: boolean
}

export const COMMAND_CATEGORIES: readonly {
  readonly id: CommandCategoryId
  readonly label: string
}[] = [
  { id: "navigation", label: "Navigation" },
  { id: "terminal", label: "Terminal" },
  { id: "window", label: "Window" },
  { id: "session", label: "Session" },
  { id: "workspace", label: "Workspace" },
]

export const COMMAND_CATALOG: readonly CommandDescriptor[] = [
  {
    id: "commandPalette.show",
    title: "Show commands",
    category: "navigation",
    aliases: ["command palette", "actions", "find command"],
    icon: "command",
    availability: "always",
    repeat: "suppress",
    bindingId: "prefix.commands",
    palette: false,
  },
  {
    id: "terminal.switch",
    title: "Switch terminal",
    category: "navigation",
    aliases: ["find terminal", "jump terminal", "terminal palette"],
    icon: "search",
    availability: "anyTerminal",
    repeat: "suppress",
    bindingId: "prefix.terminal.switch",
  },
  {
    id: "terminal.switchPrevious",
    title: "Switch to previous terminal",
    category: "navigation",
    aliases: ["last terminal", "toggle terminal", "back terminal"],
    icon: "windowPrevious",
    availability: "multipleAvailableTerminals",
    repeat: "suppress",
    bindingId: "prefix.terminal.switchPrevious",
  },
  {
    id: "session.switch",
    title: "Switch session",
    category: "navigation",
    aliases: ["find session", "session palette", "workspace"],
    icon: "sessions",
    availability: "always",
    repeat: "suppress",
    bindingId: "prefix.session.switch",
  },
  {
    id: "terminal.next",
    title: "Next terminal",
    category: "navigation",
    aliases: ["cycle terminal", "forward"],
    icon: "arrowRight",
    availability: "multipleTerminals",
    repeat: "allow",
    bindingId: "prefix.terminal.next",
  },
  {
    id: "terminal.previous",
    title: "Previous terminal",
    category: "navigation",
    aliases: ["cycle terminal", "back"],
    icon: "arrowLeft",
    availability: "multipleTerminals",
    repeat: "allow",
    bindingId: "prefix.terminal.previous",
  },
  {
    id: "tab.next",
    title: "Next Window",
    category: "navigation",
    aliases: ["cycle window", "next tab"],
    icon: "windowNext",
    availability: "multipleTabs",
    repeat: "allow",
    bindingId: "prefix.tab.next",
  },
  {
    id: "tab.previous",
    title: "Previous Window",
    category: "navigation",
    aliases: ["cycle window", "previous tab"],
    icon: "windowPrevious",
    availability: "multipleTabs",
    repeat: "allow",
    bindingId: "prefix.tab.previous",
  },
  {
    id: "terminal.jump",
    title: "Jump to terminal by position",
    category: "navigation",
    aliases: ["terminal number", "terminal index"],
    icon: "terminal",
    availability: "anyTerminal",
    repeat: "suppress",
    bindingId: "prefix.terminal.jump",
    palette: false,
  },
  {
    id: "terminal.jumpLive",
    title: "Jump to live output",
    category: "navigation",
    aliases: ["scroll bottom", "latest output", "resume terminal"],
    icon: "arrowDown",
    availability: "viewportNotLive",
    repeat: "suppress",
    bindingId: "prefix.terminal.jumpLive",
  },
  {
    id: "terminal.toggleInspectionPause",
    title: "Toggle output inspection pause",
    category: "terminal",
    aliases: ["pause output", "resume inspection", "freeze viewport"],
    icon: "pause",
    availability: "viewportPausable",
    repeat: "suppress",
    bindingId: "prefix.terminal.toggleInspectionPause",
  },
  {
    id: "terminal.newTerminal",
    title: "New terminal",
    category: "terminal",
    aliases: ["create terminal", "shell"],
    icon: "terminal",
    availability: "activeSession",
    repeat: "suppress",
    bindingId: "prefix.terminal.new",
  },
  {
    id: "terminal.close",
    title: "Close terminal",
    category: "terminal",
    aliases: ["archive terminal", "stop terminal"],
    icon: "close",
    availability: "activeTerminal",
    repeat: "suppress",
    bindingId: "prefix.terminal.close",
  },
  {
    id: "pane.zoom",
    title: "Toggle pane zoom",
    category: "terminal",
    aliases: ["maximize pane", "restore pane"],
    icon: "maximize",
    availability: "activeTerminal",
    repeat: "suppress",
    bindingId: "prefix.pane.zoom",
  },
  {
    id: "pane.splitRight",
    title: "Split right",
    category: "terminal",
    aliases: ["split pane horizontal", "new pane right"],
    icon: "splitRight",
    availability: "activeTab",
    repeat: "suppress",
    bindingId: "direct.pane.splitRight",
  },
  {
    id: "pane.splitDown",
    title: "Split down",
    category: "terminal",
    aliases: ["split pane vertical", "new pane below"],
    icon: "splitDown",
    availability: "activeTab",
    repeat: "suppress",
    bindingId: "direct.pane.splitDown",
  },
  {
    id: "tab.new",
    title: "New Window",
    category: "window",
    aliases: ["create window", "new tab"],
    icon: "plus",
    availability: "activeSession",
    repeat: "suppress",
    bindingId: "prefix.tab.new",
  },
  {
    id: "tab.close",
    title: "Close Window",
    category: "window",
    aliases: ["archive window", "close tab"],
    icon: "close",
    availability: "activeTab",
    repeat: "suppress",
    bindingId: "prefix.tab.close",
  },
  {
    id: "session.new",
    title: "New session",
    category: "session",
    aliases: ["create session", "workspace"],
    icon: "plus",
    availability: "always",
    repeat: "suppress",
    bindingId: "prefix.session.new",
  },
  {
    id: "session.close",
    title: "Close session",
    category: "session",
    aliases: ["archive session", "stop session"],
    icon: "close",
    availability: "activeSession",
    repeat: "suppress",
    bindingId: "prefix.session.close",
  },
  {
    id: "sidebar.toggle",
    title: "Toggle sidebar",
    category: "workspace",
    aliases: ["show sidebar", "hide sidebar", "navigation"],
    icon: "sidebar",
    availability: "sidebarLayout",
    repeat: "suppress",
    bindingId: "direct.sidebar.toggle",
  },
  {
    id: "settings.show",
    title: "Open settings",
    category: "workspace",
    aliases: ["preferences", "appearance", "servers"],
    icon: "settings",
    availability: "always",
    repeat: "suppress",
    bindingId: "direct.settings.show",
  },
  {
    id: "keymap.reset",
    title: "Reset keyboard shortcuts",
    category: "workspace",
    aliases: ["restore keymap", "default bindings", "keyboard recovery"],
    icon: "settings",
    availability: "always",
    repeat: "suppress",
    bindingId: "prefix.keymap.reset",
  },
]

export function commandDescriptor(id: CommandId): CommandDescriptor {
  const descriptor = COMMAND_CATALOG.find(item => item.id === id)
  if (!descriptor) throw new Error(`Missing command descriptor: ${id}`)
  return descriptor
}

export function commandCategoryLabel(id: CommandCategoryId): string {
  return COMMAND_CATEGORIES.find(category => category.id === id)?.label ?? id
}

export function paletteCommandDescriptors(): readonly CommandDescriptor[] {
  return COMMAND_CATALOG.filter(descriptor => descriptor.palette !== false)
}

export function validateCommandCatalog(
  catalog: readonly CommandDescriptor[],
  commandIds: readonly CommandId[] = COMMAND_IDS,
): readonly string[] {
  const issues: string[] = []
  const ids = new Set<string>()
  const expectedIds = new Set<string>(commandIds)
  for (const descriptor of catalog) {
    if (ids.has(descriptor.id)) issues.push(`duplicate command id: ${descriptor.id}`)
    ids.add(descriptor.id)
    if (!descriptor.title.trim()) issues.push(`missing command title: ${descriptor.id}`)
    if (descriptor.aliases.some(alias => !alias.trim())) {
      issues.push(`empty command alias: ${descriptor.id}`)
    }
  }
  for (const id of commandIds) {
    if (!ids.has(id)) issues.push(`missing command descriptor: ${id}`)
  }
  for (const id of ids) {
    if (!expectedIds.has(id)) issues.push(`unknown command descriptor: ${id}`)
  }
  return issues
}
