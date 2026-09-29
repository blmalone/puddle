import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const upstreamCommit = '36bcf5ed7cf94bfafb6e1a303e1832c769c16780';
export const upstream = `${root}.cache/railgun-contract`;

export function ensureUpstream() {
  if (!existsSync(`${upstream}/.git`)) {
    mkdirSync(`${root}.cache`, { recursive: true });
    execFileSync('git', ['init', upstream], { stdio: 'pipe' });
    execFileSync('git', ['-C', upstream, 'fetch', '--depth=1',
      'https://github.com/Railgun-Privacy/contract.git', upstreamCommit], { stdio: 'inherit' });
    execFileSync('git', ['-C', upstream, 'checkout', '--detach', upstreamCommit], { stdio: 'pipe' });
  }
  const head = execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['-C', upstream, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
  if (head !== upstreamCommit || dirty) throw new Error('RAILGUN source must match the clean pinned commit.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  ensureUpstream();
  console.log(`RAILGUN contracts pinned to ${upstreamCommit}`);
}
