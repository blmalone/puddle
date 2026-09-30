# Recovery

A standalone, static recovery interface for the deposit contracts. No deposit API,
relayer, account, analytics, external scripts or file uploads. Uses an injected
Ethereum wallet and its network connection. A blockchain connection is still required.

```sh
npm ci --ignore-scripts
npm run setup
npm run recovery:dev
```

Open http://127.0.0.1:5175. Load a recovery JSON file, connect its recovery wallet
on the specified chain, then check the balance. If needed, deploy the deposit
contract first. Recovery is a separate wallet transaction. No token approvals,
private keys or seed phrases are requested. Gas is paid by the recovery wallet.

The main demo offers a recovery download before funding. Its files refer to an
ephemeral local chain and a public test wallet; they are not live deposits.
Live preparation plans include a `recoveryFile` object; save that object alone as
JSON to import here. Older pilot contracts are not supported by this build.

## Deployment

```sh
npm run recovery:build
```

Publish **`.cache/recovery`** to a separate static site. The build generates its
intended subdomain in `CNAME` from `brand.json`: `recovery.<name>.link`. Configure
the custom domain and DNS at the hosting provider. The build does not change DNS
or deploy anything. Keep this site independent of the main app and API.

`_headers` contains security headers for hosts that support it. Apply equivalent
headers on other hosts, including `frame-ancestors 'none'`. Libraries and contract
artifacts are served locally; no CDN or hosted service is needed. Keep a copy of
the static build or serve a local build if the public domain is unavailable.

## Verification

The tool validates the file format and calculates the deposit address locally.
It compares the factory's complete onchain runtime code against the code built
from this checkout, with its fixed pool address inserted. Together these bind
the forwarder code and constructor settings. It also checks the network and
recovery owner before building each transaction; transaction data and code hashes
from imported files are never trusted.

Keep immutable, reviewed builds for each deployed contract version. A different
compiler, optimizer setting or contract source can change addresses and bytecode;
this tool rejects mismatches. Do not replace support for old deposits when shipping
new contracts. This implementation has not been independently audited.

File validation checks consistency, not that a file came from the original deposit
creator. Compare the deposit and recovery addresses with your saved records. Keep
the file private: it links deposit settings. It contains no spending keys.

Only funds still at the deposit address can be recovered. A relayer may shield
while recovery is pending; already shielded funds remain in the RAILGUN wallet.
The owner can also select another ERC-20 address or native currency to recover
mistaken or late transfers. Recovery is public and the owner cannot be changed.

Run `npm run test:recovery` for independent recovery, incorrect files, wrong
wallets/networks/contracts, mistaken assets and late-transfer checks on Anvil.
