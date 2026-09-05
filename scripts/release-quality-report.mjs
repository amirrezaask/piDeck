import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const required = [
  ["conformance", "test-results/conformance.json"],
  ["compatibility", "test-results/compatibility.json"],
  ["chaos", "test-results/terminal-chaos.json"],
  ["soak", "test-results/terminal-soak.json"],
  ["diagnostics", "test-results/diagnostics.json"],
  ["performance", "test-results/bench-quality.json"],
];
const dimensions = required.map(([name, path]) => {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) return { name, status: "missing", path };
  const bytes = readFileSync(absolute);
  let status = "invalid";
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    status = value.status ?? "invalid";
    if (name === "soak" && (!(value.measuredDurationMs >= 600_000) || value.seed === undefined)) {
      status = "insufficient-release-duration";
    }
  } catch {}
  return { name, status, path, sha256: createHash("sha256").update(bytes).digest("hex") };
});
const slos = JSON.parse(readFileSync(resolve(root, "tests/bench/slos.json"), "utf8"));
const conformance = JSON.parse(
  readFileSync(resolve(root, "tests/conformance/manifest.json"), "utf8"),
);
const unsupportedMetrics = [
  ...new Set(
    slos.objectives
      .filter((objective) => objective.status === "specified")
      .map((objective) => objective.metric),
  ),
];
const report = {
  version: 1,
  registrySha256: createHash("sha256").update(JSON.stringify(slos)).digest("hex"),
  conformanceSha256: createHash("sha256").update(JSON.stringify(conformance)).digest("hex"),
  dimensions,
  zeroTolerance: slos.zeroTolerance,
  unsupportedMetrics,
  status:
    unsupportedMetrics.length === 0 && dimensions.every((value) => value.status === "pass")
      ? "pass"
      : "fail",
};
const canonical = JSON.stringify(report);
const signed = { ...report, reportSha256: createHash("sha256").update(canonical).digest("hex") };
mkdirSync(resolve(root, "test-results"), { recursive: true });
writeFileSync(
  resolve(root, "test-results/release-quality.json"),
  `${JSON.stringify(signed, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(JSON.stringify(signed));
if (signed.status !== "pass") process.exitCode = 1;
