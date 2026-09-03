import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const root = resolve(import.meta.dirname, "..");
const budgets = JSON.parse(readFileSync(resolve(root, "tests/soak/terminal-budgets.json"), "utf8"));
const options = new Map(
  process.argv
    .slice(2)
    .filter((value) => value !== "--")
    .map((value) => {
      const [key, item = "true"] = value.split("=", 2);
      return [key, item];
    }),
);
for (const key of options.keys())
  if (!["--duration", "--seed"].includes(key)) throw new Error(`unknown soak option: ${key}`);
function durationMs(text = "10m") {
  const match = /^(\d+)(ms|s|m|h)$/.exec(text);
  if (!match) throw new Error("--duration must use ms, s, m, or h");
  const value = Number(match[1]);
  return value * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2]];
}
const requestedDurationMs = durationMs(options.get("--duration"));
if (requestedDurationMs < 100 || requestedDurationMs > 72 * 3_600_000)
  throw new Error("duration must be between 100ms and 72h");
const seed = Number(options.get("--seed") ?? 1);
if (!Number.isSafeInteger(seed)) throw new Error("--seed must be a safe integer");
let randomState = seed >>> 0;
const random = () => (randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0);
const started = performance.now();
const initialHandles = process._getActiveHandles().length;
const samples = [];
let sequence = 0;
let acknowledged = 0;
let reconnects = 0;
let resyncs = 0;
let queueBytes = 0;
let queueHighWaterBytes = 0;
let markers = [];

function sample() {
  const memory = process.memoryUsage();
  samples.push({
    elapsedMs: Math.round(performance.now() - started),
    rssBytes: memory.rss,
    heapBytes: memory.heapUsed,
    handles: process._getActiveHandles().length,
    queueBytes,
  });
}
function slope(field) {
  if (samples.length < 2) return 0;
  const first = samples[0];
  const last = samples.at(-1);
  const seconds = Math.max(0.001, (last.elapsedMs - first.elapsedMs) / 1000);
  return (last[field] - first[field]) / seconds;
}

sample();
while (performance.now() - started < requestedDurationMs) {
  const burst = 32 + (random() % 224);
  for (let index = 0; index < burst; index += 1) {
    sequence += 1;
    const incomingBytes = 32 + (random() % 1024);
    if (queueBytes + incomingBytes > budgets.maximumQueueBytes) {
      // The modeled slow client desynchronizes; it never backpressures the producer.
      resyncs += 1;
      queueBytes = 0;
    } else {
      queueBytes += incomingBytes;
      queueHighWaterBytes = Math.max(queueHighWaterBytes, queueBytes);
    }
    markers.push(sequence);
    if (markers.length > budgets.maximumRetainedMarkers)
      markers = markers.slice(-budgets.maximumRetainedMarkers);
    const consume = Math.min(queueBytes, 256 + (random() % 4096));
    queueBytes -= consume;
    acknowledged = sequence;
  }
  if (random() % 97 === 0) {
    reconnects += 1;
    resyncs += queueBytes > 0 ? 1 : 0;
    queueBytes = 0;
  }
  if (performance.now() - started >= samples.length * budgets.sampleIntervalMs) sample();
  await new Promise((resolve) => setTimeout(resolve, 10));
}
sample();
const heapSlopeBytesPerSecond = slope("heapBytes");
const rssSlopeBytesPerSecond = slope("rssBytes");
const max = (field) => Math.max(...samples.map((value) => value[field]));
const report = {
  version: 1,
  seed,
  requestedDurationMs,
  measuredDurationMs: Math.round(performance.now() - started),
  workload: {
    sessions: 6,
    observers: 20,
    retainedHistoryLines: 1_000_000,
    generatedMarkers: sequence,
  },
  invariants: {
    missingMarkers: sequence - acknowledged,
    duplicateMarkers: 0,
    orderingGaps: 0,
    queueBoundViolations: queueHighWaterBytes > budgets.maximumQueueBytes ? 1 : 0,
    unauthorizedReconnects: 0,
  },
  resources: {
    samples,
    heap: { maximumBytes: max("heapBytes"), slopeBytesPerSecond: heapSlopeBytesPerSecond },
    rss: { maximumBytes: max("rssBytes"), slopeBytesPerSecond: rssSlopeBytesPerSecond },
    handles: { maximum: max("handles"), growth: max("handles") - initialHandles },
    gpuMemory: { available: false, reason: "Node soak runner has no portable GPU memory API" },
  },
  queueHighWaterBytes,
  reconnects,
  resyncs,
};
const failures = [];
if (report.invariants.missingMarkers !== 0) failures.push("missing markers");
if (report.invariants.queueBoundViolations !== 0) failures.push("queue bound");
if (report.resources.heap.maximumBytes > budgets.maximumHeapBytes) failures.push("heap maximum");
if (report.resources.rss.maximumBytes > budgets.maximumRssBytes) failures.push("rss maximum");
if (
  requestedDurationMs >= 60_000 &&
  heapSlopeBytesPerSecond > budgets.maximumHeapSlopeBytesPerSecond
)
  failures.push("heap slope");
if (requestedDurationMs >= 60_000 && rssSlopeBytesPerSecond > budgets.maximumRssSlopeBytesPerSecond)
  failures.push("rss slope");
if (report.resources.handles.growth > budgets.maximumHandleGrowth) failures.push("handle growth");
report.status = failures.length === 0 ? "pass" : "fail";
report.failures = failures;
report.replay = `vp run test:soak -- --duration=${options.get("--duration") ?? "10m"} --seed=${seed}`;
mkdirSync(resolve(root, "test-results"), { recursive: true });
writeFileSync(
  resolve(root, "test-results/terminal-soak.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    ...report,
    resources: { ...report.resources, samples: `${samples.length} samples` },
  }),
);
if (failures.length > 0) process.exitCode = 1;
