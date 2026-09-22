# Devnet deployment

These steps deploy the Deliverable program to devnet and have its refusal gate decide on real Pyth
equity prices. Run them in order from a clean checkout. The addresses and signatures from the
2026-09-22 run are listed in [`PROOF.md`](../../PROOF.md) under "Deployments: the program on
devnet", and every script appends what it sends to [`deployment.json`](deployment.json).

## What devnet has, and what it does not

- **The Pyth Solana Receiver** (`rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`) and its Wormhole
  verifier (`HDwcJBJXjL9FpJ7UBsYBtaDjsBUhuLCUYoz3zr8SWWaQ`) are deployed on devnet. A Hermes update
  for `Equity.US.AAPL/USD` posts through them with full guardian verification, exactly as it would on
  mainnet. You need a Pyth API key for this: Hermes returns 401 for equity feeds without one.
- **There are no xStocks mints.** `create-standin-mint.ts` creates a Token-2022 mint that we control
  and gives it the same extension set as mainnet AAPLx. It is **a stand-in**: symbol `AAPLd`, name
  "AAPLx devnet stand-in", zero supply. Its own metadata says what it is.
- **There is no Kamino Scope account,** so no second, independently sourced AAPL price exists. The
  security is registered as `OracleBinding::SingleDeclared` on Pyth AAPL. The gate therefore
  refuses by design, with `SingleSource` (9) during the session and `MarketClosed` (1) outside it.
  No second source is added or synthesised, and no mock oracle is used.

## Prerequisites

- Solana CLI 3.1 (`solana`, `spl-token`), Anchor CLI 1.2, Node 24, pnpm
- `~/.config/solana/id.json` funded with about 2.3 devnet SOL. Deploying uses about 2.19 SOL, and
  almost all of that is programdata rent. The public faucet is rate-limited.
- In the repo `.env`: `HELIUS_API_KEY` for the devnet RPC and `PYTH_API_KEY` for Hermes. You can set
  `DEVNET_RPC_URL` to use a different endpoint. The scripts print only the RPC host, never the key.
- The program keypair `target/deploy/deliverable-keypair.json`. It is gitignored. Without it,
  deploy under a new id and set `DELIVERABLE_PROGRAM_ID` for every script below.

```bash
set -a; . ./.env; set +a
export DEVNET="https://devnet.helius-rpc.com/?api-key=$HELIUS_API_KEY"
```

## 1. Build

```bash
anchor build --tools-version v1.52 --arch v0
sha256sum target/deploy/deliverable.so
```

The 2026-09-22 build produced 428,928 bytes, sha256
`93160d0fa7fe163a663c503300cd0b6b077b8d7895b8225e39d9291612521b41`. For why each flag is there, see
[`docs/BUILDING.md`](../../docs/BUILDING.md).

## 2. Deploy

```bash
solana balance --url "$DEVNET"
solana-keygen new --no-bip39-passphrase -o /tmp/deliverable-buffer.json
solana program deploy target/deploy/deliverable.so \
  --program-id target/deploy/deliverable-keypair.json \
  --buffer /tmp/deliverable-buffer.json \
  --use-rpc --max-sign-attempts 100 --with-compute-unit-price 10000 \
  --url "$DEVNET"
solana program show DnLxRcayAcjUFFuLjobQmJ7K75EgDRGFkUj5tfWcMCaa --url "$DEVNET"
solana program dump DnLxRcayAcjUFFuLjobQmJ7K75EgDRGFkUj5tfWcMCaa /tmp/onchain.so --url "$DEVNET"
sha256sum /tmp/onchain.so     # must equal the build hash
```

Use the explicit `--buffer` keypair. With the plain `solana program deploy ... --program-id ...`
form, the first attempt failed mid-write with `Data writes to account failed: Custom error: Max
retries exceeded`. The buffer holds about 2.18 SOL of rent until the deploy finishes. With a buffer
keypair on disk, re-running the same command resumes the upload. Without one, you have to reclaim
the rent with `solana program close <buffer>` and start over.

## 3. Scripts

```bash
cd scripts/devnet
pnpm install
```

The Pyth receiver SDK depends on `@coral-xyz/anchor` 0.29, which would pull in an old
`@solana/web3.js`. `package.json` pins a single web3.js version through `pnpm.overrides`.

