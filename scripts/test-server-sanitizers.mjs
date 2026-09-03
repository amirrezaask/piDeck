import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const nightly = spawnSync("rustup", ["run", "nightly", "rustc", "--version"], {
  cwd: root,
  encoding: "utf8",
});
const environment = { ...process.env };
const args = ["test", "--manifest-path", "packages/yaade-server/Cargo.toml", "--lib"];
let command = "cargo";
if (nightly.status === 0 && process.platform === "linux") {
  command = "rustup";
  args.unshift("run", "nightly");
  environment.RUSTFLAGS = "-Zsanitizer=address -Cforce-frame-pointers=yes -Coverflow-checks=yes";
  environment.RUSTDOCFLAGS = "-Zsanitizer=address";
} else {
  environment.RUSTFLAGS =
    `${environment.RUSTFLAGS ?? ""} -Coverflow-checks=yes -Cdebug-assertions=yes`.trim();
  console.warn("ASan nightly target unavailable; running stable overflow/debug sanitizer smoke");
}
const result = spawnSync(command, args, { cwd: root, env: environment, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
