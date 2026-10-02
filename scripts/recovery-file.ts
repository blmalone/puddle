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
    const references = Object.values(factory.evm.deployedBytecode.immutableReferences);
    assert.equal(references.length, 1, 'Review recovery validation after changing factory immutables');
    assert(references[0].length > 0 && references[0].every(reference => reference.length === 32));
    return { forwarderCreationCode: `0x${forwarder.evm.bytecode.object}`,
      factoryRuntimeCode: `0x${factory.evm.deployedBytecode.object}`, poolReferences: references[0] };
  }
  return { railgun: build('Railgun'), 'privacy-pools': build('PrivacyPools') };
}
