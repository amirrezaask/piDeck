import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import { TerminalWorkerPool } from "./worker-pool.js";

test("six terminals occupy four fixed workers evenly and reuse released capacity", async () => {
  const workers: FakeWorker[] = [];
  class FakeWorker extends EventTarget {
    readonly messages: unknown[] = [];
    constructor() {
      super();
      workers.push(this);
    }
    postMessage(command: unknown) {
      this.messages.push(command);
    }
    terminate() {}
  }
  vi.stubGlobal("navigator", { hardwareConcurrency: 10 });
  vi.stubGlobal("Worker", FakeWorker);
  const pool = new TerminalWorkerPool();
  try {
    const channels = Array.from({ length: 6 }, (_, index) => {
      const terminalId = `terminal-${index + 1}`;
      const channel = pool.acquire(
        terminalId,
        () => {},
        (error) => {
          throw error;
        },
      );
      channel.post({ type: "dispose", terminalId, version: 1, generation: 1, sequence: 1 });
      return channel;
    });
    await Promise.resolve();
    assert.equal(pool.workerCount, 4);
    assert.deepEqual(
      workers.map((worker) => worker.messages.length),
      [2, 2, 1, 1],
    );
    channels[2]?.release();
    const replacement = pool.acquire(
      "replacement",
      () => {},
      (error) => {
        throw error;
      },
    );
    replacement.post({
      type: "dispose",
      terminalId: "replacement",
      version: 1,
      generation: 1,
      sequence: 1,
    });
    await Promise.resolve();
    assert.equal(pool.workerCount, 4);
    assert.deepEqual(
      workers.map((worker) => worker.messages.length),
      [2, 2, 2, 1],
    );
    replacement.release();
    for (const channel of channels) channel.release();
    assert.equal(pool.terminalCount, 0);
  } finally {
    pool.dispose();
    vi.unstubAllGlobals();
  }
});
