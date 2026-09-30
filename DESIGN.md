# API and cross-chain deposits

**Proposed · 30 September 2026.** The current demo runs locally; this integration
is not implemented.

## Flow

Create an address through the website or REST API, then fund it with an ordinary
transfer. Start with **USDC on Base → USDC on Arbitrum → RAILGUN on Arbitrum**,
subject to provider support. Private balances belong to a specific chain.

```text
Website or client → Puddle API → api.clkd.xyz → Across

User → Across source deposit address → Puddle destination contract → RAILGUN
```

Puddle owns deposit configuration, recovery files, shielding and overall status.
The clkd service handles bridging, reusing its Across validation and tracking.
Neither service needs user spending keys.

Keep our destination contract with its fixed recipient, recovery owner and fee
limits. Across bridges; our relayer deploys and shields. Same-chain deposits
bypass Across. Bridge completion does not prove shielding or private spendability.

## Across decision

| Option | User action | Tradeoff |
| --- | --- | --- |
| Deposit-address API | Ordinary transfer | Needs our separate shielding relay |
| Swap API with Actions | Sign a bridge transaction | Could shield during the fill; RAILGUN integration unproven |

Across [does not currently support Actions through its deposit-address API](https://docs.across.to/introduction/features).
[Access is gated and routes are specific to chains and tokens](https://docs.across.to/introduction/persistent-deposit-addresses);
use the API's supported routes and limits.

**Provider choice remains open.** The [deposit-flow audit](https://www.openzeppelin.com/news/deposit-flow-audit)
describes privileged administrator withdrawals. The [newer source design](https://github.com/across-protocol/contracts/blob/a634bea927668519c748e46036181c89c7bd9b40/contracts/periphery/counterfactual/DESIGN.md#trust-model)
permits immediate administrator upgrades. We have not matched the public API to
a deployed version and configuration. Verify its actual permissions and independent
user recovery before claiming full self-custody. Our destination contract cannot
remove source-side trust. A source contract with fixed routes and user-only
recovery is an alternative if needed, with additional contract and operating work.

## API

| Endpoint | Returns |
| --- | --- |
| `GET /v1/routes` | Supported chain/token pairs and limits |
| `POST /v1/deposits` | Funding instructions, fee limits and recovery data |
| `GET /v1/deposits/{id}` | Status and transaction hashes |

Creation takes source/destination chain and token, amount in integer token units,
public `0zk` recipient, user-controlled `0x` recovery address and accepted fee limits.
A retry key returns the same deposit for identical inputs; changed inputs are rejected.
Clients verify the destination configuration and save recovery data before funding.
The API can see recipient/address mappings; keep them out of public logs.

## Operating rules

- Itemize bridge costs, destination gas, the **0.1% service fee** and RAILGUN's fee.
  Collect the service fee once. Set the destination minimum after bridge fees;
  insufficient amounts stay recoverable. Indicative fees are not firm quotes.
- Track `awaiting_funds → bridging → awaiting_shield → shielding → shielded`, with
  separate refund, recovery and failure outcomes. Observe ambiguous submissions
  before retrying. Verify shielding from the destination transaction.
- Create fresh addresses: Across addresses are reusable, ours shield once. Detect
  repeated or late payments and support recovery.
- Recovery differs before bridging, inside the bridge and at our contract. The
  standalone tool only covers our contract. Shielded funds belong to the RAILGUN wallet.

## Before building

Confirm API access, the USDC route, delivery to undeployed contracts, exact deployed
code and audits, administrator powers, and recovery without Across. Then prove
shielding and wallet discovery, fee economics, and failure/repeated-payment handling.
Production private spending and Proof-of-Innocence acceptance remain separate checks.
