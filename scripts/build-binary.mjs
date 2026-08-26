import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const webRoot = resolve(root, 'apps/web/dist');
const buildDirectory = resolve(root, 'dist/.pideck-binary');
const entry = resolve(buildDirectory, 'entry.ts');
const output = resolve(
  root,
  process.platform === 'win32' ? 'dist/pideck-server.exe' : 'dist/pideck-server',
);

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

function quote(value) {
  return JSON.stringify(value);
}

async function main() {
  const assets = (await collectFiles(webRoot)).sort();
  if (assets.length === 0) throw new Error(`No web assets found in ${webRoot}`);

  await rm(buildDirectory, { recursive: true, force: true });
  await mkdir(dirname(entry), { recursive: true });

  const imports = assets
    .map((asset, index) => {
      return `import asset${index} from ${quote(asset)} with { type: 'file' };`;
    })
    .join('\n');
  const assetMap = assets
    .map((asset, index) => {
      const name = relative(webRoot, asset).replaceAll('\\', '/');
      return `  ${quote(name)}: asset${index},`;
    })
    .join('\n');
  const serverEntry = resolve(root, 'apps/server/src/main.ts');
  const source = `${imports}\n\n` +
    `globalThis.__PIDECK_EMBEDDED_ASSETS__ = {\n${assetMap}\n};\n` +
    `await import(${quote(serverEntry)});\n`;
  await writeFile(entry, source);

  await new Promise((resolveProcess, reject) => {
    const child = spawn('bun', ['build', '--compile', '--minify', '--outfile', output, entry], {
      cwd: root,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveProcess();
      else reject(new Error(`bun build failed${signal ? ` with ${signal}` : ` with exit code ${code}`}`));
    });
  });

  console.log(`Built static server binary: ${output}`);
}

await main();
