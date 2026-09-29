import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import solc from 'solc';
import { poseidonContract } from 'circomlibjs';
import { Contract, ContractFactory, JsonRpcProvider, getBytes, hexlify, toBeHex } from 'ethers';
import type { ContractTransactionReceipt } from 'ethers';
import engine from '@railgun-community/engine';
import { ensureUpstream, root, upstream, upstreamCommit } from './setup.ts';
import type { CompiledContracts, CompilerOutput, ContractArtifact, DepositArguments,
  DepositFactory, DepositForwarder, DepositPath, Environment, ForkConfig,
  PreparedDeposit, Recipient, TokenContract } from './types.ts';
import type { RailgunSmartWallet, ShieldEvent } from
  '../node_modules/@railgun-community/engine/dist/abi/typechain/RailgunSmartWallet.js';

// The engine pins these internal helpers; they aren't exported at package root.
const require = createRequire(import.meta.url);
const engineDist = dirname(require.resolve('@railgun-community/engine'));
const { deriveNodes, WalletNode } = require(join(engineDist, 'key-derivation/wallet-node.js')) as
  typeof import('../node_modules/@railgun-community/engine/dist/key-derivation/wallet-node.js');
const { encodeAddress, decodeAddress } = require(join(engineDist, 'key-derivation/bech32.js')) as
  typeof import('../node_modules/@railgun-community/engine/dist/key-derivation/bech32.js');
const { getSharedSymmetricKey } = require(join(engineDist, 'utils/keys-utils.js')) as
  typeof import('../node_modules/@railgun-community/engine/dist/utils/keys-utils.js');
const { ShieldNote, ShieldNoteERC20 } = engine;
const railgunSource = 'railgun/contracts/logic/RailgunSmartWallet.sol';
const poseidonSource = 'railgun/contracts/logic/Poseidon.sol';

export function compile(): CompiledContracts {
  ensureUpstream();
  const sources: Record<string, { content: string }> = {};
  for (const file of ['contracts/DepositFactory.sol', 'contracts/DemoToken.sol']) {
    sources[file] = { content: readFileSync(`${root}${file}`, 'utf8') };
  }
  sources[railgunSource] = { content: readFileSync(`${upstream}/contracts/logic/RailgunSmartWallet.sol`, 'utf8') };
  const input = {
    language: 'Solidity', sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'storageLayout'] } },
    },
  };
  const output: CompilerOutput = JSON.parse(solc.compile(JSON.stringify(input), {
    import: (name) => {
      const file = name.startsWith('railgun/')
        ? `${upstream}/${name.slice('railgun/'.length)}`
        : `${root}node_modules/${name}`;
      try { return { contents: readFileSync(file, 'utf8') }; }
      catch { return { error: `Missing import: ${name}` }; }
    },
  }));
  const errors = (output.errors ?? []).filter((entry) => entry.severity === 'error');
  if (errors.length) throw new Error(errors.map((entry) => entry.formattedMessage).join('\n'));
  assert(output.contracts, 'Solidity compilation must produce contracts');
  return output.contracts;
}

export const FORK: ForkConfig = {
  rpc: 'https://arb1.arbitrum.io/rpc',
  block: 510058182,
  pool: '0xFA7093CDD9EE6932B4eb2c9e1cde7CE00B1FA4b9',
  token: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
};

