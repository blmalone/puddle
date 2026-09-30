---
showAskAi: false
outline: false
---

# Contracts & security

Two fixed contracts. No admin setters or upgrades.

| Contract | Interface |
| --- | --- |
| `DepositFactory` | `computeAddress`, `deploy`, `deployAndShield` |
| `DepositForwarder` | `preview`, `shield`, `recover`, `recoverNative` |

## Permissions

Only the deposit's designated relayer can shield, including with a zero gas charge. It cannot change the recipient or exceed the gas cap. Only the recovery wallet can withdraw unshielded funds. Deployment itself is open to anyone.

The deposit configuration fixes the token, encrypted recipient data, recovery wallet, relayer, fee recipient, minimum deposit and maximum gas charge. Fees and shielding succeed or revert together.

## Limits

- Standard ERC-20 tokens only. No native ETH shielding, transfer-tax or rebasing tokens.
- Initial transfers and amounts remain public. Reusing a recovery address links deposits.
- Shielding depends on the relayer and RAILGUN being available; recovery remains independent of the relayer.

## Verification

The current contracts are **unaudited**. Local tests verify fees, recovery, recipient decryption and deposit inclusion. External-wallet discovery, private spending and production Proof-of-Innocence acceptance remain unverified.

Use the GitHub link above to view the source.
