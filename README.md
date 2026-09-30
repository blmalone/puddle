<!-- brand:start -->
# puddle
<!-- brand:end -->

Fund a RAILGUN private wallet with a normal token transfer. Send to a `0x`
deposit address; a relayer handles shielding—the deposit into RAILGUN.

**Local proof of concept. Unaudited. Test funds only.**

Planned REST API and cross-chain flow: [design](DESIGN.md).

## Use cases

Intended workflows:

- **Fund your private wallet:** send from MetaMask without manually shielding.
- **Receive payments:** give someone a normal address; they don't need RAILGUN.
- **Receive payouts:** use a deposit address with apps that send ordinary token transfers.

## How it works

1. Generate a fresh deposit address with a fixed recipient, token, recovery owner and fee limits.
2. Send tokens there before its contract is deployed.
3. The relayer deploys the contract, collects fees and shields the remainder for the recipient.

CREATE2 makes the address predictable before deployment. The relayer pays
shielding gas and cannot redirect the prepared deposit. Users must control their
spending and recovery keys; the demo uses local test accounts.

## Fees and contracts

The service takes **0.1% of the received balance**, rounded down, plus a gas charge in
the deposit token. RAILGUN's protocol fee applies to the remainder. Fees are paid
only if shielding succeeds; failed transactions still cost the caller gas.

Each address fixes its relayer, fee recipient, minimum deposit and maximum gas
charge. The cap is enforced onchain; it does not prove that the charge matches gas spent.

| Action | Who can call |
| --- | --- |
| `computeAddress(salt, config)`, `preview(amount, gasFee)` | Anyone |
| `deploy(salt, config)` | Anyone; cannot change the deposit terms |
| `deployAndShield(salt, config, gasFee)`, `shield(gasFee)` | Fixed relayer, including when `gasFee = 0` |
| `recover(token)`, `recoverNative()` | Fixed recovery owner |

V1 uses the relayer only. If it is offline, the recovery owner can deploy the
contract using the saved deposit configuration and recover unshielded funds.

[`DepositConfig`](contracts/DepositFactory.sol) contains all deposit terms.
Amounts use token units, not USD. Set `minDeposit` to the expected payment to
prevent a smaller transfer consuming the address. Recovery requires only the
fixed recovery owner and charges no fees. There are no admin setters or upgrades.

## Run

Requires Node.js 24.12+, Git, and [Anvil](https://getfoundry.sh/) (tested with 1.7.1).

```sh
git clone https://github.com/blmalone/puddle.git
cd puddle
npm ci --ignore-scripts
npm ci --prefix docs --ignore-scripts
npm run setup
npm run demo
npm run typecheck
npm test
```

All transactions run locally. Results: `artifacts/demo-result.json`.

### Local interface

```sh
npm run dev
```

Open **http://127.0.0.1:5173**. The menu links to the Vocs docs at **http://127.0.0.1:5174**.
Create an address, send test tokens (displayed as USDC), and watch the relayer
shield it automatically. Success requires recipient decryption and verified
inclusion in the real RAILGUN contracts running locally.

The app creates a fresh test wallet and isolated chain. No wallet connection or
real funds are needed; restarting clears the session. The gas charge is a fixed
0.2 demo USDC for this test. This verifies a deposit, not private spending or discovery
in an external wallet. Run `npm run test:ui` for the interface's end-to-end API test.

Docs live in `docs/src/pages`. Use `npm run docs:dev` to run them separately,
`npm run docs:build` to build the static site, or `npm run dev:app` for the app alone.

The bottom-right commit link identifies the frontend build; `dev` marks uncommitted
changes. Builds read Git automatically, or accept a full hash in `BUILD_COMMIT`.
Run `npm run build:ui` after editing the app's HTML or TypeScript.

### Independent recovery

Save the recovery file before funding. The [open-source recovery tool](recovery/README.md)
reads it on your device and uses your wallet directly, without the deposit API or
relayer. It checks the contract and recovery owner, then lets you deploy and recover
in separate wallet transactions. No private keys or token approvals are requested.

`npm run dev` also serves recovery at **http://127.0.0.1:5175**. Run it independently
with `npm run recovery:dev`. Build a static site with `npm run recovery:build`;
publish `.cache/recovery` to **recovery.puddle.link** (planned, not deployed).
You can keep and run a local copy if that domain is unavailable.

The demo backup belongs to its temporary test chain. Recovery files cannot withdraw
already shielded funds. Contract changes require retaining the matching recovery
build for existing deposits. Run `npm run test:recovery` to verify the flow locally.

To use deployed contracts on a local Arbitrum fork:

```sh
npm run demo:fork
npm run test:fork
```

The fork is pinned to block `510058182`. If the default public RPC rejects
historical reads, set `ARBITRUM_RPC_URL` to an Arbitrum archive RPC.
Use `FORK_BLOCK` to select a newer block. Demo gas charges are illustrative;
there is no live quote service yet.

To prepare a live Arbitrum WETH test using your public addresses:

```sh
node scripts/prepare-live.ts <0zk-recipient> <0x-recovery> <WETH-amount> artifacts/live/plan.json
```

This rehearses shielding and recovery on a fresh local fork and saves unsigned
transactions plus recovery data. It sends no real transactions and needs no private
key. Keep the output private: it links your recipient and deposit addresses.
The recovery account must deploy the factory at the saved nonce (transaction count).
This single-account pilot returns fees to its own signer. Optional fifth and
sixth arguments set the gas charge and cap in WETH (both default to zero).
Plans use version 2; old plans and previously deployed contracts are not compatible.

## Status

Tests use real RAILGUN contracts and verify recipient decryption, deposit
inclusion, fee accounting, recovery, access control and transaction rollback.

- Standard ERC-20 design; tested with WETH and a local demo token. No native ETH shielding.
  Fee-on-transfer and rebasing tokens are unsupported.
- Each address shields once. Remaining tokens can be recovered publicly;
  reusing a recovery address links deposits. Initial transfers and amounts stay public.
- Contract fee collection and a local test UI are implemented. No production
  deposit watcher or gas pricing service yet.
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
