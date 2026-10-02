import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { ContractFactory, ZeroAddress, parseEther } from 'ethers';
import { compile, createEnvironment, createRecipient, fund, prepareDeposit, settle } from '../scripts/harness.ts';
import type { Environment, PreparedDeposit } from '../scripts/types.ts';
import { createRecoveryFile, recoveryArtifacts } from '../scripts/recovery-file.ts';
import { startRecoverySite } from '../scripts/serve-recovery.ts';
import { checkRecoveryAddress, inspectRecovery, parseRecoveryFile, predictRecoveryAddress,
  recoveryTransaction, recoveryAsset } from '../recovery/core.ts';
import type { RecoveryArtifacts, RecoveryFile } from '../recovery/core.ts';

let env: Environment;
let artifacts: RecoveryArtifacts;
let recipient: string;
let owner: string;
before(async () => {
  const contracts = compile();
  artifacts = recoveryArtifacts(contracts);
  env = await createEnvironment(contracts);
  recipient = (await createRecipient()).address;
  owner = await env.recovery.getAddress();
});
after(async () => { if (env) await env.close(); });

async function prepare(): Promise<{ file: RecoveryFile; deposit: PreparedDeposit }> {
  const deposit = await prepareDeposit(env, recipient, { amount: 1_000_000n });
  const file = createRecoveryFile(deposit, deposit.quote.token);
  return { file, deposit };
}

test('backup round-trips, predicts the exact address, and matches the independent site build', async () => {
  const { file, deposit } = await prepare();
  const saved = JSON.stringify(file);
  assert.deepEqual(parseRecoveryFile(saved), file);
  assert.equal(predictRecoveryAddress(file, artifacts), deposit.address);
  assert(!saved.includes(recipient), 'Recovery does not expose the plaintext 0zk address');
  assert.doesNotMatch(saved, /"(?:privateKey|mnemonic|viewing|rpc|transactions)":/i);
  assert.deepEqual(JSON.parse(await readFile(new URL('../.cache/recovery/contracts.json', import.meta.url), 'utf8')), artifacts);
  await writeFile(new URL('../.cache/recovery-example.json', import.meta.url), saved);
});

test('rejects malformed, oversized, unsupported and executable file content', async () => {
  const { file } = await prepare();
  for (const invalid of [null, [], {}, { ...file, version: 3 }, { ...file, chainId: 31337 },
    { ...file, chainId: '0' }, { ...file, transactions: [{ to: owner }] },
    { ...file, config: { ...file.config, amount: '-1' } },
    { ...file, config: { ...file.config, maxGasFee: '1000000' } },
    { ...file, config: { ...file.config, recovery: ZeroAddress } },
    { ...file, config: { ...file.config, recipient: '0x12' } },
    { ...file, pool: '<script>alert(1)</script>' },
  ]) assert.throws(() => parseRecoveryFile(JSON.stringify(invalid)));
  assert.throws(() => parseRecoveryFile('{'));
  assert.throws(() => parseRecoveryFile(' '.repeat(16_385)), /too large/);
});

test('rejects changed deposit settings and refuses wrong wallet or chain before submitting', async () => {
  const { file } = await prepare();
  const attacker = await env.attacker.getAddress();
  const alternatives = [
    { ...file, salt: `0x${'ab'.repeat(32)}` }, { ...file, depositAddress: attacker },
    ...['recovery', 'relayer', 'feeRecipient'].map(key => ({ ...file, config: { ...file.config, [key]: attacker } })),
    { ...file, config: { ...file.config, recipient: `0x${'cd'.repeat(160)}` } },
  ];
  for (const changed of alternatives) assert.throws(() => checkRecoveryAddress(changed, artifacts), /does not match/);
  await assert.rejects(recoveryTransaction(env.provider, file, artifacts, attacker, recoveryAsset(file), 'deploy'), /Connect the recovery wallet/);
  await assert.rejects(inspectRecovery(env.provider, { ...file, chainId: '42161' }, artifacts), /Switch your wallet/);
  const wrongFactory = { ...file, factory: await env.token.getAddress() };
  wrongFactory.depositAddress = predictRecoveryAddress(wrongFactory, artifacts);
  await assert.rejects(inspectRecovery(env.provider, wrongFactory, artifacts), /factory is missing or does not match/);
});

