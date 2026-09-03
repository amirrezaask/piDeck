import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const taxonomy = JSON.parse(readFileSync(resolve(root, "tests/diagnostics/taxonomy.json"), "utf8"));
const slos = JSON.parse(readFileSync(resolve(root, "tests/bench/slos.json"), "utf8"));
const names = new Set();
if (
  taxonomy.version !== 1 ||
  !Array.isArray(taxonomy.fields) ||
  !Array.isArray(taxonomy.prohibited)
)
  throw new Error("diagnostic taxonomy v1 is required");
for (const field of taxonomy.fields) {
  if (!/^[a-z][a-z0-9_.-]+$/.test(field.name))
    throw new Error(`invalid diagnostic field: ${field.name}`);
  if (names.has(field.name)) throw new Error(`duplicate diagnostic field: ${field.name}`);
  names.add(field.name);
  if (!Number.isInteger(field.cardinality) || field.cardinality < 1 || field.cardinality > 4096)
    throw new Error(`unbounded cardinality: ${field.name}`);
  const lower = field.name.toLowerCase();
  for (const prohibited of taxonomy.prohibited)
    if (lower.includes(prohibited)) throw new Error(`sensitive diagnostic field: ${field.name}`);
}
if (slos.version !== 1 || !Array.isArray(slos.objectives) || slos.objectives.length === 0)
  throw new Error("SLO registry v1 is required");
const objectiveKeys = new Set();
for (const objective of slos.objectives) {
  const key = `${objective.metric}:${objective.percentile}:${slos.profile.id}`;
  if (objectiveKeys.has(key)) throw new Error(`duplicate SLO: ${key}`);
  objectiveKeys.add(key);
  if (objective.unit !== "ms" || !(objective.ceiling > 0))
    throw new Error(`invalid SLO unit/ceiling: ${key}`);
  if (
    !objective.startFence ||
    !objective.endFence ||
    /sleep|timeout|command-ended/i.test(objective.endFence)
  )
    throw new Error(`non-semantic SLO fence: ${key}`);
  if (!Number.isInteger(objective.iterations) || objective.iterations < 1)
    throw new Error(`invalid SLO iterations: ${key}`);
}
const canaries = [
  "terminal-output-canary",
  "/Users/private/project",
  "token=super-secret",
  "https://user:pass@example.test/?key=x",
];
const serialized = JSON.stringify({ taxonomy, slos });
for (const canary of canaries)
  if (serialized.includes(canary)) throw new Error("diagnostic registry leaked canary content");
const report = { taxonomyFields: names.size, objectives: objectiveKeys.size, status: "pass" };
mkdirSync(resolve(root, "test-results"), { recursive: true });
writeFileSync(
  resolve(root, "test-results/diagnostics.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(JSON.stringify(report));
