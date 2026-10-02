import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import { ContractFactory, Interface, ZeroAddress, hexlify, isError, parseEther, randomBytes } from 'ethers';
import { compile, createEnvironment, createRecipient, prepareDeposit, fund, settle,
  decryptDeposit } from '../scripts/harness.ts';
import type { DepositArguments, DepositConfig, DepositFactory, Environment } from '../scripts/types.ts';
import { inspectDeposit, mined, recoveryTransaction, relayDeposit, validateDeposit } from '../protocols/deposit.ts';
import { createRailgunAdapter } from '../protocols/railgun.ts';

let env: Environment;
let snapshot: string;
let errors: Interface;
const amount = 100_000_000n;
const maxGasFee = 2_500_000n; // Demo policy: 2 USDC + 0.5% of the quoted amount.
const gasFee = 1_100_000n;
const serviceFee = 100_000n;
const uint120Max = (1n << 120n) - 1n;

before(async () => {
  env = await createEnvironment(compile(true));
  errors = new Interface([
    ...env.contracts['contracts/protocols/RailgunDeposit.sol'].RailgunDeposit.abi,
    ...env.contracts['contracts/protocols/RailgunDeposit.sol'].RailgunDepositFactory.abi,
  ].filter(fragment => fragment.type === 'error' || fragment.type === 'event'));
  snapshot = await env.provider.send('evm_snapshot', []);
});
after(async () => { if (env) await env.close(); });
beforeEach(async () => {
  assert.equal(await env.provider.send('evm_revert', [snapshot]), true);
  snapshot = await env.provider.send('evm_snapshot', []);
  env.depositPath = undefined;
});

async function prepared() {
  const recipient = await createRecipient();
  return { recipient, deposit: await prepareDeposit(env, recipient.address, { amount }) };
}

async function rejects(promise: Promise<unknown>, name: string) {
  await assert.rejects(promise, error => {
    assert(isError(error, 'CALL_EXCEPTION'), String(error));
    assert(error.data, 'Expected revert data');
    assert.equal(errors.parseError(error.data)?.name, name);
    return true;
  });
}

async function unchanged(address: string, balance = amount) {
  assert.equal(await env.token.balanceOf(address), balance);
  assert.equal(await env.token.balanceOf(await env.feeCollector.getAddress()), 0n);
  assert.equal(await env.token.allowance(address, await env.pool.getAddress()), 0n);
  if (await env.provider.getCode(address) !== '0x') assert.equal(await env.forwarderAt(address).spent(), false);
}

async function fixture(name: string) {
  const file = name === 'RecoveryReceiver' ? 'RecoveryReceiver' : 'Adversarial';
  const artifact = env.contracts[`test/contracts/${file}.sol`][name];
  const contract = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, env.deployer).deploy();
  await contract.waitForDeployment();
  // Test-only fixtures use ethers' runtime method lookup at the ABI boundary.
  return contract;
}

async function configuredFactory(pool: string, tokens: string[]): Promise<DepositFactory> {
  const artifact = env.contracts['contracts/protocols/RailgunDeposit.sol'].RailgunDepositFactory;
  const factory = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, env.deployer)
    .deploy(pool, tokens.map(token => ({ token, maxGasFee: 2_000_000n, maxGasFeeBps: 50 })));
  await factory.waitForDeployment();
  return factory as unknown as DepositFactory;
}

test('shared workflow refuses changed records, wrong chains and unauthorized wallets before sending', async () => {
  const { deposit } = await prepared();
  assert.equal(deposit.protocol, 'railgun');
  assert.equal(deposit.chainId, 31337n);
  const attacker = await env.attacker.getAddress();
  const nonce = await env.relayer.getNonce();
  for (const changed of [
    { ...deposit, chainId: 42161n }, { ...deposit, factory: attacker }, { ...deposit, pool: attacker },
    { ...deposit, address: attacker }, { ...deposit, config: { ...deposit.config, recovery: attacker } },
  ]) await assert.rejects(validateDeposit(env.adapter, changed, env.provider), /does not match/);
  // @ts-expect-error Deliberately test both compile-time and runtime protocol rejection.
  await assert.rejects(validateDeposit(env.adapter, { ...deposit, protocol: 'privacy-pools' }, env.provider), /does not match/);
  await assert.rejects(relayDeposit(env.adapter, deposit, env.attacker), /Wrong wallet/);
  await assert.rejects(recoveryTransaction(env.adapter, deposit, env.provider, attacker, deposit.quote.token), /recovery wallet/);
  assert.equal(await env.relayer.getNonce(), nonce);
  assert.equal(await env.provider.getCode(deposit.address), '0x');
});

