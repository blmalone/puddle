import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JsonRpcProvider, parseEther } from 'ethers';
import { FORK, compile, createEnvironment, createRecipient, prepareDeposit, fund, settle,
  decryptDeposit } from '../scripts/harness.ts';

test('CREATE2 forwarding deposits real WETH into deployed RAILGUN on an Arbitrum fork', async t => {
  const contracts = compile();
  const rpc = process.env.ARBITRUM_RPC_URL || FORK.rpc;
  const source = new JsonRpcProvider(rpc);
  let block: number;
  try { block = process.env.FORK_BLOCK ? Number(process.env.FORK_BLOCK) : await source.getBlockNumber(); }
  finally { source.destroy(); }
  assert(Number.isSafeInteger(block) && block > 0, 'FORK_BLOCK must be a positive integer.');
  t.diagnostic(`Arbitrum block ${block}; all transactions remain on the local fork.`);
  const env = await createEnvironment(contracts, { ...FORK, rpc, block });
  try {
    const recipient = await createRecipient();
    const amount = parseEther('0.1');
    const gasFee = parseEther('0.00001');
    const serviceFee = amount / 1_000n;
    const deposit = await prepareDeposit(env, recipient.address,
      { amount, gasFee });
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
    await assert.rejects(env.forwarderAt(deposit.address).execute.staticCall({ ...deposit.quote, gasFee }, '0x'));
  } finally { await env.close(); }
});
