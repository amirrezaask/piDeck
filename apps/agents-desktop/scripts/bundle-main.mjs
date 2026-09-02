import { rm, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const output = resolve(import.meta.dirname, '../dist/main.js');
const temporaryOutput = resolve(import.meta.dirname, '../dist/main.bundle.js');

await new Promise((resolveProcess, reject) => {
  const child = spawn(
    'bun',
    [
      'build',
      output,
      '--bundle',
      '--target=node',
      '--format=esm',
      '--external',
      'electron',
      '--outfile',
      temporaryOutput,
    ],
    { stdio: 'inherit' },
  );
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code === 0) resolveProcess();
    else
      reject(
        new Error(`bun build failed${signal ? ` with ${signal}` : ` with exit code ${code}`}`),
      );
  });
});

await rm(`${output}.map`, { force: true });
await rename(temporaryOutput, output);
console.log(`Bundled Electron main process: ${output}`);
