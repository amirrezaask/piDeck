import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Terminal as TerminalIcon } from "lucide-react";
import type { PanelEvent } from "@yaade/panels";
import type {
  TerminalKind,
  MuxTerminal,
  MuxTerminalId,
} from "@yaade/rpc";
import type { PanelId } from "@yaade/shared";
import { TerminalSurfacePlacement } from "@yaade/ui/terminal";
import {
  KeyBindingKbd,
  MuxPaneChrome,
  PanelDockInDnd,
  type PanelSlotMeta,
} from "@yaade/ui/session";
import {
  Button,
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@yaade/ui/primitives";
import { muxTerminalPaneTitle, type RuntimeTerminalTitle } from "./terminal-title.js";
import {
  muxSessionDirectShortcutFor,
  muxSessionShortcutFor,
} from "./mux-keymap.js";
import type { TerminalPaneView, TerminalWorkspace } from "./terminal-tiling.js";
import { terminalIdsInWorkspace, terminalPaneCount } from "./terminal-tiling.js";

export type TerminalTilingWorkspaceProps = {
  readonly workspace: TerminalWorkspace;
  readonly terminalsById: ReadonlyMap<MuxTerminalId, MuxTerminal>;
  readonly runtimeTitles: ReadonlyMap<MuxTerminalId, RuntimeTerminalTitle>;
  readonly onPanelEvent: (event: PanelEvent) => void;
  readonly onFocusPanel: (panelId: PanelId, terminal?: MuxTerminal) => void;
  readonly onAddSplitTerminal: (
    panelId: PanelId,
    edge: "right" | "bottom",
    kind: TerminalKind,
  ) => void;
  readonly onSplit: (panelId: PanelId, edge: "right" | "bottom") => void;
  readonly onZoom: (panelId: PanelId) => void;
  readonly onCloseView: (panelId: PanelId) => void;
  readonly onChromeOverlayChange?: (open: boolean) => void;
  readonly renderTerminal: (terminal: MuxTerminal, focused: boolean) => ReactNode;
};

type PaneTerminal = {
  kind: TerminalKind;
  label: string;
  icon: typeof TerminalIcon;
  command: string;
};

const paneTerminalKinds: readonly PaneTerminal[] = [
  {
    kind: "terminal",
    label: "Terminal",
    icon: TerminalIcon,
    command: "terminal.newTerminal",
  },
];

function PaneNewTerminalMenu(props: {
  readonly panelId: PanelId;
  readonly edge: "right" | "bottom";
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly trigger: ReactNode;
  readonly onAddTerminal: (
    panelId: PanelId,
    edge: "right" | "bottom",
    kind: TerminalKind,
  ) => void;
}) {
  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange}>
      <PopoverAnchor asChild>{props.trigger}</PopoverAnchor>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={6}
        className="w-48 p-1.5"
        data-yaade-pane-terminal-menu=""
      >
        {paneTerminalKinds.map(item => {
          const Icon = item.icon;
          const shortcut = muxSessionShortcutFor(item.command);
          return (
            <Button
              key={item.kind}
              type="button"
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              data-yaade-pane-new-terminal-kind={item.kind}
              onClick={() => {
                props.onOpenChange(false);
                props.onAddTerminal(props.panelId, props.edge, item.kind);
              }}
            >
              <Icon data-icon="inline-start" />
              <span className="flex-1 text-left">{item.label}</span>
              {shortcut ? <KeyBindingKbd binding={shortcut} /> : null}
            </Button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

export default function TerminalTilingWorkspace({
  workspace,
  terminalsById,
  runtimeTitles,
  onPanelEvent,
  onFocusPanel,
  onAddSplitTerminal,
  onSplit,
  onZoom,
  onCloseView,
  onChromeOverlayChange,
  renderTerminal,
}: TerminalTilingWorkspaceProps) {
  const openTerminalIds = terminalIdsInWorkspace(workspace);
  const paneCount = terminalPaneCount(workspace);
  const canZoom = paneCount > 1;
  const zoomedPanelId = workspace.zoomedPanelId;
  const [splitTerminalTarget, setSplitTerminalTarget] = useState<{
    readonly panelId: number;
    readonly edge: "right" | "bottom";
  } | null>(null);
  useEffect(() => {
    onChromeOverlayChange?.(
      splitTerminalTarget != null,
    );
  }, [onChromeOverlayChange, splitTerminalTarget]);
  const renderHeader = useCallback(
    (view: TerminalPaneView, panelId: PanelId, meta: PanelSlotMeta) => {
      const activeTerminal =
        view.kind === "terminal"
          ? terminalsById.get(view.muxTerminalId)
          : undefined;
      const chrome = (
        <MuxPaneChrome
          title={
            activeTerminal
              ? muxTerminalPaneTitle(
                  activeTerminal,
                  runtimeTitles.get(activeTerminal.id),
                )
              : "Empty pane"
          }
          focused={meta.focused}
          paneId={activeTerminal?.id ?? `empty-${panelId.id}`}
          panelId={panelId}
          zoomed={zoomedPanelId?.id === panelId.id}
          canZoom={canZoom}
          draggable={activeTerminal != null}
          onSplitButton={(direction, event) => {
            const edge = direction === "right" ? "right" : "bottom";
            if (event.metaKey || event.ctrlKey) {
              event.preventDefault();
              setSplitTerminalTarget({ panelId: panelId.id, edge });
              return;
            }
            setSplitTerminalTarget(null);
            onAddSplitTerminal(panelId, edge, "terminal");
          }}
          wrapSplitButton={(direction, button) => {
            const edge = direction === "right" ? "right" : "bottom";
            const open =
              splitTerminalTarget?.panelId === panelId.id &&
              splitTerminalTarget.edge === edge;
            return (
              <PaneNewTerminalMenu
                panelId={panelId}
                edge={edge}
                open={open}
                onOpenChange={nextOpen => {
                  setSplitTerminalTarget(current =>
                    nextOpen
                      ? { panelId: panelId.id, edge }
                      : current?.panelId === panelId.id &&
                          current.edge === edge
                        ? null
                        : current,
                  );
                }}
                trigger={button}
                onAddTerminal={onAddSplitTerminal}
              />
            );
          }}
          onSplitRight={() => onSplit(panelId, "right")}
          onSplitDown={() => onSplit(panelId, "bottom")}
          onZoom={() => onZoom(panelId)}
          shortcutFor={command => {
            if (command === "mux.zoomPane") {
              return muxSessionShortcutFor("pane.zoom");
            }
            if (command === "mux.splitRight") {
              return muxSessionDirectShortcutFor("pane.splitRight");
            }
            if (command === "mux.splitDown") {
              return muxSessionDirectShortcutFor("pane.splitDown");
            }
            return undefined;
          }}
          onClose={() => onCloseView(panelId)}
        />
      );
      return chrome;
    },
    [
      canZoom,
      onAddSplitTerminal,
      onCloseView,
      onSplit,
      onZoom,
      runtimeTitles,
      splitTerminalTarget,
      terminalsById,
      zoomedPanelId,
    ],
  );

  const renderContent = useCallback(
    (view: TerminalPaneView, panelId: PanelId, meta: PanelSlotMeta) => {
      if (view.kind === "empty") {
        return (
          <div
            className="h-full min-h-0"
            data-yaade-empty-terminal-pending=""
          />
        );
      }
      const terminal = terminalsById.get(view.muxTerminalId);
      if (!terminal) {
        return (
          <div
            className="h-full min-h-0"
            data-yaade-empty-terminal-pending=""
          />
        );
      }
      return (
        <div
          className="flex h-full min-h-0 min-w-0 flex-col"
          data-yaade-terminal-tile={terminal.id}
          data-focused={meta.focused ? "" : undefined}
        >
          {renderTerminal(terminal, meta.focused)}
        </div>
      );
    },
    [renderTerminal, terminalsById],
  );

  const zoomedView = zoomedPanelId
    ? workspace.tree.getView(zoomedPanelId)
    : null;

  return (
    <div
      className="relative h-full min-h-0 w-full"
      data-yaade-terminal-workspace=""
      data-yaade-viewport-count={openTerminalIds.length}
      data-yaade-pane-count={paneCount}
      data-yaade-pane-zoomed={zoomedPanelId?.id}
    >
      <div
        className={zoomedPanelId ? "pointer-events-none invisible absolute inset-0" : "h-full min-h-0"}
        aria-hidden={zoomedPanelId ? true : undefined}
        inert={zoomedPanelId ? true : undefined}
        data-yaade-unzoomed-dock=""
      >
        <PanelDockInDnd
          tree={workspace.tree}
          focusedPanelId={workspace.focusedPanelId}
          onFocusPanel={(panelId) => {
            const view = workspace.tree.getView(panelId);
            const terminal =
              view?.kind === "terminal"
                ? terminalsById.get(view.muxTerminalId)
                : undefined;
            onFocusPanel(panelId, terminal);
          }}
          onEvent={onPanelEvent}
          leafClassName="rounded-none border-0 bg-background"
          renderHeader={renderHeader}
          renderContent={renderContent}
        />
      </div>
      {zoomedPanelId && zoomedView ? (
        <div
          className="absolute inset-0 z-10 flex min-h-0 flex-col overflow-hidden bg-background"
          data-yaade-panel-leaf={zoomedPanelId.id}
          data-yaade-session-window=""
          data-focused=""
          data-yaade-pane-zoomed-leaf=""
        >
          {renderHeader(zoomedView, zoomedPanelId, {
            focused: true,
            onClose: () => onCloseView(zoomedPanelId),
          })}
          <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
            {zoomedView.kind === "terminal" ? (
              <TerminalSurfacePlacement
                terminalId={zoomedView.muxTerminalId}
                focused
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
