import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { findElectronArtifacts, selectHostBinary } from './lib/electron-artifacts.mjs';
const exec = promisify(execFile);
const binary = process.argv[2] ?? selectHostBinary((await findElectronArtifacts(resolve(import.meta.dirname, '../dist/electron'))).binaries);
if (!binary) throw new Error('No packaged executable found');
const artifact = process.platform === 'darwin' ? binary.slice(0, binary.indexOf('.app/') + 4) : binary;
if (process.platform === 'darwin') {
  await exec('codesign', ['--verify', '--deep', '--strict', '--verbose=2', artifact]);
  await exec('spctl', ['--assess', '--type', 'execute', '--verbose=2', artifact]);
  await exec('xcrun', ['stapler', 'validate', artifact]);
} else if (process.platform === 'win32') {
  await exec('signtool', ['verify', '/pa', '/all', artifact]);
} else {
  console.log('Linux artifacts have no platform code-signing requirement; ASAR and fuse checks remain mandatory.');
}
