import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const docsRoot = fileURLToPath(new URL('../docs/', import.meta.url));
const docsCLI = `${docsRoot}node_modules/vocs/dist/cli.js`;
if (!existsSync(docsCLI)) throw new Error('Install docs dependencies first: npm ci --prefix docs --ignore-scripts');

const children = [
  spawn(process.execPath, ['scripts/local-app.ts'], { stdio: 'inherit' }),
  spawn(process.execPath, ['scripts/serve-recovery.ts'], { stdio: 'inherit' }),
  spawn(process.execPath, [docsCLI, 'dev', '--host', '127.0.0.1', '--port', '5174'], { cwd: docsRoot, stdio: 'inherit' }),
];
let stopping = false;
function stop(code: number) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
}
for (const child of children) {
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code ?? 1); });
}
process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));
