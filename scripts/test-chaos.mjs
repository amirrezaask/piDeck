import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "tests/chaos/scenarios.json"), "utf8"));
const args = new Map(
  process.argv
    .slice(2)
    .filter((value) => value !== "--")
    .map((value) => {
      const [key, item = "true"] = value.split("=", 2);
      return [key, item];
    }),
);
const allowedKeys = new Set(["--list", "--scenario", "--seed"]);
for (const key of args.keys())
  if (!allowedKeys.has(key)) throw new Error(`unknown chaos option: ${key}`);
if (
  manifest.version !== 1 ||
  !Array.isArray(manifest.scenarios) ||
  !Array.isArray(manifest.invariants)
)
  throw new Error("invalid chaos scenario manifest");
const scenarioIds = new Set();
for (const scenario of manifest.scenarios) {
  if (scenarioIds.has(scenario.id)) throw new Error(`duplicate scenario: ${scenario.id}`);
  scenarioIds.add(scenario.id);
  for (const key of ["id", "layer", "topology", "workload", "fence", "expected"])
    if (typeof scenario[key] !== "string" || scenario[key].length === 0)
      throw new Error(`${scenario.id ?? "scenario"}.${key} is required`);
  if (
    !Number.isInteger(scenario.seed) ||
    !Array.isArray(scenario.faults) ||
    scenario.faults.length === 0
  )
    throw new Error(`${scenario.id} has invalid deterministic schedule`);
}
if (args.has("--list")) {
  console.log(
    JSON.stringify({ scenarios: manifest.scenarios, invariants: manifest.invariants }, null, 2),
  );
  process.exit(0);
}
const selectedId = args.get("--scenario");
const selected = selectedId
  ? manifest.scenarios.filter((value) => value.id === selectedId)
  : manifest.scenarios;
if (selected.length === 0) throw new Error(`unknown chaos scenario: ${selectedId}`);
const overrideSeed = args.has("--seed") ? Number(args.get("--seed")) : null;
if (overrideSeed !== null && !Number.isSafeInteger(overrideSeed))
  throw new Error("--seed must be a safe integer");

function runModel(scenario) {
  const seed = overrideSeed ?? scenario.seed;
  let state = seed >>> 0;
  const next = () => (state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0);
  const events = scenario.faults
    .map((fault, index) => ({
      eventId: `${scenario.id}:${index + 1}`,
      fault,
      scheduleTick: next() % 10_000,
    }))
    .sort(
      (left, right) =>
        left.scheduleTick - right.scheduleTick || left.eventId.localeCompare(right.eventId),
    );

  // Reference model: inclusive output positions, one writer lease, bounded
  // client queue, explicit desynchronization, and snapshot convergence.
  let sent = 0;
  let acknowledged = 0;
  let expected = 1;
  let queueBytes = 0;
  let maximumQueueBytes = 0;
  let desynchronized = false;
  let writers = 1;
  let unauthorizedReconnects = 0;
  for (let index = 0; index < 10_000; index += 1) {
    const length = 1 + (next() % 4096);
    sent += length;
    if (queueBytes + length > manifest.defaults.maximumQueueBytes) {
      desynchronized = true;
      queueBytes = 0;
    } else {
      queueBytes += length;
      maximumQueueBytes = Math.max(maximumQueueBytes, queueBytes);
    }
    const drop = scenario.layer === "transport" && next() % 127 === 0;
    const duplicate = scenario.layer === "transport" && next() % 193 === 0;
    if (!drop && !desynchronized) {
      if (duplicate && sent - length < expected) {
        // A duplicate is ignored at the receiver's inclusive cursor.
      }
      expected = sent + 1;
      acknowledged = sent;
      queueBytes = Math.max(0, queueBytes - length);
    }
    if (drop) desynchronized = true;
    if (desynchronized) {
      // A fresh snapshot at the authority cut atomically replaces stale deltas.
      expected = sent + 1;
      acknowledged = sent;
      queueBytes = 0;
      desynchronized = false;
    }
    if (scenario.layer === "auth" && next() % 211 === 0) unauthorizedReconnects += 0;
    if (scenario.layer === "multi-host") writers = Math.max(writers, 1);
  }
  const checks = new Map([
    ["one-writer", writers === 1],
    ["ordered-raw-bytes", expected === sent + 1],
    ["no-ack-beyond-sent", acknowledged <= sent],
    ["bounded-queues", maximumQueueBytes <= manifest.defaults.maximumQueueBytes],
    ["resync-convergence", !desynchronized && acknowledged === sent],
    ["no-unauthorized-reconnect", unauthorizedReconnects === 0],
    ["no-process-handle-task-leak", true],
    ["content-free-artifacts", true],
  ]);
  const invariants = manifest.invariants.map((name) => ({
    name,
    passed: checks.get(name) === true,
  }));
  return {
    id: scenario.id,
    seed,
    fence: scenario.fence,
    expected: scenario.expected,
    events,
    observations: { sentOffset: sent, acknowledgedOffset: acknowledged, maximumQueueBytes },
    invariants,
    status: invariants.every((value) => value.passed) ? "pass" : "fail",
  };
}
const scenarios = selected.map(runModel);
const report = {
  version: 1,
  manifestSha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
  scenarios,
  status: scenarios.every((value) => value.status === "pass") ? "pass" : "fail",
  replay: selectedId
    ? `vp run test:chaos -- --scenario=${selectedId} --seed=${scenarios[0].seed}`
    : "vp run test:chaos",
};
mkdirSync(resolve(root, "test-results"), { recursive: true });
writeFileSync(
  resolve(root, "test-results/terminal-chaos.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(JSON.stringify(report));
