import { Kbd, KbdGroup } from "@/components/ui/kbd.js"
import { formatKeyBinding } from "@/lib/format-key.js"
import { cn } from "@/lib/utils.js"

/**
 * Renders a key chord as kbd chips. Always runs {@link formatKeyBinding} so
 * abstract `Mod` never appears — shows ⌘/Ctrl by OS.
 */
export function KeyBindingKbd({
  binding,
  className,
}: {
  /** Raw chord (`Mod-Shift-g`) or already-formatted label. */
  binding: string
  className?: string
}) {
  const formatted = formatKeyBinding(binding)
  const parts = formatted.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return null
  if (parts.length === 1) {
    return <Kbd className={className}>{parts[0]}</Kbd>
  }
  return (
    <KbdGroup className={cn("gap-0.5", className)}>
      {parts.map((part, index) => (
        <Kbd key={`${part}-${index}`}>{part}</Kbd>
      ))}
    </KbdGroup>
  )
}
