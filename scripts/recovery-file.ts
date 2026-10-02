import assert from 'node:assert/strict';
import { ZeroAddress } from 'ethers';
import { parseRecoveryFile, recoveryFormat } from '../recovery/core.ts';
import type { RecoveryArtifacts, RecoveryBuild } from '../recovery/core.ts';
import type { DepositRecord } from '../protocols/deposit.ts';
import type { CompiledContracts } from './types.ts';

export function createRecoveryFile(deposit: DepositRecord, asset = ZeroAddress) {
  const { protocol, chainId, factory, pool, salt, config } = deposit;
  return parseRecoveryFile(JSON.stringify({
    format: recoveryFormat, version: 1, protocol, asset, chainId: String(chainId), factory, pool,
    depositAddress: deposit.address, salt, config,
  }));
}

export function recoveryArtifacts(contracts: CompiledContracts): RecoveryArtifacts {
  function build(protocol: 'Railgun' | 'PrivacyPools'): RecoveryBuild {
    const source = contracts[`contracts/protocols/${protocol}Deposit.sol`];
    const factory = source[`${protocol}DepositFactory`];
    const forwarder = source[`${protocol}Deposit`];
    assert.deepEqual(factory.evm.bytecode.linkReferences, {});
    assert.deepEqual(forwarder.evm.bytecode.linkReferences, {});
    function runtime(artifact: typeof factory, names: string[]) {
      const references = artifact.evm.deployedBytecode.immutableReferences;
      assert.deepEqual(Object.keys(references).sort(), names.sort(), 'Review recovery validation after changing immutables');
      assert(Object.values(references).every(refs => refs.length > 0 && refs.every(ref => ref.length === 32)));
      return { code: `0x${artifact.evm.deployedBytecode.object}`, references };
    }
    return { implementationCreationCode: `0x${forwarder.evm.bytecode.object}`,
      factory: runtime(factory, ['pool', 'implementation']),
      implementation: runtime(forwarder, ['factory', 'pool']) };
  }
  return { railgun: build('Railgun'), 'privacy-pools': build('PrivacyPools') };
}
