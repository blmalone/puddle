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
