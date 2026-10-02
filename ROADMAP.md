# Roadmap

Make funding a private wallet as simple as an ordinary token transfer.
This is a proposed order of work, not a delivery schedule.

## Working now

- Local RAILGUN demo and [standalone recovery tool](recovery/README.md) for both protocols.
- [Privacy Pools integration](docs/src/pages/privacy-pools.md) with local
  deposit, private spending and recovery tests.
- Shared TypeScript and contract flow for quotes, fees, execution and recovery.

An earlier Arbitrum pilot reached the recipient's private balance. The current
contracts remain unaudited and need live validation.

## First release

Start with RAILGUN on Arbitrum, one supported token and same-chain deposits.

- **Validate the full journey.** Test the current contracts with wallet receipt,
  private spending, protocol screening and owner recovery while our server is offline.
- **Finish the website.** Accept a real recipient and user-owned recovery address.
  Verify the returned deposit configuration and recipient data in the browser;
  save recovery data before funding.
- **Build the REST API and background processing.** Create and track deposits,
  save state across restarts, handle duplicate requests, wait for confirmations
  and check submitted transactions before retrying.
- **Make fees and failures clear.** Quote the 0.1% service fee, capped gas charge
  and protocol fee. Handle partial, excess and late payments, gas spikes and
  rejected deposits with clear waiting or recovery instructions.
- **Prepare for public funds.** Complete an independent security review, address
  its findings, publish verified contract code and host recovery separately.
  Retain a matching recovery build for every deployed contract version.

## Possible additions

| Feature | Purpose and condition |
| --- | --- |
| Privacy Pools in the app and API | Offer a second private balance destination after validating production token routing, recipient setup, screening and exits. |
| Cross-chain deposits | Fund from another chain. Adopt a route only after verifying custody and user-owned recovery at every stage; see the [cross-chain design](DESIGN.md). No provider is approved yet. |
| More tokens and chains | Expand support one tested route at a time, including native-token wrapping where useful. |
| Payment links and QR codes | Let someone else pay into a private balance. Reusable links should create fresh deposit addresses for each payment. |
| TypeScript SDK and webhooks | Make wallet, app and payout integrations easier; notify clients when deposit status changes. |
| More private recovery options | Reduce public links caused by reusing a recovery address, while preserving recovery without our server. |
| Other relayers | Let additional operators complete deposits while preserving the fixed recipient and Puddle fee. The first release uses our relayer. |

Prioritize additions based on user demand and verified recovery behavior.
The [design document](DESIGN.md) holds technical proposals and unresolved questions.
