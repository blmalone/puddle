import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Contract, ContractFactory, JsonRpcProvider, formatEther, getAddress,
  getCreateAddress, keccak256, parseEther } from 'ethers';
import { FORK, compile, createEnvironment, prepareDeposit } from './harness.ts';
import type { DepositFactory } from './types.ts';
import { createRecoveryFile } from './recovery-file.ts';
import type { ShieldEvent } from
  '../node_modules/@railgun-community/engine/dist/abi/typechain/RailgunSmartWallet.js';

// Reads mainnet, but sends transactions only to a local Anvil fork. No signing key.
const [recipient, recoveryInput, amountInput, outputInput, gasFeeInput = '0', maxGasFeeInput = gasFeeInput] = process.argv.slice(2);
assert(recipient && recoveryInput && amountInput && outputInput,
  'Usage: node scripts/prepare-live.ts <0zk recipient> <0x recovery> <WETH amount> <output.json> [gas fee WETH] [maximum gas fee WETH]');
const recovery = getAddress(recoveryInput);
const amount = parseEther(amountInput);
assert(amount > 0n, 'Amount must be positive');
const gasFee = parseEther(gasFeeInput);
const maxGasFee = parseEther(maxGasFeeInput);
const serviceFee = amount / 1_000n;
assert(gasFee >= 0n && gasFee <= maxGasFee && maxGasFee < amount - serviceFee, 'Invalid fee limits');
const output = resolve(outputInput);
const rpc = process.env.ARBITRUM_RPC_URL || FORK.rpc;
const live = new JsonRpcProvider(rpc);

