import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEther } from 'ethers';
import { FORK, createEnvironment, createRecipient, prepareDeposit, fund, settle,
  decryptDeposit } from '../scripts/harness.ts';

test('CREATE2 forwarding deposits real WETH into deployed RAILGUN on an Arbitrum fork', async () => {
  const fork = { ...FORK, rpc: process.env.ARBITRUM_RPC_URL || FORK.rpc,
    block: Number(process.env.FORK_BLOCK || FORK.block) };
  const env = await createEnvironment(undefined, fork);
  try {
    const recipient = await createRecipient();
    const amount = parseEther('0.1');
    const gasFee = parseEther('0.00001');
    const serviceFee = amount / 1_000n;
    const deposit = await prepareDeposit(env, recipient.address,
      { minDeposit: amount, maxGasFee: parseEther('0.00002') });
    const balanceBefore = await env.token.balanceOf(await env.pool.getAddress());
    const feeBasisPoints = await env.pool.shieldFee();
    assert.equal(await env.provider.getCode(deposit.address), '0x');
    await fund(env, deposit.address, amount);
    assert.equal(await env.provider.getCode(deposit.address), '0x');
    const receipt = await settle(env, deposit, gasFee);
    const note = await decryptDeposit(env, recipient, receipt);
    assert.equal(note.fee, (amount - serviceFee - gasFee) * feeBasisPoints / 10_000n);
    assert.equal(note.amount + note.fee + serviceFee + gasFee, amount);
    assert.equal(await env.token.balanceOf(await env.feeCollector.getAddress()), serviceFee + gasFee);
    assert.equal(await env.token.balanceOf(await env.pool.getAddress()) - balanceBefore, note.amount);
    assert.equal(await env.token.balanceOf(deposit.address), 0n);
    assert.equal(await env.token.allowance(deposit.address, await env.pool.getAddress()), 0n);
    await assert.rejects(decryptDeposit(env, await createRecipient(), receipt));
    await assert.rejects(env.forwarderAt(deposit.address).shield.staticCall(gasFee));
  } finally { await env.close(); }
});
