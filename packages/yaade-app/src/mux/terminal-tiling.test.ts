import assert from "node:assert/strict";
import { describe, it } from "vite-plus/test";
import { Schema } from "effect";
import { MuxTerminalId } from "@yaade/rpc";
import {
  MAX_TERMINAL_TILES,
  closeTerminalPanel,
  closeTerminalTab,
  createTerminalWorkspace,
  dockTerminalView,
  openTerminalView,
  openTerminalViewInPanel,
  restoreTerminalWorkspace,
  serializeTerminalWorkspace,
  splitTerminalPanel,
  terminalIdsInWorkspace,
  terminalPaneCount,
} from "./terminal-tiling.js";

const terminalId = (suffix: string) =>
  Schema.decodeUnknownSync(MuxTerminalId)(`term-${suffix}`);

function focusedTerminal(workspace: ReturnType<typeof createTerminalWorkspace>) {
  const view = workspace.tree.getView(workspace.focusedPanelId);
  return view?.kind === "terminal" ? view.muxTerminalId : undefined;
}

describe("terminal tiling workspace", () => {
  it("opens every MuxTerminal in its own pane", () => {
    const first = terminalId("first");
    const second = terminalId("second");
    let workspace = openTerminalView(createTerminalWorkspace(), first);
    const firstPanel = workspace.focusedPanelId;
    workspace = openTerminalView(workspace, second);

    assert.deepEqual(terminalIdsInWorkspace(workspace), [first, second]);
    assert.equal(terminalPaneCount(workspace), 2);
    assert.equal(focusedTerminal(workspace), second);

    workspace = openTerminalView(workspace, first);
    assert.equal(workspace.focusedPanelId.id, firstPanel.id);
    assert.equal(focusedTerminal(workspace), first);
    assert.deepEqual(terminalIdsInWorkspace(workspace), [first, second]);
  });

  it("fills an explicit empty split before creating another pane", () => {
    const first = terminalId("first");
    const second = terminalId("second");
    let workspace = openTerminalView(createTerminalWorkspace(), first);
    workspace = splitTerminalPanel(workspace, workspace.focusedPanelId, "bottom");
    workspace = openTerminalView(workspace, second);

    assert.equal(terminalPaneCount(workspace), 2);
    assert.equal(workspace.tree.root.kind, "column");
    assert.equal(focusedTerminal(workspace), second);
  });

  it("opens a selected split terminal in the new pane", () => {
    const first = terminalId("first");
    const second = terminalId("second");
    let workspace = openTerminalView(createTerminalWorkspace(), first);
    const firstPanel = workspace.focusedPanelId;
    workspace = splitTerminalPanel(workspace, firstPanel, "right");
    const splitPanel = workspace.focusedPanelId;
    workspace = openTerminalViewInPanel(workspace, splitPanel, second);

    assert.deepEqual(terminalIdsInWorkspace(workspace), [first, second]);
    assert.equal(workspace.tree.getView(splitPanel)?.kind, "terminal");
    assert.equal(focusedTerminal(workspace), second);
  });

  it("closing a MuxTerminal closes exactly its pane", () => {
    const first = terminalId("first");
    const second = terminalId("second");
    let workspace = openTerminalView(createTerminalWorkspace(), first);
    const firstPanel = workspace.focusedPanelId;
    workspace = openTerminalView(workspace, second);
    workspace = closeTerminalTab(workspace, firstPanel, first);

    assert.deepEqual(terminalIdsInWorkspace(workspace), [second]);
    assert.equal(terminalPaneCount(workspace), 1);
    workspace = closeTerminalPanel(workspace, workspace.focusedPanelId);
    assert.deepEqual(terminalIdsInWorkspace(workspace), []);
    assert.equal(workspace.tree.getView(workspace.focusedPanelId)?.kind, "empty");
  });

  it("drops a sidebar MuxTerminal at a panel edge", () => {
    const first = terminalId("first");
    const second = terminalId("second");
    const workspace = openTerminalView(createTerminalWorkspace(), first);
    const docked = dockTerminalView(workspace, second, workspace.focusedPanelId, {
      kind: "split",
      edge: "bottom",
    });

    assert.deepEqual(terminalIdsInWorkspace(docked), [first, second]);
    assert.equal(docked.tree.root.kind, "column");
  });

  it("center-dropping an external MuxTerminal beside an occupied pane does not replace it", () => {
    const first = terminalId("first");
    const second = terminalId("second");
    const workspace = openTerminalView(createTerminalWorkspace(), first);
    const docked = dockTerminalView(workspace, second, workspace.focusedPanelId, {
      kind: "moveToPane",
    });

    assert.deepEqual(terminalIdsInWorkspace(docked), [first, second]);
    assert.equal(terminalPaneCount(docked), 2);
  });

  it("center-dropping between panes swaps their MuxTerminals", () => {
    const first = terminalId("first");
    const second = terminalId("second");
    let workspace = openTerminalView(createTerminalWorkspace(), first);
    const firstPanel = workspace.focusedPanelId;
    workspace = openTerminalView(workspace, second);
    const secondPanel = workspace.focusedPanelId;

    workspace = dockTerminalView(workspace, second, firstPanel, {
      kind: "moveToPane",
    });

    assert.equal(workspace.tree.getView(firstPanel)?.kind, "terminal");
    assert.equal(workspace.tree.getView(secondPanel)?.kind, "terminal");
    assert.equal(
      workspace.tree.getView(firstPanel)?.kind === "terminal"
        ? workspace.tree.getView(firstPanel)?.muxTerminalId
        : undefined,
      second,
    );
    assert.deepEqual(new Set(terminalIdsInWorkspace(workspace)), new Set([first, second]));
  });

  it("round-trips split geometry and focus", () => {
    const first = terminalId("first");
    const second = terminalId("second");
    let workspace = openTerminalView(createTerminalWorkspace(), first);
    workspace = openTerminalView(workspace, second);
    const layoutJson = serializeTerminalWorkspace(workspace);

    const restored = restoreTerminalWorkspace(layoutJson, [first, second]);
    assert.deepEqual(terminalIdsInWorkspace(restored), [first, second]);
    assert.equal(restored.tree.root.kind, "row");
    assert.equal(focusedTerminal(restored), second);
  });

  it("normalizes tampered persisted split ratios", () => {
    const first = terminalId("first");
    const second = terminalId("second");
    let workspace = openTerminalView(createTerminalWorkspace(), first);
    workspace = openTerminalView(workspace, second);
    if (workspace.tree.root.kind !== "row") throw new Error("expected row");
    workspace.tree.root.split.ratios = [100, 1];
    const restored = restoreTerminalWorkspace(serializeTerminalWorkspace(workspace), [first, second]);
    if (restored.tree.root.kind !== "row") throw new Error("expected row");
    const sum = restored.tree.root.split.ratios.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-6);
    assert.ok(restored.tree.root.split.ratios[0]! < 1);
  });

  it("drops stale persisted MuxTerminals and places new ones", () => {
    const stale = terminalId("stale");
    const current = terminalId("current");
    const layoutJson = serializeTerminalWorkspace(
      openTerminalView(createTerminalWorkspace(), stale),
    );

    const restored = restoreTerminalWorkspace(layoutJson, [current]);
    assert.deepEqual(terminalIdsInWorkspace(restored), [current]);
  });

  it("caps one-to-one panes without hiding additional MuxTerminals", () => {
    let workspace = createTerminalWorkspace();
    for (let index = 0; index < MAX_TERMINAL_TILES; index += 1) {
      workspace = openTerminalView(workspace, terminalId(`terminal-${index}`));
    }
    assert.equal(terminalPaneCount(workspace), MAX_TERMINAL_TILES);

    const unchanged = openTerminalView(workspace, terminalId("overflow"));
    assert.equal(unchanged, workspace);
    assert.equal(terminalIdsInWorkspace(unchanged).includes(terminalId("overflow")), false);
  });
});