try {
  assert.equal((await live.getNetwork()).chainId, 42161n, 'Arbitrum One required');
  const block = await live.getBlockNumber();
  const [nonce, pendingNonce, balance, code] = await Promise.all([
    live.getTransactionCount(recovery, block), live.getTransactionCount(recovery, 'pending'),
    live.getBalance(recovery, block), live.getCode(recovery, block),
  ]);
  assert.equal(pendingNonce, nonce, 'Wait for pending transactions before preparing');
  assert.equal(code, '0x', 'This pilot requires an ordinary signing account');
  const contracts = compile();
  const artifact = contracts['contracts/DepositFactory.sol'].DepositFactory;
  const factoryAddress = getCreateAddress({ from: recovery, nonce });
  const factoryDeployment = await new ContractFactory(artifact.abi,
    artifact.evm.bytecode.object).getDeployTransaction(FORK.pool);
  const env = await createEnvironment(contracts, { ...FORK, rpc, block });
  try {
    // Impersonation and funding occur only on the local fork.
    assert.equal((await env.provider.getNetwork()).chainId, 31337n);
    await env.provider.send('anvil_impersonateAccount', [recovery]);
    await env.provider.send('anvil_setBalance', [recovery, '0x3635c9adc5dea00000']);
    const signer = await env.provider.getSigner(recovery);
    assert.equal(await env.provider.getTransactionCount(recovery), nonce);
    const factory = await new ContractFactory(artifact.abi,
      artifact.evm.bytecode.object, signer).deploy(FORK.pool) as unknown as DepositFactory;
    const deployed = await factory.deploymentTransaction()!.wait();
    assert(deployed);
    assert.equal(await factory.getAddress(), factoryAddress);
    // This single-account pilot returns service fees and gas reimbursement to its own signer.
    const deposit = await prepareDeposit({ ...env, factory, recovery: signer, relayer: signer,
      feeCollector: signer }, recipient, { minDeposit: amount, maxGasFee });
    const config = deposit.args[1];
    assert.equal(await env.provider.getCode(deposit.address), '0x');
    const token = env.token.connect(signer);
    const wrapped = await (await token.deposit({ value: amount })).wait();
    const funded = await (await token.transfer(deposit.address, amount)).wait();
    assert(wrapped && funded);
    const snapshot = await env.provider.send('evm_snapshot', []);
    const poolBefore = await token.balanceOf(FORK.pool);
    const feeRecipientBefore = await token.balanceOf(recovery);
    const shielded = await (await factory.deployAndShield(...deposit.args, gasFee)).wait();
    assert(shielded);
    const event = shielded.logs.filter(log => getAddress(log.address) === getAddress(FORK.pool))
      .map(log => env.pool.interface.parseLog(log)).find(log => log?.name === 'Shield');
    assert(event, 'Expected a RAILGUN Shield event');
    const shield = event.args.toObject() as ShieldEvent.OutputObject;
    assert.equal(shield.commitments.length, 1);
    const preimage = shield.commitments[0];
    const shieldedAmount: bigint = preimage.value;
    const protocolFee: bigint = shield.fees[0];
    assert.deepEqual([...shield.shieldCiphertext[0].encryptedBundle],
      [...config.ciphertext.encryptedBundle]);
    assert.equal(shield.shieldCiphertext[0].shieldKey, config.ciphertext.shieldKey);
    assert.equal(preimage.npk.toLowerCase(), String(config.notePublicKey).toLowerCase());
    assert.equal(getAddress(preimage.token.tokenAddress), getAddress(FORK.token));
    assert.equal(shieldedAmount + protocolFee + serviceFee + gasFee, amount);
    assert.equal(await token.balanceOf(recovery) - feeRecipientBefore, serviceFee + gasFee);
    assert.equal(await token.balanceOf(FORK.pool) - poolBefore, shieldedAmount);
    assert.equal(await token.balanceOf(deposit.address), 0n);
    assert.equal(await token.allowance(deposit.address, FORK.pool), 0n);

    // Rehearse recovery from the still-undeployed, funded address instead of shielding.
    assert.equal(await env.provider.send('evm_revert', [snapshot]), true);
    const recoveryBefore = await token.balanceOf(recovery);
    const recoveryDeployment = await (await factory.deploy(...deposit.args)).wait();
    const recovered = await (await env.forwarderAt(deposit.address, signer).recover(FORK.token)).wait();
    assert(recoveryDeployment && recovered);
    assert.equal(await token.balanceOf(recovery) - recoveryBefore, amount);
    assert.equal(await token.balanceOf(deposit.address), 0n);

    const forwarder = new Contract(deposit.address,
      contracts['contracts/DepositFactory.sol'].DepositForwarder.abi);
    const plan = {
      version: 2, status: 'simulated-only', chainId: 42161, sourceBlock: block,
      createdAt: new Date().toISOString(), recipient, recovery, signer: recovery,
      amount: amount.toString(), gasFee: gasFee.toString(), serviceFee: serviceFee.toString(),
      token: FORK.token, pool: FORK.pool,
      factory: factoryAddress, factoryNonce: nonce, depositAddress: deposit.address,
      depositArguments: deposit.args,
      recoveryFile: createRecoveryFile(42161n, factoryAddress, FORK.pool, deposit),
      factoryCodeHash: keccak256(await env.provider.getCode(factoryAddress)),
      poolCodeHash: keccak256(await env.provider.getCode(FORK.pool)),
      transactions: {
        factory: { from: recovery, nonce, data: factoryDeployment.data },
        wrap: { to: FORK.token, data: token.interface.encodeFunctionData('deposit'), value: amount.toString() },
        fund: { to: FORK.token, data: token.interface.encodeFunctionData('transfer', [deposit.address, amount]) },
        shield: { to: factoryAddress, data: factory.interface.encodeFunctionData('deployAndShield', [...deposit.args, gasFee]) },
        deployForRecovery: { to: factoryAddress, data: factory.interface.encodeFunctionData('deploy', deposit.args) },
        recover: { to: deposit.address, data: forwarder.interface.encodeFunctionData('recover', [FORK.token]) },
      },
      simulation: {
        shieldedAmount: shieldedAmount.toString(), protocolFee: protocolFee.toString(),
        recoverySucceeded: true,
        gas: {
          factory: deployed.gasUsed.toString(), wrap: wrapped.gasUsed.toString(),
          fund: funded.gasUsed.toString(), shield: shielded.gasUsed.toString(),
          deployForRecovery: recoveryDeployment.gasUsed.toString(), recover: recovered.gasUsed.toString(),
        },
        gasNote: 'Local execution only; excludes Arbitrum L1 data fees. Obtain live quotes before signing.',
      },
    };
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    writeFileSync(output, `${JSON.stringify(plan, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2)}\n`,
      { flag: 'wx', mode: 0o600 });
    console.log(`Local fork passed: ${formatEther(amount)} WETH → ${formatEther(shieldedAmount)} WETH shielded.`);
    console.log('Independent recovery from the undeployed address also passed.');
    console.log(`Pilot fees return to its signer: ${formatEther(serviceFee)} WETH service + ${formatEther(gasFee)} WETH gas charge.`);
    console.log(`Live account balance: ${formatEther(balance)} ETH on Arbitrum.`);
    console.log(`Saved deployment and recovery data: ${output}`);
    console.log('No real transactions sent. Wallet discovery and spendability still need a live test.');
  } finally { await env.close(); }
} finally { live.destroy(); }
