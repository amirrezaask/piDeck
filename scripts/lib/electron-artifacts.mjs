import { readdir, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

export async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(path)));
    else files.push(path);
  }
  return files;
}

export async function findElectronArtifacts(electronOutput) {
  const files = await collectFiles(electronOutput).catch(() => []);
  const artifacts = files.filter((path) => /\.(zip|dmg|pkg|deb|rpm|AppImage|exe)$/i.test(path));
  const binaries = files.filter((path) => ['piDeck', 'piDeck.exe'].includes(basename(path)));
  if (artifacts.length === 0) throw new Error(`Electron artifact was not created under ${electronOutput}`);
  if (binaries.length === 0) throw new Error(`Electron executable was not created under ${electronOutput}`);
  for (const binary of binaries) {
    const metadata = await stat(binary);
    if (metadata.size === 0 || (process.platform !== 'win32' && (metadata.mode & 0o111) === 0)) {
      throw new Error(`Electron executable is not runnable: ${binary}`);
    }
  }
  return { artifacts, binaries };
}

export function selectHostBinary(binaries) {
  const expected = process.platform === 'win32' ? 'piDeck.exe' : 'piDeck';
  const platformMarker = process.platform === 'darwin' ? '.app/' : process.platform;
  return binaries.find((path) => basename(path) === expected && path.includes(platformMarker)) ??
    binaries.find((path) => basename(path) === expected);
}