async function startChain(fork?: ForkConfig) {
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert(address && typeof address !== 'string');
      server.close(() => resolve(address.port));
    });
  });
  const args = ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--silent'];
  if (fork) args.push('--fork-url', fork.rpc, '--fork-block-number', String(fork.block),
    '--no-storage-caching');
  const child = spawn('anvil', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let failure: Error | undefined;
  let stderr = '';
  child.on('error', (error) => { failure = error; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, 31337,
    { staticNetwork: true, cacheTimeout: -1, pollingInterval: 50 });
  for (let i = 0; i < 600; i++) {
    if (failure || child.exitCode !== null) {
      provider.destroy();
      throw failure ?? new Error(`Anvil failed: ${stderr}`);
    }
    try {
      await provider.send('eth_chainId', []);
      return { provider, close: async () => {
        provider.destroy();
        if (child.exitCode === null) {
          const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
          child.kill('SIGTERM');
          await exited;
        }
      } };
    } catch { await delay(50); }
  }
  provider.destroy();
  child.kill('SIGTERM');
  throw new Error('Local Anvil did not start.');
}

function linkBytecode(artifact: ContractArtifact, libraries: Record<string, string>) {
  let bytecode = artifact.evm.bytecode.object;
  for (const [file, names] of Object.entries(artifact.evm.bytecode.linkReferences)) {
    for (const [name, references] of Object.entries(names)) {
      const address = libraries[`${file}:${name}`];
      assert(address, `Missing library: ${name}`);
      for (const { start, length } of references) {
        assert.equal(length, 20);
        bytecode = bytecode.slice(0, start * 2) + address.slice(2) + bytecode.slice((start + length) * 2);
      }
    }
  }
  return `0x${bytecode}`;
}

export async function createEnvironment(
  contracts: CompiledContracts = compile(), fork?: ForkConfig,
): Promise<Environment> {
  const chain = await startChain(fork);
  try {
    const { provider } = chain;
    const [deployer, sender, relayer, recovery, attacker, treasury] = await Promise.all(
      Array.from({ length: 6 }, (_, index) => provider.getSigner(index)),
    );
    const libraries: Record<string, string> = {};
    for (const inputs of fork ? [] : [2, 3]) {
      // Match upstream's Hardhat override: real generated Poseidon, never the Solidity stubs.
      const factory = new ContractFactory(poseidonContract.generateABI(inputs),
        poseidonContract.createCode(inputs), deployer);
      const library = await factory.deploy();
      await library.waitForDeployment();
      libraries[`${poseidonSource}:PoseidonT${inputs + 1}`] = await library.getAddress();
    }
    async function deploy(source: string, name: string, args: unknown[] = []) {
      const artifact = contracts[source][name];
      const factory = new ContractFactory(artifact.abi, linkBytecode(artifact, libraries), deployer);
      const contract = await factory.deploy(...args);
      await contract.waitForDeployment();
      return contract;
    }
    // ethers builds methods from runtime ABIs; type assertions stay at this boundary.
    let pool: RailgunSmartWallet;
    let token: TokenContract;
    if (fork) {
      assert.notEqual(await provider.getCode(fork.pool), '0x', 'Fork must contain the RAILGUN deployment');
      assert.notEqual(await provider.getCode(fork.token), '0x', 'Fork must contain WETH');
      pool = new Contract(fork.pool, contracts[railgunSource].RailgunSmartWallet.abi, deployer) as
        unknown as RailgunSmartWallet;
      token = new Contract(fork.token, [
        ...contracts['contracts/DemoToken.sol'].DemoToken.abi,
        'function deposit() payable',
      ], deployer) as unknown as TokenContract;
      assert.equal(await token.symbol(), 'WETH');
    } else {
      pool = await deploy(railgunSource, 'RailgunSmartWallet') as unknown as RailgunSmartWallet;
      await (await pool.initializeRailgunLogic(await treasury.getAddress(), 25, 25, 0,
        await deployer.getAddress())).wait();
      token = await deploy('contracts/DemoToken.sol', 'DemoToken') as TokenContract;
    }
    const factory = await deploy('contracts/DepositFactory.sol', 'DepositFactory',
      [await pool.getAddress()]) as DepositFactory;
    const forwarderAt = (address: string, signer = relayer) => new Contract(address,
      contracts['contracts/DepositFactory.sol'].DepositForwarder.abi, signer) as unknown as DepositForwarder;
    return { ...chain, contracts, fork, pool, token, factory, deployer, sender, relayer,
      recovery, attacker, treasury, forwarderAt };
  } catch (error) { await chain.close(); throw error; }
}

export async function createRecipient(): Promise<Recipient> {
  // Fresh ephemeral test identity. No real keys are accepted, persisted, or printed.
  const mnemonic = engine.Mnemonic.generate();
  const nodes = deriveNodes(mnemonic);
  const spending = nodes.spending.getSpendingKeyPair();
  const viewing = await nodes.viewing.getViewingKeyPair();
  const masterPublicKey = WalletNode.getMasterPublicKey(spending.pubkey,
    await nodes.viewing.getNullifyingKey());
  return { address: encodeAddress({ masterPublicKey, viewingPublicKey: viewing.pubkey }),
    masterPublicKey, viewing };
}

export async function prepareDeposit(env: Environment, recipientAddress: string): Promise<PreparedDeposit> {
  // Preparation knows only the PUBLIC 0zk address. It cannot spend for the recipient.
  const { masterPublicKey, viewingPublicKey } = decodeAddress(recipientAddress);
  const random = randomBytes(16).toString('hex');
  const note = new ShieldNoteERC20(masterPublicKey, random, 1n, await env.token.getAddress());
  // Value 1 is only an SDK construction placeholder; the contract reads the live balance.
  const request = await note.serialize(randomBytes(32), viewingPublicKey);
  const salt = hexlify(randomBytes(32));
  const args: DepositArguments = [salt, await env.token.getAddress(), request.preimage.npk,
    request.ciphertext, await env.recovery.getAddress()];
  return { args, address: await env.factory.computeAddress(...args) };
}

export async function fund(env: Environment, address: string, amount: bigint) {
  if (env.fork) await (await env.token.connect(env.sender).deposit({ value: amount })).wait();
  else await (await env.token.mint(await env.sender.getAddress(), amount)).wait();
  const receipt = await (await env.token.connect(env.sender).transfer(address, amount)).wait();
  assert(receipt, 'Funding transaction must be mined');
  return receipt;
}

export async function settle(env: Environment, deposit: PreparedDeposit) {
  env.depositPath = await captureDepositPath(env);
  const receipt = await (await env.factory.connect(env.relayer).deployAndShield(...deposit.args)).wait();
  assert(receipt, 'Shielding transaction must be mined');
  return receipt;
}

export async function captureDepositPath(env: Environment): Promise<DepositPath> {
  const index = await env.pool.nextLeafIndex();
  const nextTree = index === 65536n;
  const insertionIndex = nextTree ? 0n : index;
  const layout = env.contracts[railgunSource].RailgunSmartWallet.storageLayout.storage;
  const filled = layout.find((entry) => entry.label === 'filledSubTrees');
  assert(filled, 'Pinned upstream storage layout must contain filledSubTrees');
  const siblings = await Promise.all(Array.from({ length: 16 }, (_, level) =>
    ((insertionIndex >> BigInt(level)) & 1n) === 1n
      ? env.provider.getStorage(env.pool.target, BigInt(filled.slot) + BigInt(level))
      : env.pool.zeros(level)));
  return { index: insertionIndex, treeNumber: await env.pool.treeNumber() + (nextTree ? 1n : 0n), siblings };
}

export async function decryptDeposit(
  env: Environment, recipient: Recipient, receipt: ContractTransactionReceipt,
) {
  const poolAddress = (await env.pool.getAddress()).toLowerCase();
  const events = receipt.logs.filter((log) => log.address.toLowerCase() === poolAddress)
    .map((log) => { try { return env.pool.interface.parseLog(log); } catch { return null; } });
  const event = events.find((entry) => entry?.name === 'Shield');
  assert(event, 'Real RAILGUN contract must emit Shield');
  const shield = event.args.toObject() as ShieldEvent.OutputObject;
  const preimage = shield.commitments[0];
  const ciphertext = shield.shieldCiphertext[0];
  const key = await getSharedSymmetricKey(recipient.viewing.privateKey, getBytes(ciphertext.shieldKey));
  assert(key, 'Recipient must derive the shared encryption key');
  const random = ShieldNote.decryptRandom([...ciphertext.encryptedBundle], key);
  const reconstructed = new ShieldNoteERC20(recipient.masterPublicKey, random,
    preimage.value, preimage.token.tokenAddress);
  assert.equal(toBeHex(reconstructed.notePublicKey, 32), preimage.npk);
  const commitment = toBeHex(ShieldNote.getShieldNoteHash(reconstructed.notePublicKey,
    reconstructed.tokenHash, preimage.value), 32);
  assert.equal(await env.pool.hashCommitment({ npk: preimage.npk,
    token: { tokenType: preimage.token.tokenType, tokenAddress: preimage.token.tokenAddress,
      tokenSubID: preimage.token.tokenSubID }, value: preimage.value }), commitment);

  // Read-only path capture lets us verify a deposit in an existing forked tree
  // without replaying years of historical logs or modifying pool storage.
  const path = env.depositPath ?? {
    index: 0n, treeNumber: 0n,
    siblings: await Promise.all(Array.from({ length: 16 }, (_, level) => env.pool.zeros(level))),
  };
  assert.equal(shield.startPosition, path.index);
  assert.equal(shield.treeNumber, path.treeNumber);
  let root = commitment;
  for (let level = 0; level < 16; level++) {
    root = ((path.index >> BigInt(level)) & 1n) === 1n
      ? await env.pool.hashLeftRight(path.siblings[level], root)
      : await env.pool.hashLeftRight(root, path.siblings[level]);
  }
  assert.equal(await env.pool.merkleRoot(), root);
  assert.equal(await env.pool.rootHistory(shield.treeNumber, root), true);
  return { commitment, amount: preimage.value, fee: shield.fees[0], root };
}

export function saveReport(report: Record<string, unknown>) {
  mkdirSync(`${root}artifacts`, { recursive: true });
  writeFileSync(`${root}artifacts/demo-result.json`, JSON.stringify({
    upstreamCommit, ...report,
  }, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
}
