import { Contract, Interface, getAddress, keccak256 } from 'ethers';
import type { Provider } from 'ethers';
import { createDepositAdapter, prepareRecord, quoteDeposit } from './deposit.ts';
import type { Deployment, DepositExecution, DepositQuote, DepositRecord, DepositTerms } from './deposit.ts';

export type PrivacyPoolsAddress = DepositRecord<'privacy-pools'>;
export type PrivacyPoolsDeposit = DepositExecution<'privacy-pools'>;
interface PrivacyPoolsInput extends DepositTerms {
  token: string;
  recipient: `0x${string}`;
  value: bigint;
}
// Structural SDK boundary: installing the PP SDK is only necessary for proof preparation.
interface PreparedPoolDeposit { to: string; callData: string }
interface PoolSession<T extends PreparedPoolDeposit> {
  prepareDepositFor(params: {
    tokenId: `0x${string}`; value: `0x${string}`; discoveryData: { evmAddress: `0x${string}` };
  }): Promise<T>;
}

export function createPrivacyPoolsAdapter(configuration: Deployment, entrypointABI: Interface) {
  const common = createDepositAdapter('privacy-pools', configuration);
  const { deployment } = common;
  const adapter = {
    ...common,
    async validateExecution(deposit: PrivacyPoolsDeposit, provider: Provider) {
      if (keccak256(deposit.data) !== deposit.config.recipient
        || deposit.data.slice(0, 10) !== entrypointABI.getFunction('deposit')!.selector) {
        throw new Error('Deposit instructions do not match the committed call.');
      }
      await common.validateExecution(deposit, provider);
      const call = entrypointABI.decodeFunctionData('deposit', deposit.data);
      const value = BigInt(call[0].pubSignals[2]);
      const { quote } = deposit;
      const asset = await new Contract(deployment.pool, entrypointABI, provider).getFunction('assets')(quote.token);
      const cost = value + value * BigInt(asset.vettingFeeBPS) / 10_000n;
      if (!asset.enabled || value < asset.minAmount || BigInt(call[0].pubSignals[1]) !== BigInt(quote.token)
        || quote.amount - quote.amount / 1_000n - quote.gasFee !== cost) {
        throw new Error('Quote does not match the prepared Privacy Pools deposit.');
      }
    },
    async prepare<T extends PreparedPoolDeposit>(provider: Provider, session: PoolSession<T>, input: PrivacyPoolsInput) {
      const asset = await new Contract(deployment.pool, entrypointABI, provider).getFunction('assets')(input.token);
      if (!asset.enabled || input.value < asset.minAmount) throw new Error('Unsupported asset or deposit amount.');
      const deposit = await session.prepareDepositFor({ tokenId: getAddress(input.token) as `0x${string}`,
        value: `0x${input.value.toString(16)}`, discoveryData: { evmAddress: input.recipient } });
      if (getAddress(deposit.to) !== getAddress(deployment.pool)) throw new Error('Unexpected deposit destination.');
      const call = entrypointABI.decodeFunctionData('deposit', deposit.callData);
      if (BigInt(call[0].pubSignals[1]) !== BigInt(input.token) || BigInt(call[0].pubSignals[2]) !== input.value) {
        throw new Error('Proof does not match the requested token and amount.');
      }
      const record = await prepareRecord(adapter, provider, {
        recipient: keccak256(deposit.callData), recovery: input.recovery,
        relayer: input.relayer, feeRecipient: input.feeRecipient,
      });
      return { record, deposit };
    },
    quote(provider: Provider, address: PrivacyPoolsAddress, quote: DepositQuote, data: string) {
      return quoteDeposit(adapter, provider, address, quote, data);
    },
  };
  return adapter;
}
