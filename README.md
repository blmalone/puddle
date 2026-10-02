<!-- brand:start -->
# puddle
<!-- brand:end -->

Fund a RAILGUN or Privacy Pools private balance with a normal token transfer.
Send to a `0x` deposit address; a relayer handles the pool deposit.

**Local proof of concept. Unaudited. Test funds only.**

## Use cases

- Fund your private wallet without manually shielding.
- Receive payments from people who don't use a privacy wallet.
- Accept payouts from apps that send ordinary token transfers.

## Supported protocols

| Protocol | Contracts & SDK | Web demo |
| --- | :---: | :---: |
| [RAILGUN](https://railgun.org/) | ✅ | ✅ |
| [Privacy Pools v2](docs/src/pages/privacy-pools.md) | ✅ | — |

Both integrations are tested locally. The standalone recovery tool supports both.

## Run locally

Requires Node.js 24.12+, Git and [Foundry](https://getfoundry.sh/) 1.7.1.

```sh
npm ci --ignore-scripts
npm ci --prefix docs --ignore-scripts
npm run setup:contracts
npm run dev
```

[App](http://127.0.0.1:5173) · [Docs](http://127.0.0.1:5174) · [Recovery](http://127.0.0.1:5175)

The demo supplies test USDC and checks the recipient's decrypted RAILGUN deposit.
Restarting clears the local chain. Use `npm run demo` for a terminal-only run.

## Design

Both protocols share fee limits, single-use execution, CREATE2 deployment and
owner recovery. Each deposit is a fixed ERC-1167 clone. Small adapters build or
validate each pool's deposit call.

An address fixes its recipient instructions, recovery owner, relayer and fee
recipient. Quotes supply token, amount, gas charge and expiry separately. RAILGUN
permits changing token and amount; Privacy Pools must preserve its prepared proof's
private deposit. Fees are **0.1% plus a capped gas charge**, with pool fees on top.
Fees are collected only when the deposit succeeds.

Standard ERC-20 tokens only. Initial transfers are public; reusing a recovery
address links deposits. Excess and late funds stay owner-recoverable. Puddle has
no admin setters or upgrades; the underlying pools have their own governance.

| Path | Purpose |
| --- | --- |
| `contracts/` | Shared settlement and protocol adapters |
| `protocols/` | TypeScript preparation, quotes and execution |
| `app/`, `recovery/` | Local demo and independent recovery website |
| `test/` | Solidity and real-protocol integration tests |

[Contracts & security](docs/src/pages/contracts.md) · [Fees](docs/src/pages/fees.md) ·
[Recovery](recovery/README.md) · [API and cross-chain design](DESIGN.md) · [Roadmap](ROADMAP.md)

## Development

```sh
npm run check                         # Types, contracts, integrations, UI, recovery, docs
FOUNDRY_PROFILE=ci npm run test:contracts  # Deeper fuzz and transaction-sequence tests
```

Privacy Pools proof tests additionally require pnpm, Git LFS and access to the
currently private upstream repository: `npm run privacy-pools:setup`, then
`npm run test:privacy-pools`. Public CI tests both contract adapters without that SDK.

`npm run test:fork` uses a recent Arbitrum block and prints it for reproduction.
Set `FORK_BLOCK` to pin it and `ARBITRUM_RPC_URL` for an archive RPC. No real transactions are sent.

Keep contributions focused, add tests for behavior changes and run `npm run check`.
See [security notes](SECURITY.md) for limits and dependency advisories.

Branding lives in [brand.json](brand.json). Run `npm run rename -- new-name`;
add `--github` to rename the repository. Rebuild afterward. Both sites show their
built commit; `dev` marks local changes. Source archives can set `BUILD_COMMIT`.

## License

[MIT](LICENSE) for original code. Dependencies and logos retain their own terms,
including `circomlibjs` (GPL-3.0); see [asset credits](app/assets/README.md).
Pinned upstream contracts and generated artifacts are not redistributed here.
