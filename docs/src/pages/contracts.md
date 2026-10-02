---
showAskAi: false
outline: false
---

# Contracts & security

One factory and one fixed implementation per protocol; each deposit is a single-use
[ERC-1167 clone](https://eips.ethereum.org/EIPS/eip-1167). No Puddle admin
setters or upgrades; the underlying pools have their own governance.

| Contract | Interface |
| --- | --- |
| Factory | `computeAddress`, `deploy`, `deployAndExecute`, `implementation`, `gasPolicies`, `maxGasFee` |
| Deposit | `preview`, `execute`, `recover`, `recoverNative` |

RAILGUN and Privacy Pools share `DepositBase` and `DepositFactory`: permissions,
fee policy, execution, recovery and protection against callbacks entering again.
Protocol adapters only build or validate the pool call. Clones delegate to their
factory's fixed implementation. The factory creates and initializes each clone in
one transaction; initialization cannot run again, including on the implementation.
The salt includes every deposit setting, so changing the recipient or recovery
wallet changes the address. No implementation or deposit setting can be replaced.

## Permissions

Only the deposit's designated relayer can shield, including with a zero gas charge. It cannot change the recipient or exceed the gas cap. Only the recovery wallet can withdraw unshielded funds. Deployment itself is open to anyone.

The address fixes encrypted recipient data, recovery wallet, relayer and fee recipient.
The factory fixes the supported tokens and each token's gas ceiling: a fixed allowance
plus a percentage of the quoted amount. There are no policy setters.

The relayer supplies the token, amount, gas charge and expiry when shielding. Its
transaction authorizes that quote; the user needs no extra signature. Refreshing
the quote does not change the address. The contract checks expiry, funding, fee limits
and that some value remains for shielding. It consumes exactly the quoted amount
once; excess stays recoverable. Fees and shielding succeed or revert together.

Recovery does not cancel an address. Repeated and later transfers remain
recoverable; an unspent address can still shield if funded again. The service may
stop automatic retries after a recovery event, without changing those permissions.

RAILGUN accepts any supported token and amount. Privacy Pools commits a complete
prepared deposit call, including the proof and encrypted recipient data. Its gas
quote and gross amount can change while preserving the token and net pool deposit.
Changing that private deposit requires a new prepared call and address.

## Limits

- Standard ERC-20 tokens only. No native ETH shielding, transfer-tax or rebasing tokens.
- Initial transfers and amounts remain public. Reusing a recovery address links deposits.
- Depositing depends on the relayer and selected pool being available; recovery remains independent of the relayer.

## Verification

The current contracts are **unaudited**. Shared Solidity unit, fuzz and transaction-sequence
tests cover both adapters. Integration tests use real RAILGUN contracts and Privacy
Pools proofs; they cover deposit, recipient discovery and recovery. Privacy Pools
also has local private withdrawal and public exit tests.

Contract changes produce new CREATE2 addresses. Recovery uses one current file
format for both protocols, checked against the tool's own contract build. Old
pre-release formats and mismatched factory code are rejected.

The recipient confirmed wallet receipt in the first Arbitrum mainnet pilot on 29 September 2026. The revised contracts, cross-chain flow, private spending and production Proof-of-Innocence acceptance still need live validation.

Use the GitHub link above to view the source.
