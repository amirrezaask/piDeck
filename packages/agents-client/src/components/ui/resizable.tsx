import { GripHorizontalIcon, GripVerticalIcon } from 'lucide-react';
import {
  createContext,
  use,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { cn } from '@agents/lib/utils';

export type Orientation = 'horizontal' | 'vertical';
export type Layout = Record<string, number>;

type ResizeContextValue = {
  orientation: Orientation;
  layout: Layout;
  beginResize(event: ReactPointerEvent<HTMLDivElement>): void;
  resizeBy(delta: number): void;
};

const ResizeContext = createContext<ResizeContextValue | null>(null);

function ResizablePanelGroup({
  className,
  orientation = 'horizontal',
  defaultLayout,
  onLayoutChanged,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  orientation?: Orientation;
  defaultLayout: Layout;
  onLayoutChanged?: (layout: Layout, meta: { isUserInteraction: boolean }) => void;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState(defaultLayout);
  const ids = Object.keys(defaultLayout);
  const firstId = ids[0];
  const secondId = ids[1];

  useLayoutEffect(() => setLayout(defaultLayout), [defaultLayout]);

  const commitSecondSize = useCallback(
    (nextSecondSize: number) => {
      if (!firstId || !secondId) return;
      const clamped = Math.max(20, Math.min(75, nextSecondSize));
      const next = { [firstId]: 100 - clamped, [secondId]: clamped };
      setLayout(next);
      onLayoutChanged?.(next, { isUserInteraction: true });
    },
    [firstId, onLayoutChanged, secondId],
  );

  const beginResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!secondId) return;
      event.preventDefault();
      const root = rootRef.current;
      if (!root) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      const move = (pointerEvent: PointerEvent) => {
        const rect = root.getBoundingClientRect();
        const secondSize =
          orientation === 'vertical'
            ? ((rect.bottom - pointerEvent.clientY) / rect.height) * 100
            : ((rect.right - pointerEvent.clientX) / rect.width) * 100;
        commitSecondSize(secondSize);
      };
      const finish = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish, { once: true });
      window.addEventListener('pointercancel', finish, { once: true });
    },
    [commitSecondSize, orientation, secondId],
  );

  const value = useMemo<ResizeContextValue>(
    () => ({
      orientation,
      layout,
      beginResize,
      resizeBy(delta) {
        if (!secondId) return;
        commitSecondSize((layout[secondId] ?? 40) + delta);
      },
    }),
    [beginResize, commitSecondSize, layout, orientation, secondId],
  );

  return (
    <ResizeContext value={value}>
      <div
        ref={rootRef}
        data-slot="resizable-panel-group"
        data-orientation={orientation}
        className={cn(
          'flex h-full w-full bg-transparent data-[orientation=vertical]:flex-col',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </ResizeContext>
  );
}

function ResizablePanel({
  id,
  className,
  style,
  children,
  defaultSize: _defaultSize,
  minSize: _minSize,
  ...props
}: HTMLAttributes<HTMLDivElement> & { id: string; defaultSize?: string; minSize?: string }) {
  const context = use(ResizeContext);
  const size = context?.layout[id] ?? 100;
  const panelStyle: CSSProperties = {
    ...style,
    flexBasis: `${size}%`,
    flexGrow: 0,
    flexShrink: 0,
  };
  return (
    <div id={id} data-slot="resizable-panel" className={className} style={panelStyle} {...props}>
      {children}
    </div>
  );
}

function ResizableHandle({
  withHandle = true,
  orientation = 'horizontal',
  className,
  onDoubleClick,
  onKeyDown,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  withHandle?: boolean;
  orientation?: Orientation;
}) {
  const context = use(ResizeContext);
  const vertical = orientation === 'vertical';
  const GripIcon = vertical ? GripHorizontalIcon : GripVerticalIcon;
  const secondSize = Object.values(context?.layout ?? {})[1] ?? 40;

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={vertical ? 'horizontal' : 'vertical'}
      aria-valuemin={20}
      aria-valuemax={75}
      aria-valuenow={Math.round(secondSize)}
      data-slot="resizable-handle"
      data-orientation={orientation}
      className={cn(
        'relative z-20 flex shrink-0 items-center justify-center bg-border transition-colors duration-150 hover:bg-foreground/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        vertical
          ? '-my-[3px] h-1.5 w-full cursor-row-resize'
          : '-mx-[3px] h-full w-1.5 cursor-col-resize',
        className,
      )}
      onPointerDown={(event) => context?.beginResize(event)}
      onDoubleClick={onDoubleClick}
      onKeyDown={(event) => {
        const decrease = vertical ? event.key === 'ArrowUp' : event.key === 'ArrowLeft';
        const increase = vertical ? event.key === 'ArrowDown' : event.key === 'ArrowRight';
        if (decrease || increase) {
          event.preventDefault();
          context?.resizeBy(decrease ? 2 : -2);
        }
        onKeyDown?.(event);
      }}
      {...props}
    >
      {withHandle ? (
        <span className="absolute grid h-4 w-8 place-items-center rounded-sm border bg-background text-muted-foreground shadow-sm">
          <GripIcon className="size-3" aria-hidden="true" />
        </span>
      ) : null}
    </div>
  );
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
