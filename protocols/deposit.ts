import { Contract, Interface, ZeroAddress, getAddress, hexlify, randomBytes } from 'ethers';
import type { Provider, Signer, TransactionRequest, TransactionResponse } from 'ethers';

export type Protocol = 'railgun' | 'privacy-pools';

export interface Deployment {
  chainId: bigint;
  factory: string;
  pool: string;
}

export interface DepositTerms {
  recovery: string;
  relayer: string;
  feeRecipient: string;
}

export interface DepositConfig extends DepositTerms { recipient: string }
export interface DepositQuote { token: string; amount: bigint; gasFee: bigint; deadline: bigint }
export const configTuple = 'tuple(bytes recipient,address recovery,address relayer,address feeRecipient)';
export const quoteTuple = 'tuple(address token,uint256 amount,uint256 gasFee,uint256 deadline)';
export const factoryABI = new Interface([
  'function pool() view returns (address)',
  'function maxGasFee(address token,uint256 amount) view returns (uint256)',
  'function gasPolicies(address token) view returns (uint120 fixedAllowance,uint16 basisPoints,bool supported)',
  `function computeAddress(bytes32 salt,${configTuple} config) view returns (address)`,
  `function deploy(bytes32 salt,${configTuple} config) returns (address)`,
  `function deployAndExecute(bytes32 salt,${configTuple} config,${quoteTuple} quote,bytes data) returns (address)`,
]);

// Internal records, not a parser for user-supplied JSON or executable recovery files.
export interface DepositRecord<P extends Protocol = Protocol>
  extends Deployment {
  protocol: P;
  address: string;
  salt: string;
  config: DepositConfig;
}

export interface ProtocolDeployment<P extends Protocol = Protocol> {
  protocol: P;
  // Supplied by application configuration, never by an imported deposit record.
  deployment: Readonly<Deployment>;
  factoryABI: Interface;
}

export interface DepositExecution<P extends Protocol = Protocol> extends DepositRecord<P> {
  quote: DepositQuote;
  data: string;
}
export interface DepositAdapter<P extends Protocol = Protocol> extends ProtocolDeployment<P> {
  validateExecution(deposit: DepositExecution<P>, provider: Provider): Promise<void>;
  relayData(deposit: DepositExecution<P>): string;
}

export function createDepositAdapter<P extends Protocol>(protocol: P, deployment: Deployment) {
  const adapter: DepositAdapter<P> = {
    protocol, deployment: Object.freeze({ ...deployment }), factoryABI,
    async validateExecution(deposit, provider) {
      const { quote } = deposit;
      if (quote.amount <= 0n || quote.amount >= (1n << 120n) || quote.gasFee < 0n
        || quote.gasFee >= quote.amount - quote.amount / 1_000n || quote.deadline < 0n
        || quote.deadline >= (1n << 256n)) throw new Error('Invalid deposit amount, gas charge or expiry.');
      const [cap, block] = await Promise.all([
        new Contract(deployment.factory, factoryABI, provider).getFunction('maxGasFee')(quote.token, quote.amount) as Promise<bigint>,
        provider.getBlock('latest'),
      ]);
      if (quote.gasFee > cap) throw new Error('Gas charge exceeds the deposit cap.');
      if (!block || BigInt(block.timestamp) > quote.deadline) throw new Error('Deposit quote has expired.');
    },
    relayData(deposit) {
      return factoryABI.encodeFunctionData('deployAndExecute', [deposit.salt, deposit.config, deposit.quote, deposit.data]);
    },
  };
  return adapter;
}

export async function quoteDeposit<P extends Protocol>(
  adapter: DepositAdapter<P>, provider: Provider, address: DepositRecord<P>, quote: DepositQuote, data = '0x',
): Promise<DepositExecution<P>> {
  await validateDeposit(adapter, address, provider);
  const deposit = { ...address, quote: { ...quote }, data };
  await adapter.validateExecution(deposit, provider);
  return deposit;
}

const tokenABI = ['function balanceOf(address) view returns (uint256)'];
const forwarderABI = new Interface([
  'function spent() view returns (bool)', 'function recover(address)', 'function recoverNative()',
]);
const sameAddress = (a: string, b: string) => getAddress(a) === getAddress(b);

async function checkChain(provider: Provider, chainId: bigint) {
  if ((await provider.getNetwork()).chainId !== chainId) throw new Error('Wrong deposit chain.');
}

