# API and cross-chain deposits

**Proposed · 30 September 2026.** The current demo runs locally; this integration
is not implemented.

## Flow

Create an address through the website or REST API, then fund it with an ordinary
transfer. First candidate: **USDC on Base → USDC on Arbitrum → RAILGUN on Arbitrum**.
Private balances belong to a specific chain.

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

**Provider choice remains open.** Across's [current source design](https://github.com/across-protocol/contracts/blob/a634bea927668519c748e46036181c89c7bd9b40/contracts/periphery/counterfactual/DESIGN.md#trust-model)
permits immediate administrator upgrades; its [withdrawal module](https://github.com/across-protocol/contracts/blob/a634bea927668519c748e46036181c89c7bd9b40/contracts/periphery/counterfactual/WithdrawImplementation.sol)
allows both a configured administrator and user to withdraw. User recovery does
not remove administrator control. Match the API's actual deployment and audit
before claiming full self-custody. Our destination contract cannot remove this
source-side trust. Fixed source contracts with user-only recovery remain an alternative.

### Checked on 30 September 2026

- Across's live `available-routes` endpoint lists native USDC from Base to Arbitrum.
  This does not confirm the separate deposit-address product's route.
- Authenticated deposit-address requests hit Cloudflare error 1010 on both official
  API hosts. Key permissions, supported inputs and undeployed recipients remain unverified;
  no deposit address was created or funded.
- The [published Base factory](https://github.com/across-protocol/contracts/blob/a634bea927668519c748e46036181c89c7bd9b40/broadcast/DeployCounterfactualDepositFactory.s.sol/8453/run-latest.json)
  resolves on-chain to a beacon with a nonzero owner; its implementation addresses
  match the deployment manifests. This has not been tied to an API-created address
  or independently matched byte-for-byte to audited source.
- The recipient confirmed wallet receipt in the first Arbitrum pilot on 29 September.
  Revised contracts, cross-chain receipt and private spending still need live tests.

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
  partial, repeated and late payments; amounts arriving after shielding require recovery.
- Gas above the accepted cap must wait or lead to recovery, never a higher charge.
  Do not promise recovery for unsupported source chains or tokens without testing it.

## Recovery boundaries

| Where the funds are | Recovery requirement |
| --- | --- |
| Across source address | Supply the user's `refundAddresses`; verify a direct withdrawal path and save all required proofs/configuration. An API refund promise is not independent recovery. |
| Inside the bridge | Track expiry and [settlement refunds](https://docs.across.to/introduction/refunds) separately; they can take hours. Verify where this route sends them; source funds may return to its deposit contract. |
| Puddle contract | The fixed recovery owner can withdraw, before or after shielding, without our server. |
| RAILGUN | The recipient controls the private balance. Test the wallet's return-to-origin flow as well as private spending. |

[MulticallHandler](https://github.com/across-protocol/contracts/blob/a634bea927668519c748e46036181c89c7bd9b40/contracts/handlers/MulticallHandler.sol)
can refund a failed destination action during the bridge fill. It cannot undo a
completed bridge when Puddle shields later. With a fallback recipient, a successful
fill can mean a public refund rather than a successful action; track both outcomes.
Never park funds in this shared handler: anyone can claim leftover balances.

RAILGUN's [current wallet code](https://github.com/railgun-community/wallet/blob/5c9d04c844879b8377d91775052e88c836b48730/src/services/transactions/tx-unshield.ts#L263-L398)
derives the return address from token-transfer logs, with fallbacks to the transaction
sender. For our single-deposit flow, that should return tokens to Puddle, where
recovery still works. Verify the actual wallet version and transaction. Direct
shielding from MulticallHandler could instead return funds to that unsafe shared address.

## Before building

Resolve API access, confirm the deposit-address route and undeployed recipient,
and establish source custody and independent recovery. Then test one complete route,
refunds, partial/repeated payments and gas economics. Keep wallet receipt separate
from private spending and Proof-of-Innocence readiness.
