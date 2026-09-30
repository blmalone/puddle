import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import { ContractFactory, Interface, ZeroAddress, hexlify, isError, parseEther, randomBytes } from 'ethers';
import { compile, createEnvironment, createRecipient, prepareDeposit, fund, settle,
  decryptDeposit } from '../scripts/harness.ts';
import type { DepositArguments, DepositConfig, Environment } from '../scripts/types.ts';

let env: Environment;
let snapshot: string;
let errors: Interface;
const amount = 100_000_000n;
const maxGasFee = 2_000_000n;
const gasFee = 1_100_000n;
const serviceFee = 100_000n;
const uint120Max = (1n << 120n) - 1n;

before(async () => {
  env = await createEnvironment(compile(true));
  errors = new Interface([
    ...env.contracts['contracts/DepositFactory.sol'].DepositForwarder.abi,
    ...env.contracts['contracts/DepositFactory.sol'].DepositFactory.abi,
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
  return { recipient, deposit: await prepareDeposit(env, recipient.address, { minDeposit: amount, maxGasFee }) };
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
  const artifact = env.contracts['test/contracts/Adversarial.sol'][name];
  const contract = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, env.deployer).deploy();
  await contract.waitForDeployment();
  // Test-only fixtures use ethers' runtime method lookup at the ABI boundary.
  return contract;
}

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
    .map(log => errors.parseLog(log)).find(log => log?.name === 'Shielded');
  assert(event);
  assert.deepEqual([...event.args], [amount, serviceFee, gasFee, shieldAmount]);
  await assert.rejects(decryptDeposit(env, await createRecipient(), receipt));
});

test('every recipient and fee term and the salt are bound to the CREATE2 address', async () => {
  const { deposit } = await prepared();
  await fund(env, deposit.address, amount);
  const [salt, config] = deposit.args;
  const attacker = await env.attacker.getAddress();
  const otherToken = await fixture('AdversarialToken');
  const mutations: Partial<DepositConfig>[] = [
    { token: await otherToken.getAddress() }, { notePublicKey: hexlify(randomBytes(32)) },
    { ciphertext: { ...config.ciphertext, shieldKey: hexlify(randomBytes(32)) } },
    { ciphertext: { ...config.ciphertext, encryptedBundle: [hexlify(randomBytes(32)),
      config.ciphertext.encryptedBundle[1], config.ciphertext.encryptedBundle[2]] } },
    { recovery: attacker }, { relayer: attacker }, { feeRecipient: attacker },
    { minDeposit: amount + 1n }, { maxGasFee: maxGasFee + 1n },
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
    await rejects(env.factory.connect(env.attacker).deployAndShield.staticCall(...deposit.args, fee),
      'UnauthorizedRelayer');
  }
  assert.equal(await env.provider.getCode(deposit.address), '0x');
  // Public deployment, recovery ownership and receiving fees confer no relayer authority.
  await (await env.factory.connect(env.attacker).deploy(...deposit.args)).wait();
  for (const caller of [env.attacker, env.recovery, env.feeCollector, env.deployer]) {
    for (const fee of [0n, gasFee]) {
      await rejects(env.forwarderAt(deposit.address, caller).shield.staticCall(fee), 'UnauthorizedRelayer');
      await rejects(env.factory.connect(caller).deployAndShield.staticCall(...deposit.args, fee),
        'UnauthorizedRelayer');
    }
  }
  await unchanged(deposit.address);
});

test('the gas cap is enforced through either entry point, including the maximum uint256 input', async () => {
  const { deposit } = await prepared();
  await fund(env, deposit.address, amount);
  await rejects(env.factory.connect(env.relayer).deployAndShield.staticCall(...deposit.args, maxGasFee + 1n),
    'GasFeeTooHigh');
  await (await env.factory.deploy(...deposit.args)).wait();
  for (const fee of [maxGasFee + 1n, (1n << 256n) - 1n]) {
    await rejects(env.forwarderAt(deposit.address).shield.staticCall(fee), 'GasFeeTooHigh');
  }
  await unchanged(deposit.address);
  await (await env.forwarderAt(deposit.address).shield(maxGasFee)).wait();
  assert.equal(await env.token.balanceOf(await env.feeCollector.getAddress()), serviceFee + maxGasFee);
});

test('the relayer can waive the gas charge while the fixed service fee still applies', async () => {
  const { recipient, deposit } = await prepared();
  await fund(env, deposit.address, amount);
  const receipt = await (await env.factory.connect(env.relayer).deployAndShield(...deposit.args, 0n)).wait();
  assert(receipt);
  const note = await decryptDeposit(env, recipient, receipt);
  assert.equal(note.amount + note.fee, amount - serviceFee);
  assert.equal(await env.token.balanceOf(await env.feeCollector.getAddress()), serviceFee);
  assert.equal(await env.token.balanceOf(await env.relayer.getAddress()), 0n);
});

