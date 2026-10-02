---
showAskAi: false
outline: false
---

# Fees

The service charges **0.1% of the quoted deposit amount**, rounded down, plus a gas charge in the deposit token. The selected pool's own fee also applies. Any excess balance stays recoverable.

The factory fixes each supported token's ceiling:

```text
maximum gas charge = fixed allowance + deposit amount × basis points / 10,000
```

The 0.1% service fee is separate. Quotes can change without changing the address,
but cannot exceed this ceiling or consume the whole deposit. The charge is quoted;
it does not measure actual gas spent. The relayer can charge up to the ceiling.
If gas is too expensive, it must wait or leave the funds recoverable.

This follows the fee pattern in Across's published
[deposit-address implementation](https://github.com/across-protocol/contracts/blob/a634bea927668519c748e46036181c89c7bd9b40/contracts/periphery/counterfactual/CounterfactualDepositSpokePool.sol):
fixed destination instructions, a later execution fee and an onchain ceiling.
Across verifies its service's fee signature; Puddle restricts execution to its
designated relayer. Neither mechanism proves the user accepted an exact quote.
Apps should distinguish the estimated charge from the enforced maximum. Funding
still needs only an ordinary transfer, with no token approval or extra signature.

Privacy Pools quotes must preserve the net amount in the prepared deposit proof.

Production ceilings have not been chosen. The local factory uses a test allowance
of 2 USDC plus 0.5%; the demo's actual gas charge is 0.2 USDC.

## Local example

For a **100 USDC** demo deposit (local test tokens), using the fixed gas charge and 0.25% RAILGUN fee:

| | USDC |
| --- | ---: |
| Service | 0.1 |
| Gas | 0.2 |
| RAILGUN | 0.24925 |
| **Private receipt** | **99.45075** |

Fees are paid only when shielding succeeds. Failed transactions still cost the caller gas. [Recovery](/recovery) charges no service fee.
