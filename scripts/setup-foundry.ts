import { ensureUpstream as ensureRailgun, root } from './setup.ts';
import { ensureCheckout } from './checkout.ts';

// Test dependencies only. No SDK build, proving keys, RPC or wallet required.
const forgeStd = `${root}.cache/forge-std`;
const forgeStdCommit = '77041d2ce690e692d6e03cc812b57d1ddaa4d505'; // v1.9.7
ensureRailgun();
ensureCheckout(forgeStd, 'https://github.com/foundry-rs/forge-std.git', forgeStdCommit);

console.log('Foundry dependencies ready.');