test('adapter checks keep their configured deployment when the caller changes its configuration', async () => {
  const { deposit } = await prepared();
  const configuration = { ...env.adapter.deployment };
  const adapter = createRailgunAdapter(configuration);
  configuration.chainId = 42161n;
  configuration.factory = await env.attacker.getAddress();
  configuration.pool = configuration.factory;
  assert.deepEqual(adapter.deployment, env.adapter.deployment);
  assert.deepEqual(await adapter.quote(env.provider, deposit, deposit.quote), deposit);
});

test('shared funding checks permit top-ups, enforce the gas cap and refuse replay after confirmation', async () => {
  const { deposit } = await prepared();
  await fund(env, deposit.address, amount - 1n);
  assert.deepEqual(await inspectDeposit(env.adapter, deposit, env.provider),
    { deployed: false, spent: false, balance: amount - 1n, ready: false });
  await assert.rejects(relayDeposit(env.adapter, { ...deposit, quote: { ...deposit.quote, gasFee: gasFee } }, env.relayer), /not fully funded/);
  await fund(env, deposit.address, 1n);
  assert.equal((await inspectDeposit(env.adapter, deposit, env.provider)).ready, true);
  await assert.rejects(relayDeposit(env.adapter, { ...deposit, quote: { ...deposit.quote, gasFee: maxGasFee + 1n } }, env.relayer), /cap/);
  await mined(relayDeposit(env.adapter, { ...deposit, quote: { ...deposit.quote, gasFee: gasFee } }, env.relayer));
  assert.deepEqual(await inspectDeposit(env.adapter, deposit, env.provider),
    { deployed: true, spent: true, balance: 0n, ready: false });
  await assert.rejects(relayDeposit(env.adapter, { ...deposit, quote: { ...deposit.quote, gasFee: gasFee } }, env.relayer), /already been relayed/);
});

test('shared recovery builds owner-only deployment and withdrawal without relayer involvement', async () => {
  const { deposit } = await prepared();
  await fund(env, deposit.address, 123n);
  const owner = await env.recovery.getAddress();
  const before = await env.token.balanceOf(owner);
  for (const target of [deposit.factory, deposit.address]) {
    const tx = await recoveryTransaction(env.adapter, deposit, env.provider, owner, deposit.quote.token);
    assert.equal(tx.to, target);
    assert.equal(tx.chainId, deposit.chainId);
    await mined(env.recovery.sendTransaction(tx));
  }
  assert.equal(await env.token.balanceOf(owner), before + 123n);
  assert.equal(await env.token.balanceOf(deposit.address), 0n);
});

test('paid settlement conserves funds and creates a recipient-decryptable real RAILGUN note', async () => {
  const { recipient, deposit } = await prepared();
  assert.equal(await env.provider.getCode(deposit.address), '0x');
  await fund(env, deposit.address, amount);
  assert.equal(await env.provider.getCode(deposit.address), '0x');
  const relayerBefore = await env.provider.getBalance(await env.relayer.getAddress());
  const receipt = await settle(env, deposit, gasFee);
  const note = await decryptDeposit(env, recipient, receipt);
  const shieldAmount = amount - serviceFee - gasFee;
  assert.equal(note.fee, shieldAmount * 25n / 10_000n);
  assert.equal(note.amount + note.fee + serviceFee + gasFee, amount);
  assert.equal(await env.token.balanceOf(await env.pool.getAddress()), note.amount);
  assert.equal(await env.token.balanceOf(await env.treasury.getAddress()), note.fee);
  assert.equal(await env.token.balanceOf(await env.feeCollector.getAddress()), serviceFee + gasFee);
  assert.equal(await env.token.balanceOf(await env.relayer.getAddress()), 0n);
  assert.equal(await env.token.balanceOf(deposit.address), 0n);
  assert.equal(await env.token.allowance(deposit.address, await env.pool.getAddress()), 0n);
  assert.equal(await env.forwarderAt(deposit.address).spent(), true);
  assert.equal(relayerBefore - await env.provider.getBalance(await env.relayer.getAddress()), receipt.fee);
  const event = receipt.logs.filter(log => log.address.toLowerCase() === deposit.address.toLowerCase())
    .map(log => errors.parseLog(log)).find(log => log?.name === 'Executed');
  assert(event);
  assert.deepEqual([...event.args], [await env.token.getAddress(), amount, serviceFee, gasFee, shieldAmount]);
  await assert.rejects(decryptDeposit(env, await createRecipient(), receipt));
});

