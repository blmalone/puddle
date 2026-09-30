import assert, { AssertionError } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Contract, ContractFactory, JsonRpcProvider, Wallet, formatEther,
  getAddress, getCreate2Address, getCreateAddress, keccak256, parseEther } from 'ethers';
import type { ContractTransactionReceipt, Signer, TransactionReceipt, TransactionRequest } from 'ethers';
import { FORK, compile, createEnvironment } from './harness.ts';
import type { DepositArguments, DepositFactory } from './types.ts';
import type { ShieldEvent } from
  '../node_modules/@railgun-community/engine/dist/abi/typechain/RailgunSmartWallet.js';

interface Plan {
  version: number;
  chainId: number;
  recipient: string;
  recovery: string;
  signer: string;
  amount: string;
  gasFee: string;
  serviceFee: string;
  token: string;
  pool: string;
  factory: string;
  factoryNonce: number;
  depositAddress: string;
  depositArguments: DepositArguments;
  factoryCodeHash: string;
  poolCodeHash: string;
  transactions: { factory: { data: string } };
}
type Stage = 'factory' | 'fund' | 'shield';
interface Journal {
  mode: string;
  planHash: string;
  transactions: Partial<Record<Stage, string>>;
  complete?: boolean;
  shieldedAmount?: string;
  protocolFee?: string;
  gasCost?: string;
}