### 3a. Registry and calendar

```bash
pnpm tsx init.ts
```

This sends `init_registry` with the wallet as authority and a new attestor keypair, written to
`keys/attestor.json`. Then it sends `init_calendar` for calendar 0 (09:30 to 16:00 ET) and
`append_calendar_entries` with the 12 entries of `US_EQUITY_2026_2027` from
`programs/deliverable/src/state/registry.rs`. Those entries are Pyth's published `Equity.US.*`
schedule. The script is idempotent.

### 3b. The stand-in mint

```bash
pnpm tsx create-standin-mint.ts
```

This creates a Token-2022 mint with the keypair in `keys/standin-mint.json`, 8 decimals, and these
extensions:

| extension | value | why it is there |
|---|---|---|
| ScaledUiAmount | multiplier `1.0032690125398187` | the program reads it on every gated action |
| Pausable | not paused | the program reads it (code 6) |
| TransferHook | initialised, program id null | the program reads it (code 7) |
| PermanentDelegate | the wallet | as mainnet AAPLx |
| DefaultAccountState | Initialized | as mainnet AAPLx |
| ConfidentialTransferMint | authority set, manual approval, no auditor | as mainnet AAPLx |
| MetadataPointer + TokenMetadata | `AAPLd`, "AAPLx devnet stand-in", plus `standin_for` and `note` fields | labelling |

Check it with `spl-token display <mint> --url "$DEVNET"` (CLI 5.5 does not decode ScaledUiAmount or
Pausable) or with `pnpm tsx read.ts`, which decodes all of them.

### 3c. Register the security

```bash
pnpm tsx register.ts
```

This sends `register_security` for the stand-in mint with symbol `AAPLd` and
`SingleDeclared { primary: Pyth { feed_id: 49f6b65c…5688 (Equity.US.AAPL/USD), max_age: 3600 } }`.
The tolerances are the program defaults: `max_price_age` 60 s, `max_conf_bps` 100,
`max_divergence_bps` 150. `max_age` 3600 is the outer bound, as in the program's own tests. Past it,
the read fails outright instead of returning a typed refusal.

### 3d. Probe the gate

```bash
pnpm tsx probe.ts            # mode chosen from the devnet clock
pnpm tsx probe.ts --open     # force the in-session flow
pnpm tsx probe.ts --closed   # force the closed-session flow
```

**In session** (US regular hours, 13:30 to 20:00 UTC while New York is on EDT): the script fetches
the latest `Equity.US.AAPL/USD` update from `https://hermes.pyth.network`, sending the API key as a
Bearer token. It posts the update through the receiver with `@pythnetwork/pyth-solana-receiver`
0.16.0, in two transactions:

1. Wormhole `InitEncodedVaa`, `WriteEncodedVaa`, `VerifyEncodedVaaV1`
2. receiver `PostUpdate`, then `sync_security` and `probe_security`, in the same transaction

`sync_security` writes Pyth's price, confidence and publish time to the SecurityState.
`probe_security` runs the gate and records its verdict. The expected verdict is code 9
`SingleSource`. It comes after the staleness check (at most 60 s) and the confidence check (at most
100 bps) have passed on the real update. The update and encoded-VAA accounts are left open so you
can inspect them.

**Closed session**: the script sends only `probe_security`. The oracle slot gets the last posted
update, which the program does not read, because the calendar refuses first. The expected verdict is
code 1 `MarketClosed`.

### 3e. Read it back

```bash
pnpm tsx read.ts
```

This reads the program, registry, calendar, the stand-in mint with every extension decoded, the
SecurityState, and each posted `PriceUpdateV2`. The SecurityState read includes `refusals`,
`last_refusal_code`, `last_refusal_ts`, and the Pyth price and confidence it recorded.

The repo verifier checks the deployment independently:

```bash
cd ../ && DELIVERABLE_PROGRAM_ID=DnLxRcayAcjUFFuLjobQmJ7K75EgDRGFkUj5tfWcMCaa DELIVERABLE_CLUSTER=devnet pnpm verify
```

## Keys

`keys/` is gitignored. It holds the attestor and stand-in mint keypairs that the scripts generate on
first run. Nothing in this directory reads or writes the program keypair or the wallet except by
path.
