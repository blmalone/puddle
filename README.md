<!-- brand:start -->
# puddle
<!-- brand:end -->

Fund a RAILGUN private wallet with a normal token transfer. Send to a `0x`
deposit address; a relayer handles shielding—the deposit into RAILGUN.

**Local proof of concept. Unaudited. Test funds only.**

## Use cases

Intended workflows:

- **Fund your private wallet:** send from MetaMask without manually shielding.
- **Receive payments:** give someone a normal address; they don't need RAILGUN.
- **Receive payouts:** use a deposit address with apps that send ordinary token transfers.

## How it works

1. Generate a fresh deposit address for a recipient, token, network, and recovery owner.
2. Send tokens there before its contract is deployed.
3. A relayer deploys the contract and shields the balance for the recipient.

CREATE2 makes the address predictable before deployment. The relayer pays
shielding gas and cannot redirect the prepared deposit. Users must control their
spending and recovery keys; the demo uses local test accounts.

## Run

Requires Node.js 24.12+, Git, and [Anvil](https://getfoundry.sh/) (tested with 1.7.1).

```sh
git clone https://github.com/blmalone/puddle.git
cd puddle
npm ci --ignore-scripts
npm run setup
npm run demo
npm run typecheck
npm test
```

All transactions run locally. Results: `artifacts/demo-result.json`.

To use deployed contracts on a local Arbitrum fork:

```sh
npm run demo:fork
npm run test:fork
```

The fork is pinned to block `510058182`. If the default public RPC rejects
historical reads, set `ARBITRUM_RPC_URL` to an Arbitrum archive RPC.

## Status

Verified on a local Arbitrum fork: **0.1 WETH → 0.09975 WETH shielded** after
protocol fees, with recipient decryption and deposit inclusion checked.

- Standard ERC-20 design; tested with WETH and a local demo token. No native ETH.
- Each address shields once. Remaining tokens can be recovered publicly;
  reusing a recovery address links deposits. Initial transfers and amounts stay public.
- No automatic deposit watcher, relayer service, fee reimbursement, or UI yet.
- Real-wallet balance discovery, private spending, and production
  Proof-of-Innocence acceptance remain unverified.
- Deposit data must be verified on the user's device. Dependencies have known
  audit findings.

## Rename

Branding lives in [`brand.json`](brand.json). To change it everywhere:

```sh
npm run rename -- new-name
```

Add `--github` to rename the GitHub repository and update `origin` too (requires
the GitHub CLI). Add `--definition "Meaning of the name."` to set the README definition;
a new name clears the old meaning. Rebuild or restart the app and docs afterward.
The command updates package names, lockfiles and README links. It does not commit,
push, change contracts or move your checkout folder.

## License

[MIT](LICENSE) for puddle's original code. Dependencies retain their own terms,
including `circomlibjs` (GPL-3.0). Setup fetches pinned RAILGUN contracts marked
`UNLICENSED`; they and generated artifacts are not redistributed here.
