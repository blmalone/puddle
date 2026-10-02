# Deposit API and cross-chain design

**Updated 2 October 2026.** Both protocol adapters share the contract and TypeScript
address/quote flow below. The production REST API and cross-chain integration
remain proposed; the demo runs locally.

## Address and execution quote

Create the RAILGUN address before choosing a token or amount:

```text
address = prepare(recipient0zk, recoveryOwner, configuredDeployment)
quote   = quote(address, token, amount, gasFee, expiry)
user transfers tokens to address
relayer deploys and shields(address, quote)
```

Permanent terms are the encrypted recipient, recovery owner, relayer and fee
recipient. Chain, factory, pool and random salt also determine the address.
The factory fixes a supported token list and each token's fee policy at deployment:

```text
maximum gas charge = fixed allowance + amount × basis points / 10,000
service fee        = amount / 1,000 (rounded down)
gross shield       = amount − service fee − quoted gas charge
```

This follows Across's [fixed-plus-percentage fee ceiling pattern](https://github.com/across-protocol/contracts/blob/a634bea927668519c748e46036181c89c7bd9b40/contracts/periphery/counterfactual/CounterfactualDepositSpokePool.sol),
not its bridge integration or administrator model. Our policies have no setters or
upgrades. A different policy requires a new factory; existing addresses are unchanged.

Only the designated relayer can execute, so its transaction already authorizes the
quote. No separate quote signature or user signature is needed in v1. The contract
checks expiry, funding, the cap and a positive remainder, then consumes exactly the
quoted amount once. It cannot prove the charge matches actual gas expense; the
relayer can charge up to the ceiling. Production ceilings remain to be chosen.

Requoting a partial payment, excess balance or expired quote preserves the address.
The service must show the updated quote before requesting funding and avoid silently
changing an accepted amount. Once executed, remaining or late funds require recovery.
All fee transfers roll back if shielding fails; the relayer still pays transaction gas.

Privacy Pools uses the same configuration, quote and execution interface. Its
recipient instructions commit the entire prepared deposit call, including the
proof and encrypted note. This binds its token and net pool deposit. Gas and gross
amount can change together without replacing the address or proof; changing the
private deposit requires new preparation. Recovery needs the call hash, not the
proof or SDK.

`DepositBase` owns execution, fee collection and recovery; `DepositFactory` owns
fee policy and CREATE2 deployment. Protocol contracts only build or validate the
pool call. TypeScript follows the same split in `protocols/`. There are no retained
legacy execution paths.

## Walkaway requirement

Before shielding, users must be able to recover with their own wallet and saved
public data if Puddle or the bridge operator disappears. Assume the underlying
chain and token remain operational. Recovery may have a bounded delay, but must
not require a new operator signature. Administrators must not be able to redirect funds.

**Relay's tested Base settlement contract fails this requirement. Across's published
deposit-address design also has administrator control; its API deployment remains
unverified. Neither provider is approved for a trustless cross-chain v1.**

| Stage | Walkaway assessment |
| --- | --- |
| Relay source deposit address | Unverified implementation and independent address derivation. |
| Relay depository | Fails: withdrawals require its authorizer; no user-only timeout exit. Owner can replace the authorizer. |
| Across source deposit address | Published module permits user withdrawal with a saved proof, but administrator withdrawals/upgrades prevent user-only control. Actual API configuration unverified. |
| Puddle destination contract | User recovery works without our server, given the recovery file and deployed factory. This does not recover funds still inside a bridge. |
| RAILGUN | Recipient controls the private balance; validate private spending and return-to-origin separately. |

Adding a Puddle source contract would protect funds before bridge submission. It
cannot create an independent exit from Relay's depository after submission.

## Flow

Candidate route: **USDC on Base → USDC on Arbitrum → RAILGUN on Arbitrum**.
Private balances belong to a specific chain. This flow remains conditional on provider selection.

```text
Website or client → Puddle API → api.clkd.xyz → Relay

User → Relay source deposit address → Puddle destination contract → RAILGUN
```

Puddle handles configuration, recovery files, shielding and status. The clkd service
needs a Relay adapter. Keep our destination contract's fixed recipient, recovery owner
and fee limits. Same-chain deposits bypass Relay.

## Relay integration explored

