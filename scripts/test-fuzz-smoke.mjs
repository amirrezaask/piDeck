import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const vp = process.platform === "win32" ? "vp.cmd" : "vp";
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(process.execPath, ["scripts/test-conformance.mjs"]);
run(vp, ["test", "packages/yaade-rpc/src/terminal-ws.fuzz.test.ts"]);
run("cargo", ["test", "--manifest-path", "crates/terminal-protocol/Cargo.toml"]);
if (process.env.YAADE_LONG_FUZZ === "1") {
  run("cargo", [
    "fuzz",
    "run",
    "terminal_protocol_decode",
    "--fuzz-dir",
    "crates/terminal-protocol/fuzz",
    "--",
    "-runs=10000",
    "-seed=4210756",
    "-max_len=1048576",
  ]);
}
console.log(
  JSON.stringify({
    status: "pass",
    seed: 4210756,
    typescriptIterations: 10000,
    rustTarget: "terminal_protocol_decode",
    rustMode: process.env.YAADE_LONG_FUZZ === "1" ? "libfuzzer" : "deterministic-corpus",
  }),
);