export async function prepareRecord<P extends Protocol>(
  adapter: ProtocolDeployment<P>, provider: Provider, config: DepositConfig,
): Promise<DepositRecord<P>> {
  const { protocol, deployment, factoryABI } = adapter;
  await checkChain(provider, deployment.chainId);
  const salt = hexlify(randomBytes(32));
  const factory = new Contract(deployment.factory, factoryABI, provider);
  const address: string = await factory.getFunction('computeAddress')(salt, config);
  const record = { ...deployment, protocol, address, salt, config };
  await validateDeposit(adapter, record, provider);
  return record;
}

export async function validateDeposit<D extends DepositRecord>(
  adapter: ProtocolDeployment<D['protocol']>, deposit: D, provider: Provider,
) {
  const expected = adapter.deployment;
  if (deposit.protocol !== adapter.protocol || deposit.chainId !== expected.chainId
    || !sameAddress(deposit.factory, expected.factory) || !sameAddress(deposit.pool, expected.pool)) {
    throw new Error('Deposit does not match the configured protocol deployment.');
  }
  await checkChain(provider, expected.chainId);
  const factory = new Contract(expected.factory, adapter.factoryABI, provider);
  const [pool, predicted] = await Promise.all([
    factory.getFunction('pool')() as Promise<string>,
    factory.getFunction('computeAddress')(deposit.salt, deposit.config) as Promise<string>,
  ]);
  if (!sameAddress(pool, expected.pool) || !sameAddress(predicted, deposit.address)) {
    throw new Error('Deposit address or pool does not match its fixed terms.');
  }
}

export async function inspectDeposit<P extends Protocol>(
  adapter: DepositAdapter<P>, deposit: DepositExecution<P>, provider: Provider,
) {
  await validateDeposit(adapter, deposit, provider);
  const token = new Contract(deposit.quote.token, tokenABI, provider);
  const [code, balance] = await Promise.all([
    provider.getCode(deposit.address),
    token.getFunction('balanceOf')(deposit.address) as Promise<bigint>,
  ]);
  const deployed = code !== '0x';
  const spent: boolean = deployed
    ? await new Contract(deposit.address, forwarderABI, provider).getFunction('spent')() : false;
  return { deployed, spent, balance, ready: !spent && balance >= deposit.quote.amount };
}

async function signerProvider(signer: Signer, owner: string) {
  if (!sameAddress(await signer.getAddress(), owner)) throw new Error('Wrong wallet for this deposit action.');
  if (!signer.provider) throw new Error('A connected wallet is required.');
  return signer.provider;
}

// Return the submission immediately so a persistent worker can save its hash before waiting.
// Confirmation is not recipient verification or approval for private spending.
export async function relayDeposit<P extends Protocol>(
  adapter: DepositAdapter<P>, deposit: DepositExecution<P>, signer: Signer,
): Promise<TransactionResponse> {
  const provider = await signerProvider(signer, deposit.config.relayer);
  const state = await inspectDeposit(adapter, deposit, provider);
  if (state.spent) throw new Error('Deposit has already been relayed.');
  if (!state.ready) throw new Error('Deposit is not fully funded.');
  await adapter.validateExecution(deposit, provider);
  return signer.sendTransaction({ to: deposit.factory, chainId: deposit.chainId, value: 0n,
    data: adapter.relayData(deposit) });
}

// Call once per step: deploy if needed, then recover. Neither step needs the relayer.
// The independent recovery website additionally verifies pinned contract bytecode.
export async function recoveryTransaction<P extends Protocol>(
  adapter: DepositAdapter<P>, deposit: DepositRecord<P>, provider: Provider, owner: string, asset: string,
): Promise<TransactionRequest> {
  if (!sameAddress(owner, deposit.config.recovery)) throw new Error('Connect the deposit recovery wallet.');
  await validateDeposit(adapter, deposit, provider);
  const deployed = await provider.getCode(deposit.address) !== '0x';
  const data = !deployed ? adapter.factoryABI.encodeFunctionData('deploy', [deposit.salt, deposit.config])
    : sameAddress(asset, ZeroAddress) ? forwarderABI.encodeFunctionData('recoverNative')
      : forwarderABI.encodeFunctionData('recover', [getAddress(asset)]);
  return { from: deposit.config.recovery, to: deployed ? deposit.address : deposit.factory,
    chainId: deposit.chainId, value: 0n, data };
}

export async function mined(transaction: Promise<TransactionResponse>) {
  const receipt = await (await transaction).wait();
  if (!receipt || receipt.status !== 1) throw new Error('Transaction did not succeed.');
  return receipt;
}