test('public deployment preserves exclusive relayer access and the fixed recipient', async () => {
  const { recipient, deposit } = await prepared();
  await fund(env, deposit.address, amount);
  await (await env.factory.connect(env.attacker).deploy(...deposit.args)).wait();
  await rejects(env.forwarderAt(deposit.address, env.attacker).shield.staticCall(0n), 'UnauthorizedRelayer');
  const receipt = await (await env.forwarderAt(deposit.address, env.relayer).shield(0n)).wait();
  assert(receipt);
  const note = await decryptDeposit(env, recipient, receipt);
  assert.equal(note.amount + note.fee + serviceFee, amount);
});

test('zero and partial deposits cannot consume a one-shot address; topping up enables settlement', async () => {
  const { deposit } = await prepared();
  await rejects(env.factory.connect(env.relayer).deployAndShield.staticCall(...deposit.args, gasFee), 'InvalidBalance');
  await fund(env, deposit.address, 1n);
  await rejects(env.factory.connect(env.relayer).deployAndShield.staticCall(...deposit.args, 0n), 'InvalidBalance');
  await (await env.factory.deploy(...deposit.args)).wait();
  await rejects(env.forwarderAt(deposit.address).shield.staticCall(gasFee), 'InvalidBalance');
  await unchanged(deposit.address, 1n);
  await fund(env, deposit.address, amount - 1n);
  await settle(env, deposit, gasFee);
  assert.equal(await env.forwarderAt(deposit.address).spent(), true);
});

test('overpayments are included in the note, with the same gas cap and 0.1% of the actual balance', async () => {
  const { recipient, deposit } = await prepared();
  const actual = amount * 2n + 999n;
  await fund(env, deposit.address, actual);
  const note = await decryptDeposit(env, recipient, await settle(env, deposit, gasFee));
  assert.equal(await env.token.balanceOf(await env.feeCollector.getAddress()), actual / 1_000n + gasFee);
  assert.equal(note.amount + note.fee + actual / 1_000n + gasFee, actual);
});

test('real pool rejection reverts deployment, fee payments and approvals; full recovery still works', async () => {
  const { deposit } = await prepared();
  await fund(env, deposit.address, amount);
  await (await env.pool.addToBlocklist([await env.token.getAddress()])).wait();
  const gasBefore = await env.provider.getBalance(await env.relayer.getAddress());
  await assert.rejects(async () => {
    const tx = await env.factory.connect(env.relayer).deployAndShield(...deposit.args, gasFee,
      { gasLimit: 5_000_000 });
    await tx.wait();
  });
  assert.equal(await env.provider.getCode(deposit.address), '0x');
  assert((await env.provider.getBalance(await env.relayer.getAddress())) < gasBefore);
  await unchanged(deposit.address);
  await (await env.factory.deploy(...deposit.args)).wait();
  await rejects(env.forwarderAt(deposit.address, env.attacker).recover.staticCall(await env.token.getAddress()),
    'NotRecoveryOwner');
  await (await env.forwarderAt(deposit.address, env.recovery).recover(await env.token.getAddress())).wait();
  assert.equal(await env.token.balanceOf(await env.recovery.getAddress()), amount);
  assert.equal(await env.token.balanceOf(await env.feeCollector.getAddress()), 0n);
});