test('the permanent recipient, parties and salt are bound to the CREATE2 address', async () => {
  const { deposit } = await prepared();
  await fund(env, deposit.address, amount);
  const { salt, config } = deposit;
  const attacker = await env.attacker.getAddress();
  const mutations: Partial<DepositConfig>[] = [
    ...Array.from({ length: 5 }, (_, i) => ({ recipient: config.recipient.slice(0, 2 + i * 64)
      + hexlify(randomBytes(32)).slice(2) + config.recipient.slice(2 + (i + 1) * 64) })),
    { recovery: attacker }, { relayer: attacker }, { feeRecipient: attacker },
  ];
  for (const mutation of mutations) {
    const changed: DepositArguments = [salt, { ...config, ...mutation }];
    assert.notEqual(await env.factory.computeAddress(...changed), deposit.address);
  }
  assert.notEqual(await env.factory.computeAddress(hexlify(randomBytes(32)), config), deposit.address);
  await unchanged(deposit.address);
});

test('only the fixed relayer can shield directly or through the factory, even with zero gas fee', async () => {
  const { deposit } = await prepared();
  await fund(env, deposit.address, amount);
  for (const fee of [0n, gasFee]) {
    await rejects(env.factory.connect(env.attacker).deployAndExecute.staticCall(deposit.salt, deposit.config, { ...deposit.quote, gasFee: fee }, '0x'),
      'UnauthorizedRelayer');
  }
  assert.equal(await env.provider.getCode(deposit.address), '0x');
  // Public deployment, recovery ownership and receiving fees confer no relayer authority.
  await (await env.factory.connect(env.attacker).deploy(deposit.salt, deposit.config)).wait();
  for (const caller of [env.attacker, env.recovery, env.feeCollector, env.deployer]) {
    for (const fee of [0n, gasFee]) {
      await rejects(env.forwarderAt(deposit.address, caller).execute.staticCall({ ...deposit.quote, gasFee: fee }, '0x'), 'UnauthorizedRelayer');
      await rejects(env.factory.connect(caller).deployAndExecute.staticCall(deposit.salt, deposit.config, { ...deposit.quote, gasFee: fee }, '0x'),
        'UnauthorizedRelayer');
    }
  }
  await unchanged(deposit.address);
});

test('the gas cap is enforced through either entry point, including the maximum uint256 input', async () => {
  const { deposit } = await prepared();
  await fund(env, deposit.address, amount);
  await rejects(env.factory.connect(env.relayer).deployAndExecute.staticCall(deposit.salt, deposit.config, { ...deposit.quote, gasFee: maxGasFee + 1n }, '0x'),
    'GasFeeTooHigh');
  await (await env.factory.deploy(deposit.salt, deposit.config)).wait();
  for (const fee of [maxGasFee + 1n, (1n << 256n) - 1n]) {
    await rejects(env.forwarderAt(deposit.address).execute.staticCall({ ...deposit.quote, gasFee: fee }, '0x'), 'GasFeeTooHigh');
  }
  await unchanged(deposit.address);
  await (await env.forwarderAt(deposit.address).execute({ ...deposit.quote, gasFee: maxGasFee }, '0x')).wait();
  assert.equal(await env.token.balanceOf(await env.feeCollector.getAddress()), serviceFee + maxGasFee);
});

