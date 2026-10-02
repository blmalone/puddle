import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { ZeroAddress, hexlify, keccak256, parseEther, randomBytes } from 'ethers';
import { compile, environment, prepare, mined, addressOf, hex } from './harness.ts';
import type { Environment } from './harness.ts';
import { NoteStatus } from '../../.cache/privacy-pools-v2/packages/sdk/dist/index.js';
import { inspectDeposit, recoveryTransaction, relayDeposit, validateDeposit } from '../../protocols/deposit.ts';
import { createPrivacyPoolsAdapter } from '../../protocols/privacy-pools.ts';

let env: Environment;
before(async () => { env = await environment(compile()); });
after(async () => {
  await env?.close();
  // snarkjs keeps its worker pool alive globally after proving.
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate();
});

test('ordinary transfer becomes a recipient-owned, discoverable private note', async t => {
  const recipientKeys = env.keys();
  const recipient = await env.session(env.recipient, recipientKeys);
  await recipient.registerKeystore();
  const recipientAddress = await addressOf(env.recipient);
  const quote = await prepare(env, recipientAddress);
  const { config, salt, address, deposit, value } = quote;
  assert.equal(quote.protocol, 'privacy-pools');
  assert.equal((await inspectDeposit(env.adapter, quote, env.provider)).ready, false);
  await assert.rejects(relayDeposit(env.adapter, quote, env.relayer), /not fully funded/);
  const balance = (owner: string) => env.token.getFunction('balanceOf')(owner) as Promise<bigint>;
  await mined(env.token.getFunction('mint')(await env.sender.getAddress(), quote.quote.amount + 7n));
  await mined(env.token.connect(env.sender).getFunction('transfer')(address, quote.quote.amount + 7n));
  assert.equal(await env.provider.getCode(address), '0x', 'Fund the counterfactual address before deployment');

  await t.test('strangers cannot execute or alter the committed deposit', async () => {
    await assert.rejects(env.factory.connect(env.attacker).getFunction('deployAndExecute').staticCall(salt, config, quote.quote, deposit.callData), /UnauthorizedRelayer/);
    const changed = `${deposit.callData.slice(0, -2)}${deposit.callData.endsWith('00') ? '01' : '00'}`;
    await mined(env.factory.getFunction('deploy')(salt, config));
    for (const caller of [env.attacker, env.recipient, env.fees, env.admin]) {
      await assert.rejects(env.forwarder(address, caller).getFunction('execute').staticCall(quote.quote, deposit.callData), /UnauthorizedRelayer/);
      await assert.rejects(env.factory.connect(caller).getFunction('deployAndExecute').staticCall(salt, config, quote.quote, deposit.callData), /UnauthorizedRelayer/);
    }
    await assert.rejects(env.forwarder(address).getFunction('execute').staticCall(quote.quote, changed), /WrongDepositCall/);
    assert.equal(await balance(address), quote.quote.amount + 7n);
    assert.equal(await balance(await env.fees.getAddress()), 0n);
    await assert.rejects(relayDeposit(env.adapter, quote, env.attacker), /Wrong wallet/);
    await assert.rejects(relayDeposit(env.adapter, { ...quote, quote: { ...quote.quote, gasFee: quote.quote.gasFee + 1n } }, env.relayer), /does not match/);
    await assert.rejects(relayDeposit(env.adapter, { ...quote, data: changed }, env.relayer), /committed call/);
    // @ts-expect-error Deliberately test both compile-time and runtime protocol rejection.
    await assert.rejects(validateDeposit(env.adapter, { ...quote, protocol: 'railgun' }, env.provider), /does not match/);
  });

  assert.equal((await inspectDeposit(env.adapter, quote, env.provider)).ready, true);
  await mined(relayDeposit(env.adapter, quote, env.relayer));
  const status = await inspectDeposit(env.adapter, quote, env.provider);
  assert.equal(status.spent, true);
  assert.equal(status.ready, false);
  assert.equal(status.balance, 7n);
  await assert.rejects(relayDeposit(env.adapter, quote, env.relayer), /already been relayed/);
  assert.equal(await balance(await env.pool.getAddress()), value);
  assert.equal(await balance(await env.entrypoint.getAddress()), value * env.vettingFeeBPS / 10_000n);
  assert.equal(await balance(await env.fees.getAddress()), quote.quote.amount / 1000n + quote.quote.gasFee);
  assert.equal(await balance(address), 7n, 'Overpayment remains recoverable');
  assert.equal(await env.token.getFunction('allowance')(address, await env.entrypoint.getAddress()), 0n);
  assert.equal(await env.forwarder(address).getFunction('spent')(), true);
  await assert.rejects(env.forwarder(address).getFunction('execute').staticCall(quote.quote, deposit.callData), /AlreadyExecuted/);

  // New recipient session: no preparer's pending note is copied into this wallet.
  // Discovery must decrypt the actual Note event using only the recipient's keys.
  const freshRecipient = await env.session(env.recipient, recipientKeys);
  const notes = await freshRecipient.discoverNotes({ fromBlock: '0x0' });
  const note = notes.find(note => note.commitment === deposit.pendingNote.commitment);
  assert(note, 'Recipient must discover the encrypted deposit from chain events');
  assert.equal(BigInt(note.value), value);
  assert.equal(note.ownerAddress.toLowerCase(), recipientAddress.toLowerCase());
  assert.equal(note.status, NoteStatus.PENDING);
  const stranger = await env.session(env.attacker);
  assert.equal((await stranger.discoverNotes({ fromBlock: '0x0' })).length, 0);

  await t.test('approval permits a real private-spend proof and withdrawal', async () => {
    await env.approve(note.label);
    await freshRecipient.discoverNotes();
    assert.equal((await freshRecipient.exportAccount()).notes.find(n => n.commitment === note.commitment)?.status, NoteStatus.ACTIVE);
    const beforeBalance = await balance(recipientAddress);
    const withdrawal = await freshRecipient.prepareWithdraw({ inputCommitments: [note.commitment],
      tokenId: await addressOf(env.token), amount: hex(value / 2n), recipientAddress,
      feeAmount: '0x0', processorAddress: recipientAddress });
    await assert.rejects(env.attacker.sendTransaction({ to: withdrawal.to, data: withdrawal.callData }));
    const receipt = await freshRecipient.executeWithdraw(withdrawal);
    assert.equal(receipt.status, true);
    assert.equal(await balance(recipientAddress), beforeBalance + value / 2n);
    await assert.rejects(env.recipient.sendTransaction({ to: withdrawal.to, data: withdrawal.callData }));
  });

  await t.test('late tokens belong only to the fixed recovery owner', async () => {
    await mined(env.token.getFunction('mint')(address, 9n));
    await assert.rejects(env.forwarder(address, env.attacker).getFunction('recover').staticCall(await env.token.getAddress()), /NotRecoveryOwner/);
    const beforeBalance = await balance(recipientAddress);
    await mined(env.recipient.sendTransaction(await recoveryTransaction(env.adapter, quote, env.provider, recipientAddress, quote.quote.token)));
    assert.equal(await balance(recipientAddress), beforeBalance + 16n);
  });
});