let step = 'preflight';
let shutdown: (() => Promise<void>) | undefined;
let live: JsonRpcProvider | undefined;
try {
  const [planInput, mode, budgetInput, itemId] = process.argv.slice(2);
  assert(planInput && (mode === 'check' || mode === 'send') && budgetInput,
    'Usage: node scripts/run-live.ts <plan.json> <check|send> <total-USD-cap> [1Password-item-id]');
  const dollarCap = Number(budgetInput);
  assert(Number.isFinite(dollarCap) && dollarCap > 0);
  const path = resolve(planInput);
  const planText = readFileSync(path);
  const plan: Plan = JSON.parse(planText.toString());
  const planHash = keccak256(planText);
  const amount = BigInt(plan.amount);
  // This pilot never wraps ETH and never permits more than this total transaction fee.
  const gasBudget = parseEther('0.0005');
  assert(plan.version === 2 && plan.chainId === 42161 && amount > 0n,
    'A version 2 plan is required; legacy plans must not be used with these contracts');
  const gasFee = BigInt(plan.gasFee);
  const serviceFee = amount / 1_000n;
  assert.equal(BigInt(plan.serviceFee), serviceFee);
  const config = plan.depositArguments[1];
  config.minDeposit = BigInt(config.minDeposit);
  config.maxGasFee = BigInt(config.maxGasFee);
  assert.equal(config.minDeposit, amount);
  assert(gasFee >= 0n && gasFee <= config.maxGasFee && config.maxGasFee < amount - serviceFee);
  assert.equal(getAddress(plan.signer), getAddress(plan.recovery));
  assert.equal(getAddress(plan.token), getAddress(FORK.token));
  assert.equal(getAddress(plan.pool), getAddress(FORK.pool));
  assert.equal(getAddress(config.token), getAddress(plan.token));
  assert.equal(getAddress(config.recovery), getAddress(plan.recovery));
  assert.equal(getAddress(config.relayer), getAddress(plan.signer));
  assert.equal(getAddress(config.feeRecipient), getAddress(plan.signer), 'Pilot fees must return to its own signer');
  assert.equal(getCreateAddress({ from: plan.signer, nonce: plan.factoryNonce }), plan.factory);
  const priceResponse = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot');
  assert(priceResponse.ok, 'Price quote unavailable');
  const quote = await priceResponse.json() as { data: { amount: string; base: string; currency: string } };
  assert.equal(quote.data.base, 'ETH');
  assert.equal(quote.data.currency, 'USD');
  const price = Number(quote.data.amount);
  assert(Number.isFinite(price) && price > 0);
  assert(Number(formatEther(amount + gasBudget)) * price <= dollarCap, 'Total budget exceeded');
  console.log(`Deposit: ${formatEther(amount)} WETH; all transaction fees capped at ${formatEther(gasBudget)} ETH.`);
  console.log(`Maximum at current ETH/USD quote: $${(Number(formatEther(amount + gasBudget)) * price).toFixed(2)}; user cap: $${dollarCap}.`);

  const rpc = process.env.ARBITRUM_RPC_URL || FORK.rpc;
  live = new JsonRpcProvider(rpc, undefined, { cacheTimeout: -1, pollingInterval: 1000 });
  assert.equal((await live.getNetwork()).chainId, 42161n);
  const sourceFees = await live.getFeeData();
  const contracts = compile();
  const factoryArtifact = contracts['contracts/DepositFactory.sol'].DepositFactory;
  const forwarderArtifact = contracts['contracts/DepositFactory.sol'].DepositForwarder;
  const factoryDeployment = await new ContractFactory(factoryArtifact.abi,
    factoryArtifact.evm.bytecode.object).getDeployTransaction(plan.pool);
  assert.equal(factoryDeployment.data, plan.transactions.factory.data, 'Factory bytecode changed');
  const forwarderDeployment = await new ContractFactory(forwarderArtifact.abi,
    forwarderArtifact.evm.bytecode.object).getDeployTransaction(plan.pool, config);
  assert(forwarderDeployment.data);
  assert.equal(getCreate2Address(plan.factory, plan.depositArguments[0],
    keccak256(forwarderDeployment.data)), plan.depositAddress, 'Deposit address mismatch');

  let provider = live;
  let signer: Signer;
  if (mode === 'check') {
    const env = await createEnvironment(contracts, { ...FORK, rpc, block: await live.getBlockNumber() });
    shutdown = env.close;
    provider = env.provider;
    assert.equal((await provider.getNetwork()).chainId, 31337n);
    await provider.send('anvil_impersonateAccount', [plan.signer]);
    signer = await provider.getSigner(plan.signer);
  } else {
    assert(itemId, 'A 1Password item ID is required to sign');
    step = 'unlocking signing key';
    let secret: string;
    try {
      const item = JSON.parse(execFileSync('op', ['item', 'get', itemId, '--format', 'json'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 })) as
        { fields: { value?: string }[] };
      const matches = item.fields.map(field => field.value?.trim() ?? '').filter(value => {
        if (!/^(0x)?[a-fA-F0-9]{64}$/.test(value)) return false;
        try { return new Wallet(value.startsWith('0x') ? value : `0x${value}`).address === getAddress(plan.signer); }
        catch { return false; }
      });
      assert.equal(matches.length, 1);
      secret = matches[0].startsWith('0x') ? matches[0] : `0x${matches[0]}`;
    } catch { throw new Error('Could not obtain the matching signing key'); }
    signer = new Wallet(secret, provider);
    secret = '';
  }
  assert.equal(await signer.getAddress(), getAddress(plan.signer));
  assert.equal(keccak256(await provider.getCode(plan.pool)), plan.poolCodeHash);
  const factory = new Contract(plan.factory, factoryArtifact.abi, provider) as unknown as DepositFactory;
  const token = new Contract(plan.token, [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
    'function transfer(address,uint256) returns (bool)',
  ], provider);
  const journalPath = `${path}.${mode}.json`;
  const journal: Journal = mode === 'send' && existsSync(journalPath)
    ? JSON.parse(readFileSync(journalPath, 'utf8'))
    : { mode, planHash, transactions: {} };
  assert.equal(journal.planHash, planHash, 'Plan changed since execution started');
  function save() {
    const temporary = `${journalPath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, journalPath);
  }
  save();
  async function feesPaid() {
    let total = 0n;
    for (const hash of Object.values(journal.transactions)) {
      const receipt = await provider.getTransactionReceipt(hash);
      assert(receipt, 'A recorded transaction is pending; wait before continuing');
      total += receipt.fee;
    }
    return total;
  }
  async function send(stage: Stage, request: TransactionRequest): Promise<TransactionReceipt> {
    step = stage;
    const existing = journal.transactions[stage];
    if (existing) {
      const receipt = await provider.getTransactionReceipt(existing);
      assert(receipt && receipt.status === 1, 'Recorded transaction is pending or failed');
      return receipt;
    }
    assert.equal((await provider.getNetwork()).chainId, mode === 'send' ? 42161n : 31337n);
    const [latestNonce, pendingNonce, feeData, balance] = await Promise.all([
      provider.getTransactionCount(plan.signer, 'latest'), provider.getTransactionCount(plan.signer, 'pending'),
      mode === 'check' ? Promise.resolve(sourceFees) : provider.getFeeData(), provider.getBalance(plan.signer),
    ]);
    assert.equal(latestNonce, pendingNonce, 'Unexpected pending transaction');
    assert(feeData.gasPrice && feeData.gasPrice > 0n);
    const gasPrice = feeData.gasPrice * 2n;
    const transaction = { ...request, from: plan.signer, nonce: latestNonce, gasPrice,
      chainId: mode === 'send' ? 42161 : 31337, type: 0, value: 0n };
    const gasLimit = (await provider.estimateGas(transaction)) * 120n / 100n + 10000n;
    const maximumFee = gasLimit * gasPrice;
    assert(await feesPaid() + maximumFee <= gasBudget, 'Hard fee limit exceeded');
    assert(balance >= maximumFee, 'Insufficient ETH for transaction fees');
    console.log(`${mode}: ${stage}; maximum fee ${formatEther(maximumFee)} ETH`);
    const tx = await signer.sendTransaction({ ...transaction, gasLimit });
    journal.transactions[stage] = tx.hash;
    save();
    console.log(`${stage} transaction: ${tx.hash}`);
    const receipt = await tx.wait(1, 120000);
    assert(receipt && receipt.status === 1, 'Transaction failed or timed out');
    return receipt;
  }

  step = 'checking balances and factory';
  const factoryCode = await provider.getCode(plan.factory);
  if (factoryCode === '0x') {
    assert.equal(await provider.getTransactionCount(plan.signer, 'pending'), plan.factoryNonce);
    assert(await token.balanceOf(plan.signer) >= amount, 'Insufficient WETH');
    await send('factory', { data: factoryDeployment.data });
  }
  assert.equal(keccak256(await provider.getCode(plan.factory)), plan.factoryCodeHash, 'Unexpected factory code');
  assert.equal(await factory.computeAddress(...plan.depositArguments), plan.depositAddress);
  const forwarder = new Contract(plan.depositAddress, forwarderArtifact.abi, provider);
  const spent = await provider.getCode(plan.depositAddress) !== '0x' && await forwarder.spent();
  if (!spent) {
    let deposited: bigint = await token.balanceOf(plan.depositAddress);
    if (deposited === 0n) {
      assert(!journal.transactions.fund, 'A recorded deposit is missing; investigate before retrying');
      assert(await token.balanceOf(plan.signer) >= amount, 'Insufficient WETH');
      await send('fund', { to: plan.token,
        data: token.interface.encodeFunctionData('transfer', [plan.depositAddress, amount]) });
      deposited = await token.balanceOf(plan.depositAddress);
    }
    assert.equal(deposited, amount, 'Unexpected deposit balance');
    await send('shield', { to: plan.factory,
      data: factory.interface.encodeFunctionData('deployAndShield', [...plan.depositArguments, gasFee]) });
  }
  step = 'verifying shield';
  assert(journal.transactions.shield, 'Already shielded without a recorded transaction; inspect events');
  const receipt = await provider.getTransactionReceipt(journal.transactions.shield) as ContractTransactionReceipt | null;
  assert(receipt && receipt.status === 1);
  const pool = new Contract(plan.pool, contracts['railgun/contracts/logic/RailgunSmartWallet.sol'].RailgunSmartWallet.abi);
  const event = receipt.logs.filter(log => getAddress(log.address) === getAddress(plan.pool))
    .map(log => pool.interface.parseLog(log)).find(log => log?.name === 'Shield');
  assert(event);
  const shield = event.args.toObject() as ShieldEvent.OutputObject;
  assert.equal(shield.commitments.length, 1);
  const commitment = shield.commitments[0];
  assert.equal(commitment.npk, config.notePublicKey);
  assert.equal(getAddress(commitment.token.tokenAddress), getAddress(plan.token));
  assert.equal(commitment.value + shield.fees[0] + serviceFee + gasFee, amount);
  assert.equal(shield.shieldCiphertext[0].shieldKey, config.ciphertext.shieldKey);
  assert.deepEqual([...shield.shieldCiphertext[0].encryptedBundle], [...config.ciphertext.encryptedBundle]);
  const feeEvent = receipt.logs.filter(log => getAddress(log.address) === getAddress(plan.depositAddress))
    .map(log => forwarder.interface.parseLog(log)).find(log => log?.name === 'Shielded');
  assert(feeEvent, 'Expected a deposit Shielded event');
  assert.deepEqual([...feeEvent.args], [amount, serviceFee, gasFee, amount - serviceFee - gasFee]);
  assert.equal(await token.balanceOf(plan.depositAddress), 0n);
  assert.equal(await token.allowance(plan.depositAddress, plan.pool), 0n);
  assert.equal(await forwarder.spent(), true);
  journal.complete = true;
  journal.shieldedAmount = commitment.value.toString();
  journal.protocolFee = shield.fees[0].toString();
  journal.gasCost = (await feesPaid()).toString();
  save();
  console.log(`${mode === 'check' ? 'LOCAL REHEARSAL' : 'MAINNET'} PASSED: ${formatEther(commitment.value)} WETH shielded.`);
  console.log(`Actual transaction fees: ${formatEther(BigInt(journal.gasCost))} ETH.`);
  console.log(`Saved transaction record: ${journalPath}`);
} catch (error) {
  // Never print raw subprocess or wallet errors: they can include secret input.
  console.error(`Stopped during ${step}. No further transactions will be sent. Inspect the saved transaction record before retrying.`);
  if (error instanceof AssertionError) console.error(error.message);
  process.exitCode = 1;
} finally {
  if (shutdown) await shutdown();
  live?.destroy();
}