test('the relayer can waive the gas charge while the fixed service fee still applies', async () => {
  const { recipient, deposit } = await prepared();
  await fund(env, deposit.address, amount);
  const receipt = await (await env.factory.connect(env.relayer).deployAndExecute(deposit.salt, deposit.config, { ...deposit.quote, gasFee: 0n }, '0x')).wait();
  assert(receipt);
  const note = await decryptDeposit(env, recipient, receipt);
  assert.equal(note.amount + note.fee, amount - serviceFee);
  assert.equal(await env.token.balanceOf(await env.feeCollector.getAddress()), serviceFee);
  assert.equal(await env.token.balanceOf(await env.relayer.getAddress()), 0n);
});

test('public deployment preserves exclusive relayer access and the fixed recipient', async () => {
  const { recipient, deposit } = await prepared();
  await fund(env, deposit.address, amount);
  await (await env.factory.connect(env.attacker).deploy(deposit.salt, deposit.config)).wait();
  await rejects(env.forwarderAt(deposit.address, env.attacker).execute.staticCall({ ...deposit.quote, gasFee: 0n }, '0x'), 'UnauthorizedRelayer');
  const receipt = await (await env.forwarderAt(deposit.address, env.relayer).execute({ ...deposit.quote, gasFee: 0n }, '0x')).wait();
  assert(receipt);
  const note = await decryptDeposit(env, recipient, receipt);
  assert.equal(note.amount + note.fee + serviceFee, amount);
});

test('the quoted amount must be funded; topping up enables settlement', async () => {
  const { deposit } = await prepared();
  await rejects(env.factory.connect(env.relayer).deployAndExecute.staticCall(deposit.salt, deposit.config, { ...deposit.quote, gasFee }, '0x'), 'InvalidBalance');
  await fund(env, deposit.address, 1n);
  await rejects(env.factory.connect(env.relayer).deployAndExecute.staticCall(deposit.salt, deposit.config, { ...deposit.quote, gasFee: 0n }, '0x'), 'InvalidBalance');
  await (await env.factory.deploy(deposit.salt, deposit.config)).wait();
  await rejects(env.forwarderAt(deposit.address).execute.staticCall({ ...deposit.quote, gasFee }, '0x'), 'InvalidBalance');
  await unchanged(deposit.address, 1n);
  await fund(env, deposit.address, amount - 1n);
  await settle(env, deposit, gasFee);
  assert.equal(await env.forwarderAt(deposit.address).spent(), true);
});

test('only the quoted amount is shielded; excess remains recoverable without a second fee', async () => {
  const { recipient, deposit } = await prepared();
  const actual = amount * 2n + 999n;
  await fund(env, deposit.address, actual);
  const note = await decryptDeposit(env, recipient, await settle(env, deposit, gasFee));
  assert.equal(await env.token.balanceOf(await env.feeCollector.getAddress()), serviceFee + gasFee);
  assert.equal(note.amount + note.fee + serviceFee + gasFee, amount);
  assert.equal(await env.token.balanceOf(deposit.address), actual - amount);
  await (await env.forwarderAt(deposit.address, env.recovery).recover(await env.token.getAddress())).wait();
  assert.equal(await env.token.balanceOf(await env.recovery.getAddress()), actual - amount);
});

test('a new amount and fee quote preserves the address and creates a decryptable note', async () => {
  const { recipient, deposit } = await prepared();
  const actual = amount * 2n + 999n;
  const requoted = await env.adapter.quote(env.provider, deposit, { ...deposit.quote, amount: actual, gasFee });
  assert.equal(requoted.address, deposit.address);
  assert.deepEqual(requoted.config, deposit.config);
  await fund(env, deposit.address, actual);
  const note = await decryptDeposit(env, recipient, await settle(env, requoted, gasFee));
  assert.equal(note.amount + note.fee + actual / 1_000n + gasFee, actual);
  assert.equal(await env.token.balanceOf(deposit.address), 0n);
});

