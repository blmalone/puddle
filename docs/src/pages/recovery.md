---
showAskAi: false
outline: false
---

# Recovery

Only the fixed recovery wallet can withdraw unshielded funds. The relayer's permission is not required.

Save the recovery file before funding a deposit. It contains the configuration,
salt, chain and factory address; no private keys. Keep it private.

The open-source recovery tool works independently of the deposit service. Load
the file locally, connect the recovery wallet on the correct chain, and check
the balance. The file is not uploaded. You can also run the tool yourself with
`npm run recovery:dev` at **http://127.0.0.1:5175**.

1. Deploy the deposit contract if needed (one wallet transaction).
2. Recover the selected asset (a second wallet transaction).
3. The balance returns to the fixed recovery wallet.

The tool checks the deposit address and factory code against its own contract
build. The current format supports both RAILGUN and Privacy Pools; old pre-release
formats and unknown versions are rejected. The demo
uses a local chain and test recovery wallet; the public recovery site is not deployed yet.

Recovery also works for partial deposits, wrong tokens and transfers received after shielding. Use `recoverNative()` for native currency accidentally sent before deployment or forcibly received.

You pay transaction gas; there is no service fee. Recovery is public, and reusing a recovery address links deposits. Successfully deposited funds are controlled through the recipient's protocol wallet.