[Relay deposit addresses](https://docs.relay.link/features/deposit-addresses) accept
ordinary transfers, avoiding a custom Puddle source contract. They cannot execute
destination calls, so shielding remains a separate transaction by our relayer.
Start with native USDC, regular EVM wallets and fresh, single-use addresses.

Request `useDepositAddress: true`, `strict: true` and `EXACT_INPUT`. Set `refundTo`
and `recoveryAddress` to a user-controlled wallet, never a Puddle or clkd wallet.
Verify recorded recovery ownership. Strict underpayments refund; overpayments can
bridge the full amount. Unsupported tokens are not generally recoverable.

### Custody and recovery

- [Relay withdrawals](https://docs.relay.link/references/protocol/guides/withdrawals)
  require the recovery owner's signature plus Relay's infrastructure. This API flow
  does not support smart-contract wallet signatures.
- The [verified Base depository](https://sourcify.dev/server/v2/contract/8453/0x4cd00e387622c35bddb9b4c962c136462338bc31?fields=all)
  requires its authorizer's signature for every outgoing call. Its owner can replace
  that authorizer without a contract-enforced delay. There is no user withdrawal
  function or elapsed-time exception. The contract does not itself verify bridge fills.
- [API address verification](https://docs.relay.link/references/api/api_core_concepts/input-validation)
  is not yet supported for deposit addresses. The [protocol guide](https://docs.relay.link/references/protocol/components/deposit-addresses)
  describes CREATE2 contracts; the [current repository](https://github.com/relayprotocol/relay-settlement/tree/b2f3e0e5fba9381293f030ef340ffb4872687fcf/packages/lit-deposit-address)
  also contains wallets controlled by signing software. Our quote's implementation
  and audit coverage remain unverified.
- [Screening](https://docs.relay.link/security/compliance) can stop a fill without
  automatic refund. RAILGUN support remains unconfirmed; a quote does not establish it.

The current [signing code](https://github.com/relayprotocol/relay-settlement/tree/b2f3e0e5fba9381293f030ef340ffb4872687fcf/packages/lit-allocator)
requires approved attestations. Hosting a replacement frontend does not supply those
signing keys. This remains true even where users can initiate requests themselves.

### Across comparison

The supplied [deposit-address endpoint](https://docs.across.to/api-reference/deposit-addresses/post)
returns persistent addresses, supported inputs and limits. Supply user-owned `refundAddresses`.
Its [deposit-address product has no destination Actions](https://docs.across.to/introduction/features),
so Puddle would still shield separately.

The published [withdrawal module](https://github.com/across-protocol/contracts/blob/a634bea927668519c748e46036181c89c7bd9b40/contracts/periphery/counterfactual/WithdrawImplementation.sol)
lets the configured user **or administrator** withdraw with a valid route proof.
The [beacon design](https://github.com/across-protocol/contracts/blob/a634bea927668519c748e46036181c89c7bd9b40/contracts/periphery/counterfactual/DESIGN.md#trust-model)
allows immediate upgrades affecting all deposit contracts, without a timelock.
Recovery could survive an inactive operator if the correct proof is saved and the
implementation remains unchanged; this does not protect against administrator changes.
Recovery after funds leave that source address needs a separate bridge-route review.

### Checked on 30 September 2026

- Relay quotes and authenticated tracking returned HTTP 200 for 100 USDC Base →
  Arbitrum. Transfer, output and refund matched; the recipient had no deployed code.
  With distinct sender/refund/recovery test wallets, status was `waiting` and history
  returned no records. No funds sent. The order response did not prove the source
  address's binding or recorded recovery owner; actual Puddle delivery remains untested.
- Relay's Base depository `0x4cd00e387622c35bddb9b4c962c136462338bc31` matches
  Sourcify's verified runtime byte-for-byte. A local fork at Base block **51988385**
  confirmed user-signed withdrawal rejection before and after a simulated year;
  an administrator could replace the authorizer and transfer to a different recipient
  without depositor consent. Only simulated funds moved. This checks depository
  permissions, not the source-address implementation or the signing network's security.
- Across's published Base factory still resolves to beacon
  `0xB7eBaD46Ae4Ccbd0d9676ee1A34Ceb0136388133`, with nonzero owner and implementation
  matching the manifests. This has not been tied to an API-created address or audited
  bytecode. Earlier authenticated API attempts hit Cloudflare error 1010; access and
  the route's recovery proofs remain unverified.
- The recipient confirmed wallet receipt in the first Arbitrum pilot on 29 September.
  Revised contracts, cross-chain receipt and private spending still need live tests.

## Other cross-chain candidates

Research shortlist, not approvals. No funds moved in these checks.

- **Eco Routes — closest fit for ordinary transfers.** Its
  [per-intent vaults](https://docs.eco.com/concepts/vaults) accept ERC-20 transfers
  before deployment. Eligible refunds go to `reward.creator`; this must be the user.
  [Source reviewed](https://github.com/eco/eco-routes/blob/ea5111ba0cd644089d04f922e05a5253dbd21fb8/contracts/IntentSource.sol)
  exposes permissionless refunds after expiry when no valid fulfillment proof exists.
  An unfunded 100 USDC Base → Arbitrum quote returned two routes: CCTP and Hyperlane.
  The quoted Base Portal reports **2.6**, while reviewed source is **2.12.0**.
  Verify that deployment and its selected proof system before relying on recovery.
  Neither quote establishes the strict walkaway requirement.
- **LI.FI Intents / Open Intents Framework — integration alternative.**
  [Orders](https://docs.li.fi/lifi-intents/intents-api/api-overview) have refund
  deadlines and support destination calls. Standard funding requires contract calls
  or signed authorization; ordinary-transfer funding needs an adapter. Safety depends
  on the [chosen delivery verifier](https://docs.li.fi/lifi-intents/architecture/oracle-systems).
- **Garden — atomic-swap alternative.**
  [Contracts](https://garden.finance/docs/contracts/evm) provide timeout refunds.
  [One-click mode](https://garden.finance/docs/developers/api/1click) delegates the
  swap secret to a service; premature disclosure can undermine atomic-swap safety.
  Prefer user-held secrets and verify the deposit adapter. The live asset API lists
  Base USDC but no Arbitrum USDC, so our target pair is not confirmed.
- **Circle Gateway — conditional USDC option.** It documents a
  [seven-day on-chain withdrawal](https://developers.circle.com/gateway/references/technical-guide)
  without its API. However, its contracts allow
  [owner upgrades](https://github.com/circlefin/evm-gateway-contracts/blob/c21d2d2e356d6566b6c7c3dde7ebcbdf1747590b/src/GatewayCommon.sol)
  and [pausing withdrawals](https://github.com/circlefin/evm-gateway-contracts/blob/c21d2d2e356d6566b6c7c3dde7ebcbdf1747590b/src/modules/wallet/Withdrawals.sol).
  This requires accepting Circle control, not our strict no-administrator model.

Prioritize Eco's exact quoted deployment, refund path and Hyperlane configuration.
Keep CCTP burns separate: completion still needs Circle's attestation. Check RAILGUN
compatibility and the Puddle recipient independently for any selected route.

## API

| Endpoint | Returns |
| --- | --- |
| `GET /v1/routes` | Supported chain/token pairs and limits |
| `POST /v1/deposits` | Destination address, fixed terms and recovery data |
| `POST /v1/deposits/{id}/quotes` | Token, amount, fees, expiry and funding instructions |
| `GET /v1/deposits/{id}` | Status and transaction hashes |

Address creation selects the protocol and destination chain. RAILGUN takes a
public `0zk` recipient and user-controlled `0x` recovery address. Privacy Pools
takes a registered Ethereum recipient, recovery address, token and desired private
amount so it can prepare its proof. Quotes use integer token units; cross-chain
quotes additionally take the source chain and asset.
The server selects its configured factory, relayer, fee recipient and supported routes.
A retry key returns the same address for identical creation inputs; changed inputs
are rejected. Quotes may change while the address is unspent.
Clients verify the destination configuration and save recovery data before funding.
The API can see recipient/address mappings; keep them out of public logs.

## Operating rules

- Itemize bridge costs, destination gas, the **0.1% service fee** and RAILGUN's fee.
  Collect the service fee once. Set explicit slippage limits and check guaranteed
  bridge output against the shielding quote; indicative output is not a guarantee.
- Track `awaiting_funds → bridging → awaiting_shield → shielding → shielded`, with
  separate refund, recovery and failure outcomes. Observe ambiguous submissions
  before retrying. Verify shielding from the destination transaction.
- Our contracts shield once. Detect partial, repeated and late payments;
  amounts arriving after shielding require recovery.
- Gas above the accepted cap must wait or lead to recovery, never a higher charge.
  Do not promise recovery for unsupported source chains or tokens without testing it.

Failed shielding cannot undo a completed bridge. Destination refunds may also reach
Puddle; distinguish them from successful fills. Never park funds in shared bridge contracts.

RAILGUN's [current wallet code](https://github.com/railgun-community/wallet/blob/5c9d04c844879b8377d91775052e88c836b48730/src/services/transactions/tx-unshield.ts#L263-L398)
derives the return address from token-transfer logs, with fallbacks to the transaction
sender. For our single-deposit flow, that should return tokens to Puddle, where
recovery still works. Verify the actual wallet version and transaction.

## Before building

Resolve the walkaway requirement before adopting either provider. A successful
funded transfer or refund would test operations, not remove administrator powers.

Questions prepared for Relay; not sent:

1. Does another deposit-address/settlement mode provide a user-only on-chain exit
   without Relay, its approved signers or administrator cooperation? Provide contracts
   and the exact recovery procedure before sweeping and after entering the depository.
2. For strict Base → Arbitrum USDC quotes, provide address derivation, the recorded
   recovery-owner binding, deployed signing configuration and matching audit coverage.
3. Is bridging to a Puddle contract that subsequently shields into RAILGUN supported?
   If screening rejects a fill, can the user still recover independently?

For Across, request the API address's exact factory/implementation, withdrawal proof
and administrator permissions, plus any immutable mode with user-only recovery.
Keep wallet receipt separate from private spending and Proof-of-Innocence readiness.
