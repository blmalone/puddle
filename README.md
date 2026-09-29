# jumpr

Send tokens to an address. A relayer pays the gas to deposit them into your
RAILGUN private wallet.

jumpr is a proof of concept using CREATE2, Ethereum's mechanism for computing a
contract address before deploying it. The sender makes a normal token transfer;
they do not need to call RAILGUN or approve tokens to jumpr.

**Research software. Unaudited. Use test funds only.**

## How it works

1. Prepare a fresh deposit address from the recipient's public RAILGUN address.
2. Transfer tokens to that address while it has no deployed code.
3. Anyone can pay to deploy its contract and shield the balance into RAILGUN.
4. The recipient decrypts the resulting private deposit.

The recipient, token, pool, encrypted note, and recovery address determine the
deposit address. Changing any of them changes that address. The relayer cannot
redirect a prepared deposit and does not need the recipient's spending key.

Each address shields once. Transfers received before settlement are combined;
late arrivals can be recovered by the fixed recovery owner. For the intended
non-custodial design, users must control both their spending and recovery keys.
The demo uses a separate local test account for recovery.

## Run

Requires Node.js 24, Git, and [Anvil](https://getfoundry.sh/) on your PATH.
The demo has been tested with Anvil 1.7.1.

```sh
git clone https://github.com/blmalone/jumpr.git
cd jumpr
npm ci --ignore-scripts
npm run setup
npm run demo
```

The default demo deploys RAILGUN locally with a freely mintable test token.
All transactions run on a temporary local Anvil node at `127.0.0.1`, chain ID
`31337`. It stops automatically; no real funds or wallet keys are needed.

To test against Arbitrum's existing RAILGUN and WETH contracts instead:

```sh
npm run demo:fork
```

This forks block **510058182** through `https://arb1.arbitrum.io/rpc` by default.
Public endpoints may reject historical reads. If you see `historical state ...
is not available`, use an Arbitrum archive RPC that serves the pinned block:

```sh
ARBITRUM_RPC_URL=https://your-arbitrum-rpc npm run demo:fork
```

`FORK_BLOCK` can override the source block. Both demos transact only locally.

Results are written to `artifacts/demo-result.json`. Recipient secrets are not
saved or printed. The transaction hashes belong to the temporary local chain.

## Verified

The fork demo deposited **0.1 WETH**, producing a **0.09975 WETH** private note
and a **0.00025 WETH** protocol fee. It checks recipient decryption,
wrong-recipient rejection, the pool's balance increase, and inclusion in the
pool's record of deposits. Deployment and shielding used about **1.58 million
local EVM gas**; this is not an Arbitrum fee quote.

```sh
npm test            # Local deposit, tampering, failure, and recovery checks
npm run test:fork   # Check against the deployed contracts on a local fork
```

GitHub Actions runs the local tests on pushes and pull requests. The fork test
can also be enabled in a manual workflow run; it depends on an external RPC.

## Remaining work

- Private spending and withdrawals are not yet demonstrated. The local pool has
  no spending verification keys configured.
- Production Proof-of-Innocence acceptance is untested. A local fork cannot
  establish whether external services will accept these deposits.
- There is no deposit watcher, relayer service, gas reimbursement, or UI.
- Recovery is public, and reusing a recovery address links deposits. Recovery
  cannot retrieve funds already shielded into RAILGUN.
- Only standard ERC-20 tokens are supported. Native ETH, unusual tokens,
  minimum deposits, and fee limits need separate work.
- Deposit preparation must be verified on the user's trusted client: malformed
  encrypted data can create an unusable note. Transfers and amounts stay public.
- Dependencies are pinned for research and have known audit findings.

## Contributing

Issues and pull requests are welcome. Keep changes focused, explain the behavior
being changed, and run the relevant tests above. Never commit wallet secrets,
RPC credentials, dependency caches, or generated artifacts.

The core contract is in `contracts/DepositFactory.sol`; the demo and test helpers
are in `scripts/harness.mjs`. Tests live in `test/`.

## License and dependencies

jumpr's original code is [MIT licensed](LICENSE). Dependencies retain their own
terms, including `circomlibjs` (GPL-3.0).

Setup downloads [RAILGUN contracts](https://github.com/Railgun-Privacy/contract/tree/36bcf5ed7cf94bfafb6e1a303e1832c769c16780)
at commit `36bcf5ed7cf94bfafb6e1a303e1832c769c16780` and verifies a clean checkout.
That upstream package and its Solidity files are marked `UNLICENSED`; jumpr's
MIT license does not grant rights to them. Upstream source and compiled artifacts
are not redistributed in this repository.

The harness uses Solidity 0.8.17 and the [RAILGUN engine](https://github.com/Railgun-Community/engine)
9.8.0, including pinned internal SDK helpers. On a fork it reads cached tree data
using the pinned storage layout to verify the new deposit; it does not modify
the deployed contracts' code or storage to simulate shielding.
