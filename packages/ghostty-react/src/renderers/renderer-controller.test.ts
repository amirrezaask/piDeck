import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { GhosttyViewportModel } from "@yaade/ghostty-core";
import { RendererController, type ControlledTerminalRenderer } from "./renderer-controller.js";
import type { TerminalRenderOverlays } from "./terminal-renderer.js";

const overlays: TerminalRenderOverlays = {
  forceFull: true,
  cursorOn: false,
  focused: false,
  metrics: { width: 8, height: 16, baseline: 12 },
  font: { family: "monospace", size: 12 },
  viewport: { cssWidth: 80, cssHeight: 40, pixelRatio: 1, padding: 0, originY: 0 },
};

function renderer(kind: "webgl2" | "canvas2d", fail = true): ControlledTerminalRenderer {
  return {
    canvas: new EventTarget() as HTMLCanvasElement,
    renderer: {
      kind,
      clear() {},
      resize() {},
      dispose() {},
      setFont: async () => overlays.metrics,
      render() {
        if (fail) throw new Error("viewport exceeds atlas capacity");
      },
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

test("construction success cannot cause an endless render recovery loop", async () => {
  const attempts: string[] = [];
  const controller = new RendererController(
    renderer("webgl2"),
    async (backend) => {
      attempts.push(backend);
      return renderer(backend);
    },
    () => {},
    () => {},
  );
  const model = new GhosttyViewportModel();
  assert.equal(controller.render(model, null, overlays), false);
  await settle();
  assert.equal(controller.backend, "webgl2");
  assert.equal(controller.render(model, null, overlays), false);
  await settle();
  assert.equal(controller.backend, "canvas2d");
  assert.equal(controller.state, "fallback");
  assert.equal(controller.render(model, null, overlays), false);
  await settle();
  assert.equal(controller.state, "unavailable");
  for (let i = 0; i < 10; i += 1) controller.render(model, null, overlays);
  assert.deepEqual(attempts, ["webgl2", "canvas2d"]);
  controller.dispose();
});

test("Canvas fallback submits the offending content after one WebGL retry", async () => {
  const controller = new RendererController(
    renderer("webgl2"),
    async (backend) => renderer(backend, backend === "webgl2"),
    () => {},
    () => {},
  );
  const model = new GhosttyViewportModel();
  controller.render(model, null, overlays);
  await settle();
  controller.render(model, null, overlays);
  await settle();
  assert.equal(controller.render(model, null, overlays), true);
  assert.equal(controller.state, "fallback");
  controller.dispose();
});
