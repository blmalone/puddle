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
import engine from '@railgun-community/engine';
import { ensureUpstream, root, upstream, upstreamCommit } from './setup.mjs';

// The engine pins these internal helpers; they aren't exported at package root.
const require = createRequire(import.meta.url);
const engineDist = dirname(require.resolve('@railgun-community/engine'));
const { deriveNodes, WalletNode } = require(join(engineDist, 'key-derivation/wallet-node.js'));
const { encodeAddress, decodeAddress } = require(join(engineDist, 'key-derivation/bech32.js'));
const { getSharedSymmetricKey } = require(join(engineDist, 'utils/keys-utils.js'));
const { ShieldNote, ShieldNoteERC20 } = engine;
const railgunSource = 'railgun/contracts/logic/RailgunSmartWallet.sol';
const poseidonSource = 'railgun/contracts/logic/Poseidon.sol';

export function compile() {
  ensureUpstream();
  const sources = {};
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
  const output = JSON.parse(solc.compile(JSON.stringify(input), {
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
  return output.contracts;
}

export const FORK = {
  rpc: 'https://arb1.arbitrum.io/rpc',
  block: 510058182,
  pool: '0xFA7093CDD9EE6932B4eb2c9e1cde7CE00B1FA4b9',
  token: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
};

async function startChain(fork) {
  const port = await new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
  const args = ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--silent'];
  if (fork) args.push('--fork-url', fork.rpc, '--fork-block-number', String(fork.block),
    '--no-storage-caching');
  const child = spawn('anvil', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let failure;
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
          const exited = new Promise((resolve) => child.once('exit', resolve));
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

function linkBytecode(artifact, libraries) {
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

export async function createEnvironment(contracts = compile(), fork) {
  const chain = await startChain(fork);
  try {
    const { provider } = chain;
    const [deployer, sender, relayer, recovery, attacker, treasury] = await Promise.all(
      Array.from({ length: 6 }, (_, index) => provider.getSigner(index)),
    );
    const libraries = {};
    for (const inputs of fork ? [] : [2, 3]) {
      // Match upstream's Hardhat override: real generated Poseidon, never the Solidity stubs.
      const factory = new ContractFactory(poseidonContract.generateABI(inputs),
        poseidonContract.createCode(inputs), deployer);
      const library = await factory.deploy();
      await library.waitForDeployment();
      libraries[`${poseidonSource}:PoseidonT${inputs + 1}`] = await library.getAddress();
    }
    async function deploy(source, name, args = []) {
      const artifact = contracts[source][name];
      const factory = new ContractFactory(artifact.abi, linkBytecode(artifact, libraries), deployer);
      const contract = await factory.deploy(...args);
      await contract.waitForDeployment();
      return contract;
    }
    let pool;
    let token;
    if (fork) {
      assert.notEqual(await provider.getCode(fork.pool), '0x', 'Fork must contain the RAILGUN deployment');
      assert.notEqual(await provider.getCode(fork.token), '0x', 'Fork must contain WETH');
      pool = new Contract(fork.pool, contracts[railgunSource].RailgunSmartWallet.abi, deployer);
      token = new Contract(fork.token, [
        ...contracts['contracts/DemoToken.sol'].DemoToken.abi,
        'function deposit() payable',
      ], deployer);
      assert.equal(await token.symbol(), 'WETH');
    } else {
      pool = await deploy(railgunSource, 'RailgunSmartWallet');
      await (await pool.initializeRailgunLogic(await treasury.getAddress(), 25, 25, 0,
        await deployer.getAddress())).wait();
      token = await deploy('contracts/DemoToken.sol', 'DemoToken');
    }
    const factory = await deploy('contracts/DepositFactory.sol', 'DepositFactory', [await pool.getAddress()]);
    const forwarderAt = (address, signer = relayer) => new Contract(address,
      contracts['contracts/DepositFactory.sol'].DepositForwarder.abi, signer);
    return { ...chain, contracts, fork, pool, token, factory, deployer, sender, relayer,
      recovery, attacker, treasury, forwarderAt };
  } catch (error) { await chain.close(); throw error; }
}

export async function createRecipient() {
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

export async function prepareDeposit(env, recipientAddress) {
  // Preparation knows only the PUBLIC 0zk address. It cannot spend for the recipient.
  const { masterPublicKey, viewingPublicKey } = decodeAddress(recipientAddress);
  const random = randomBytes(16).toString('hex');
  const note = new ShieldNoteERC20(masterPublicKey, random, 1n, await env.token.getAddress());
  // Value 1 is only an SDK construction placeholder; the contract reads the live balance.
  const request = await note.serialize(randomBytes(32), viewingPublicKey);
  const salt = hexlify(randomBytes(32));
  const args = [salt, await env.token.getAddress(), request.preimage.npk,
    request.ciphertext, await env.recovery.getAddress()];
  return { args, address: await env.factory.computeAddress(...args) };
}

export async function fund(env, address, amount) {
  if (env.fork) await (await env.token.connect(env.sender).deposit({ value: amount })).wait();
  else await (await env.token.mint(await env.sender.getAddress(), amount)).wait();
  return (await env.token.connect(env.sender).transfer(address, amount)).wait();
}

export async function settle(env, deposit) {
  env.depositPath = await captureDepositPath(env);
  return (await env.factory.connect(env.relayer).deployAndShield(...deposit.args)).wait();
}

export async function captureDepositPath(env) {
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

export async function decryptDeposit(env, recipient, receipt) {
  const events = receipt.logs.filter((log) => log.address.toLowerCase() === env.pool.target.toLowerCase())
    .map((log) => { try { return env.pool.interface.parseLog(log); } catch { return null; } });
  const event = events.find((entry) => entry?.name === 'Shield');
  assert(event, 'Real RAILGUN contract must emit Shield');
  const preimage = event.args.commitments[0];
  const ciphertext = event.args.shieldCiphertext[0];
  const key = await getSharedSymmetricKey(recipient.viewing.privateKey, getBytes(ciphertext.shieldKey));
  assert(key, 'Recipient must derive the shared encryption key');
  const random = ShieldNote.decryptRandom([...ciphertext.encryptedBundle], key);
  const reconstructed = new ShieldNoteERC20(recipient.masterPublicKey, random,
    preimage.value, preimage.token.tokenAddress);
  assert.equal(toBeHex(reconstructed.notePublicKey, 32), preimage.npk);
  const commitment = toBeHex(ShieldNote.getShieldNoteHash(reconstructed.notePublicKey,
    reconstructed.tokenHash, preimage.value), 32);
  assert.equal(await env.pool.hashCommitment({ npk: preimage.npk,
    token: [...preimage.token], value: preimage.value }), commitment);

  // Read-only path capture lets us verify a deposit in an existing forked tree
  // without replaying years of historical logs or modifying pool storage.
  const path = env.depositPath ?? {
    index: 0n, treeNumber: 0n,
    siblings: await Promise.all(Array.from({ length: 16 }, (_, level) => env.pool.zeros(level))),
  };
  assert.equal(event.args.startPosition, path.index);
  assert.equal(event.args.treeNumber, path.treeNumber);
  let root = commitment;
  for (let level = 0; level < 16; level++) {
    root = ((path.index >> BigInt(level)) & 1n) === 1n
      ? await env.pool.hashLeftRight(path.siblings[level], root)
      : await env.pool.hashLeftRight(root, path.siblings[level]);
  }
  assert.equal(await env.pool.merkleRoot(), root);
  assert.equal(await env.pool.rootHistory(event.args.treeNumber, root), true);
  return { commitment, amount: preimage.value, fee: event.args.fees[0], root };
}

export function saveReport(report) {
  mkdirSync(`${root}artifacts`, { recursive: true });
  writeFileSync(`${root}artifacts/demo-result.json`, JSON.stringify({
    upstreamCommit, ...report,
  }, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
}
