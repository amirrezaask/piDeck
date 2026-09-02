import * as React from "react"
import { XIcon } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { yaadeOverlayContentClass, type YaadeOverlayMotion } from "@/motion/tokens"

export type YaadeDialogSize = "default" | "prompt" | "picker" | "wide" | "stage"
export type YaadeDialogPlacement = "center" | "quick-input"

const dialogSizeClass = {
  default: "sm:max-w-lg",
  prompt: "sm:max-w-sm",
  picker: "sm:max-w-[32rem]",
  wide: "sm:max-w-[42rem]",
  stage:
    "h-dvh w-screen max-h-none max-w-none gap-0 overflow-hidden p-0 rounded-none sm:max-w-none sm:rounded-none",
} satisfies Record<YaadeDialogSize, string>

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  motion = "standard",
  placement = "center",
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay> & {
  motion?: YaadeOverlayMotion
  placement?: YaadeDialogPlacement
}) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "yaade-dialog-overlay fixed inset-0 z-50 overscroll-contain",
        placement === "quick-input"
          ? "bg-transparent"
          : "bg-backdrop",
        className
      )}
      data-yaade-dialog-motion={motion}
      data-yaade-dialog-placement={placement}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  motion = "standard",
  size = "default",
  placement = "center",
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
  motion?: YaadeOverlayMotion
  size?: YaadeDialogSize
  placement?: YaadeDialogPlacement
}) {
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay motion={motion} placement={placement} />
      {/* Keep positioning off the animated node so enter transforms cannot clobber it. */}
      <div
        className={cn(
          "pointer-events-none fixed inset-0 z-50 flex justify-center px-4",
          placement === "quick-input"
            ? "items-start pt-[var(--yaade-quick-input-top)]"
            : "items-center",
        )}
        data-yaade-dialog-placement={placement}
      >
        <DialogPrimitive.Content
          data-slot="dialog-content"
          className={cn(
            "pointer-events-auto grid w-full max-w-[calc(100%-2rem)] gap-4 rounded-xl border border-border bg-popover p-5 shadow-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            dialogSizeClass[size],
            yaadeOverlayContentClass,
            className
          )}
          data-yaade-dialog-motion={motion}
          data-yaade-dialog-size={size}
          data-yaade-dialog-placement={placement}
          {...props}
        >
          {children}
          {showCloseButton && (
            <DialogPrimitive.Close
              data-slot="dialog-close"
              className="absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-hidden disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
            >
              <XIcon />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Content>
      </div>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