test('preparation and quote checks keep the configured pool when the caller changes its configuration', async () => {
  const recipient = await env.provider.getSigner(6);
  await (await env.session(recipient)).registerKeystore();
  const configuration = { ...env.adapter.deployment };
  const adapter = createPrivacyPoolsAdapter(configuration, env.entrypoint.interface);
  configuration.pool = await env.attacker.getAddress();
  const deposit = await prepare({ ...env, adapter }, await addressOf(recipient));
  assert.equal(deposit.pool, await env.entrypoint.getAddress());
  await adapter.validateExecution(deposit, env.provider);
});

test('failed execution is atomic and the owner recovers an undeployed address without the relayer', async () => {
  const owner = await env.session(env.attacker);
  await owner.registerKeystore();
  const quote = await prepare(env, await addressOf(env.attacker));
  await mined(env.token.getFunction('mint')(quote.address, quote.quote.amount));
  const beforeFees: bigint = await env.token.getFunction('balanceOf')(await env.fees.getAddress());
  await mined(env.pool.getFunction('pause')());
  await assert.rejects(async () => mined(env.factory.connect(env.relayer).getFunction('deployAndExecute')(
    quote.salt, quote.config, quote.quote, quote.deposit.callData, { gasLimit: 6_000_000 })));
  assert.equal(await env.provider.getCode(quote.address), '0x', 'Revert rolls back deployment as well');
  assert.equal(await env.token.getFunction('balanceOf')(quote.address), quote.quote.amount);
  assert.equal(await env.token.getFunction('balanceOf')(await env.fees.getAddress()), beforeFees);
  for (let step = 0; step < 2; step++) {
    await mined(env.attacker.sendTransaction(await recoveryTransaction(
      env.adapter, quote, env.provider, await env.attacker.getAddress(), quote.quote.token)));
  }
  assert.equal(await env.token.getFunction('balanceOf')(quote.address), 0n);
  assert.equal(await env.token.getFunction('balanceOf')(await env.attacker.getAddress()), quote.quote.amount);
  await mined(env.pool.getFunction('unpause')());
});