test('the token can be selected after address creation; single-use and recovery cover every asset', async () => {
  const recipient = await createRecipient();
  const other = await fixture('AdversarialToken');
  const token = await env.token.getAddress();
  const otherToken = await other.getAddress();
  const factory = await configuredFactory(await env.pool.getAddress(), [token, otherToken]);
  const adapter = createRailgunAdapter({ chainId: 31337n, factory: await factory.getAddress(),
    pool: await env.pool.getAddress() });
  const address = await adapter.prepare(env.provider, {
    recipient: recipient.address, recovery: await env.recovery.getAddress(),
    relayer: await env.relayer.getAddress(), feeRecipient: await env.feeCollector.getAddress(),
  });
  const block = await env.provider.getBlock('latest');
  assert(block);
  const quote = { token, amount, gasFee, deadline: BigInt(block.timestamp + 3600) };
  const first = await adapter.quote(env.provider, address, quote);
  const second = await adapter.quote(env.provider, address, { ...quote, token: otherToken, amount: amount / 2n });
  assert.equal(first.address, second.address);
  assert.deepEqual(first.config, second.config);
  await fund(env, address.address, amount);
  await (await other.getFunction('mint')(address.address, second.quote.amount)).wait();
  const receipt = await mined(relayDeposit(adapter, second, env.relayer));
  const note = await decryptDeposit(env, recipient, receipt);
  assert.equal(note.amount + note.fee + second.quote.amount / 1_000n + gasFee, second.quote.amount);
  assert.equal(await other.getFunction('balanceOf')(address.address), 0n);
  assert.equal(await env.token.balanceOf(address.address), amount);
  await assert.rejects(relayDeposit(adapter, first, env.relayer), /already been relayed/);
  await rejects(factory.connect(env.relayer).deployAndExecute.staticCall(first.salt, first.config, first.quote, '0x'),
    'AlreadyExecuted');
  await mined(env.recovery.sendTransaction(await recoveryTransaction(
    adapter, first, env.provider, await env.recovery.getAddress(), first.quote.token)));
  assert.equal(await env.token.balanceOf(await env.recovery.getAddress()), amount);
});

test('expired quotes cannot deploy or pay fees; refreshing the quote preserves the address', async () => {
  const { deposit } = await prepared();
  await fund(env, deposit.address, amount);
  await env.provider.send('evm_increaseTime', [3601]);
  await env.provider.send('evm_mine', []);
  await assert.rejects(relayDeposit(env.adapter, deposit, env.relayer), /expired/);
  await rejects(env.factory.connect(env.relayer).deployAndExecute.staticCall(
    deposit.salt, deposit.config, deposit.quote, '0x'), 'QuoteExpired');
  await unchanged(deposit.address);
  assert.equal(await env.provider.getCode(deposit.address), '0x');
  const block = await env.provider.getBlock('latest');
  assert(block);
  const refreshed = await env.adapter.quote(env.provider, deposit,
    { ...deposit.quote, deadline: BigInt(block.timestamp + 3600) });
  assert.equal(refreshed.address, deposit.address);
  await settle(env, refreshed);
});

test('real pool rejection reverts deployment, fee payments and approvals; full recovery still works', async () => {
  const { deposit } = await prepared();
  await fund(env, deposit.address, amount);
  await (await env.pool.addToBlocklist([await env.token.getAddress()])).wait();
  const gasBefore = await env.provider.getBalance(await env.relayer.getAddress());
  await assert.rejects(async () => {
    const tx = await env.factory.connect(env.relayer).deployAndExecute(deposit.salt, deposit.config, { ...deposit.quote, gasFee }, '0x',
      { gasLimit: 5_000_000 });
    await tx.wait();
  });
  assert.equal(await env.provider.getCode(deposit.address), '0x');
  assert((await env.provider.getBalance(await env.relayer.getAddress())) < gasBefore);
  await unchanged(deposit.address);
  await (await env.factory.deploy(deposit.salt, deposit.config)).wait();
  await rejects(env.forwarderAt(deposit.address, env.attacker).recover.staticCall(await env.token.getAddress()),
    'NotRecoveryOwner');
  await (await env.forwarderAt(deposit.address, env.recovery).recover(await env.token.getAddress())).wait();
  assert.equal(await env.token.balanceOf(await env.recovery.getAddress()), amount);
  assert.equal(await env.token.balanceOf(await env.feeCollector.getAddress()), 0n);
});

