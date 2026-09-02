import { Schema } from "effect";
import {
  PanelTree,
  type PanelNode,
  type PanelTreeOptions,
  type PanelTreeSnapshot,
} from "@yaade/panels";
import { panelId, type DropAction, type PanelId } from "@yaade/shared";
import { MuxTerminalId } from "@yaade/rpc";

/** Maximum number of simultaneously rendered MuxTerminal panes in one Window. */
export const MAX_TERMINAL_TILES = 6;

/** A Window leaf is either available or owns exactly one MuxTerminal. */
export type TerminalPaneView =
  | { readonly kind: "empty" }
  | { readonly kind: "terminal"; readonly muxTerminalId: MuxTerminalId };

export type TerminalWorkspace = {
  readonly tree: PanelTree<TerminalPaneView>;
  readonly focusedPanelId: PanelId;
  /** Temporary presentation state; zoom never changes the persisted split tree. */
  readonly zoomedPanelId: PanelId | null;
};

const TERMINAL_PANE_OPTIONS: PanelTreeOptions<TerminalPaneView> = {
  emptyView: () => ({ kind: "empty" }),
  isEmpty: view => view.kind === "empty",
};

function firstPanel(tree: PanelTree<TerminalPaneView>): PanelId {
  if (tree.root.kind === "leaf") return tree.root.panelId;
  let first: PanelId | undefined;
  tree.visitLeaves(leaf => {
    first ??= leaf.panelId;
  });
  return first ?? tree.allocPanelId();
}

function panelExists(tree: PanelTree<TerminalPaneView>, panelId: PanelId): boolean {
  return tree.getLeaf(panelId) != null;
}

export function terminalPaneCount(workspace: TerminalWorkspace): number {
  let count = 0;
  workspace.tree.visitLeaves(() => {
    count += 1;
  });
  return count;
}

function resolvedFocus(
  tree: PanelTree<TerminalPaneView>,
  preferred: PanelId,
): PanelId {
  return panelExists(tree, preferred) ? preferred : firstPanel(tree);
}

function findTerminalPanel(
  tree: PanelTree<TerminalPaneView>,
  muxTerminalId: MuxTerminalId,
): PanelId | null {
  return tree.findPanelWithView(
    view => view.kind === "terminal" && view.muxTerminalId === muxTerminalId,
  );
}

function removeTerminalPanel(
  tree: PanelTree<TerminalPaneView>,
  panelId: PanelId,
): void {
  if (tree.getLeaf(panelId) == null) return;
  let count = 0;
  tree.visitLeaves(() => {
    count += 1;
  });
  if (count === 1) tree.setView(panelId, { kind: "empty" });
  else tree.closePanel(panelId);
}

export function createTerminalWorkspace(): TerminalWorkspace {
  const tree = new PanelTree(TERMINAL_PANE_OPTIONS);
  return {
    tree,
    focusedPanelId: firstPanel(tree),
    zoomedPanelId: null,
  };
}

/**
 * Focus an existing MuxTerminal, fill an empty pane, or split the focused pane.
 * It never replaces an occupied pane and never groups multiple terminals in a leaf.
 */
export function openTerminalView(
  workspace: TerminalWorkspace,
  muxTerminalId: MuxTerminalId,
): TerminalWorkspace {
  const existing = findTerminalPanel(workspace.tree, muxTerminalId);
  if (existing) return focusTerminalPanel(workspace, existing);

  const tree = workspace.tree.clone();
  const target = resolvedFocus(tree, workspace.focusedPanelId);
  const targetView = tree.getView(target);
  if (!targetView || targetView.kind === "empty") {
    tree.setView(target, { kind: "terminal", muxTerminalId });
    return { tree, focusedPanelId: target, zoomedPanelId: null };
  }
  if (terminalPaneCount(workspace) >= MAX_TERMINAL_TILES) return workspace;

  const created = tree.splitAtEdge(target, "right");
  tree.setView(created, { kind: "terminal", muxTerminalId });
  return { tree, focusedPanelId: created, zoomedPanelId: null };
}

/** Open a MuxTerminal in a known empty pane, falling back to normal placement. */
export function openTerminalViewInPanel(
  workspace: TerminalWorkspace,
  panelId: PanelId,
  muxTerminalId: MuxTerminalId,
): TerminalWorkspace {
  const existing = findTerminalPanel(workspace.tree, muxTerminalId);
  if (existing) return focusTerminalPanel(workspace, existing);
  if (!panelExists(workspace.tree, panelId)) {
    return openTerminalView(workspace, muxTerminalId);
  }

  const targetView = workspace.tree.getView(panelId);
  if (targetView?.kind !== "empty") {
    return openTerminalView(workspace, muxTerminalId);
  }

  const tree = workspace.tree.clone();
  tree.setView(panelId, { kind: "terminal", muxTerminalId });
  return { tree, focusedPanelId: panelId, zoomedPanelId: null };
}

