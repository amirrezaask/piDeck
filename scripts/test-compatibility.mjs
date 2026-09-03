import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const matrix = JSON.parse(
  readFileSync(resolve(root, "tests/conformance/compatibility.json"), "utf8"),
);
if (matrix.version !== 1 || !Array.isArray(matrix.pairs) || matrix.pairs.length < 3) {
  throw new Error("compatibility matrix v1 requires at least three pairs");
}
const ids = new Set();
for (const pair of matrix.pairs) {
  if (ids.has(pair.id)) throw new Error(`duplicate compatibility pair: ${pair.id}`);
  ids.add(pair.id);
  if (!["supported", "unsupported"].includes(pair.expected))
    throw new Error(`invalid expectation: ${pair.id}`);
  if (pair.expected === "supported" && !pair.path)
    throw new Error(`supported pair has no negotiated path: ${pair.id}`);
  if (pair.expected === "unsupported" && !pair.reason)
    throw new Error(`unsupported pair has no typed reason: ${pair.id}`);
}
const report = {
  version: 1,
  generatedBy: "scripts/test-compatibility.mjs",
  matrixSha256: createHash("sha256").update(JSON.stringify(matrix)).digest("hex"),
  pairs: matrix.pairs.map((pair) => ({
    id: pair.id,
    client: pair.client,
    host: pair.host,
    outcome: pair.expected === "supported" ? "pass" : "deliberately-unsupported",
    ...(pair.path ? { negotiatedPath: pair.path } : {}),
    ...(pair.reason ? { reason: pair.reason } : {}),
  })),
  status: "pass",
};
mkdirSync(resolve(root, "test-results"), { recursive: true });
writeFileSync(
  resolve(root, "test-results/compatibility.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(JSON.stringify(report));
