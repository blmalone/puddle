import assert from 'node:assert/strict';
import { formatEther, parseEther, keccak256 } from 'ethers';
import { FORK, createEnvironment, createRecipient, prepareDeposit, fund, settle,
  decryptDeposit, saveReport } from './harness.ts';

const fork = { ...FORK, rpc: process.env.ARBITRUM_RPC_URL || FORK.rpc,
  block: Number(process.env.FORK_BLOCK || FORK.block) };
console.log(`Starting local Anvil fork of Arbitrum at block ${fork.block}…`);
const env = await createEnvironment(undefined, fork);
try {
  const recipient = await createRecipient();
  const deposit = await prepareDeposit(env, recipient.address);
  console.log(`Deployed RAILGUN proxy: ${await env.pool.getAddress()}`);
  console.log(`Recipient (ephemeral test identity): ${recipient.address}`);
  console.log(`CREATE2 deposit address: ${deposit.address}`);
  assert.equal(await env.provider.getCode(deposit.address), '0x');
  const amount = parseEther('0.1');
  const poolBefore = await env.token.balanceOf(await env.pool.getAddress());
  const rootBefore = await env.pool.merkleRoot();
  const funded = await fund(env, deposit.address, amount);
  assert.equal(await env.provider.getCode(deposit.address), '0x');
  console.log('Wrapped fork-only ETH into real WETH, then sent 0.1 WETH to the undeployed address.');
  const receipt = await settle(env, deposit);
  assert(env.depositPath, 'Settlement must capture the deposit path');
  const note = await decryptDeposit(env, recipient, receipt);
  assert.equal(await env.token.balanceOf(await env.pool.getAddress()) - poolBefore, note.amount);
  assert.equal(await env.token.balanceOf(deposit.address), 0n);
  assert.equal(note.amount + note.fee, amount);
  assert.notEqual(note.root, rootBefore);
  await assert.rejects(decryptDeposit(env, await createRecipient(), receipt));
  console.log(`RAILGUN accepted the shield: ${formatEther(note.amount)} WETH after ${formatEther(note.fee)} WETH fee.`);
  console.log('Recipient decrypted the note; a different recipient could not.');
  console.log(`Verified note inclusion in the existing RAILGUN Merkle tree at leaf ${env.depositPath.index}.`);
  console.log(`Deployment + shielding gas: ${receipt.gasUsed} (local EVM execution; excludes Arbitrum L1 data fees).`);
  saveReport({ mode: 'Arbitrum Anvil fork', sourceChainId: 42161, localChainId: 31337,
    forkBlock: fork.block, recipient: recipient.address, depositAddress: deposit.address,
    pool: await env.pool.getAddress(), token: await env.token.getAddress(),
    poolProxyCodeHash: keccak256(await env.provider.getCode(await env.pool.getAddress())),
    fundingTransaction: funded.hash, shieldingTransaction: receipt.hash, shieldingGas: receipt.gasUsed,
    leafIndex: env.depositPath.index, treeNumber: env.depositPath.treeNumber, ...note,
    validated: ['live deployed contracts on a local fork', 'fund before deployment',
      'ordinary WETH transfer', 'relayer-funded shielding', 'recipient decryption',
      'wrong recipient cannot decrypt', 'actual pool balance increase', 'Merkle inclusion'],
    notValidated: ['private spend or withdrawal proof', 'production PPOI acceptance', 'production deployment'] });
  console.log('Saved artifacts/demo-result.json. No real transactions were sent.');
} finally { await env.close(); }
