import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

// Fetch exact commits. An interrupted first download can be retried without deleting the cache.
export function ensureCheckout(directory: string, repository: string, commit: string) {
  mkdirSync(directory, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' } }).trim();
  if (!existsSync(`${directory}/.git`)) git('init');
  if (spawnSync('git', ['-C', directory, 'rev-parse', '--verify', 'HEAD'], { stdio: 'ignore' }).status !== 0) {
    git('fetch', '--depth=1', repository, commit);
    git('checkout', '--detach', commit);
  }
  if (git('rev-parse', 'HEAD') !== commit || git('status', '--porcelain')) {
    throw new Error(`Expected a clean checkout at ${commit}: ${directory}`);
  }
}
