#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, platform, arch, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ZIG_VERSION = "0.15.2";
const GHOSTTY_REPOSITORY = "https://github.com/ghostty-org/ghostty.git";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_FILE = join(ROOT, "packages/ghostty-core/src/vendor/VERSION");
const COMPAT_VERSION_FILE = join(ROOT, "packages/ghostty-react/src/vendor/VERSION");

const ZIG_ARCHIVES = {
  "darwin-arm64": {
    url: `https://ziglang.org/download/${ZIG_VERSION}/zig-aarch64-macos-${ZIG_VERSION}.tar.xz`,
    sha256: "3cc2bab367e185cdfb27501c4b30b1b0653c28d9f73df8dc91488e66ece5fa6b",
  },
  "darwin-x64": {
    url: `https://ziglang.org/download/${ZIG_VERSION}/zig-x86_64-macos-${ZIG_VERSION}.tar.xz`,
    sha256: "375b6909fc1495d16fc2c7db9538f707456bfc3373b14ee83fdd3e22b3d43f7f",
  },
  "linux-arm64": {
    url: `https://ziglang.org/download/${ZIG_VERSION}/zig-aarch64-linux-${ZIG_VERSION}.tar.xz`,
    sha256: "958ed7d1e00d0ea76590d27666efbf7a932281b3d7ba0c6b01b0ff26498f667f",
  },
  "linux-x64": {
    url: `https://ziglang.org/download/${ZIG_VERSION}/zig-x86_64-linux-${ZIG_VERSION}.tar.xz`,
    sha256: "02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239",
  },
  "win32-arm64": {
    url: `https://ziglang.org/download/${ZIG_VERSION}/zig-aarch64-windows-${ZIG_VERSION}.zip`,
    sha256: "b926465f8872bf983422257cd9ec248bb2b270996fbe8d57872cca13b56fc370",
  },
  "win32-x64": {
    url: `https://ziglang.org/download/${ZIG_VERSION}/zig-x86_64-windows-${ZIG_VERSION}.zip`,
    sha256: "3a0ed1e8799a2f8ce2a6e6290a9ff22e6906f8227865911fb7ddedc3cc14cb0c",
  },
};

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) {
    fail(`${command} could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = options.capture ? `: ${(result.stderr || result.stdout).trim()}` : "";
    fail(`${command} exited with ${result.status}${detail}`);
  }
  return options.capture ? result.stdout.trim() : "";
}

async function readRevision() {
  const revision = (await readFile(VERSION_FILE, "utf8")).trim();
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    fail(`${VERSION_FILE} must contain one lowercase 40-character Git revision`);
  }
  const compatibilityRevision = (await readFile(COMPAT_VERSION_FILE, "utf8")).trim();
  if (compatibilityRevision !== revision) {
    fail(`${COMPAT_VERSION_FILE} must match ${VERSION_FILE}`);
  }
  return revision;
}

function cacheRoot() {
  return resolve(
    process.env.YAADE_GHOSTTY_CACHE_DIR ?? join(homedir(), ".cache", "yaade", "ghostty"),
  );
}

function sourcePath(revision) {
  return resolve(process.env.GHOSTTY_SOURCE_DIR ?? join(cacheRoot(), `source-${revision}`));
}

function zigExecutableName() {
  return platform() === "win32" ? "zig.exe" : "zig";
}

function downloadedZigPath() {
  const key = `${platform()}-${arch()}`;
  return join(cacheRoot(), `zig-${ZIG_VERSION}-${key}`, zigExecutableName());
}

function zigGlobalCachePath() {
  return join(cacheRoot(), `zig-global-${ZIG_VERSION}`);
}

function zigTarget() {
  const targets = {
    "darwin-arm64": "aarch64-macos",
    "darwin-x64": "x86_64-macos",
    "linux-arm64": "aarch64-linux-gnu",
    "linux-x64": "x86_64-linux-gnu",
    "win32-arm64": "aarch64-windows-msvc",
    "win32-x64": "x86_64-windows-msvc",
  };
  const key = `${platform()}-${arch()}`;
  const target = targets[key];
  if (!target) {
    fail(`no native Ghostty target mapping for ${key}`);
  }
  return target;
}

function verifyZig(candidate) {
  const result = spawnSync(candidate, ["version"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() === ZIG_VERSION;
}

async function verifySource(path, revision) {
  if (!existsSync(join(path, ".git"))) {
    fail(`Ghostty source is not prepared at ${path}; run \`vp run prepare:ghostty\``);
  }
  const actual = run("git", ["rev-parse", "HEAD"], { cwd: path, capture: true });
  if (actual !== revision) {
    fail(`Ghostty source at ${path} is ${actual}, expected ${revision}`);
  }
  const dirty = run("git", ["status", "--porcelain=v1", "--untracked-files=no"], {
    cwd: path,
    capture: true,
  });
  if (dirty !== "") {
    fail(`Ghostty source at ${path} has tracked modifications; refusing to use it`);
  }
  const requiredZig = await readFile(join(path, "build.zig.zon"), "utf8");
  if (!requiredZig.includes(`.minimum_zig_version = "${ZIG_VERSION}"`)) {
    fail(`Ghostty ${revision} does not declare Zig ${ZIG_VERSION}`);
  }
}