test('a failed call on an existing forwarder leaves it unspent and can be retried', async () => {
  const { deposit } = await prepared();
  await fund(env, deposit.address, amount);
  await (await env.factory.deploy(deposit.salt, deposit.config)).wait();
  await (await env.pool.addToBlocklist([await env.token.getAddress()])).wait();
  await assert.rejects(async () => {
    const tx = await env.forwarderAt(deposit.address).execute({ ...deposit.quote, gasFee }, '0x', { gasLimit: 3_000_000 });
    await tx.wait();
  });
  await unchanged(deposit.address);
  await (await env.pool.removeFromBlocklist([await env.token.getAddress()])).wait();
  await settle(env, deposit, gasFee);
});

test('successful settlement cannot be replayed or charge late arrivals a second fee', async () => {
  const { deposit } = await prepared();
  await fund(env, deposit.address, amount);
  await settle(env, deposit, gasFee);
  await fund(env, deposit.address, 2_000_000n);
  await rejects(env.forwarderAt(deposit.address).execute.staticCall({ ...deposit.quote, gasFee }, '0x'), 'AlreadyExecuted');
  await rejects(env.factory.connect(env.relayer).deployAndExecute.staticCall(deposit.salt, deposit.config, { ...deposit.quote, gasFee }, '0x'), 'AlreadyExecuted');
  await (await env.factory.deploy(deposit.salt, deposit.config)).wait(); // Idempotent deployment does not reset state.
  await rejects(env.forwarderAt(deposit.address, env.attacker).execute.staticCall({ ...deposit.quote, gasFee: 0n }, '0x'), 'AlreadyExecuted');
  await (await env.forwarderAt(deposit.address, env.recovery).recover(await env.token.getAddress())).wait();
  assert.equal(await env.token.balanceOf(await env.recovery.getAddress()), 2_000_000n);
  assert.equal(await env.token.balanceOf(await env.feeCollector.getAddress()), serviceFee + gasFee);
  assert.equal(await env.pool.nextLeafIndex(), 1n);
});

test('recovery works below the quoted amount, with no relayer involvement or fee', async () => {
  const { deposit } = await prepared();
  await fund(env, deposit.address, 1n);
  await (await env.factory.connect(env.recovery).deploy(deposit.salt, deposit.config)).wait();
  await (await env.forwarderAt(deposit.address, env.recovery).recover(await env.token.getAddress())).wait();
  assert.equal(await env.token.balanceOf(await env.recovery.getAddress()), 1n);
  assert.equal(await env.token.balanceOf(await env.feeCollector.getAddress()), 0n);
});

test('wrong tokens and native currency sent before deployment remain recoverable only by their owner', async () => {
  const { deposit } = await prepared();
  const other = await fixture('AdversarialToken');
  await (await other.getFunction('mint')(deposit.address, 42n)).wait();
  const nativeAmount = parseEther('0.01');
  await (await env.sender.sendTransaction({ to: deposit.address, value: nativeAmount })).wait();
  await (await env.factory.connect(env.recovery).deploy(deposit.salt, deposit.config)).wait();
  await rejects(env.forwarderAt(deposit.address, env.attacker).recoverNative.staticCall(), 'NotRecoveryOwner');
  await rejects(env.forwarderAt(deposit.address, env.attacker).recover.staticCall(await other.getAddress()),
    'NotRecoveryOwner');
  const before = await env.provider.getBalance(await env.recovery.getAddress());
  const receipt = await (await env.forwarderAt(deposit.address, env.recovery).recoverNative()).wait();
  assert(receipt);
  assert.equal(await env.provider.getBalance(await env.recovery.getAddress()), before + nativeAmount - receipt.fee);
  await (await env.forwarderAt(deposit.address, env.recovery).recover(await other.getAddress())).wait();
  assert.equal(await other.getFunction('balanceOf')(await env.recovery.getAddress()), 42n);
  assert.equal(await env.provider.getBalance(deposit.address), 0n);
});