export function focusTerminalPanel(
  workspace: TerminalWorkspace,
  panelId: PanelId,
): TerminalWorkspace {
  if (!panelExists(workspace.tree, panelId)) return workspace;
  if (
    workspace.focusedPanelId.id === panelId.id &&
    workspace.zoomedPanelId == null
  ) {
    return workspace;
  }
  return {
    ...workspace,
    focusedPanelId: panelId,
    zoomedPanelId: null,
  };
}

/** Compatibility alias while callers migrate from pane-local tabs. */
export function activateTerminalTab(
  workspace: TerminalWorkspace,
  panelId: PanelId,
  muxTerminalId: MuxTerminalId,
): TerminalWorkspace {
  const view = workspace.tree.getView(panelId);
  if (view?.kind !== "terminal" || view.muxTerminalId !== muxTerminalId) return workspace;
  return focusTerminalPanel(workspace, panelId);
}

/** A one-terminal pane has no local tab order. */
export function reorderTerminalTabs(
  workspace: TerminalWorkspace,
  _panelId: PanelId,
  _muxTerminalId: MuxTerminalId,
  _toIndex: number,
): TerminalWorkspace {
  return workspace;
}

export function splitTerminalPanel(
  workspace: TerminalWorkspace,
  panelId: PanelId,
  edge: "right" | "bottom",
): TerminalWorkspace {
  if (!panelExists(workspace.tree, panelId)) return workspace;
  if (terminalPaneCount(workspace) >= MAX_TERMINAL_TILES) return workspace;
  const tree = workspace.tree.clone();
  const created = tree.splitAtEdge(panelId, edge);
  return { tree, focusedPanelId: created, zoomedPanelId: null };
}

/** Toggle a temporary full-workspace view for one pane. */
export function toggleTerminalPanelZoom(
  workspace: TerminalWorkspace,
  panelId: PanelId,
): TerminalWorkspace {
  if (!panelExists(workspace.tree, panelId) || terminalPaneCount(workspace) < 2) {
    return workspace;
  }
  return {
    ...workspace,
    focusedPanelId: panelId,
    zoomedPanelId:
      workspace.zoomedPanelId?.id === panelId.id ? null : panelId,
  };
}

/** Close a pane without archiving its MuxTerminal. */
export function closeTerminalPanel(
  workspace: TerminalWorkspace,
  panelId: PanelId,
): TerminalWorkspace {
  if (!panelExists(workspace.tree, panelId)) return workspace;
  const tree = workspace.tree.clone();
  removeTerminalPanel(tree, panelId);
  return {
    tree,
    focusedPanelId: resolvedFocus(tree, workspace.focusedPanelId),
    zoomedPanelId:
      workspace.zoomedPanelId?.id === panelId.id
        ? null
        : workspace.zoomedPanelId,
  };
}

/** Close the pane containing a MuxTerminal without archiving the host MuxTerminal. */
export function closeTerminalTab(
  workspace: TerminalWorkspace,
  panelId: PanelId,
  muxTerminalId: MuxTerminalId,
): TerminalWorkspace {
  const view = workspace.tree.getView(panelId);
  if (view?.kind !== "terminal" || view.muxTerminalId !== muxTerminalId) return workspace;
  return closeTerminalPanel(workspace, panelId);
}

export function resizeTerminalSplit(
  workspace: TerminalWorkspace,
  path: number[],
  ratios: number[],
): TerminalWorkspace {
  const tree = workspace.tree.clone();
  if (!tree.setSplitRatios(path, ratios)) return workspace;
  return { ...workspace, tree };
}

