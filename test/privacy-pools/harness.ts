import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { Contract, ContractFactory, JsonRpcProvider, id } from 'ethers';
import type { InterfaceAbi, JsonRpcSigner } from 'ethers';
import solc from 'solc';
import { artifacts, root, upstream } from './setup.ts';
import {
  CryptoService, MerkleService, PoolSessionBuilder, PoseidonHashService, ViemRPCInteractor,
} from '../../.cache/privacy-pools-v2/packages/sdk/dist/index.js';
import type {
  Address, Hex, IASPDataProvider, IRelayerInteractor, ProtocolKeys,
} from '../../.cache/privacy-pools-v2/packages/sdk/dist/index.js';
import { mined } from '../../protocols/deposit.ts';
import { createPrivacyPoolsAdapter } from '../../protocols/privacy-pools.ts';
import { compile as compilePuddle } from '../../scripts/harness.ts';
export { mined } from '../../protocols/deposit.ts';

type Artifact = { abi: InterfaceAbi; evm: { bytecode: { object: string;
  linkReferences: Record<string, Record<string, { start: number; length: number }[]>> } } };
type Compiled = Record<string, Record<string, Artifact>>;
export const hex = (value: bigint | number) => `0x${BigInt(value).toString(16)}` as Hex;
export const addressOf = async (contract: { getAddress(): Promise<string> }) => await contract.getAddress() as Address;

export function compile(): Compiled {
  const load = (name: string) => {
    if (name === 'contracts/DepositBase.sol' || name === 'test/contracts/RecoveryReceiver.sol') {
      return readFileSync(`${root}${name}`, 'utf8');
    }
    if (name.startsWith('verifiers/')) return readFileSync(`${artifacts}/${name.slice(10)}`, 'utf8');
    if (name.startsWith('@lean-imt/') || name.startsWith('lean-imt/')) {
      return readFileSync(`${upstream}/packages/contracts/lib/lean-imt/${name.split('/').slice(1).join('/')}`, 'utf8');
    }
    const file = /^(contracts|interfaces|abstracts|libraries|utils|src)\//.test(name)
      ? `${upstream}/packages/contracts/${name.startsWith('src/') ? '' : 'src/'}${name}`
      : `${upstream}/packages/contracts/node_modules/${name}`;
    return readFileSync(file, 'utf8');
  };
  const names = [...['AccessRouter', 'Keystore', 'ASPRegistry', 'PoolVault', 'Entrypoint']
    .map(name => `contracts/${name}.sol`), '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol',
    'verifiers/transact_1x1/groth16_verifier.sol'];
  const sources = Object.fromEntries(names.map(name => [name, { content: load(name) }]));
  sources['TestToken.sol'] = { content: `// SPDX-License-Identifier: MIT
    pragma solidity 0.8.32;
    import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
    contract TestToken is ERC20 {
      constructor() ERC20("Test USDC", "USDC") {}
      function decimals() public pure override returns (uint8) { return 6; }
      function mint(address to, uint256 value) external { _mint(to, value); }
    }` };
  const output = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources,
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'prague',
      remappings: ['@lean-imt/=lean-imt/'],
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode'] } } },
  }), { import: name => { try { return { contents: load(name) }; }
    catch { return { error: `Missing import: ${name}` }; } } })) as {
      errors?: { severity: string; formattedMessage: string }[]; contracts: Compiled;
    };
  const errors = output.errors?.filter(e => e.severity === 'error') ?? [];
  assert.equal(errors.length, 0, errors.map(e => e.formattedMessage).join('\n'));
  return { ...output.contracts, ...compilePuddle(true) };
}

async function startChain() {
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert(address && typeof address !== 'string');
      server.close(() => resolve(address.port));
    });
  });
  const url = `http://127.0.0.1:${port}`;
  const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--silent'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  let failure: Error | undefined;
  let stderr = '';
  child.on('error', error => { failure = error; });
  child.stderr.on('data', data => { stderr += data; });
  const provider = new JsonRpcProvider(url, 31337, { staticNetwork: true, cacheTimeout: -1, pollingInterval: 50 });
  const close = async () => {
    provider.destroy();
    if (child.exitCode === null && !failure) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await exited;
    }
  };
  for (let n = 0; n < 200; n++) {
    if (failure || child.exitCode !== null) { await close(); throw failure ?? new Error(stderr); }
    try { await provider.send('eth_chainId', []); return { provider, url, close }; }
    catch { await delay(50); }
  }
  await close();
  throw new Error('Local Anvil did not start');
}

