import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { platform, arch, release } from "node:os";

const root = resolve(import.meta.dirname, "..");
const args = new Map(
  process.argv
    .slice(2)
    .filter((value) => value !== "--")
    .map((value) => {
      const [key, item = "true"] = value.split("=", 2);
      return [key, item];
    }),
);
for (const key of args.keys())
  if (!["--dry-run", "--output", "--confirm"].includes(key))
    throw new Error(`unknown bundle option: ${key}`);
const candidates = [
  ["compatibility.json", "test-results/compatibility.json"],
  ["terminal-chaos.json", "test-results/terminal-chaos.json"],
  ["terminal-soak.json", "test-results/terminal-soak.json"],
  ["release-quality.json", "test-results/release-quality.json"],
];
const maximumFileBytes = 1024 * 1024;
const maximumTotalBytes = 4 * 1024 * 1024;
const included = candidates
  .filter(([, path]) => existsSync(resolve(root, path)))
  .map(([name, path]) => ({
    name,
    path,
    bytes: Math.min(statSync(resolve(root, path)).size, maximumFileBytes),
  }));
const inventory = {
  version: 1,
  files: ["manifest.json", "status.json", ...included.map((value) => value.name)],
  estimatedMaximumBytes: Math.min(
    maximumTotalBytes,
    16_384 + included.reduce((total, value) => total + value.bytes, 0),
  ),
  excluded: [
    "databases",
    "terminal archives and rows",
    "browser storage",
    "environment",
    "paths",
    "URLs",
    "credentials",
    "screenshots",
    "memory dumps",
  ],
  uploadsAutomatically: false,
};
if (args.has("--dry-run")) {
  console.log(JSON.stringify(inventory, null, 2));
  process.exit(0);
}
if (!args.has("--confirm"))
  throw new Error("bundle generation requires --confirm after reviewing --dry-run");
const output = resolve(root, args.get("--output") ?? "test-results/yaade-support-bundle");
const temporary = `${output}.tmp-${process.pid}`;
rmSync(temporary, { recursive: true, force: true });
mkdirSync(temporary, { recursive: true, mode: 0o700 });
const aliasSalt = randomBytes(16).toString("hex");
const manifest = {
  ...inventory,
  createdLocally: true,
  aliasSaltSha256: createHash("sha256").update(aliasSalt).digest("hex"),
};
const packageVersion = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
const status = {
  version: 1,
  build: packageVersion,
  platform: platform(),
  architecture: arch(),
  osRelease: release(),
  health: "not-probed",
  note: "No server was contacted by the offline bundle command.",
};
writeFileSync(resolve(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
  mode: 0o600,
});
writeFileSync(resolve(temporary, "status.json"), `${JSON.stringify(status, null, 2)}\n`, {
  mode: 0o600,
});
let total = Buffer.byteLength(JSON.stringify(manifest)) + Buffer.byteLength(JSON.stringify(status));
for (const item of included) {
  if (total >= maximumTotalBytes) break;
  const data = readFileSync(resolve(root, item.path)).subarray(
    0,
    Math.min(item.bytes, maximumTotalBytes - total),
  );
  // Imported reports are generated from typed, content-free harnesses only.
  writeFileSync(resolve(temporary, basename(item.name)), data, { mode: 0o600 });
  total += data.byteLength;
}
rmSync(output, { recursive: true, force: true });
renameSync(temporary, output);
chmodSync(output, 0o700);
console.log(
  JSON.stringify({
    output: basename(output),
    bytes: total,
    files: inventory.files,
    uploaded: false,
  }),
);