/** Move one MuxTerminal pane or split it beside another pane. */
export function dockTerminalView(
  workspace: TerminalWorkspace,
  muxTerminalId: MuxTerminalId,
  target: PanelId,
  action: DropAction,
): TerminalWorkspace {
  if (!panelExists(workspace.tree, target)) return workspace;
  const source = findTerminalPanel(workspace.tree, muxTerminalId);
  const split = action.kind === "split" && action.edge !== "center";
  if (source?.id === target.id) return focusTerminalPanel(workspace, target);

  const tree = workspace.tree.clone();
  const targetView = tree.getView(target);

  if (split) {
    if (!source && terminalPaneCount(workspace) >= MAX_TERMINAL_TILES) return workspace;
    if (source) removeTerminalPanel(tree, source);
    if (!panelExists(tree, target)) return workspace;
    const created = tree.splitAtEdge(target, action.edge);
    tree.setView(created, { kind: "terminal", muxTerminalId });
    return { tree, focusedPanelId: created, zoomedPanelId: null };
  }

  if (source) {
    const sourceView = tree.getView(source);
    if (targetView?.kind === "terminal" && sourceView?.kind === "terminal") {
      // Center-drop swaps the two panes so neither MuxTerminal becomes hidden.
      tree.setView(source, targetView);
      tree.setView(target, sourceView);
    } else {
      tree.setView(target, { kind: "terminal", muxTerminalId });
      removeTerminalPanel(tree, source);
    }
    return { tree, focusedPanelId: target, zoomedPanelId: null };
  }

  if (targetView?.kind === "empty") {
    tree.setView(target, { kind: "terminal", muxTerminalId });
    return { tree, focusedPanelId: target, zoomedPanelId: null };
  }

  if (terminalPaneCount(workspace) >= MAX_TERMINAL_TILES) return workspace;
  const created = tree.splitAtEdge(target, "right");
  tree.setView(created, { kind: "terminal", muxTerminalId });
  return { tree, focusedPanelId: created, zoomedPanelId: null };
}

export function removeMissingTerminalViews(
  workspace: TerminalWorkspace,
  liveMuxTerminalIds: ReadonlySet<MuxTerminalId>,
): TerminalWorkspace {
  const missing: Array<{ panelId: PanelId; muxTerminalId: MuxTerminalId }> = [];
  workspace.tree.visitLeaves(leaf => {
    if (
      leaf.view.kind === "terminal" &&
      !liveMuxTerminalIds.has(leaf.view.muxTerminalId)
    ) {
      missing.push({ panelId: leaf.panelId, muxTerminalId: leaf.view.muxTerminalId });
    }
  });
  let next = workspace;
  for (const item of missing) {
    next = closeTerminalTab(next, item.panelId, item.muxTerminalId);
  }
  return next;
}

export function terminalIdsInWorkspace(
  workspace: TerminalWorkspace,
): readonly MuxTerminalId[] {
  const ids: MuxTerminalId[] = [];
  workspace.tree.visitLeaves(leaf => {
    if (leaf.view.kind === "terminal") ids.push(leaf.view.muxTerminalId);
  });
  return ids;
}

type PersistedTerminalWorkspace = {
  readonly version: 1;
  readonly tree: PanelTreeSnapshot<TerminalPaneView>;
  readonly focusedPanelId: number;
  readonly zoomedPanelId: number | null;
};

type PersistedPaneView =
  | { readonly kind: "empty" }
  | { readonly kind: "terminal"; readonly muxTerminalId: MuxTerminalId };

type PersistedPanelNode =
  | {
      readonly kind: "leaf";
      readonly panelId: { readonly id: number };
      readonly view: PersistedPaneView;
    }
  | {
      readonly kind: "row" | "column";
      readonly split: {
        readonly children: readonly PersistedPanelNode[];
        readonly ratios: readonly number[];
      };
    };

type PersistedPanelNodeEncoded =
  | {
      readonly kind: "leaf";
      readonly panelId: { readonly id: number };
      readonly view:
        | { readonly kind: "empty" }
        | { readonly kind: "terminal"; readonly muxTerminalId: string };
    }
  | {
      readonly kind: "row" | "column";
      readonly split: {
        readonly children: readonly PersistedPanelNodeEncoded[];
        readonly ratios: readonly number[];
      };
    };

const PositiveInteger = Schema.Number.pipe(
  Schema.filter(value => Number.isSafeInteger(value) && value > 0),
);
const PositiveRatio = Schema.Number.pipe(
  Schema.filter(value => Number.isFinite(value) && value > 0),
);
const PersistedPaneViewSchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("empty") }),
  Schema.Struct({ kind: Schema.Literal("terminal"), muxTerminalId: MuxTerminalId }),
);
const PersistedPanelNodeSchema: Schema.Schema<
  PersistedPanelNode,
  PersistedPanelNodeEncoded
