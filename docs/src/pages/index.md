---
showAskAi: false
outline: false
---

# How it works

Send tokens to a normal Ethereum address. The relayer deposits them into your RAILGUN or Privacy Pools private balance.

1. Choose a recipient, user-owned recovery wallet, token and amount.
2. Create a deposit address and review the fee quote.
3. Send tokens to the address. The relayer collects fees and deposits into the pool.

CREATE2 lets the contract's address be calculated before deployment. Its recipient,
recovery rights and factory fee rules cannot change. Quotes are separate from address
creation. RAILGUN permits changing token and amount; [Privacy Pools](/privacy-pools)
must preserve the private deposit prepared in its proof. Each address executes once;
excess funds remain recoverable.

## Use cases

Fund your private wallet, receive payments, or accept payouts from apps that send ordinary token transfers.

## Try it locally

Run `npm run dev` from the repository and open the [app](http://127.0.0.1:5173).
The web demo uses RAILGUN. It provides test tokens and verifies the private receipt.
Nothing is sent to a public network. Privacy Pools has a separate integration test suite.
