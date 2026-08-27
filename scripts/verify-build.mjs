import { stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findElectronArtifacts } from './lib/electron-artifacts.mjs';

const root = resolve(import.meta.dirname, '..');
const serverBinary = resolve(
  root,
  process.platform === 'win32' ? 'dist/pideck-server.exe' : 'dist/pideck-server',
);
const electronOutput = resolve(root, 'dist/electron');

const execFileAsync = promisify(execFile);

async function assertStaticServerBinary() {
  const metadata = await stat(serverBinary).catch(() => undefined);
  if (!metadata?.isFile() || metadata.size === 0) {
    throw new Error(`Static server binary was not created: ${serverBinary}`);
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o111) === 0) {
    throw new Error(`Static server binary is not executable: ${serverBinary}`);
  }
}

async function verifyAsarAndFuses(binary) {
  const asar = resolve(dirname(binary), process.platform === 'darwin' ? '../Resources/app.asar' : 'resources/app.asar');
  const metadata = await stat(asar).catch(() => undefined);
  if (!metadata?.isFile() || metadata.size === 0) throw new Error(`Packaged ASAR is missing: ${asar}`);
  const fuseCli = resolve(root, 'node_modules/.bin/electron-fuses');
  const fuseTarget = process.platform === 'darwin' ? binary.slice(0, binary.indexOf('.app/') + 4) : binary;
  const { stdout } = await execFileAsync(fuseCli, ['read', '--app', fuseTarget]);
  for (const expected of ['RunAsNode is Disabled', 'EnableNodeOptionsEnvironmentVariable is Disabled', 'EnableNodeCliInspectArguments is Disabled', 'OnlyLoadAppFromAsar is Enabled']) {
    if (!stdout.includes(expected)) throw new Error(`Required Electron fuse is not set: ${expected}`);
  }
}

await assertStaticServerBinary();
const electronOutputFiles = await findElectronArtifacts(electronOutput);
console.log(`Verified static server binary: ${serverBinary}`);
for (const binary of electronOutputFiles.binaries) {
  await verifyAsarAndFuses(binary);
  console.log(`Verified static Electron binary: ${binary}`);
}
for (const artifact of electronOutputFiles.artifacts) {
  console.log(`Verified static Electron artifact: ${basename(artifact)}`);
}
