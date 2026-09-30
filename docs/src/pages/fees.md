---
showAskAi: false
outline: false
---

# Fees

The service charges **0.1% of the received balance**, rounded down, plus a gas charge in the deposit token. RAILGUN's own fee applies to the remainder.

The gas charge cannot exceed the limit fixed into the deposit address. It is a quoted charge, not an onchain measurement of gas spent.

## Local example

For a **100 USDC** demo deposit (local test tokens), using the fixed gas charge and 0.25% RAILGUN fee:

| | USDC |
| --- | ---: |
| Service | 0.1 |
| Gas | 0.2 |
| RAILGUN | 0.24925 |
| **Private receipt** | **99.45075** |

Fees are paid only when shielding succeeds. Failed transactions still cost the caller gas. [Recovery](/recovery) charges no service fee.