// Recovery does not require a valid proof, recipient registration or a live screening service.
async function recoverableDeposit(recovery = env.recipient.getAddress()) {
  const config = { recipient: keccak256('0x'), recovery: await recovery, relayer: await env.relayer.getAddress(),
    feeRecipient: await env.fees.getAddress() };
  const salt = hexlify(randomBytes(32));
  const address: string = await env.factory.getFunction('computeAddress')(salt, config);
  return { config, salt, address };
}

test('shared ownership validation rejects invalid parties before funding or deployment', async () => {
  const { salt, config } = await recoverableDeposit();
  for (const change of [{ recipient: '0x12' },
    { recovery: ZeroAddress }, { relayer: ZeroAddress }, { feeRecipient: ZeroAddress }]) {
    await assert.rejects(env.factory.getFunction('computeAddress')(salt, { ...config, ...change }), /InvalidConfiguration/);
    await assert.rejects(env.factory.getFunction('deploy').staticCall(salt, { ...config, ...change }), /InvalidConfiguration/);
  }
});

test('shared recovery returns partial tokens and native currency only to the owner, without fees', async () => {
  const { config, salt, address } = await recoverableDeposit();
  const nativeAmount = parseEther('0.01');
  await mined(env.token.getFunction('mint')(address, 3n));
  await mined(env.sender.sendTransaction({ to: address, value: nativeAmount }));
  assert.equal(await env.provider.getCode(address), '0x');
  await mined(env.factory.connect(env.attacker).getFunction('deploy')(salt, config));
  const forwarder = env.forwarder(address, env.recipient);
  for (const [name, expected] of Object.entries({ recovery: config.recovery, relayer: config.relayer,
    feeRecipient: config.feeRecipient, factory: await env.factory.getAddress() })) {
    assert.equal(await forwarder.getFunction(name)(), expected);
  }
  assert.equal(await forwarder.getFunction('SERVICE_FEE_BPS')(), 10n);
  const feesBefore: bigint = await env.token.getFunction('balanceOf')(config.feeRecipient);
  for (const caller of [env.attacker, env.relayer, env.fees, env.admin]) {
    await assert.rejects(env.forwarder(address, caller).getFunction('recover').staticCall(await env.token.getAddress()), /NotRecoveryOwner/);
    await assert.rejects(env.forwarder(address, caller).getFunction('recoverNative').staticCall(), /NotRecoveryOwner/);
  }
  const tokensBefore: bigint = await env.token.getFunction('balanceOf')(config.recovery);
  await mined(forwarder.getFunction('recover')(await env.token.getAddress()));
  assert.equal(await env.token.getFunction('balanceOf')(config.recovery), tokensBefore + 3n);
  const nativeBefore = await env.provider.getBalance(config.recovery);
  const receipt = await mined(forwarder.getFunction('recoverNative')());
  assert.equal(await env.provider.getBalance(config.recovery), nativeBefore + nativeAmount - receipt.fee);
  assert.equal(await env.provider.getBalance(address), 0n);
  assert.equal(await env.token.getFunction('balanceOf')(config.feeRecipient), feesBefore);
  assert.equal(await forwarder.getFunction('spent')(), false);
});

