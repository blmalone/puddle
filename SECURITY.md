# Security

The contracts and SDK are unaudited. This repository demonstrates local deposits;
it is not a production service. An earlier Arbitrum pilot does not validate the
current contracts. See the [release requirements](ROADMAP.md).

- Verify recipient instructions, recovery ownership and deployment before funding.
- Save recovery data. Puddle cannot reset keys or retrieve already-private funds.
- The demo owns disposable test wallets. Keep it bound to localhost and use test funds.
- Pool governance and screening remain outside Puddle's control.

## Dependencies

Install from the lockfiles with `--ignore-scripts`. Overrides pin fixes for
transitive dependencies; they do not replace the protocol SDK or cryptography.
The docs' TOML override retains the parser interface used by its Markdown plugin.

`npm audit` still reports upstream RAILGUN dependencies, including legacy Web3
networking, Swarm archive tooling and ethers v5's elliptic dependency. Puddle does
not use these legacy transport or signing APIs. Disabling install scripts limits
installation-time exposure; it does not establish that the dependency tree is safe
for production. Resolve or formally assess these findings before a public service.
Do not use `npm audit fix --force`: its suggested RAILGUN downgrade changes the protocol SDK.

Run `npm audit`, `npm audit --prefix docs` and
`npm audit --prefix test/privacy-pools` to check the current lockfiles.

For a suspected vulnerability, open an issue requesting a private reporting channel
without exploit details, keys or recovery files. No bounty program is offered.
