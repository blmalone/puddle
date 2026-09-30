# Recovery

Standalone recovery for unshielded funds. Uses a saved recovery file and the
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
checks consistency, not the file's origin. Only this contract version is supported;
retain matching recovery builds for older deposits. The tool is unaudited.

The demo uses a temporary local chain and test wallet. Already shielded funds
remain in the RAILGUN wallet; a pending recovery can be overtaken by shielding.
Partial deposits, wrong assets and late transfers remain recoverable publicly.

## Hosting

`npm run recovery:build` produces a standalone site in `.cache/recovery`.
The intended domain is `recovery.<brand>.link`; nothing is deployed yet.
Host it independently of the app, or keep a local copy. Apply the generated
`_headers`, including its content security policy, or equivalent host settings.
Libraries and contract artifacts are included; no CDN is required.

Run `npm run test:recovery` to verify recovery and invalid-input handling on Anvil.