test('shared recovery guard blocks reentry and preserves funds when the owner rejects payment', async () => {
  const receiver = env.recoveryReceiver;
  const { config, salt, address } = await recoverableDeposit(receiver.getAddress());
  const amount = parseEther('0.01');
  await mined(env.sender.sendTransaction({ to: address, value: amount }));
  await mined(env.factory.getFunction('deploy')(salt, config));
  await mined(receiver.getFunction('configure')(address, true));
  await assert.rejects(receiver.getFunction('recoverNative').staticCall());
  assert.equal(await env.provider.getBalance(address), amount);
  await mined(receiver.getFunction('configure')(address, false));
  await mined(receiver.getFunction('recoverNative')());
  assert.equal(await receiver.getFunction('reentryBlocked')(), true);
  assert.equal(await env.provider.getBalance(address), 0n);
  assert.equal(await env.provider.getBalance(config.recovery), amount);
});

test('a new gas quote reuses the same address and real deposit proof', async () => {
  const original = await prepare(env, await addressOf(env.recipient));
  const cost = original.value + original.value * env.vettingFeeBPS / 10_000n;
  const gasFee = original.quote.gasFee / 2n;
  const quote = await env.adapter.quote(env.provider, original, {
    ...original.quote, gasFee, amount: (cost + gasFee) * 1000n / 999n,
  }, original.data);
  assert.equal(quote.address, original.address);
  assert.deepEqual(quote.config, original.config);
  assert.equal(quote.data, original.data);
  await mined(env.token.getFunction('mint')(quote.address, quote.quote.amount));
  const beforeFees: bigint = await env.token.getFunction('balanceOf')(await env.fees.getAddress());
  await mined(relayDeposit(env.adapter, quote, env.relayer));
  assert.equal(await env.token.getFunction('balanceOf')(quote.address), 0n);
  assert.equal(await env.token.getFunction('balanceOf')(await env.fees.getAddress()),
    beforeFees + quote.quote.amount / 1000n + gasFee);
});

test('recipient can ragequit an unapproved deposit while paused with all services offline', async () => {
  // Reuse the recipient's address with a fresh registered test identity on another account.
  const keys = env.keys();
  const owner = await env.session(env.sender, keys);
  await owner.registerKeystore();
  const ownerAddress = await addressOf(env.sender);
  const quote = await prepare(env, ownerAddress);
  await mined(env.token.getFunction('mint')(quote.address, quote.quote.amount));
  await mined(relayDeposit(env.adapter, quote, env.relayer));
  await owner.discoverNotes({ fromBlock: '0x0' });
  const backup = await owner.exportAccount();
  assert.equal(backup.notes.find(note => note.commitment === quote.deposit.pendingNote.commitment)?.status, NoteStatus.PENDING);

  env.goOffline();
  await mined(env.pool.getFunction('pause')());
  const restored = await env.session(env.sender, keys);
  await restored.importAccount(backup);
  const exit = await restored.prepareRageQuit({ commitment: quote.deposit.pendingNote.commitment });
  await assert.rejects(env.relayer.sendTransaction({ to: exit.to, data: exit.callData }));
  const beforeBalance: bigint = await env.token.getFunction('balanceOf')(ownerAddress);
  const receipt = await restored.executeRageQuit(exit);
  assert.equal(receipt.status, true);
  assert.equal(await env.token.getFunction('balanceOf')(ownerAddress), beforeBalance + quote.value);
  await assert.rejects(env.sender.sendTransaction({ to: exit.to, data: exit.callData }));
  assert.equal(keccak256(quote.deposit.callData), quote.config.recipient);
});