async function prepareSource(path, revision) {
  if (existsSync(path)) {
    await verifySource(path, revision);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = await mkdtemp(join(dirname(path), ".source-"));
  try {
    run("git", ["clone", "--filter=blob:none", "--no-checkout", GHOSTTY_REPOSITORY, temporary]);
    run("git", ["fetch", "--depth=1", "origin", revision], { cwd: temporary });
    run("git", ["checkout", "--detach", revision], { cwd: temporary });
    await verifySource(temporary, revision);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) {
    fail(`download failed (${response.status}) for ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function prepareZig() {
  if (process.env.GHOSTTY_ZIG) {
    const explicit = resolve(process.env.GHOSTTY_ZIG);
    if (!verifyZig(explicit)) {
      fail(`GHOSTTY_ZIG must point to Zig ${ZIG_VERSION}: ${explicit}`);
    }
    return explicit;
  }
  if (verifyZig("zig")) {
    return "zig";
  }

  const destination = downloadedZigPath();
  if (verifyZig(destination)) {
    return destination;
  }

  const key = `${platform()}-${arch()}`;
  const archive = ZIG_ARCHIVES[key];
  if (!archive) {
    fail(`no pinned Zig archive for ${key}`);
  }

  await mkdir(dirname(destination), { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), "yaade-zig-"));
  try {
    const bytes = await download(archive.url);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== archive.sha256) {
      fail(`Zig archive checksum mismatch: expected ${archive.sha256}, received ${actual}`);
    }
    const archivePath = join(temporary, archive.url.endsWith(".zip") ? "zig.zip" : "zig.tar.xz");
    await writeFile(archivePath, bytes);
    const extracted = join(temporary, "extracted");
    await mkdir(extracted);
    if (archivePath.endsWith(".zip")) {
      run("powershell", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${extracted.replaceAll("'", "''")}'`,
      ]);
    } else {
      run("tar", ["-xJf", archivePath, "-C", extracted]);
    }
    const entries = await readdir(extracted);
    if (entries.length !== 1) {
      fail(`unexpected Zig archive layout: ${entries.join(", ")}`);
    }
    const unpacked = join(extracted, entries[0]);
    if (!(await stat(unpacked)).isDirectory()) {
      fail("Zig archive root is not a directory");
    }
    await rm(dirname(destination), { recursive: true, force: true });
    await mkdir(dirname(dirname(destination)), { recursive: true });
    await rename(unpacked, dirname(destination));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  if (!verifyZig(destination)) {
    fail(`prepared Zig executable is not version ${ZIG_VERSION}: ${destination}`);
  }
  return destination;
}

function checkZig() {
  const candidate = process.env.GHOSTTY_ZIG
    ? resolve(process.env.GHOSTTY_ZIG)
    : verifyZig("zig")
      ? "zig"
      : downloadedZigPath();
  if (!verifyZig(candidate)) {
    fail(`Zig ${ZIG_VERSION} is not prepared; run \`vp run prepare:ghostty\``);
  }
  return candidate;
}

async function prepareZigDependencies(source, zig, revision) {
  const globalCache = zigGlobalCachePath();
  await mkdir(globalCache, { recursive: true });
  run(
    zig,
    [
      "build",
      "-Demit-lib-vt=true",
      "-Dsimd=false",
      "-Dapp-runtime=none",
      "-Demit-xcframework=false",
      `-Dtarget=${zigTarget()}`,
      "--fetch=all",
      "--global-cache-dir",
      globalCache,
    ],
    { cwd: source },
  );
  await writeFile(join(globalCache, "yaade-prepared"), `${revision}\n${ZIG_VERSION}\n`);
  return globalCache;
}

async function checkZigDependencies(revision) {
  const globalCache = zigGlobalCachePath();
  const stamp = join(globalCache, "yaade-prepared");
  if (!existsSync(stamp) || !existsSync(join(globalCache, "p"))) {
    fail(`Ghostty Zig dependencies are not prepared; run \`vp run prepare:ghostty\``);
  }
  const expected = `${revision}\n${ZIG_VERSION}\n`;
  if ((await readFile(stamp, "utf8")) !== expected) {
    fail(`Ghostty Zig dependency cache does not match ${revision}`);
  }
  return globalCache;
}

async function main() {
  const checkOnly = process.argv.includes("check") || process.argv.includes("--check");
  const json = process.argv.includes("--json");
  const revision = await readRevision();
  const source = sourcePath(revision);

  if (checkOnly) {
    await verifySource(source, revision);
  } else {
    await prepareSource(source, revision);
  }
  const zig = checkOnly ? checkZig() : await prepareZig();
  const zigGlobalCache = checkOnly
    ? await checkZigDependencies(revision)
    : await prepareZigDependencies(source, zig, revision);
  const identity = createHash("sha256")
    .update(`${revision}\0${ZIG_VERSION}\0${platform()}\0${arch()}`)
    .digest("hex");
  const result = {
    revision,
    source,
    zig,
    zigGlobalCache,
    zigVersion: ZIG_VERSION,
    identity,
  };

  if (process.env.GITHUB_ENV) {
    await writeFile(
      process.env.GITHUB_ENV,
      `GHOSTTY_SOURCE_DIR=${source}\nGHOSTTY_ZIG=${zig}\nGHOSTTY_ZIG_GLOBAL_CACHE_DIR=${zigGlobalCache}\n`,
      { flag: "a" },
    );
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(
      `[ghostty] revision=${revision}\n[ghostty] source=${source}\n[ghostty] zig=${zig} (${ZIG_VERSION})\n[ghostty] dependencies=${zigGlobalCache}\n[ghostty] cache=${identity}\n`,
    );
  }
}

main().catch((error) => {
  console.error(`[ghostty] ${error.message}`);
  process.exitCode = 1;
});
