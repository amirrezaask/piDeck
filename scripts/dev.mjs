#!/usr/bin/env node

import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requestedPort = process.env.YAADE_PORT ? Number(process.env.YAADE_PORT) : undefined;
const hostPort = requestedPort ?? (await firstAvailablePort(7774, 100));

if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65_535) {
  throw new Error(`Invalid YAADE_PORT: ${process.env.YAADE_PORT}`);
}
if (requestedPort && !(await portIsAvailable(requestedPort))) {
  throw new Error(`YAADE_PORT ${requestedPort} is already in use`);
}

const environment = {
  ...process.env,
  YAADE_PORT: String(hostPort),
  YAADE_DATA_DIR:
    process.env.YAADE_DATA_DIR ?? path.join(repoRoot, ".tmp", `dev-server-${hostPort}`),
};
const children = new Set();
let stopping = false;

console.log(`[dev] unified host: http://127.0.0.1:${hostPort}`);
const server = start(
  "cargo",
  ["run", "--manifest-path", "apps/server/Cargo.toml", "--", "serve", "--port", String(hostPort)],
  environment,
);
children.add(server);
watch(server);

try {
  await waitForHost(server, hostPort);
} catch (error) {
  stopAll("SIGTERM");
  throw error;
}

const web = start(process.execPath, ["apps/web/scripts/dev-web.mjs"], environment);
children.add(web);
watch(web);

process.once("SIGINT", () => stopAll("SIGINT"));
process.once("SIGTERM", () => stopAll("SIGTERM"));

function start(command, args, env) {
  return spawn(command, args, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
}

function watch(child) {
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (stopping) return;
    stopping = true;
    stopAll("SIGTERM");
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

function stopAll(signal) {
  if (!stopping) stopping = true;
  for (const child of children) stopTree(child, signal);
}

function stopTree(child, signal) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitForHost(child, port) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Unified host exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/agents/v1/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) return;
    } catch {
      // The Rust process may still be compiling or binding its socket.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Unified host did not become ready on port ${port}`);
}

async function firstAvailablePort(start, attempts) {
  for (let port = start; port < start + attempts; port += 1) {
    if (await portIsAvailable(port)) return port;
  }
  throw new Error(`No available host port in ${start}-${start + attempts - 1}`);
}

function portIsAvailable(port) {
  return new Promise((resolve) => {
    const socket = net.createServer();
    socket.unref();
    socket.once("error", () => resolve(false));
    socket.listen({ host: "127.0.0.1", port }, () => {
      socket.close(() => resolve(true));
    });
  });
}
