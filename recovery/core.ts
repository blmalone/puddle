import { AbiCoder, Contract, Interface, ZeroAddress, concat, getAddress, getCreate2Address,
  keccak256, zeroPadValue } from 'ethers';
import type { Provider, TransactionRequest } from 'ethers';

export const recoveryFormat = 'private-deposit-recovery';
export const maxRecoveryFileBytes = 16_384;
const configTuple = 'tuple(bytes recipient,address recovery,address relayer,address feeRecipient)';
const forwarderABI = new Interface([
  'function recover(address asset)', 'function recoverNative()', 'function recovery() view returns (address)',
]);

// Independent of product names. Never put keys, arbitrary calldata or RPC URLs in this file.
export interface RecoveryFile {
  format: typeof recoveryFormat;
  version: 1;
  protocol: 'railgun' | 'privacy-pools';
  chainId: string;
  factory: string;
  pool: string;
  depositAddress: string;
  salt: string;
  asset: string; // Initial selection only; never part of CREATE2 derivation.
  config: { recipient: string; recovery: string; relayer: string; feeRecipient: string };
}

// Supplied by this tool's build, NEVER by an imported recovery file.
export interface RecoveryBuild {
  forwarderCreationCode: string;
  factoryRuntimeCode: string;
  poolReferences: { start: number; length: number }[];
}
export type RecoveryArtifacts = Record<RecoveryFile['protocol'], RecoveryBuild>;
export const recoveryAsset = (file: RecoveryFile) => file.asset;

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) throw new Error('Invalid recovery file fields.');
  return value as Record<string, unknown>;
}

function address(value: unknown, allowZero = false): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error('Invalid address in recovery file.');
  const result = getAddress(value);
  if (!allowZero && result === ZeroAddress) throw new Error('Recovery file contains a zero address.');
  return result;
}

function bytes32(value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('Invalid deposit data.');
  return value.toLowerCase();
}

function uint(value: unknown, bits = 256): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value)
    || BigInt(value) >= 2n ** BigInt(bits)) throw new Error('Invalid number in recovery file.');
  return value;
}

export function parseRecoveryFile(text: string): RecoveryFile {
  if (new TextEncoder().encode(text).length > maxRecoveryFileBytes) throw new Error('Recovery file is too large.');
  let input: unknown;
  try { input = JSON.parse(text); } catch { throw new Error('Choose a valid JSON recovery file.'); }
  const file = object(input, ['format', 'version', 'protocol', 'chainId', 'factory', 'pool',
    'depositAddress', 'salt', 'asset', 'config']);
  if (file.format !== recoveryFormat || file.version !== 1
    || (file.protocol !== 'railgun' && file.protocol !== 'privacy-pools')) throw new Error('Unsupported recovery format.');
  const config = object(file.config, ['recipient', 'recovery', 'relayer', 'feeRecipient']);
  const recipientBytes = file.protocol === 'railgun' ? 160 : 32;
  if (typeof config.recipient !== 'string'
    || !new RegExp(`^0x[0-9a-fA-F]{${recipientBytes * 2}}$`).test(config.recipient)) {
    throw new Error('Invalid recipient instructions.');
  }
  if (file.protocol === 'privacy-pools' && BigInt(config.recipient) === 0n) throw new Error('Invalid deposit commitment.');
  const result: RecoveryFile = {
    format: recoveryFormat, version: 1, protocol: file.protocol, chainId: uint(file.chainId),
    factory: address(file.factory), pool: address(file.pool), depositAddress: address(file.depositAddress),
    salt: bytes32(file.salt), asset: address(file.asset, true),
    config: { recipient: config.recipient.toLowerCase(), recovery: address(config.recovery),
      relayer: address(config.relayer), feeRecipient: address(config.feeRecipient) },
  };
  if (result.chainId === '0' || result.config.recovery === result.depositAddress
    || result.config.feeRecipient === result.depositAddress) throw new Error('Invalid deposit configuration.');
  return result;
}

export function predictRecoveryAddress(file: RecoveryFile, artifacts: RecoveryArtifacts): string {
  const constructor = AbiCoder.defaultAbiCoder().encode(['address', configTuple], [file.pool, file.config]);
  return getCreate2Address(file.factory, file.salt, keccak256(concat([artifacts[file.protocol].forwarderCreationCode, constructor])));
}