test('recovers from an undeployed funded address using only the saved file and owner wallet', async () => {
  const prepared = await prepare();
  await fund(env, prepared.deposit.address, 900_000n); // Below the quoted amount is recoverable.
  const file = parseRecoveryFile(JSON.stringify(prepared.file));
  assert.equal(await env.provider.getCode(file.depositAddress), '0x');
  const before = await env.token.balanceOf(owner);
  const feesBefore = await env.token.balanceOf(await env.feeCollector.getAddress());
  const status = await inspectRecovery(env.provider, file, artifacts);
  assert.equal(status.deployed, false);
  assert.equal(status.balance, 900_000n);
  await assert.rejects(recoveryTransaction(env.provider, file, artifacts, owner, recoveryAsset(file), 'recover'), /Deploy.*first/);
  const deploy = await recoveryTransaction(env.provider, file, artifacts, owner, recoveryAsset(file), 'deploy');
  assert.equal(deploy.to, file.factory);
  assert.equal(deploy.value, 0n);
  assert.equal(deploy.chainId, 31337n);
  await (await env.recovery.sendTransaction(deploy)).wait();
  await assert.rejects(recoveryTransaction(env.provider, file, artifacts, owner, recoveryAsset(file), 'deploy'), /Already deployed/);
  const recover = await recoveryTransaction(env.provider, file, artifacts, owner, recoveryAsset(file), 'recover');
  assert.equal(recover.to, file.depositAddress);
  await (await env.recovery.sendTransaction(recover)).wait();
  assert.equal(await env.token.balanceOf(owner) - before, 900_000n);
  assert.equal(await env.token.balanceOf(file.depositAddress), 0n);
  assert.equal(await env.token.balanceOf(await env.feeCollector.getAddress()), feesBefore);
  await assert.rejects(recoveryTransaction(env.provider, file, artifacts, owner, recoveryAsset(file), 'recover'), /no funds/);
});

test('the same recovery tool deploys and recovers a Privacy Pools address without its SDK or relayer', async () => {
  const artifact = env.contracts['contracts/protocols/PrivacyPoolsDeposit.sol'].PrivacyPoolsDepositFactory;
  const factory = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, env.sender)
    .deploy(await env.pool.getAddress(), [{ token: await env.token.getAddress(), maxGasFee: 0, maxGasFeeBps: 0 }]);
  await factory.waitForDeployment();
  const { file: template } = await prepare();
  const config = { ...template.config, recipient: `0x${'ab'.repeat(32)}` };
  const file = createRecoveryFile({ protocol: 'privacy-pools', chainId: 31337n,
    factory: await factory.getAddress(), pool: template.pool, salt: template.salt, config,
    address: await factory.getFunction('computeAddress')(template.salt, config) }, template.asset);
  await fund(env, file.depositAddress, 321n);
  const before = await env.token.balanceOf(owner);
  for (const action of ['deploy', 'recover'] as const) {
    await (await env.recovery.sendTransaction(await recoveryTransaction(
      env.provider, file, artifacts, owner, file.asset, action))).wait();
  }
  assert.equal(await env.token.balanceOf(owner), before + 321n);
});

test('the asset hint changes the displayed balance, not the address or recovery rights', async () => {
  const { file } = await prepare();
  const alternative = { ...file, asset: await env.pool.getAddress() };
  assert.equal(predictRecoveryAddress(alternative, artifacts), file.depositAddress);
  assert.deepEqual(parseRecoveryFile(JSON.stringify(alternative)), alternative);
});

