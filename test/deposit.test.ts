import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import { hexlify, randomBytes } from 'ethers';
import { createEnvironment, createRecipient, prepareDeposit, fund, settle,
  decryptDeposit } from '../scripts/harness.ts';
import type { DepositArguments, Environment } from '../scripts/types.ts';

let env: Environment;
let snapshot: string;
before(async () => { env = await createEnvironment(); snapshot = await env.provider.send('evm_snapshot', []); });
after(async () => { if (env) await env.close(); });
beforeEach(async () => {
  await env.provider.send('evm_revert', [snapshot]);
  snapshot = await env.provider.send('evm_snapshot', []);
});

test('ordinary transfer to an undeployed address becomes a recipient-decryptable RAILGUN note', async () => {
  const recipient = await createRecipient();
  const deposit = await prepareDeposit(env, recipient.address);
  assert.equal(await env.provider.getCode(deposit.address), '0x');
  await fund(env, deposit.address, 123_456_789n);
  assert.equal(await env.provider.getCode(deposit.address), '0x');
  const relayerBefore = await env.provider.getBalance(await env.relayer.getAddress());
  const receipt = await settle(env, deposit);
  const note = await decryptDeposit(env, recipient, receipt);
  assert.equal(note.fee, 123_456_789n * 25n / 10_000n);
  assert.equal(note.amount, 123_456_789n - note.fee);
  assert.equal(await env.token.balanceOf(await env.pool.getAddress()), note.amount);
  assert.equal(await env.token.balanceOf(await env.treasury.getAddress()), note.fee);
  assert.equal(await env.token.balanceOf(deposit.address), 0n);
  assert.equal(await env.token.allowance(deposit.address, await env.pool.getAddress()), 0n);
  assert.equal(await env.provider.getBalance(deposit.address), 0n);
  assert((await env.provider.getBalance(await env.relayer.getAddress())) < relayerBefore);
  await assert.rejects(decryptDeposit(env, await createRecipient(), receipt));
});

test('changing recipient data, ciphertext, token or recovery owner changes the address', async () => {
  const deposit = await prepareDeposit(env, (await createRecipient()).address);
  await fund(env, deposit.address, 100_000_000n);
  const [salt, token, npk, ciphertext, recovery] = deposit.args;
  const attacker = await env.attacker.getAddress();
  const mutations: DepositArguments[] = [
    [salt, attacker, npk, ciphertext, recovery],
    [salt, token, hexlify(randomBytes(32)), ciphertext, recovery],
    [salt, token, npk, { ...ciphertext, shieldKey: hexlify(randomBytes(32)) }, recovery],
    [salt, token, npk, ciphertext, attacker],
  ];
  for (const changed of mutations) {
    assert.notEqual(await env.factory.computeAddress(...changed), deposit.address);
    await assert.rejects(env.factory.connect(env.attacker).deployAndShield.staticCall(...changed));
  }
  assert.equal(await env.token.balanceOf(deposit.address), 100_000_000n);
});

test('a stranger can front-run deployment and settlement but funds still reach the intended note', async () => {
  const recipient = await createRecipient();
  const deposit = await prepareDeposit(env, recipient.address);
  await fund(env, deposit.address, 50_000_000n);
  await (await env.factory.connect(env.attacker).deploy(...deposit.args)).wait();
  const receipt = await (await env.forwarderAt(deposit.address, env.attacker).shield()).wait();
  assert(receipt, 'Shielding transaction must be mined');
  assert.equal((await decryptDeposit(env, recipient, receipt)).amount, 49_875_000n);
  assert.equal(await env.token.balanceOf(await env.attacker.getAddress()), 0n);
});

test('a rejected shielding transaction preserves the prefunded address and its recovery path', async () => {
  const deposit = await prepareDeposit(env, (await createRecipient()).address);
  await fund(env, deposit.address, 100_000_000n);
  await (await env.pool.addToBlocklist([await env.token.getAddress()])).wait();
  // Explicit gas submits an actual reverting transaction instead of stopping at estimation.
  await assert.rejects(async () => {
    const tx = await env.factory.connect(env.relayer).deployAndShield(...deposit.args, { gasLimit: 4_000_000 });
    await tx.wait();
  });
  assert.equal(await env.provider.getCode(deposit.address), '0x');
  assert.equal(await env.token.balanceOf(deposit.address), 100_000_000n);
  await (await env.factory.deploy(...deposit.args)).wait();
  await assert.rejects(env.forwarderAt(deposit.address, env.attacker).recover.staticCall(await env.token.getAddress()));
  await (await env.forwarderAt(deposit.address, env.recovery).recover(await env.token.getAddress())).wait();
  assert.equal(await env.token.balanceOf(await env.recovery.getAddress()), 100_000_000n);
});

test('empty addresses cannot settle; one-shot notes reject replay and allow late-funds recovery', async () => {
  const deposit = await prepareDeposit(env, (await createRecipient()).address);
  await assert.rejects(env.factory.deployAndShield.staticCall(...deposit.args));
  await fund(env, deposit.address, 10_000_000n);
  await settle(env, deposit);
  await fund(env, deposit.address, 2_000_000n);
  await assert.rejects(env.forwarderAt(deposit.address).shield.staticCall());
  await (await env.forwarderAt(deposit.address, env.recovery).recover(await env.token.getAddress())).wait();
  assert.equal(await env.token.balanceOf(await env.recovery.getAddress()), 2_000_000n);
  assert.equal(await env.pool.nextLeafIndex(), 1n);
});
