# Devnet deployment

These steps deploy the Deliverable program to devnet and have its refusal gate decide on real Pyth
equity prices. Run them in order from a clean checkout. The addresses and signatures from the
2026-09-22 runs are listed in [`PROOF.md`](../../PROOF.md) under "Deployments: the program on
devnet", and every script appends what it sends to [`deployment.json`](deployment.json).

The program on devnet was **upgraded** on 2026-09-22 after a self-audit, and the audit changed two
account layouts. The state accounts created before the upgrade are still on chain and are no longer
usable; [After an upgrade that changes a layout](#after-an-upgrade-that-changes-a-layout) below says
why, and why the scripts take a `--calendar-id` and a `--new-mint`.

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

The build on chain now is 458,040 bytes, sha256
`53d5da025a9eae4d89abc2faac136721995eaff5280131326e9d9f7b6014d572`. The first deploy, before the
audit, was 428,928 bytes, sha256
`93160d0fa7fe163a663c503300cd0b6b077b8d7895b8225e39d9291612521b41`; it is kept in
`deployment.json` under `history.initialDeploy` because artifacts produced by it are evidence about
it and not about the current binary. For why each flag is there, see
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

### Upgrading

A later build that is larger than the first one does not fit the programdata account, so extend it
first:

```bash
solana program extend DnLxRcayAcjUFFuLjobQmJ7K75EgDRGFkUj5tfWcMCaa 40000 --url "$DEVNET"
# then the same deploy command as above
```

After an extend, `solana program dump` returns the whole programdata payload, so it is longer than
the `.so` and its sha256 will not match. Compare the first `$(stat -c %s target/deploy/deliverable.so)`
bytes; the rest is the zero padding the extend left:

```bash
head -c "$(stat -c %s target/deploy/deliverable.so)" /tmp/onchain.so | sha256sum
```

## 3. Scripts

```bash
cd scripts/devnet
pnpm install
```

The Pyth receiver SDK depends on `@coral-xyz/anchor` 0.29, which would pull in an old
`@solana/web3.js`. `package.json` pins a single web3.js version through `pnpm.overrides`.

Every script takes the same two selectors, so the deployment is reproducible rather than a one-off:

| flag | scripts | meaning |
|---|---|---|
| `--calendar-id=<u16>` | `init`, `register`, `probe`, `read` | which `["calendar", id]` PDA to use. Defaults to the `calendarId` in `deployment.json`, else 1. `CALENDAR_ID=<n>` does the same thing and survives an `&&` chain. |
| `--new-mint` | `mint` | create the stand-in under the next unused `keys/standin-mint-N.json` instead of reusing the recorded one |
| `--mint-key=<name>` | `mint` | use `keys/<name>.json` exactly; how you resume a run that failed after the keypair was written |
| `--mint=<pubkey>` | `register` | register a mint other than the recorded one |
| `--open` / `--closed` | `probe` | force a flow instead of picking one from the chain clock |

`package.json` wires the common ones:

```bash
pnpm run init                 # registry + calendar
pnpm run mint                 # the stand-in mint the record names
pnpm run mint:new             # a fresh stand-in mint
pnpm run register             # register it
pnpm run probe                # probe, mode from the chain clock
pnpm run probe:open           # force the in-session flow
pnpm run probe:closed         # force the closed-session flow
pnpm run read                 # read the whole thing back
CALENDAR_ID=2 pnpm run recreate   # init + mint:new + register, all against calendar 2
```

### 3a. Registry and calendar

```bash
pnpm run init                      # the calendar the record names
pnpm run init --calendar-id=1      # a specific one
```

This sends `init_registry` with the wallet as authority and a new attestor keypair, written to
`keys/attestor.json`. Then it sends `init_calendar` (09:30 to 16:00 ET) and
`append_calendar_entries` with the 13 entries of `US_EQUITY_2026_2027` from
`programs/deliverable/src/state/registry.rs`. Those entries are Pyth's published `Equity.US.*`
schedule plus Labor Day 2027, which falls outside the twelve months that capture covers. The script
is idempotent.

Each entry's key is `(year << 16) | (month << 8) | day`. The year is part of the key: keyed on bare
MMDD, every entry fired in every later year and the following year's real dates were missing
altogether, which is the direction that reports a regular session on a day the exchange is shut.

### 3b. The stand-in mint

```bash
pnpm run mint                                 # keys/<recorded>.json
pnpm run mint:new                             # the next unused keys/standin-mint-N.json
pnpm run mint --mint-key=standin-mint-2       # that key exactly
```

This creates a Token-2022 mint with 8 decimals and these extensions:

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
Pausable) or with `pnpm run read`, which decodes all of them.

`--new-mint` picks the next free slot and generates the keypair before it sends anything, so a run
that fails after the keypair is written will skip that slot next time. Re-run it with
`--mint-key=<that name>` rather than `--new-mint`.

### 3c. Register the security

