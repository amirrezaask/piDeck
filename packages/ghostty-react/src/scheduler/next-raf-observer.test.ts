import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { NextRafObserver } from "./next-raf-observer.js";

test("continuous submissions cannot starve the oldest next-rAF fence", () => {
  const callbacks: FrameRequestCallback[] = [];
  const observed: number[] = [];
  const observer = new NextRafObserver<{ frame: number }>(
    (sample) => observed.push(sample.frame),
    (callback) => {
      callbacks.push(callback);
      return callbacks.length;
    },
    () => assert.fail("a newer submission must not cancel an older fence"),
  );
  observer.submit({ frame: 1 });
  for (let frame = 2; frame <= 100; frame += 1) observer.submit({ frame });
  assert.equal(callbacks.length, 1);
  callbacks[0]?.(16);
  assert.deepEqual(observed, [1]);
  assert.equal(callbacks.length, 2);
  callbacks[1]?.(32);
  assert.deepEqual(observed, [1, 100]);
});

test("reset rejects stale callbacks and drops the queued latest sample", () => {
  const callbacks: FrameRequestCallback[] = [];
  const observed: number[] = [];
  const observer = new NextRafObserver<{ frame: number }>(
    (sample) => observed.push(sample.frame),
    (callback) => {
      callbacks.push(callback);
      return callbacks.length;
    },
    () => {},
  );
  observer.submit({ frame: 1 });
  observer.submit({ frame: 2 });
  observer.reset();
  observer.submit({ frame: 3 });
  callbacks[0]?.(16);
  assert.deepEqual(observed, []);
  callbacks[1]?.(32);
  assert.deepEqual(observed, [3]);
  assert.equal(callbacks.length, 2);
});
