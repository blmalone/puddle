import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureCheckout } from '../../scripts/checkout.ts';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const upstream = `${root}.cache/privacy-pools-v2`;
export const commit = '4d48c4feb874606ffd9eb309e16fbe846e3ceaf6';
export const artifacts = `${root}.cache/privacy-pools-artifacts/${commit}`;

export function ensureUpstream() {
  ensureCheckout(upstream, 'https://github.com/0xbow-io/v2-monorepo.git', commit);
}

export async function setup() {
  ensureUpstream();
  execFileSync('pnpm', ['--filter', '@privacy-pools-v2/sdk...', 'install',
    '--frozen-lockfile', '--ignore-scripts', '--store-dir', `${root}.cache/privacy-pools-pnpm-store`],
  { cwd: upstream, stdio: 'inherit', env: { ...process.env, CI: 'true' } });
  execFileSync('pnpm', ['--filter', '@privacy-pools-v2/sdk', 'build'], { cwd: upstream, stdio: 'inherit' });
  execFileSync('git', ['-C', upstream, 'remote', 'set-url', 'origin', 'https://github.com/0xbow-io/v2-monorepo.git']);
  execFileSync('git', ['-C', upstream, 'lfs', 'fetch', 'origin', commit,
    '--include=packages/circuits/build/deposit/**,packages/circuits/build/ragequit/**,packages/circuits/build/transact_1x1/**'],
  { stdio: 'inherit' });

  // Fetch only the three circuits the integration tests use. Verify each LFS object
  // against the SHA-256 stored in the pinned commit. Matching verifiers are
  // deployed locally; this does not verify a production setup ceremony.
  for (const circuit of ['deposit', 'ragequit', 'transact_1x1']) {
    for (const name of ['groth16_pkey.zkey', 'groth16_verifier.sol', 'groth16_vkey.json', `${circuit}_js/${circuit}.wasm`]) {
      const relative = `${circuit}/${name}`;
      const source = `packages/circuits/build/${relative}`;
      const pointer = execFileSync('git', ['-C', upstream, 'show', `${commit}:${source}`], { encoding: 'utf8' });
      const hash = /oid sha256:([a-f0-9]{64})/.exec(pointer)?.[1];
      const destination = `${artifacts}/${relative}`;
      const data = hash
        ? readFileSync(`${upstream}/.git/lfs/objects/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`)
        : Buffer.from(pointer);
      if (hash && digest(data) !== hash) throw new Error(`Artifact checksum mismatch: ${source}`);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, data);
    }
  }
  console.log(`Privacy Pools test dependencies ready (${commit.slice(0, 7)}). Local test artifacts only.`);
}

function digest(data: Buffer) { return createHash('sha256').update(data).digest('hex'); }

if (process.argv[1] === fileURLToPath(import.meta.url)) await setup();