```bash
pnpm run register
pnpm run register --calendar-id=1 --mint=<pubkey>
```

This sends `register_security` for the stand-in mint with symbol `AAPLd` and
`SingleDeclared { primary: Pyth { feed_id: 49f6b65c…5688 (Equity.US.AAPL/USD), max_age: 3600 } }`.
The tolerances are the program defaults: `max_price_age` 60 s, `max_conf_bps` 100,
`max_divergence_bps` 150. `max_age` 3600 is the outer bound, as in the program's own tests. Past it,
the read fails outright instead of returning a typed refusal.

### 3d. Probe the gate

```bash
pnpm run probe            # mode chosen from the devnet clock
pnpm run probe:open       # force the in-session flow
pnpm run probe:closed     # force the closed-session flow
```

**In session** (US regular hours, 13:30 to 20:00 UTC while New York is on EDT, on a weekday the
committed calendar does not mark closed): the script fetches the latest `Equity.US.AAPL/USD` update
from `https://hermes.pyth.network`, sending the API key as a Bearer token. It posts the update
through the receiver with `@pythnetwork/pyth-solana-receiver` 0.16.0, in two transactions:

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

`--open` outside a session is allowed and is a different artifact, recorded as mode `open-forced`:
Hermes keeps publishing equity updates around the clock, so the update posts and `sync_security`
records it, and then `probe_security` still refuses `MarketClosed` — the calendar decides before any
oracle is read. It does not produce code 9 and is not a substitute for an in-session probe.

After each probe the script re-reads the SecurityState and prints `refusals` before and after. It
warns loudly if the counter did not move by exactly one, or if `last_refusal_ts` is not a plausible
timestamp near the chain clock. Both are the symptoms of a stale account layout.

### 3e. Read it back

```bash
pnpm run read
```

This reads the program, registry, calendar, the stand-in mint with every extension decoded, the
SecurityState, and each posted `PriceUpdateV2`. The SecurityState read includes `refusals`,
`last_refusal_code`, `last_refusal_ts`, the halt state including `lifted_ts`, and the Pyth price and
confidence it recorded.

The repo verifier checks the deployment independently:

```bash
cd ../ && DELIVERABLE_PROGRAM_ID=DnLxRcayAcjUFFuLjobQmJ7K75EgDRGFkUj5tfWcMCaa DELIVERABLE_CLUSTER=devnet pnpm verify
```

## After an upgrade that changes a layout

A program upgrade replaces the code and leaves every account exactly as it was. Anchor's
`#[account]` accounts are borsh, so an account written by an older build still deserialises — it
just stops meaning what it says, from the first changed field onward. Nothing errors.

That is what happened here. The audit added `lifted_ts: i64` to `HaltState`, which sits in the
middle of `SecurityState`, and widened `CalendarEntry.date_key` from `u16` to `u32`. The accounts
created before the upgrade were:

| account | on chain | current layout | consequence |
|---|---|---|---|
| `Registry` `DiK3Y7ZC…36Ls` | 74 bytes | 74 bytes | unchanged, reused |
| `MarketCalendar` id 0, `GcsF2uRF…tNAF` | 373 bytes, 12 entries of 5 bytes | 501 bytes, 7 bytes an entry | every `date_key` reads as garbage, so no holiday or half-day matches and the calendar silently has no exceptions |
| `SecurityState` `4d8cqHM7…J2fT` | 321 bytes | 329 bytes | everything from `halt` on is read eight bytes early: the gate ran with `max_price_age` 150, `max_conf_bps` 2 and `max_divergence_bps` 3000934913, and wrote `refusals` and `last_refusal_ts` where an older reader does not look |

The visible symptom was a probe that emitted the right `Refused` event and logged `refused code=1`,
while `refusals` did not move and `last_refusal_ts` read back as `72057595844812450`.

This program has no instruction that closes a PDA, so the accounts cannot be reopened at the right
size. The fix is a new seed:

```bash
CALENDAR_ID=1 pnpm run recreate     # init.ts --calendar-id, mint --new-mint, register
pnpm run probe:closed
pnpm run probe:open                 # in a regular session
```

`init.ts` skips the registry, initialises `["calendar", 1]` and appends the schedule to it;
`create-standin-mint.ts --new-mint` creates a mint under a new keypair, which gives
`["security", mint]` a new address; `register.ts` binds the new security to the new calendar.
`deployment.json` then points at the new accounts, and the old ones move under `history`, labelled
with the build that produced them. They are not deleted: the refusals they recorded were real, they
were just recorded by a different binary.

The decoders in `lib.ts` check every account's length against `8 + T::INIT_SPACE` for the current
program and refuse to decode a short one. That check is what turns this class of mistake from
plausible nonsense into an error message.

## Keys

`keys/` is gitignored. It holds the attestor keypair and the stand-in mint keypairs
(`standin-mint.json`, `standin-mint-2.json`, …) that the scripts generate on first run. Nothing in
this directory reads or writes the program keypair or the wallet except by path.
