import { Slot } from "radix-ui"
import type {
  ComponentPropsWithoutRef,
  ElementRef,
  ReactNode,
  Ref,
} from "react"
import { cn } from "../lib/utils.js"

export type GlassMaterial = "shell" | "chrome" | "content" | "floating"

export type GlassSurfaceProps = ComponentPropsWithoutRef<"div"> & {
  ref?: Ref<ElementRef<"div">>
  material: GlassMaterial
  interactive?: boolean
  elevated?: boolean
  asChild?: boolean
}

export function GlassSurface({
  material,
  interactive = false,
  elevated = false,
  asChild = false,
  className,
  ref,
  ...props
}: GlassSurfaceProps) {
  const Comp = asChild ? Slot.Root : "div"
  return (
    <Comp
      ref={ref}
      data-yaade-glass-surface=""
      data-yaade-glass-material={material}
      data-yaade-glass-interactive={interactive ? "true" : undefined}
      data-yaade-glass-elevated={elevated ? "true" : undefined}
      className={cn("yaade-glass-surface", className)}
      {...props}
    />
  )
}

export type GlassControlGroupProps = Omit<GlassSurfaceProps, "material"> & {
  children?: ReactNode
}

export function GlassControlGroup({ className, children, ...props }: GlassControlGroupProps) {
  return (
    <GlassSurface
      material="floating"
      interactive
      className={cn("yaade-glass-control-group", className)}
      {...props}
    >
      {children}
    </GlassSurface>
  )
}

export type GlassDividerProps = ComponentPropsWithoutRef<"span"> & {
  orientation?: "horizontal" | "vertical"
}

export function GlassDivider({
  orientation = "horizontal",
  className,
  ...props
}: GlassDividerProps) {
  return (
    <span
      role="separator"
      aria-orientation={orientation}
      data-orientation={orientation}
      className={cn("yaade-glass-divider", className)}
      {...props}
    />
  )
}

export type GlassFocusRingProps = ComponentPropsWithoutRef<"div"> & {
  asChild?: boolean
}

export function GlassFocusRing({
  asChild = false,
  className,
  ...props
}: GlassFocusRingProps) {
  const Comp = asChild ? Slot.Root : "div"
  return <Comp className={cn("yaade-glass-focus-ring", className)} {...props} />
}

export type AmbientCanvasProps = ComponentPropsWithoutRef<"div"> & {
  asChild?: boolean
}

export function AmbientCanvas({
  asChild = false,
  className,
  ...props
}: AmbientCanvasProps) {
  const Comp = asChild ? Slot.Root : "div"
  return <Comp className={cn("yaade-ambient-canvas", className)} {...props} />
}
