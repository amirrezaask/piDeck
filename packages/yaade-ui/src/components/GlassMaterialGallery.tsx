import { useState } from "react"
import { Check, Command, Search, Terminal } from "lucide-react"
import { cn } from "../lib/utils.js"
import {
  AmbientCanvas,
  GlassControlGroup,
  GlassDivider,
  GlassFocusRing,
  GlassSurface,
  type GlassMaterial,
} from "./glass.js"

const materials: readonly GlassMaterial[] = [
  "shell",
  "chrome",
  "content",
  "floating",
]

const materialDescriptions = {
  shell: "Application frame and structural navigation",
  chrome: "Tabs, pane headers, and compact controls",
  content: "Matte work surfaces for terminal content",
  floating: "Search, palette, menus, and temporary actions",
} satisfies Record<GlassMaterial, string>

export function GlassMaterialGallery() {
  const [busyCanvas, setBusyCanvas] = useState(false)
  const [selectedMaterial, setSelectedMaterial] = useState<GlassMaterial>("chrome")

  return (
    <AmbientCanvas
      className={cn(
        "min-h-full overflow-auto p-6 text-foreground sm:p-10",
        busyCanvas && "yaade-glass-gallery-busy",
      )}
      data-yaade-glass-gallery=""
    >
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-2xl">
            <p className="font-mono text-3xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              YAADE / material lab
            </p>
            <h1 className="mt-2 text-xl font-semibold tracking-[-0.03em]">
              Liquid glass
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
              The same milk-glass language in both schemes: a white frost film,
              saturated blur, and a bright refractive rim. The work surface
              stays matte so the terminal does not sit behind glass.
            </p>
          </div>
          <GlassSurface material="chrome" interactive asChild>
            <button
              type="button"
              className="yaade-glass-focus-ring px-3 py-2 text-xs font-medium"
              onClick={() => setBusyCanvas(value => !value)}
              aria-pressed={busyCanvas}
              aria-label={busyCanvas ? "Use void canvas" : "Use sample canvas"}
              data-yaade-glass-gallery-busy-toggle=""
            >
              {busyCanvas ? "Void canvas" : "Sample canvas"}
            </button>
          </GlassSurface>
        </header>

        <section
          className="grid gap-4 md:grid-cols-2"
          aria-label="Glass materials"
          data-yaade-glass-gallery-materials=""
        >
          {materials.map(material => (
            <GlassSurface
              key={material}
              material={material}
              interactive
              elevated={selectedMaterial === material}
              className="min-h-44 p-5"
              data-yaade-glass-gallery-material={material}
            >
              <button
                type="button"
                className="flex h-full w-full flex-col text-left outline-none"
                onClick={() => setSelectedMaterial(material)}
                aria-pressed={selectedMaterial === material}
              >
                <span className="flex items-center justify-between gap-3">
                  <span className="font-mono text-sm font-semibold">{material}</span>
                  {selectedMaterial === material ? (
                    <Check className="size-4 text-primary" aria-hidden />
                  ) : null}
                </span>
                <span className="mt-3 max-w-sm text-xs leading-relaxed text-muted-foreground">
                  {materialDescriptions[material]}
                </span>
                <span className="mt-auto pt-6 font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground/70">
                  fill / blur / elevation are tokenized
                </span>
              </button>
            </GlassSurface>
          ))}
        </section>

        <section className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]" aria-label="Material states">
          <GlassSurface material="shell" className="p-5" data-yaade-glass-gallery-shell="">
            <div className="flex items-center gap-3">
              <span className="font-mono text-3xs uppercase tracking-[0.12em] text-muted-foreground">
                Navigation shelf
              </span>
              <GlassDivider orientation="horizontal" className="flex-1" />
              <span className="font-mono text-3xs text-success">connected</span>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <GlassSurface material="chrome" interactive className="px-3 py-2 text-xs">
                Workspace
              </GlassSurface>
              <GlassSurface
                material="chrome"
                interactive
                elevated
                className="-translate-y-px px-3 py-2 text-xs font-medium"
              >
                Active tab
              </GlassSurface>
              <GlassSurface material="chrome" interactive className="px-3 py-2 text-xs text-muted-foreground">
                Other tab
              </GlassSurface>
            </div>
            <div className="mt-5 flex items-center justify-between gap-3 border-t border-border/40 pt-4 text-xs text-muted-foreground">
              <span className="font-mono">~/src/yaade</span>
              <span>3 terminals</span>
            </div>
          </GlassSurface>

          <GlassSurface material="content" className="p-5" data-yaade-glass-gallery-content="">
            <div className="flex items-center gap-2 text-xs font-medium">
              <Terminal className="size-4 text-muted-foreground" aria-hidden />
              Matte content
            </div>
            <pre className="mt-4 overflow-auto rounded-[var(--yaade-material-control-radius)] bg-background/80 p-4 font-mono text-3xs leading-relaxed text-muted-foreground">
{`$ pwd
~/src/yaade

ready for focused work`}
            </pre>
          </GlassSurface>
        </section>

        <section className="grid gap-4 md:grid-cols-2" aria-label="Floating examples">
          <GlassSurface material="floating" elevated className="p-4" data-yaade-glass-gallery-floating="palette">
            <div className="flex items-center gap-2 border-b border-border/40 pb-3">
              <Search className="size-4 text-muted-foreground" aria-hidden />
              <span className="text-sm">Quick open</span>
              <kbd className="ml-auto rounded border border-border/50 px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
                ⌘P
              </kbd>
            </div>
            <div className="mt-3 grid gap-1">
              {["MuxSessionApp.tsx", "materials.css", "GlassMaterialGallery.tsx"].map((item, index) => (
                <GlassFocusRing asChild key={item}>
                  <button
                    type="button"
                    className={cn(
                      "flex items-center gap-2 rounded-[var(--yaade-material-control-radius)] px-2.5 py-2 text-left text-xs",
                      index === 0 ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
                    )}
                  >
                    <Command className="size-3.5" aria-hidden />
                    {item}
                  </button>
                </GlassFocusRing>
              ))}
            </div>
          </GlassSurface>

          <GlassControlGroup className="self-start" data-yaade-glass-gallery-controls="">
            <GlassFocusRing asChild>
              <button type="button" className="rounded-[var(--yaade-material-control-radius)] px-3 py-2 text-xs hover:bg-accent">
                Split
              </button>
            </GlassFocusRing>
            <GlassFocusRing asChild>
              <button type="button" className="rounded-[var(--yaade-material-control-radius)] px-3 py-2 text-xs hover:bg-accent">
                Layout
              </button>
            </GlassFocusRing>
            <GlassFocusRing asChild>
              <button type="button" className="rounded-[var(--yaade-material-control-radius)] px-3 py-2 text-xs text-destructive hover:bg-destructive/10">
                Close
              </button>
            </GlassFocusRing>
          </GlassControlGroup>
        </section>
      </main>
    </AmbientCanvas>
  )
}
