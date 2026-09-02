#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

function resolvePtyRoot(fromDirectory) {
  const require = createRequire(path.join(fromDirectory, 'package.json'));
  return path.dirname(require.resolve('node-pty/package.json'));
}

try {
  const root = resolvePtyRoot(path.dirname(fileURLToPath(import.meta.url)));
  const prebuilds = path.join(root, 'prebuilds');
  if (fs.existsSync(prebuilds)) {
    for (const platform of fs.readdirSync(prebuilds)) {
      const helper = path.join(prebuilds, platform, 'spawn-helper');
      if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
    }
  }
} catch (error) {
  console.warn(
    `[fix-node-pty-perms] skipped: ${error instanceof Error ? error.message : String(error)}`,
  );
}
