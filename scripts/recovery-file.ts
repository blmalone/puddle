import assert from 'node:assert/strict';
import { hexlify } from 'ethers';
import { parseRecoveryFile, recoveryFormat } from '../recovery/core.ts';
import type { RecoveryArtifacts } from '../recovery/core.ts';
import type { CompiledContracts, PreparedDeposit } from './types.ts';

export function createRecoveryFile(chainId: bigint, factory: string, pool: string, deposit: PreparedDeposit) {
  const [salt, config] = deposit.args;
  return parseRecoveryFile(JSON.stringify({
    format: recoveryFormat, version: 1, chainId: String(chainId), factory, pool,
    depositAddress: deposit.address, salt,
    config: { ...config, notePublicKey: hexlify(config.notePublicKey),
      ciphertext: { encryptedBundle: config.ciphertext.encryptedBundle.map(value => hexlify(value)),
        shieldKey: hexlify(config.ciphertext.shieldKey) },
      minDeposit: String(config.minDeposit), maxGasFee: String(config.maxGasFee) },
  }));
}

export function recoveryArtifacts(contracts: CompiledContracts): RecoveryArtifacts {
  const { DepositFactory: factory, DepositForwarder: forwarder } = contracts['contracts/DepositFactory.sol'];
  assert.deepEqual(factory.evm.bytecode.linkReferences, {});
  assert.deepEqual(forwarder.evm.bytecode.linkReferences, {});
  const references = Object.values(factory.evm.deployedBytecode.immutableReferences);
  // The factory has exactly one immutable: its pool address. Fail closed if this changes.
  assert.equal(references.length, 1, 'Review recovery validation after changing factory immutables');
  assert(references[0].length > 0 && references[0].every(reference => reference.length === 32));
  return {
    forwarderCreationCode: `0x${forwarder.evm.bytecode.object}`,
    factoryRuntimeCode: `0x${factory.evm.deployedBytecode.object}`,
    poolReferences: references[0],
  };
}
