---
showAskAi: false
outline: false
---

# Privacy Pools v2

Ordinary token transfer → Puddle deposit address → recipient's Privacy Pools balance.
The adapter is part of the main contracts and SDK. The web demo currently uses RAILGUN.
**Unaudited; tested locally, not deployed for production.**

## Flow

1. The recipient registers their public keys with Privacy Pools and backs up their
   wallet. Puddle never needs their private spending keys.
2. Puddle prepares a deposit proof and encrypted note using the recipient's registered
   Ethereum address. The deposit address commits to these exact instructions and
   the recovery owner, relayer and fee recipient.
3. The sender reviews the quote, saves recovery data and transfers the quoted amount.
4. The relayer deploys the address and deposits in one transaction. The recipient's
   wallet discovers the note; screening approval is needed for private spending.

Both protocols use the same Puddle fee policy, quote, execution and recovery code.
The Privacy Pools adapter only checks the committed deposit call. The shared
executor approves the quoted token and requires the pool to consume the exact net
amount. A mismatch reverts the whole transaction, including fees.

The proof fixes the token and private amount. A new gas quote can reuse the same
address and proof if the gross amount changes to preserve the net pool deposit.
A different private deposit needs a new proof and address. Each address executes once.

## API shape

The production REST API and background processing are not built yet. The intended
input is a chain, supported token, desired private amount, registered recipient
and user-owned recovery address. The server needs the SDK, proof files, pool settings,
a blockchain connection and its funded relayer wallet.

```ts
// Protocol-specific preparation, using the recipient's public key.
const { record, deposit } = await privacyPools.prepare(provider, session, {
  token, value, recipient, recovery, relayer, feeRecipient,
});

// Shared quote, funding checks and submission.
const execution = await privacyPools.quote(provider, record, {
  token, amount: totalToSend, gasFee, deadline,
}, deposit.callData);

// Return the address, fees and recovery data; wait for confirmed funding.
const tx = await relayDeposit(privacyPools, execution, relayerWallet);
// Save the hash before waiting; confirmation is not screening approval.
```

Amounts are integer token units. Total sent covers the private amount, the pool's
configured fee, Puddle's 0.1% and a capped gas charge. Puddle fees are collected only
when the pool deposit succeeds.

The UI follows the same sequence: enter details → review and save recovery data →
send → track the deposit and screening. A sending-wallet connection is optional
for an ordinary transfer. Registration and wallet backup happen first.

## Failures and recovery

| Situation | Outcome |
| --- | --- |
| Invalid or unregistered recipient | Reject before funding; complete Privacy Pools setup first. |
| Too little sent | Top up, obtain a viable new quote, or recover. The proof's net deposit must stay fixed. |
| Excess or late payment | Only the quoted amount deposits, once. The recovery owner can retrieve the rest. |
| Wrong asset | Ordinary ERC-20 tokens on the correct chain and accidentally received native currency are owner-recoverable. Wrong-chain recovery is not guaranteed. |
| Puddle unavailable, quote expired or pool call fails | Funds stay at the address. Refresh the quote, wait, or use independent recovery. A failed call collects no Puddle fees; the relayer pays transaction gas. |
| Screening delayed or rejected | Funds are already in the pool. The recipient can wait or use its public exit, called ragequit, with their keys and note backup. Paid fees are not refunded. |
| Recovery races with a deposit | The first successful transaction determines where the funds go. A Puddle recovery file cannot withdraw funds already in the pool. |
| Lost keys or wrong recipient | Puddle has no reset key. Client verification before funding is essential; a fixed contract does not prove the server originally chose the right recipient. |

The [recovery tool](/recovery) can deploy and recover a Puddle address using the
saved configuration and call hash. It needs no proof, SDK or relayer signature.
The recipient's protocol wallet and note backup remain necessary after the pool deposit.
Recovery is public; reusing its owner address links deposits.

## Tests

Both adapters run in the root Solidity unit, fuzz and transaction-sequence suite:

```sh
npm run setup:contracts
npm run test:contracts
```

Real Privacy Pools proof tests run separately:

```sh
npm run privacy-pools:setup
npm run test:privacy-pools
```

These require Node 24.12+, pnpm, Git LFS, Anvil and access to the currently private
[upstream repository](https://github.com/0xbow-io/v2-monorepo). Setup pins commit
`4d48c4feb874606ffd9eb309e16fbe846e3ceaf6` and verifies proof files against its LFS
hashes. Dependencies stay in ignored caches. Tests start their own local chain;
they do not accept real private keys or a public RPC override.

The tests cover deposit, note discovery, approved private withdrawal, quote refresh,
fee rollback, owner recovery and public exit from a backup while services are offline
and the pool is paused. These do not establish production screening acceptance,
ceremony-key safety or deployed upgrade permissions. Puddle has no upgrade authority;
the underlying Privacy Pools entrypoint remains upgradeable.