test('invalid configurations are rejected before returning a fundable address and cannot deploy', async () => {
  const { deposit } = await prepared();
  const { salt, config } = deposit;
  const invalid: Partial<DepositConfig>[] = [
    { recovery: ZeroAddress }, { relayer: ZeroAddress }, { feeRecipient: ZeroAddress },
  ];
  for (const change of invalid) {
    await rejects(env.factory.computeAddress(salt, { ...config, ...change }), 'InvalidConfiguration');
    await rejects(env.factory.deploy.staticCall(salt, { ...config, ...change }), 'InvalidConfiguration');
  }
  const artifact = env.contracts['contracts/protocols/RailgunDeposit.sol'].RailgunDepositFactory;
  const factory = new ContractFactory(artifact.abi, artifact.evm.bytecode.object, env.deployer);
  await rejects(factory.deploy(ZeroAddress, []), 'InvalidPool');
  await rejects(factory.deploy(await env.attacker.getAddress(), []), 'InvalidPool');
});

test('fee rounding and boundary amounts preserve at least one unit for shielding', async () => {
  const recipient = await createRecipient();
  const deposit = await prepareDeposit(env, recipient.address, { amount: 1_000n });
  await (await env.factory.deploy(deposit.salt, deposit.config)).wait();
  const forwarder = env.forwarderAt(deposit.address);
  for (const balance of [1_000n, 1_001n, 1_999n, 2_000n, 100_001n, uint120Max - 1n, uint120Max]) {
    for (const fee of [0n, 1n, 998n]) {
      const [service, shield] = await forwarder.preview({ ...deposit.quote, amount: balance, gasFee: fee });
      assert.equal(service + shield + fee, balance);
      assert(shield > 0n);
      assert(service * 1_000n <= balance && (service + 1n) * 1_000n > balance);
    }
  }
  await rejects(forwarder.preview({ ...deposit.quote, amount: 0n }), 'InvalidBalance');
  await rejects(forwarder.preview({ ...deposit.quote, amount: uint120Max + 1n }), 'InvalidBalance');
  await rejects(forwarder.preview({ ...deposit.quote, gasFee: 999n }), 'InvalidBalance');
});

test('a balance above the supported note size stays recoverable instead of being truncated', async () => {
  const { deposit } = await prepared();
  const balance = uint120Max + 1n;
  await fund(env, deposit.address, balance);
  await rejects(env.factory.connect(env.relayer).deployAndExecute.staticCall(deposit.salt, deposit.config,
    { ...deposit.quote, amount: balance }, '0x'), 'InvalidBalance');
  await (await env.factory.deploy(deposit.salt, deposit.config)).wait();
  await (await env.forwarderAt(deposit.address, env.recovery).recover(await env.token.getAddress())).wait();
  assert.equal(await env.token.balanceOf(await env.recovery.getAddress()), balance);
});

for (const [name, mode] of [['false-returning', 1], ['fee-on-transfer', 2]] as const) {
  test(name + ' fee payouts revert without consuming the deposit or paying a fee', async () => {
    const { deposit } = await prepared();
    const token = await fixture('AdversarialToken');
    const factory = await configuredFactory(await env.pool.getAddress(), [await token.getAddress()]);
    const args: DepositArguments = [deposit.salt, deposit.config];
    const quote = { ...deposit.quote, token: await token.getAddress(), gasFee };
    const address = await factory.computeAddress(...args);
    await (await token.getFunction('mint')(address, amount)).wait();
    await (await factory.deploy(...args)).wait();
    await (await token.getFunction('configure')(mode, address)).wait();
    await assert.rejects(async () => {
      const tx = await factory.connect(env.relayer).deployAndExecute(...args, quote, '0x', { gasLimit: 5_000_000 });
      await tx.wait();
    });
    assert.equal(await token.getFunction('balanceOf')(address), amount);
    assert.equal(await token.getFunction('balanceOf')(await env.feeCollector.getAddress()), 0n);
    assert.equal(await token.getFunction('allowance')(address, await env.pool.getAddress()), 0n);
    assert.equal(await env.forwarderAt(address).spent(), false);
  });
}