test('a failed call on an existing forwarder leaves it unspent and can be retried', async () => {
  const { deposit } = await prepared();
  await fund(env, deposit.address, amount);
  await (await env.factory.deploy(...deposit.args)).wait();
  await (await env.pool.addToBlocklist([await env.token.getAddress()])).wait();
  await assert.rejects(async () => {
    const tx = await env.forwarderAt(deposit.address).shield(gasFee, { gasLimit: 3_000_000 });
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
  await rejects(env.forwarderAt(deposit.address).shield.staticCall(gasFee), 'AlreadyShielded');
  await rejects(env.factory.connect(env.relayer).deployAndShield.staticCall(...deposit.args, gasFee), 'AlreadyShielded');
  await (await env.factory.deploy(...deposit.args)).wait(); // Idempotent deployment does not reset state.
  await rejects(env.forwarderAt(deposit.address, env.attacker).shield.staticCall(0n), 'AlreadyShielded');
  await (await env.forwarderAt(deposit.address, env.recovery).recover(await env.token.getAddress())).wait();
  assert.equal(await env.token.balanceOf(await env.recovery.getAddress()), 2_000_000n);
  assert.equal(await env.token.balanceOf(await env.feeCollector.getAddress()), serviceFee + gasFee);
  assert.equal(await env.pool.nextLeafIndex(), 1n);
});

test('recovery works below the minimum, with no relayer involvement or fee', async () => {
  const { deposit } = await prepared();
  await fund(env, deposit.address, 1n);
  await (await env.factory.connect(env.recovery).deploy(...deposit.args)).wait();
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
  await (await env.factory.connect(env.recovery).deploy(...deposit.args)).wait();
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
  const [salt, config] = deposit.args;
  const invalid: Partial<DepositConfig>[] = [
    { token: ZeroAddress }, { token: await env.attacker.getAddress() }, { recovery: ZeroAddress },
    { relayer: ZeroAddress }, { feeRecipient: ZeroAddress }, { minDeposit: 0n },
    { minDeposit: uint120Max + 1n }, { maxGasFee: amount - serviceFee },
    { maxGasFee: (1n << 256n) - 1n },
  ];
  for (const change of invalid) {
    await rejects(env.factory.computeAddress(salt, { ...config, ...change }), 'InvalidConfiguration');
    await rejects(env.factory.deploy.staticCall(salt, { ...config, ...change }), 'InvalidConfiguration');
  }
  const artifact = env.contracts['contracts/DepositFactory.sol'].DepositFactory;
  const factory = new ContractFactory(artifact.abi, artifact.evm.bytecode.object, env.deployer);
  await rejects(factory.deploy(ZeroAddress), 'InvalidPool');
  await rejects(factory.deploy(await env.attacker.getAddress()), 'InvalidPool');
});

test('fee rounding and boundary amounts preserve at least one unit for shielding', async () => {
  const recipient = await createRecipient();
  const deposit = await prepareDeposit(env, recipient.address, { minDeposit: 1_000n, maxGasFee: 998n });
  await (await env.factory.deploy(...deposit.args)).wait();
  const forwarder = env.forwarderAt(deposit.address);
  for (const balance of [1_000n, 1_001n, 1_999n, 2_000n, 100_001n, uint120Max - 1n, uint120Max]) {
    for (const fee of [0n, 1n, 998n]) {
      const [service, shield] = await forwarder.preview(balance, fee);
      assert.equal(service + shield + fee, balance);
      assert(shield > 0n);
      assert(service * 1_000n <= balance && (service + 1n) * 1_000n > balance);
    }
  }
  await rejects(forwarder.preview(999n, 0n), 'InvalidBalance');
  await rejects(forwarder.preview(uint120Max + 1n, 0n), 'InvalidBalance');
  await rejects(forwarder.preview(1_000n, 999n), 'GasFeeTooHigh');
});

test('a balance above the supported note size stays recoverable instead of being truncated', async () => {
  const { deposit } = await prepared();
  const balance = uint120Max + 1n;
  await fund(env, deposit.address, balance);
  await rejects(env.factory.connect(env.relayer).deployAndShield.staticCall(...deposit.args, gasFee), 'InvalidBalance');
  await (await env.factory.deploy(...deposit.args)).wait();
  await (await env.forwarderAt(deposit.address, env.recovery).recover(await env.token.getAddress())).wait();
  assert.equal(await env.token.balanceOf(await env.recovery.getAddress()), balance);
});

for (const [name, mode] of [['false-returning', 1], ['fee-on-transfer', 2]] as const) {
  test(name + ' fee payouts revert without consuming the deposit or paying a fee', async () => {
    const { deposit } = await prepared();
    const token = await fixture('AdversarialToken');
    const args: DepositArguments = [deposit.args[0], { ...deposit.args[1], token: await token.getAddress() }];
    const address = await env.factory.computeAddress(...args);
    await (await token.getFunction('mint')(address, amount)).wait();
    await (await env.factory.deploy(...args)).wait();
    await (await token.getFunction('configure')(mode, address)).wait();
    await assert.rejects(async () => {
      const tx = await env.factory.connect(env.relayer).deployAndShield(...args, gasFee, { gasLimit: 5_000_000 });
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
    const args: DepositArguments = [deposit.args[0], { ...deposit.args[1], token: await token.getAddress() }];
    const address = await env.factory.computeAddress(...args);
    await (await token.getFunction('mint')(address, amount)).wait();
    await (await token.getFunction('configure')(mode, address)).wait();
    await (await env.factory.connect(env.relayer).deployAndShield(...args, gasFee)).wait();
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
  const artifact = env.contracts['contracts/DepositFactory.sol'].DepositForwarder;
  const forwarder = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, env.deployer)
    .deploy(await pool.getAddress(), deposit.args[1]);
  const address = await forwarder.getAddress();
  await fund(env, address, amount);
  await rejects(env.forwarderAt(address).shield.staticCall(gasFee), 'IncompleteShield');
  await assert.rejects(async () => {
    const tx = await env.forwarderAt(address).shield(gasFee, { gasLimit: 1_000_000 });
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
  const artifact = env.contracts['contracts/DepositFactory.sol'].DepositForwarder;
  const forwarder = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, env.deployer)
    .deploy(await pool.getAddress(), deposit.args[1]);
  const address = await forwarder.getAddress();
  await fund(env, address, amount);
  await (await env.forwarderAt(address).shield(gasFee)).wait();
  assert.equal(await pool.getFunction('reentryBlocked')(), true);
  assert.equal(await env.token.balanceOf(await pool.getAddress()), amount - serviceFee - gasFee);
  assert.equal(await env.token.balanceOf(await env.feeCollector.getAddress()), serviceFee + gasFee);
});

test('native recovery resists receiver reentry and preserves funds if the receiver rejects payment', async () => {
  const { deposit } = await prepared();
  const receiver = await fixture('RecoveryReceiver');
  const args: DepositArguments = [deposit.args[0], { ...deposit.args[1], recovery: await receiver.getAddress() }];
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