export async function environment(contracts: Compiled) {
  const chain = await startChain();
  try {
    const { provider } = chain;
    const [admin, sender, relayer, recipient, fees, attacker] = await Promise.all(
      Array.from({ length: 6 }, (_, i) => provider.getSigner(i)));
    const libraries = new Map<string, string>();
    async function deploy(file: string, name: string, args: unknown[] = []): Promise<Contract> {
      const artifact = contracts[file][name];
      let code = artifact.evm.bytecode.object;
      // Use the upstream dependency's deployable Poseidon bytecode. Compiling
      // this hand-written hash assembly via IR inflates it beyond EIP-170.
      if (file.startsWith('poseidon-solidity/')) {
        const require = createRequire(import.meta.url);
        const deployment = require(`${upstream}/packages/contracts/node_modules/poseidon-solidity/deploy/${name}.js`) as { bytecode: string };
        code = deployment.bytecode.replace(/^0x/, '');
      }
      for (const [source, names] of Object.entries(artifact.evm.bytecode.linkReferences)) {
        for (const [library, refs] of Object.entries(names)) {
          const key = `${source}:${library}`;
          if (!libraries.has(key)) libraries.set(key, await (await deploy(source, library)).getAddress());
          for (const ref of refs) {
            assert.equal(ref.length, 20);
            code = code.slice(0, ref.start * 2) + libraries.get(key)!.slice(2) + code.slice((ref.start + 20) * 2);
          }
        }
      }
      const instance = await new ContractFactory(artifact.abi, `0x${code}`, admin).deploy(...args);
      await instance.waitForDeployment();
      return new Contract(await instance.getAddress(), artifact.abi, admin);
    }
    const a = await admin.getAddress();
    const access = await deploy('contracts/AccessRouter.sol', 'AccessRouter', [a, a, [], a, [a], [a], a, a]);
    async function proxy(name: string, args: unknown[]) {
      const implementation = await deploy(`contracts/${name}.sol`, name, [await access.getAddress()]);
      const proxy = await deploy('@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol', 'ERC1967Proxy',
        [await implementation.getAddress(), implementation.interface.encodeFunctionData('initialize', args)]);
      return new Contract(await proxy.getAddress(), implementation.interface, admin);
    }
    const keystore = await proxy('Keystore', [1200, 2 ** 18]);
    const registry = await proxy('ASPRegistry', []);
    const depositVerifier = await deploy('verifiers/deposit/groth16_verifier.sol', 'Groth16Verifier');
    const ragequitVerifier = await deploy('verifiers/ragequit/groth16_verifier.sol', 'Groth16Verifier');
    const transactVerifier = await deploy('verifiers/transact_1x1/groth16_verifier.sol', 'Groth16Verifier');
    const selector = transactVerifier.interface.getFunction('verifyProof')!.selector;
    const pool = await proxy('PoolVault', [16, [[1, 1, [await transactVerifier.getAddress(), selector]]],
      await registry.getAddress(), await keystore.getAddress(), await ragequitVerifier.getAddress(),
      await depositVerifier.getAddress(), 2 ** 22]);
    const entrypoint = await proxy('Entrypoint', [await pool.getAddress()]);
    await mined(access.getFunction('grantRole')(id('DEPOSITOR_ROLE'), await entrypoint.getAddress()));
    const token = await deploy('TestToken.sol', 'TestToken');
    const vettingFeeBPS = 25n;
    await mined(entrypoint.getFunction('setAssetConfiguration')(await token.getAddress(), [true, 1n, vettingFeeBPS, 0n]));
    const factory = await deploy('contracts/protocols/PrivacyPoolsDeposit.sol', 'PrivacyPoolsDepositFactory',
      [await entrypoint.getAddress(), [{ token: await token.getAddress(), maxGasFee: 2_000_000n, maxGasFeeBps: 50 }]]);
    const recoveryReceiver = await deploy('test/contracts/RecoveryReceiver.sol', 'RecoveryReceiver');
    const hashService = await PoseidonHashService.create();
    const merkle = new MerkleService({ hashService });
    const crypto = new CryptoService();
    const aspKeys = crypto.generateEphemeralKeyPair();
    const approved: Hex[] = [];
    let aspOnline = true;
    const offline = async (): Promise<never> => { throw new Error('No external service available in this test'); };
    const asp: IASPDataProvider = {
      getRoot: async () => { if (!aspOnline) return offline(); return hex(await registry.getFunction('latestASPRoot')()); },
      getLeaves: async () => { if (!aspOnline) return offline(); return approved; },
      getRejectedLabels: async () => { if (!aspOnline) return offline(); return []; },
      getLabelStatus: async hash => {
        if (!aspOnline) return offline();
        return { status: approved.some(value => BigInt(value) === BigInt(hash)) ? 'approved' : 'pending' };
      },
      getASPPublicKey: async () => { if (!aspOnline) return offline(); return aspKeys.publicKey; },
      // Force the SDK to discover actual chain events, not fabricated server results.
      getEventSnapshot: offline,
      getNoteEvents: offline,
    };
    const noRelayers: IRelayerInteractor = { getRelayers: async () => [], getTransferQuote: offline,
      getWithdrawalQuote: offline, relayTransfer: offline, relayWithdrawal: offline };
    function keys(): ProtocolKeys {
      const viewing = crypto.generateEphemeralKeyPair();
      return { privateNullifyingKey: crypto.generateSecret(), privateRevocableKey: crypto.generateSecret(),
        revocableKeyIndex: '0x0', viewingPrivateKey: viewing.privateKey, viewingPublicKey: viewing.publicKey };
    }
    async function session(signer: JsonRpcSigner, protocolKeys = keys()) {
      const rpc = ViemRPCInteractor.create({ rpcUrl: chain.url });
      // Anvil mines faster than viem's block-number cache expires. Read the
      // real head for every SDK sync so tests never depend on a sleep.
      rpc.getBlockNumber = async () => await provider.send('eth_blockNumber', []) as Hex;
      return PoolSessionBuilder.fromConfig({ chainId: 31337, rpcUrl: chain.url,
        ownerAddress: await addressOf(signer), protocolKeys, circuitArtifactsDir: artifacts,
        persistentStorage: { type: 'memory' }, aspPublicKey: aspKeys.publicKey,
        deployment: { poolAddress: await addressOf(pool), entrypointAddress: await addressOf(entrypoint),
          keystoreAddress: await addressOf(keystore), aspRegistryAddress: await addressOf(registry) },
        walletInteractor: { type: 'EIP1193', provider: { request: async ({ method, params }) => {
          if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [await signer.getAddress()];
          return provider.send(method, (params ?? []) as unknown[]);
        } } },
      }).withRpcInteractor(rpc).withAspDataProvider(asp).withRelayerInteractor(noRelayers).create();
    }
    async function approve(label: Hex) {
      approved.push(hashService.hash([label]));
      await mined(registry.getFunction('updateASPRoot')(await merkle.computeRoot(approved), '0x01'));
    }
    const forwarder = (address: string, signer = relayer) => new Contract(address,
      contracts['contracts/protocols/PrivacyPoolsDeposit.sol'].PrivacyPoolsDeposit.abi, signer);
    const adapter = createPrivacyPoolsAdapter({ chainId: (await provider.getNetwork()).chainId,
      factory: await factory.getAddress(), pool: await entrypoint.getAddress() }, entrypoint.interface);
    return { ...chain, admin, sender, relayer, recipient, fees, attacker, token, pool, entrypoint, registry,
      keystore, factory, adapter, recoveryReceiver, session, approve, keys, forwarder, vettingFeeBPS, crypto, hashService,
      goOffline: () => { aspOnline = false; } };
  } catch (error) { await chain.close(); throw error; }
}

export type Environment = Awaited<ReturnType<typeof environment>>;

export async function prepare(env: Environment, recipient: Address, value = 100_000_000n, gasFee = 250_000n) {
  // No recipient spending keys enter preparation. The SDK fetches their public viewing key.
  const preparer = await env.session(env.relayer);
  const { record, deposit } = await env.adapter.prepare(env.provider, preparer, {
    token: await env.token.getAddress(), value, recipient, recovery: recipient,
    relayer: await env.relayer.getAddress(), feeRecipient: await env.fees.getAddress(),
  });
  const block = await env.provider.getBlock('latest');
  assert(block);
  const cost = value + value * env.vettingFeeBPS / 10_000n;
  const execution = await env.adapter.quote(env.provider, record, {
    token: await env.token.getAddress(), amount: (cost + gasFee) * 1000n / 999n,
    gasFee, deadline: BigInt(block.timestamp + 3600),
  }, deposit.callData);
  return { ...execution, deposit, value };
}