for (const [name, mode] of [['reentrant', 3], ['no-return', 4]] as const) {
  test(name + ' token callbacks cannot duplicate payment or bypass the fixed fee destination', async () => {
    const { deposit } = await prepared();
    const token = await fixture('AdversarialToken');
    const factory = await configuredFactory(await env.pool.getAddress(), [await token.getAddress()]);
    const args: DepositArguments = [deposit.salt, deposit.config];
    const quote = { ...deposit.quote, token: await token.getAddress(), gasFee };
    const address = await factory.computeAddress(...args);
    await (await token.getFunction('mint')(address, amount)).wait();
    await (await token.getFunction('configure')(mode, address)).wait();
    await (await factory.connect(env.relayer).deployAndExecute(...args, quote, '0x')).wait();
    assert.equal(await token.getFunction('balanceOf')(address), 0n);
    assert.equal(await token.getFunction('balanceOf')(await env.feeCollector.getAddress()), serviceFee + gasFee);
    assert.equal(await env.forwarderAt(address).spent(), true);
    if (mode === 3) assert.equal(await token.getFunction('reentryBlocked')(), true);
  });
}

test('a pool that does not consume the full shield amount cannot collect fees or consume the note', async () => {
  const { deposit } = await prepared();
  const pool = await fixture('AdversarialPool');
  await (await pool.getFunction('configure')(2)).wait();
  const factory = await configuredFactory(await pool.getAddress(), [await env.token.getAddress()]);
  const address = await factory.computeAddress(deposit.salt, deposit.config);
  await (await factory.deploy(deposit.salt, deposit.config)).wait();
  await fund(env, address, amount);
  await rejects(env.forwarderAt(address).execute.staticCall({ ...deposit.quote, gasFee }, '0x'), 'IncompleteDeposit');
  await assert.rejects(async () => {
    const tx = await env.forwarderAt(address).execute({ ...deposit.quote, gasFee }, '0x', { gasLimit: 1_000_000 });
    await tx.wait();
  });
  await unchanged(address);
  assert.equal(await env.token.balanceOf(await pool.getAddress()), 0n);
  assert.equal(await env.token.allowance(address, await pool.getAddress()), 0n);
});

test('pool callbacks cannot reenter shielding', async () => {
  const { deposit } = await prepared();
  const pool = await fixture('AdversarialPool');
  await (await pool.getFunction('configure')(3)).wait();
  const factory = await configuredFactory(await pool.getAddress(), [await env.token.getAddress()]);
  const address = await factory.computeAddress(deposit.salt, deposit.config);
  await (await factory.deploy(deposit.salt, deposit.config)).wait();
  await fund(env, address, amount);
  await (await env.forwarderAt(address).execute({ ...deposit.quote, gasFee }, '0x')).wait();
  assert.equal(await pool.getFunction('reentryBlocked')(), true);
  assert.equal(await env.token.balanceOf(await pool.getAddress()), amount - serviceFee - gasFee);
  assert.equal(await env.token.balanceOf(await env.feeCollector.getAddress()), serviceFee + gasFee);
});

test('native recovery resists receiver reentry and preserves funds if the receiver rejects payment', async () => {
  const { deposit } = await prepared();
  const receiver = await fixture('RecoveryReceiver');
  const args: DepositArguments = [deposit.salt, { ...deposit.config, recovery: await receiver.getAddress() }];
  const address = await env.factory.computeAddress(...args);
  await (await env.sender.sendTransaction({ to: address, value: parseEther('0.01') })).wait();
  await (await env.factory.deploy(...args)).wait();
  await (await receiver.getFunction('configure')(address, true)).wait();
  await assert.rejects(receiver.getFunction('recoverNative').staticCall());
  assert.equal(await env.provider.getBalance(address), parseEther('0.01'));
  await (await receiver.getFunction('configure')(address, false)).wait();
  await (await receiver.getFunction('recoverNative')()).wait();
  assert.equal(await receiver.getFunction('reentryBlocked')(), true);
  assert.equal(await env.provider.getBalance(address), 0n);
  assert.equal(await env.provider.getBalance(await receiver.getAddress()), parseEther('0.01'));
});
