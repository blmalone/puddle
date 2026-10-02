# Recovery

Standalone recovery for unshielded RAILGUN and Privacy Pools deposits. Uses a saved recovery file and the
owner's wallet; no deposit API, relayer, private keys or token approvals.
Files stay on your device. The wallet needs a blockchain connection and gas.

```sh
npm ci --ignore-scripts
npm run setup
npm run recovery:dev
```

Open **http://127.0.0.1:5175**. Load the file, connect its recovery wallet on the
specified chain, then check the balance. Deploy the deposit contract if needed;
recover the selected token or native currency in a separate transaction.

## Verification

The tool validates the file, computes the deposit address and compares the
factory's onchain code with its own build. It checks the network and recovery
owner before each transaction. Imported transaction data is never trusted.

Keep the file private and compare its addresses with your records. Validation
checks consistency, not the file's origin. Only the current `private-deposit-recovery`
format is supported; old pre-release files and unknown versions are rejected.
The tool is unaudited.

The file stores the protocol, chain, factory, pool, deposit address, salt, recipient
instructions and fixed recovery/relayer/fee addresses. Recipient instructions are
an encrypted RAILGUN note or a Privacy Pools call hash; recovery needs no proof or
Privacy Pools SDK. The `asset` field only selects the
initial token to check; it does not affect the deposit address. Amount, fee and expiry
are execution settings and are unnecessary for recovery.

The demo uses a temporary local chain and test wallet. Already shielded funds
remain in the recipient's protocol wallet; a pending recovery can be overtaken by depositing.
Partial deposits, wrong assets and late transfers remain recoverable publicly.

## Hosting

`npm run recovery:build` produces a standalone site in `.cache/recovery`.
The intended domain is `recovery.<brand>.link`; nothing is deployed yet.
Host it independently of the app, or keep a local copy. Apply the generated
`_headers`, including its content security policy, or equivalent host settings.
Libraries and contract artifacts are included; no CDN is required.

Run `npm run test:recovery` to verify recovery and invalid-input handling on Anvil.