test('recovers native currency from a previously undeployed address', async () => {
  const { file } = await prepare();
  const amount = parseEther('0.01');
  await (await env.sender.sendTransaction({ to: file.depositAddress, value: amount })).wait();
  const status = await inspectRecovery(env.provider, file, artifacts, ZeroAddress);
  assert.equal(status.balance, amount);
  await (await env.recovery.sendTransaction(await recoveryTransaction(
    env.provider, file, artifacts, owner, ZeroAddress, 'deploy'))).wait();
  const before = await env.provider.getBalance(owner);
  const receipt = await (await env.recovery.sendTransaction(await recoveryTransaction(
    env.provider, file, artifacts, owner, ZeroAddress, 'recover'))).wait();
  assert(receipt);
  assert.equal(await env.provider.getBalance(owner) - before + receipt.fee, amount);
  assert.equal(await env.provider.getBalance(file.depositAddress), 0n);
});

test('rejects substituted implementation or clone code before allowing recovery', async () => {
  const { file } = await prepare();
  await fund(env, file.depositAddress, 123n);
  const implementation: string = await env.factory.getFunction('implementation')();
  const original = await env.provider.getCode(implementation);
  try {
    await env.provider.send('anvil_setCode', [implementation, '0x00']);
    await assert.rejects(inspectRecovery(env.provider, file, artifacts), /implementation is missing or does not match/);
  } finally {
    await env.provider.send('anvil_setCode', [implementation, original]);
  }
  await (await env.recovery.sendTransaction(await recoveryTransaction(
    env.provider, file, artifacts, owner, file.asset, 'deploy'))).wait();
  const clone = await env.provider.getCode(file.depositAddress);
  try {
    await env.provider.send('anvil_setCode', [file.depositAddress, '0x00']);
    await assert.rejects(inspectRecovery(env.provider, file, artifacts), /not the expected fixed clone/);
  } finally {
    await env.provider.send('anvil_setCode', [file.depositAddress, clone]);
  }
  assert.equal((await inspectRecovery(env.provider, file, artifacts)).balance, 123n);
});

test('recovers a different token without touching the intended token', async () => {
  const { file } = await prepare();
  const tokenArtifact = env.contracts['test/contracts/DemoToken.sol'].DemoToken;
  const other = await new ContractFactory(tokenArtifact.abi, tokenArtifact.evm.bytecode.object, env.sender).deploy();
  await other.waitForDeployment();
  const otherAddress = await other.getAddress();
  await (await other.getFunction('mint')(file.depositAddress, 123n)).wait();
  await fund(env, file.depositAddress, 555n);
  for (const action of ['deploy', 'recover'] as const) {
    await (await env.recovery.sendTransaction(await recoveryTransaction(
      env.provider, file, artifacts, owner, otherAddress, action))).wait();
  }
  assert.equal(await other.getFunction('balanceOf').staticCall(owner), 123n);
  assert.equal(await env.token.balanceOf(file.depositAddress), 555n);
});

test('cannot recover shielded funds, but can recover a later transfer to the same address', async () => {
  const { file, deposit } = await prepare();
  await fund(env, file.depositAddress, deposit.quote.amount);
  await settle(env, deposit);
  assert.equal((await inspectRecovery(env.provider, file, artifacts)).balance, 0n);
  await assert.rejects(recoveryTransaction(env.provider, file, artifacts, owner, recoveryAsset(file), 'recover'), /no funds/);
  await fund(env, file.depositAddress, 100n);
  const before = await env.token.balanceOf(owner);
  await (await env.recovery.sendTransaction(await recoveryTransaction(
    env.provider, file, artifacts, owner, recoveryAsset(file), 'recover'))).wait();
  assert.equal(await env.token.balanceOf(owner) - before, 100n);
});

test('serves a self-contained static recovery site without a deposit API or file-upload endpoint', async () => {
  const site = await startRecoverySite(0);
  try {
    const page = await fetch(site.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Recovery file/);
    assert.doesNotMatch(html, /\{\{brand\./);
    assert.match(page.headers.get('content-security-policy') ?? '', /connect-src 'self'/);
    assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    for (const path of ['/main.js', '/core.js', '/vendor/ethers.js', '/contracts.json', '/theme.js']) {
      assert.equal((await fetch(site.url + path)).status, 200);
    }
    assert.equal((await fetch(site.url + '/api/state')).status, 404);
    assert.equal((await fetch(site.url, { method: 'POST', body: '{}' })).status, 404);
  } finally { await site.close(); }
});
