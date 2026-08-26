import { readdir, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const serverBinary = resolve(
  root,
  process.platform === 'win32' ? 'dist/pideck-server.exe' : 'dist/pideck-server',
);
const electronOutput = resolve(root, 'dist/electron');

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(path)));
    else files.push(path);
  }
  return files;
}

async function assertStaticServerBinary() {
  const metadata = await stat(serverBinary).catch(() => undefined);
  if (!metadata?.isFile() || metadata.size === 0) {
    throw new Error(`Static server binary was not created: ${serverBinary}`);
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o111) === 0) {
    throw new Error(`Static server binary is not executable: ${serverBinary}`);
  }
}

async function findElectronArtifacts() {
  const files = await collectFiles(electronOutput).catch(() => []);
  const artifacts = files.filter((path) => /\.(zip|dmg|pkg|deb|rpm|AppImage|exe)$/i.test(path));
  if (artifacts.length === 0) {
    throw new Error(`Electron artifact was not created under ${electronOutput}`);
  }
  const binaries = files.filter((path) => ['piDeck', 'piDeck.exe'].includes(basename(path)));
  if (binaries.length === 0) {
    throw new Error(`Electron executable was not created under ${electronOutput}`);
  }
  for (const binary of binaries) {
    const metadata = await stat(binary);
    if (metadata.size === 0 || (process.platform !== 'win32' && (metadata.mode & 0o111) === 0)) {
      throw new Error(`Electron executable is not runnable: ${binary}`);
    }
  }
  return { artifacts, binaries };
}

await assertStaticServerBinary();
const electronOutputFiles = await findElectronArtifacts();
console.log(`Verified static server binary: ${serverBinary}`);
for (const binary of electronOutputFiles.binaries) {
  console.log(`Verified static Electron binary: ${binary}`);
}
for (const artifact of electronOutputFiles.artifacts) {
  console.log(`Verified static Electron artifact: ${basename(artifact)}`);
}
