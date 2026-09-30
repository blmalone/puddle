---
showAskAi: false
outline: false
---

# How it works

Send tokens to a normal Ethereum address. The relayer deposits them into your RAILGUN private balance.

1. Create an address for your recipient, token, recovery wallet and fee limits.
2. Send tokens to it with an ordinary transfer.
3. The relayer collects the agreed fees and shields the remainder into RAILGUN.

CREATE2 lets the contract's address be calculated before deployment. Its destination and fee limits cannot change. Each address shields once; use a fresh address for each deposit.

## Use cases

Fund your private wallet, receive payments, or accept payouts from apps that send ordinary token transfers.

## Try it locally

Run `npm run dev` from the repository and open the [app](http://127.0.0.1:5173).
It provides test tokens and verifies the private receipt. Nothing is sent to a public network.
