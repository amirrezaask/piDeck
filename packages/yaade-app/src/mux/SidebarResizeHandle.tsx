import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { cn } from "@yaade/ui/session";

type SidebarResizeHandleProps = {
  value: number;
  min: number;
  max: number;
  side: "left" | "right";
  label: string;
  onChange: (value: number) => void;
};

/** Keyboard and pointer resize rail for the session shell sidebars. */
export function SidebarResizeHandle({
  value,
  min,
  max,
  side,
  label,
  onChange,
}: SidebarResizeHandleProps) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const bodyStyleRef = useRef<{ cursor: string; userSelect: string } | null>(
    null,
  );

  const finishDrag = useCallback(() => {
    dragRef.current = null;
    if (bodyStyleRef.current) {
      document.body.style.cursor = bodyStyleRef.current.cursor;
      document.body.style.userSelect = bodyStyleRef.current.userSelect;
      bodyStyleRef.current = null;
    }
  }, []);

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const direction = side === "left" ? 1 : -1;
      const next = drag.startWidth + (event.clientX - drag.startX) * direction;
      onChange(Math.max(min, Math.min(max, Math.round(next))));
    },
    [max, min, onChange, side],
  );

  useEffect(() => {
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
      finishDrag();
    };
  }, [finishDrag, handlePointerMove]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    dragRef.current = { startX: event.clientX, startWidth: value };
    bodyStyleRef.current = {
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const physicalDirection =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (physicalDirection === 0 && event.key !== "Home" && event.key !== "End")
      return;
    event.preventDefault();
    if (event.key === "Home") {
      onChange(min);
      return;
    }
    if (event.key === "End") {
      onChange(max);
      return;
    }
    const direction = side === "left" ? physicalDirection : -physicalDirection;
    onChange(Math.max(min, Math.min(max, value + direction * 10)));
  };

  return (
    <div
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemax={max}
      aria-valuemin={min}
      aria-valuenow={Math.round(value)}
      className={cn(
        "group absolute inset-y-0 z-30 hidden w-2 -translate-x-1/2 cursor-col-resize items-center justify-center outline-none md:flex",
        side === "right" && "translate-x-1/2",
      )}
      onKeyDown={handleKeyDown}
      onPointerDown={handlePointerDown}
      role="separator"
      style={side === "left" ? { left: `${value}px` } : { right: `${value}px` }}
      tabIndex={0}
      title={`${label}. Drag to resize.`}
    >
      <span className="h-full w-px bg-border/0 transition-colors duration-[var(--yaade-motion-fast)] group-hover:bg-sidebar-ring group-focus-visible:bg-sidebar-ring" />
    </div>
  );
}
