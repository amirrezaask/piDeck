import { KeyBindingKbd } from "@/components/KeyBindingKbd.js"
import { cn } from "@/lib/utils.js"

export type WhichKeyEntry = {
  key: string
  desc: string
  group?: string
}

export type WhichKeyGroup = {
  id: string
  label: string
}

export function WhichKeyPanel({
  prefix,
  entries,
  groups,
  onSelect,
  variant = "bar",
}: {
  prefix: string
  entries: WhichKeyEntry[]
  groups?: readonly WhichKeyGroup[]
  onSelect?: (key: string) => void
  variant?: "bar" | "overlay"
}) {
  const clustered = clusterEntries(entries, groups)
  const overlay = variant === "overlay"

  return (
    <div
      className={cn(
        overlay
          ? "rounded-md border border-border bg-popover shadow-lg"
          : "border-t border-primary/35 bg-popover px-4 py-2.5",
      )}
      data-yaade-which-key=""
      data-yaade-glass-surface={overlay ? "" : undefined}
      data-yaade-glass-material={overlay ? "floating" : undefined}
      data-variant={variant}
      role="dialog"
      aria-label="Prefix commands"
    >
      <div
        className={cn(
          "flex items-baseline gap-2 text-xs text-foreground",
          overlay
            ? "border-b border-border px-3 py-2"
            : "mb-2",
        )}
      >
        <KeyBindingKbd binding={prefix} />
        <span className="text-muted-foreground">then</span>
      </div>
      <div
        className={cn(
          overlay
            ? "grid grid-cols-1 gap-4 p-3 sm:grid-cols-3"
            : "flex flex-wrap gap-x-6 gap-y-2",
        )}
      >
        {clustered.map(cluster => (
          <div key={cluster.id} className="flex min-w-0 flex-col gap-1">
            {cluster.label ? (
              <p className="px-1 text-3xs font-medium tracking-wide text-muted-foreground uppercase">
                {cluster.label}
              </p>
            ) : null}
            <div className={overlay ? "flex flex-col gap-0.5" : "flex flex-wrap gap-x-6 gap-y-2"}>
              {cluster.items.map(entry => {
                const row = (
                  <>
                    <KeyBindingKbd
                      binding={entry.key}
                      className="min-w-5 justify-center"
                    />
                    <span className="min-w-0 truncate text-sm text-muted-foreground">
                      {entry.desc}
                    </span>
                  </>
                )
                if (!onSelect) {
                  return (
                    <div key={entry.key} className="flex min-w-[148px] items-baseline gap-2">
                      {row}
                    </div>
                  )
                }
                return (
                  <button
                    key={entry.key}
                    type="button"
                    data-yaade-which-key-item={entry.key}
                    aria-label={`${entry.desc} (${entry.key})`}
                    className="group/which-key yaade-press flex min-h-9 w-full items-center gap-2 rounded-md border border-border/70 bg-secondary/25 px-2 py-1.5 text-left text-foreground outline-none transition-[background-color,border-color,color,box-shadow] duration-[var(--yaade-motion-hot)] hover:border-primary/45 hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
                    onClick={() => onSelect(entry.key)}
                  >
                    <KeyBindingKbd
                      binding={entry.key}
                      className="min-w-6 justify-center border border-border/80 bg-background/80 text-foreground shadow-xs transition-colors duration-[var(--yaade-motion-hot)] group-hover/which-key:border-primary/35 group-hover/which-key:bg-primary/10 group-hover/which-key:text-primary"
                    />
                    <span className="min-w-0 truncate text-sm text-muted-foreground transition-colors duration-[var(--yaade-motion-hot)] group-hover/which-key:text-accent-foreground">
                      {entry.desc}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function clusterEntries(
  entries: WhichKeyEntry[],
  groups?: readonly WhichKeyGroup[],
): readonly { id: string; label: string; items: WhichKeyEntry[] }[] {
  if (!groups || groups.length === 0) {
    return [{ id: "all", label: "", items: entries }]
  }
  return groups
    .map(group => ({
      id: group.id,
      label: group.label,
      items: entries.filter(entry => entry.group === group.id),
    }))
    .filter(group => group.items.length > 0)
}