> = Schema.suspend(
  () =>
    Schema.Union(
      Schema.Struct({
        kind: Schema.Literal("leaf"),
        panelId: Schema.Struct({ id: PositiveInteger }),
        view: PersistedPaneViewSchema,
      }),
      Schema.Struct({
        kind: Schema.Literal("row", "column"),
        split: Schema.Struct({
          children: Schema.Array(PersistedPanelNodeSchema).pipe(
            Schema.minItems(2),
          ),
          ratios: Schema.Array(PositiveRatio).pipe(Schema.minItems(2)),
        }),
      }),
    ),
);
const PersistedTerminalWorkspaceSchema = Schema.Struct({
  version: Schema.Literal(1),
  tree: Schema.Struct({
    root: PersistedPanelNodeSchema,
    nextPanelId: PositiveInteger,
  }),
  focusedPanelId: PositiveInteger,
  zoomedPanelId: Schema.Union(PositiveInteger, Schema.Null),
});

function runtimePanelNode(
  node: PersistedPanelNode,
): PanelNode<TerminalPaneView> | null {
  if (node.kind === "leaf") {
    return {
      kind: "leaf",
      panelId: panelId(node.panelId.id),
      view: node.view,
    };
  }
  if (node.split.children.length !== node.split.ratios.length) return null;
  const ratioSum = node.split.ratios.reduce((sum, ratio) => sum + ratio, 0);
  if (!Number.isFinite(ratioSum) || ratioSum <= 0) return null;
  const children: PanelNode<TerminalPaneView>[] = [];
  for (const child of node.split.children) {
    const parsed = runtimePanelNode(child);
    if (!parsed) return null;
    children.push(parsed);
  }
  return {
    kind: node.kind,
    split: {
      children,
      ratios: node.split.ratios.map(ratio => ratio / ratioSum),
    },
  };
}

function parseTerminalWorkspace(layoutJson: string | undefined): TerminalWorkspace | null {
  if (!layoutJson) return null;
  try {
    const decoded = Schema.decodeUnknownSync(PersistedTerminalWorkspaceSchema)(
      JSON.parse(layoutJson),
    );
    const root = runtimePanelNode(decoded.tree.root);
    if (!root) return null;
    const tree = PanelTree.fromJSON(TERMINAL_PANE_OPTIONS, {
      root,
      nextPanelId: decoded.tree.nextPanelId,
    });
    const focusedPanelId = panelId(decoded.focusedPanelId);
    if (!panelExists(tree, focusedPanelId)) return null;
    const zoomedPanelId = decoded.zoomedPanelId === null
      ? null
      : panelId(decoded.zoomedPanelId);
    return {
      tree,
      focusedPanelId,
      zoomedPanelId:
        zoomedPanelId && panelExists(tree, zoomedPanelId)
          ? zoomedPanelId
          : null,
    };
  } catch {
    return null;
  }
}

/** Decode a persisted Window, discard stale MuxTerminals, and place new terminals. */
function capRestoredTerminalPanes(workspace: TerminalWorkspace): TerminalWorkspace {
  let next = workspace;
  while (terminalPaneCount(next) > MAX_TERMINAL_TILES) {
    const leaves: PanelId[] = [];
    next.tree.visitLeaves(leaf => leaves.push(leaf.panelId));
    const empty = leaves.find(panel => next.tree.getView(panel)?.kind === "empty");
    const panel = empty ?? leaves.at(-1);
    if (!panel) break;
    next = closeTerminalPanel(next, panel);
  }
  return next;
}

export function restoreTerminalWorkspace(
  layoutJson: string | undefined,
  liveMuxTerminalIds: readonly MuxTerminalId[],
): TerminalWorkspace {
  const live = new Set(liveMuxTerminalIds);
  let workspace = parseTerminalWorkspace(layoutJson) ?? createTerminalWorkspace();
  workspace = capRestoredTerminalPanes(removeMissingTerminalViews(workspace, live));
  const open = new Set(terminalIdsInWorkspace(workspace));
  for (const muxTerminalId of liveMuxTerminalIds) {
    if (open.has(muxTerminalId)) continue;
    const next = openTerminalView(workspace, muxTerminalId);
    if (next === workspace) break;
    workspace = next;
    open.add(muxTerminalId);
  }
  return workspace;
}

export function serializeTerminalWorkspace(workspace: TerminalWorkspace): string {
  const persisted: PersistedTerminalWorkspace = {
    version: 1,
    tree: workspace.tree.toJSON(),
    focusedPanelId: workspace.focusedPanelId.id,
    zoomedPanelId: workspace.zoomedPanelId?.id ?? null,
  };
  return JSON.stringify(persisted);
}