export function checkRecoveryAddress(file: RecoveryFile, artifacts: RecoveryArtifacts) {
  if (predictRecoveryAddress(file, artifacts) !== file.depositAddress) {
    throw new Error('The deposit address does not match this file and contract version.');
  }
}

function factoryCode(file: RecoveryFile, artifacts: RecoveryBuild): string {
  let code = artifacts.factoryRuntimeCode.slice(2);
  const pool = zeroPadValue(file.pool, 32).slice(2).toLowerCase();
  for (const { start, length } of artifacts.poolReferences) {
    if (length !== 32) throw new Error('Unsupported factory build.');
    code = code.slice(0, start * 2) + pool + code.slice((start + length) * 2);
  }
  return `0x${code}`;
}

export interface RecoveryStatus {
  deployed: boolean;
  balance: bigint;
  decimals: number;
  symbol: string;
}

export async function inspectRecovery(
  provider: Provider, file: RecoveryFile, artifacts: RecoveryArtifacts, asset = recoveryAsset(file),
): Promise<RecoveryStatus> {
  checkRecoveryAddress(file, artifacts);
  if ((await provider.getNetwork()).chainId !== BigInt(file.chainId)) {
    throw new Error(`Switch your wallet to chain ${file.chainId}, then check again.`);
  }
  const [factory, deposit] = await Promise.all([
    provider.getCode(file.factory), provider.getCode(file.depositAddress),
  ]);
  if (factory.toLowerCase() !== factoryCode(file, artifacts[file.protocol]).toLowerCase()) {
    throw new Error('The factory is missing or does not match this tool’s contract build.');
  }
  // Matching factory code + locally calculated CREATE2 address binds the forwarder code
  // and constructor arguments. Do not trust a file-supplied code hash or factory reply.
  const deployed = deposit !== '0x';
  if (deployed) {
    const forwarder = new Contract(file.depositAddress, forwarderABI, provider);
    if (getAddress(await forwarder.getFunction('recovery').staticCall()) !== file.config.recovery) {
      throw new Error('The deployed recovery owner does not match.');
    }
  }
  if (asset === ZeroAddress) {
    return { deployed, balance: await provider.getBalance(file.depositAddress), decimals: 18, symbol: 'native token' };
  }
  asset = address(asset);
  if (await provider.getCode(asset) === '0x') throw new Error('No token contract at this address.');
  const token = new Contract(asset, [
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)', 'function symbol() view returns (string)',
  ], provider);
  const balance: bigint = await token.getFunction('balanceOf').staticCall(file.depositAddress);
  // Metadata is optional and untrusted. Display text only; fall back to raw base units.
  let decimals = 0;
  let symbol = 'base units';
  try {
    decimals = Number(await token.getFunction('decimals').staticCall());
    symbol = 'tokens';
    try { symbol = String(await token.getFunction('symbol').staticCall()).slice(0, 32); } catch { /* Optional. */ }
  } catch { /* Non-standard metadata must not prevent recovery. */ }
  return { deployed, balance, decimals, symbol };
}

export async function recoveryTransaction(
  provider: Provider, file: RecoveryFile, artifacts: RecoveryArtifacts, account: string,
  asset: string, action: 'deploy' | 'recover',
): Promise<TransactionRequest> {
  if (getAddress(account) !== file.config.recovery) throw new Error('Connect the recovery wallet shown in the file.');
  const status = await inspectRecovery(provider, file, artifacts, asset);
  if (status.balance === 0n) throw new Error('There are no funds of this asset to recover.');
  if (action === 'deploy' && status.deployed) throw new Error('Already deployed. Check the balance again.');
  if (action === 'recover' && !status.deployed) throw new Error('Deploy the recovery contract first.');
  const factoryABI = new Interface([`function deploy(bytes32 salt,${configTuple} config) returns (address)`]);
  const data = action === 'deploy'
    ? factoryABI.encodeFunctionData('deploy', [file.salt, file.config])
    : asset === ZeroAddress ? forwarderABI.encodeFunctionData('recoverNative')
      : forwarderABI.encodeFunctionData('recover', [address(asset)]);
  return {
    from: file.config.recovery, to: action === 'deploy' ? file.factory : file.depositAddress,
    data, value: 0n, chainId: BigInt(file.chainId),
  };
}
