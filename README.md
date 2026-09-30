<!-- brand:start -->
# puddle
<!-- brand:end -->

Fund a RAILGUN private balance with a normal token transfer. Send to a `0x`
deposit address; a relayer handles shielding—the deposit into RAILGUN.

**Local proof of concept. Unaudited. Test funds only.**

## Use cases

- Fund your private wallet without manually shielding.
- Receive payments from people who don't use RAILGUN.
- Accept payouts from apps that send ordinary token transfers.

## Run

Requires Node.js 24.12+, Git and [Anvil](https://getfoundry.sh/) (tested with 1.7.1).

```sh
npm ci --ignore-scripts
npm ci --prefix docs --ignore-scripts
npm run setup
npm run dev
```

App: **http://127.0.0.1:5173** · Docs: **http://127.0.0.1:5174** · Recovery: **http://127.0.0.1:5175**

The demo supplies test USDC and verifies recipient decryption and deposit inclusion
using real RAILGUN contracts on a local chain. Restarting clears the session.
Use `npm run demo` for a terminal-only run.

## Contracts

Each address fixes its recipient, token, recovery owner, relayer and fee limits.
The relayer collects **0.1% plus a capped gas charge** and shields the remainder.
RAILGUN's own fee also applies. Fees are collected only when shielding succeeds.

Addresses shield once. Only the recovery owner can withdraw unshielded or late
funds, independently of the relayer. No admin setters or upgrades.

Standard ERC-20 tokens only; no native ETH shielding, transfer-tax or rebasing
tokens. Initial transfers remain public, and reusing a recovery address links
deposits. External-wallet discovery, private spending and production
Proof-of-Innocence acceptance remain unverified.

- [Fees](docs/src/pages/fees.md) · [Contracts and security](docs/src/pages/contracts.md)
- [Recovery tool](recovery/README.md)
- [Proposed API and cross-chain design](DESIGN.md)

## Development

```sh
npm run typecheck
npm test
npm run test:ui
npm run test:recovery
```

`npm run test:fork` checks deployed contracts on a local Arbitrum fork, pinned to
block `510058182`. Set `ARBITRUM_RPC_URL` for an archive RPC or `FORK_BLOCK` to
change the block. No real transactions are sent.

Run `npm run build:ui` after editing app HTML or TypeScript. The footer shows the
built commit; `dev` marks local changes. `BUILD_COMMIT` accepts a full commit hash.
Build the docs with `npm run docs:build`.

Branding lives in [brand.json](brand.json). Run `npm run rename -- new-name`;
add `--github` to rename the repository, or `--definition "Meaning."` for a README
definition. Rebuild the app and docs afterward.

## License

[MIT](LICENSE) for puddle's original code. Dependencies retain their own terms,
including `circomlibjs` (GPL-3.0). Setup fetches pinned RAILGUN contracts marked
`UNLICENSED`; they and generated artifacts are not redistributed here.
