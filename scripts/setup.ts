import { fileURLToPath } from 'node:url';
import { ensureCheckout } from './checkout.ts';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const upstreamCommit = '36bcf5ed7cf94bfafb6e1a303e1832c769c16780';
export const upstream = `${root}.cache/railgun-contract`;

export function ensureUpstream() {
  ensureCheckout(upstream, 'https://github.com/Railgun-Privacy/contract.git', upstreamCommit);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  ensureUpstream();
  console.log(`RAILGUN contracts pinned to ${upstreamCommit}`);
}
