import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { AbiCoder, ZeroAddress } from 'ethers';
import type { Provider } from 'ethers';
import engine from '@railgun-community/engine';
import { createDepositAdapter, prepareRecord, quoteDeposit } from './deposit.ts';
import type { Deployment, DepositExecution, DepositQuote, DepositRecord, DepositTerms } from './deposit.ts';

export type RailgunAddress = DepositRecord<'railgun'>;
export type RailgunDeposit = DepositExecution<'railgun'>;
export interface RailgunInput extends DepositTerms { recipient: string }
export const railgunRecipientTypes = ['bytes32', 'tuple(bytes32[3] encryptedBundle,bytes32 shieldKey)'];

const require = createRequire(import.meta.url);
const engineDist = dirname(require.resolve('@railgun-community/engine'));
const { decodeAddress } = require(join(engineDist, 'key-derivation/bech32.js')) as
  typeof import('../node_modules/@railgun-community/engine/dist/key-derivation/bech32.js');

export function createRailgunAdapter(deployment: Deployment) {
  const common = createDepositAdapter('railgun', deployment);
  const adapter = {
    ...common,
    async validateExecution(deposit: RailgunDeposit, provider: Provider) {
      if (deposit.data !== '0x') throw new Error('RAILGUN builds its own deposit instructions.');
      await common.validateExecution(deposit, provider);
    },
    async prepare(provider: Provider, input: RailgunInput): Promise<RailgunAddress> {
      const { masterPublicKey, viewingPublicKey } = decodeAddress(input.recipient);
      // Only recipient data is retained. Token and amount are chosen at execution.
      const note = new engine.ShieldNoteERC20(masterPublicKey, randomBytes(16).toString('hex'), 1n, ZeroAddress);
      const request = await note.serialize(randomBytes(32), viewingPublicKey);
      return prepareRecord(adapter, provider, {
        recipient: AbiCoder.defaultAbiCoder().encode(railgunRecipientTypes, [request.preimage.npk, request.ciphertext]),
        recovery: input.recovery, relayer: input.relayer, feeRecipient: input.feeRecipient,
      });
    },
    quote(provider: Provider, address: RailgunAddress, quote: DepositQuote) {
      return quoteDeposit(adapter, provider, address, quote);
    },
  };
  return adapter;
}
