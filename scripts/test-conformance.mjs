import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifestPath = resolve(root, "tests/conformance/manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const owners = new Set(["rust", "typescript", "native-wasm"]);
const boundaries = new Set(["wire", "persistence", "parser", "auth", "url-storage"]);
const compatibility = new Set([
  "previous-current",
  "current-only",
  "reset-only",
  "compatibility-only",
]);

function fail(message) {
  throw new Error(`conformance manifest: ${message}`);
}
if (manifest.version !== 1 || !Array.isArray(manifest.decoders) || manifest.decoders.length === 0) {
  fail("version 1 with a non-empty decoders array is required");
}
const ids = new Set();
for (const [index, decoder] of manifest.decoders.entries()) {
  const at = `decoders[${index}]`;
  if (!/^[a-z0-9][a-z0-9.-]+$/.test(decoder.id ?? "")) fail(`${at}.id is invalid`);
  if (ids.has(decoder.id)) fail(`${at}.id duplicates ${decoder.id}`);
  ids.add(decoder.id);
  if (!owners.has(decoder.owner)) fail(`${at}.owner is invalid`);
  if (!boundaries.has(decoder.boundary)) fail(`${at}.boundary is invalid`);
  if (!compatibility.has(decoder.compatibility)) fail(`${at}.compatibility is invalid`);
  if (
    !Number.isInteger(decoder.maximumInputBytes) ||
    decoder.maximumInputBytes < 1 ||
    decoder.maximumInputBytes > 64 * 1024 * 1024
  )
    fail(`${at}.maximumInputBytes is invalid`);
  if (!existsSync(resolve(root, decoder.path))) fail(`${at}.path does not exist: ${decoder.path}`);
  if (!existsSync(resolve(root, decoder.corpus)))
    fail(`${at}.corpus does not exist: ${decoder.corpus}`);
  if (typeof decoder.fuzzTarget !== "string" || decoder.fuzzTarget.length === 0)
    fail(`${at}.fuzzTarget is required`);
  if (decoder.currentVersion === undefined) fail(`${at}.currentVersion is required`);
  if (!("previousSupportedVersion" in decoder)) fail(`${at}.previousSupportedVersion is required`);
}

const required = [
  "terminal.protocol-v4",
  "terminal.ws-client",
  "terminal.semantic-v3",
  "ghostty.native-wasm",
  "terminal.history-v2",
  "host.rpc-effect-schema",
  "device.auth",
  "host.url-origin",
];
for (const id of required) if (!ids.has(id)) fail(`missing required boundary ${id}`);
const report = { version: manifest.version, decoderCount: ids.size, status: "pass" };
mkdirSync(resolve(root, "test-results"), { recursive: true });
writeFileSync(
  resolve(root, "test-results/conformance.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(JSON.stringify(report));
