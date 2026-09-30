# API and cross-chain deposits

**Status: proposed. Research checked 30 September 2026.** The current demo runs on
a local chain. This document does not describe a deployed cross-chain service.

## Goal

Create a deposit address through the website or REST API. Send tokens to it with
an ordinary wallet transfer; receive the remainder in a chosen RAILGUN private
balance after fees. No manual shielding or spending key is needed by the service.

Start with one route: **USDC on Base → USDC on Arbitrum → RAILGUN on Arbitrum**,
subject to provider support. A private balance belongs to a specific chain.

## Proposed flow

```text
Website or API client → Puddle API → clkd bridge service → Across

User transfer → Across source deposit address
              → Puddle deposit contract on Arbitrum
              → Puddle relayer → RAILGUN
```

The Puddle API owns deposit configuration, recovery files, shielding and overall
status. The bridge integration lives in `api.clkd.xyz`, reusing its Across quote,
validation, simulation and tracking code. Neither service holds user spending keys.

Keep the current destination contract: it fixes the recipient, recovery owner,
relayer and fee limits. Across delivers tokens; our relayer deploys and shields.
Same-chain deposits bypass Across. Bridge delivery and shielding are separate
transactions, so a successful bridge does not mean shielding succeeded.

## Across options

| Integration | User action | Fit |
| --- | --- | --- |
| Deposit-address API | Ordinary token transfer | Closest to the intended experience; requires a separate shielding relay |
| Swap API with Actions | Sign a bridge transaction in a connected wallet | Could bridge and shield together; RAILGUN integration remains unproven |

Across currently lists [embedded actions as unsupported for deposit addresses](https://docs.across.to/introduction/features).
Its [deposit-address API](https://docs.across.to/introduction/persistent-deposit-addresses)
requires gated access and returns route-specific tokens, limits and indicative
fees. Discover supported routes from the response; do not promise every chain.

**Provider choice is not final.** The [deposit-flow audit](https://www.openzeppelin.com/news/deposit-flow-audit)
describes user recovery alongside an administrator able to withdraw to arbitrary
recipients. The [newer source design](https://github.com/across-protocol/contracts/blob/a634bea927668519c748e46036181c89c7bd9b40/contracts/periphery/counterfactual/DESIGN.md#trust-model)
also permits immediate administrator upgrades of deposit accounts. We have not
matched the public API to a deployed version and configuration. These sources do
not establish the exact permissions of an API-created address today.

Our destination contract cannot remove trust introduced at the source address.
Do not claim the combined route is fully self-custodial until those permissions
and independent recovery are verified. If they do not meet our requirements,
evaluate a source contract with fixed routes and user-only recovery; that would
add contract and operating work.

## Minimal API

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/routes` | Supported chain/token pairs and current limits |
| `POST /v1/deposits` | Create a deposit and return funding instructions, fee limits and recovery data |
| `GET /v1/deposits/{id}` | Read bridge, shielding and recovery status with transaction hashes |

Creation takes the source and destination chain/token, amount, public `0zk`
recipient, user-controlled `0x` recovery address and accepted fee limits. Express
amounts in integer token units. Use an idempotency key so retrying the same request
returns the same deposit; reject changed inputs under that key.

Before funding, clients verify the fixed destination configuration and save its
recovery file. Never request spending keys. Keep recipient/address mappings out
of public logs; an API that prepares deposits can still see those mappings.

## Fees, status and recovery

- Show bridge costs, destination gas charge, the **0.1% service fee** and RAILGUN's
  fee separately. Charge the service fee once, in the destination contract.
- Set the destination minimum using the expected amount **after bridge fees**.
  Indicative bridge fees are not a guaranteed final quote. If the received amount
  is insufficient, leave it recoverable rather than exceed accepted fee limits.
- Track `awaiting_funds → bridging → awaiting_shield → shielding → shielded`.
  Record refunds, recovery and failures separately. Retry observation after an
  ambiguous submission; do not blindly submit another transaction.
- Confirm shielding from the destination transaction. Wallet discovery and
  eligibility for private spending require separate verification.
- Use a fresh address for each deposit. Across addresses are reusable, but our
  current contract shields only once. Repeated or late transfers must be detected
  and recoverable; presenting an address as single-use cannot prevent reuse.
- Recovery depends on where funds are: at the source address, in the bridge, or
  at our destination contract. The current standalone recovery tool only covers
  the last stage. Already shielded funds belong to the RAILGUN wallet.

## Before implementation

1. Confirm API access, the USDC route and delivery to an undeployed contract address.
2. Identify the source contracts, applicable audits, administrator permissions and
   user recovery path, including the data needed if Across is unavailable.
3. Prove successful shielding and recipient wallet discovery, then test stopped
   relayers, failed/expired bridges, insufficient amounts and repeated deposits.
4. Confirm total fees and gas economics. Keep public deployment and a contract
   audit separate from this research prototype.
