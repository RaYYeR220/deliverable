# Deliverable

**Options on tokenized US stocks that survive corporate actions and the closing bell.**

Reads real Solana mainnet accounts · the program targets devnet for the live demonstration · Token-2022 · physically settled in the real share · MIT

---

## The problem, stated exactly

A Solana program cannot find out what is true about a tokenized stock.

Pyth's on-chain `PriceUpdateV2` account has **no status field** — the legacy
`PriceStatus::{Trading,Halted,Auction}` enum did not survive into the pull-oracle model. So the only
on-chain signal that a US equity market is closed is `publish_time` going stale, and four completely
different conditions are indistinguishable from one another:

| condition | danger | how often |
|---|---|---|
| market closed — nights, weekends, holidays | none, expected | ~81% of the week |
| stock halted — LULD, news pending | extreme | rare, unpredictable |
| oracle outage | extreme | rare |
| early close — the half-day before Thanksgiving and Christmas Eve | moderate | twice a year |

The standard defence, `get_price_no_older_than`, is therefore **structurally wrong for equities**.
Reject stale prices and your product is dead four-fifths of the week — the regular session is 32.5 of
168 hours. Accept them and you transact at Friday's close during a Monday gap.

### And the other failure mode is worse, because it is invisible

Kamino's xStocks lending market holds **$22.8M** of tokenized-equity collateral
([public API](https://api.kamino.finance/kamino-market/5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua/reserves/metrics?env=mainnet-beta),
read 2026-09-22), and its AAPLx and NVDAx reserves price from entries 317 and 332 of Scope's
`OraclePrices` account. Here is that account, sampled twice ninety seconds apart on Sunday 2026-09-20 at 09:15 UTC — thirty-seven hours after the
NYSE closed — beside the price one share of each was trading at on-chain:

| | oracle, per token | moved in 90 s | timestamp advanced | slot advanced | multiplier | oracle, per share | on-chain, per share | basis |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| CRCLx | 91.8400 | **0.0000** | +82 s | +312 | 1.0 | 91.8400 | 89.3708 | **−268.9 bps** |
| HOODx | 119.8650 | **0.0000** | +82 s | +312 | 1.0 | 119.8650 | 117.0405 | **−235.6 bps** |
| COINx | 194.2150 | **0.0000** | +82 s | +312 | 1.0 | 194.2150 | 192.4424 | −91.3 bps |
| AAPLx | 336.7021 | **0.0000** | +82 s | +312 | 1.00326901 | 335.6050 | 333.2898 | −69.0 bps |
| NVDAx | 222.3476 | **0.0000** | +82 s | +312 | 1.00170120 | 221.9700 | 220.6316 | −60.3 bps |
| SPYx | 766.4572 | 0.0074 | +82 s | +312 | 1.00571456 | 762.1021 | 761.5214 | −7.6 bps |
| QQQx | 721.6674 | 0.1497 | +82 s | +312 | 1.00345608 | 719.1819 | 719.1442 | −0.5 bps |
| METAx | 669.7853 | −0.0238 | +82 s | +312 | 1.00285154 | 667.8808 | 669.9745 | +31.3 bps |

Scope prices one unscaled token. The on-chain market price, Jupiter price v3 `usdPrice`, is per
share, and one token is `multiplier` shares, so the oracle is divided by the multiplier before the
two are compared. The multipliers in full, read from the mints: AAPLx 1.0032690125398187, NVDAx
1.001701196801074, SPYx 1.005714560286254, QQQx 1.0034560758968376, METAx 1.0028515433272898.

The timestamp advances. The slot advances. The price does not: AAPLx, NVDAx, CRCLx, HOODx and COINx
did not move at all, and SPYx, QQQx and METAx moved by cents. **Every freshness check a program can
perform passes**, on a number that is economically thirty-seven hours old.

Read like for like, the table separates the ETFs from the single names. The oracle holds still. The
ETFs, SPYx and QQQx, trade within 8 bps of it while the reference market is shut. We did not
observe the market-maker quotes that would say why. The single names with crypto beta drift away from it: CRCLx sat 2.7% below
the oracle and HOODx 2.4% below it. Those two are the headline. COINx sat 0.9% below, and AAPLx and NVDAx, the two entries
Kamino's reserves price from, 0.7% and 0.6% below.

Reproduce it yourself — the two-sample gap is the point:

```bash
SOLANA_RPC_URL=<your rpc> python scripts/measure-basis.py --gap 90
```

Pinned snapshot: [`docs/evidence/weekend-2026-09-20.json`](docs/evidence/weekend-2026-09-20.json).
Your numbers will differ. Inside a regular session the gap is far smaller, though not zero, since
Jupiter's price aggregates on-chain trades: in-session reads on 2026-09-22 between 15:54 and 16:15 UTC
put SPYx between −8.5 and +2.2 bps and QQQx between −8.9 and +11.1 bps like for like, and every other
entry within 50 bps except one COINx read of +111.3 bps at 16:13 UTC. That is the mechanism, not a
retraction.

**This is not a weekend artifact.** Here is the same command on a Tuesday, at 08:11 UTC, in the
ordinary overnight window five hours before the opening bell
([`docs/evidence/overnight-2026-09-22.json`](docs/evidence/overnight-2026-09-22.json)):

| | oracle, per token | moved in 90 s | timestamp advanced | slot advanced | multiplier | oracle, per share | on-chain, per share | basis |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| CRCLx | 94.4700 | **0.0000** | +84 s | +315 | 1.0 | 94.4700 | 91.4093 | **−324.0 bps** |
| COINx | 200.9850 | **0.0000** | +85 s | +315 | 1.0 | 200.9850 | 195.5922 | −268.3 bps |
| HOODx | 123.3000 | **0.0000** | +84 s | +315 | 1.0 | 123.3000 | 120.3939 | **−235.7 bps** |
| NVDAx | 227.7117 | **0.0000** | +84 s | +315 | 1.00170120 | 227.3250 | 226.3548 | −42.7 bps |
| AAPLx | 340.0982 | **0.0000** | +84 s | +315 | 1.00326901 | 338.9900 | 338.2346 | −22.3 bps |
| SPYx | 777.1273 | −0.0089 | +85 s | +315 | 1.00571456 | 772.7116 | 772.6887 | −0.3 bps |
| QQQx | 742.6743 | −0.0389 | +85 s | +315 | 1.00345608 | 740.1164 | 740.4859 | +5.0 bps |
| METAx | 747.2435 | +0.5612 | +84 s | +315 | 1.00285154 | 745.1188 | 745.7180 | +8.0 bps |

The same split: SPYx and QQQx within 5 bps of the oracle, CRCLx 3.2% and HOODx 2.4% below it, and
COINx 2.7% below it this time. It recurs every night, not once a week.

And to be precise about what is and is not being claimed: **the oracle is not broken and it is not
permanently frozen.** Between those two snapshots it moved a great deal — NVDAx 222.35 → 227.71,
METAx 669.79 → 747.24 — because the market opened on Monday and it tracked. While the reference
market is shut it holds still: over ninety seconds, in both pinned reads, AAPLx, NVDAx,
CRCLx, HOODx and COINx did not move at all, and SPYx, QQQx and METAx moved by cents (+0.0074, +0.1497
and −0.0238 on Sunday; −0.0089, −0.0389 and +0.5612 on Tuesday). That is correct behaviour for a
reference feed and catastrophic behaviour for anything that settles against it without knowing the
difference. Telling those two situations apart is what this program does.

### The first version of these tables was wrong by the multiplier

The first version of these tables set Scope's price for one unscaled token against Jupiter's price
for one share, without converting either. The two units differ by exactly the mint's
`ScaledUiAmount` multiplier, so every xStock whose multiplier is above 1.0 was misstated. That is the
mistake this project exists to prevent, and we made it in our own measurement. One row both ways:

| AAPLx, 2026-09-20 09:15 UTC | oracle | on-chain, per share | basis |
|---|---:|---:|---:|
| first version: per token against per share | 336.7021 | 333.2898 | −101.3 bps |
| corrected: 336.7021 ÷ 1.00326901, per share | 335.6050 | 333.2898 | −69.0 bps |

CRCLx, HOODx and COINx are unaffected: their multiplier is 1.0, so one token is one share. The rule
that `scripts/measure-basis.py`, the app's basis panel and `verify-onchain` check 2 now apply is

```
oracle_per_share = scope_price / effective_multiplier
basis            = (dex − oracle_per_share) / oracle_per_share
```

where the effective multiplier is `newMultiplier` once `newMultiplierEffectiveTimestamp` has passed,
and `multiplier` before it. The script and the panel print the bare figure beside the corrected one,
so the difference stays visible. SPYx carries the largest multiplier of the eight, which makes it the
cleanest check: across five in-session reads on 2026-09-22 between 15:54 and 16:15 UTC it sat between
−8.5 and +2.2 bps from the oracle like for like, and between −54.6 and −65.3 bps bare.

The pinned JSON files are untouched. Their stored `basis_bps` field was computed bare. The tables
above are recomputed from the raw `oracle_price` and `dex_price` inside them, with the multiplier
each mint had in force at the read: every one of those multipliers took effect before
2026-09-20 09:15 UTC (the latest, QQQx, at 2026-09-19 23:00 UTC), read from the mints on 2026-09-22.

### Meanwhile the unit itself moves

Every corporate action on an xStock — dividend, split, reverse split — is a change to the Token-2022
**ScaledUiAmount** multiplier on the mint. There is no event, no label, and no corporate-action feed
anywhere on Solana. Netflix went ten-for-one on-chain as `1.0 → 10.0`. CrowdStrike went four-for-one
as `1.0 → 4.0`. On 2026-09-22, 388 of the 930 xStock mints on Jupiter's verified token list carried
a multiplier other than 1.0.

The raw balance never changes, so anything doing arithmetic on raw amounts is silently wrong, and on
a split it is wrong by a factor of ten. The RPC does not even agree with itself: `getTokenSupply`
and `getTokenAccountBalance` apply the multiplier, and `getTransaction` transaction meta does not.

There is no options market on tokenized equities on Solana. This is why.

---

## What this is

Two things, in one program.

**The rail** publishes what is true about a tokenized security, on-chain, for anyone to read:

- **Market session, computed rather than fetched.** Market hours are public and knowable in advance,
  so determining "the market is closed" needs no oracle — it needs arithmetic. The program converts
  `Clock::unix_timestamp` to US Eastern civil time, applies the real DST rule, and consults a
  committed calendar of holidays and half-days. The calendar we commit is **the price publisher's
  own published schedule**, so the gate cannot disagree with the feed it guards.
- **Price, normalised from a pluggable source**, with a required second source. Scope publishes two
  independently-sourced entries per security, and their divergence is the confidence signal that
  neither entry carries on its own.
- **The corporate-action multiplier**, read straight off the mint, including the change that has been
  scheduled but has not taken effect yet.
- **Halt**, attested separately, because it is the one thing that cannot be computed.

**The venue** writes European, physically-settled covered calls against that rail.

---

## The two mechanisms

### 1. Splitting the four states

Nothing is asked to tell us all four. Each condition comes from the cheapest source that can be
trusted for it, and the gate checks them in that order — so the most frequent case, a closed market,
is decided by arithmetic before any oracle is read.

| state | source | trust model |
|---|---|---|
| market closed, early close | computed on-chain from the committed calendar | deterministic, no oracle |
| halted | attested feed | signed, not self-declared |
| oracle outage | price staleness **evaluated only inside an open session** | on-chain |
| price unreliable | divergence between two independent sources | on-chain |
| issuer intervention | the mint's own `Pausable` extension | on-chain |
| unknown code in the transfer path | the mint's `transferHook.programId` becoming non-null | on-chain |

That last row deserves a note. Every xStock carries an initialised-but-empty transfer hook whose
authority is live. If it is ever filled, arbitrary code runs on every transfer. We refuse to move
collateral into unknown code rather than discover it in production.

**Every refusal is a typed code emitted as an on-chain event.** The failure is the artifact.

### 2. The adjustment invariant

A contract covers a fixed **raw** amount. The strike is quoted per **UI** unit — per adjusted share,
the thing a human means by "a share". When the multiplier moves `m₀ → m₁`:

```
ui_size = raw_size × m₁
strike  = strike₀ × m₀ / m₁

⇒ strike × ui_size  is invariant
```

One formula covers a six-basis-point dividend and a ten-for-one split identically, so **the event
never has to be classified**. A ten-for-one split turns one option on one share at $500 into one
option on ten shares at $50: same dollars, same tokens delivered. That is the OCC's
adjusted-deliverable rule in one line of integer arithmetic.

Two consequences matter more than the formula:

- **Correctness does not depend on anyone calling an adjustment instruction.** The strike is derived
  from the mint's own extension, read inline at settlement, in the same transaction. Nothing can go
  stale and nobody has to be trusted. There is an `acknowledge_adjustment` instruction, but it only
  emits an event so indexers and the interface can show the re-cut.
- **It is tested against history, with a negative control.** The Netflix ten-for-one, the CrowdStrike
  four-for-one and a real AAPLx dividend are replayed through the engine, asserting notional
  invariance — and the same series with adjustment disabled must **fail** that assertion, so a green
  test cannot be vacuous.

No floating-point arithmetic is used. The extension stores an IEEE-754 `f64`; the program decodes
the bits into 1e12 fixed-point integers, so every number it produces is reproducible off-chain and
the rounding direction is chosen rather than inherited.

---

## Repository

```
programs/deliverable/   the program: rail + venue
keeper/                 multiplier watch, corporate-action history, oracle reader
market/                 the Meteora DBC curve for an option series
sdk/                    TypeScript client, including multiplier-correct balances
app/                    landing and application
scripts/                measurement and fixtures
docs/evidence/          pinned snapshots
```

## Running it

```bash
pnpm install
anchor build --tools-version v1.52 --arch v0   # see docs/BUILDING.md for why these flags
cargo test --manifest-path programs/deliverable/Cargo.toml
```

Tests run under LiteSVM against **real mainnet account dumps** — the real AAPLx mint with its real
multiplier, the real Scope oracle account. There is no mock oracle: the only Scope account the tests
accept is the real dump, and the tests that plant a copy under another owner do so to show the
program rejects it. The program, the SDK and the tests use real mints only. The one stand-in token in
the repository is in `market/`: devnet has no xStocks, so the devnet run of the series market quotes
in a Token-2022 stand-in with 8 decimals (`AAPLd`). Everything that reads or targets mainnet uses the
real mints ([`MOCKS.md`](MOCKS.md)).

## Honest limits

See [`MOCKS.md`](MOCKS.md) for the exact line between what is real and what is a convention, and
[`CLAIMS.md`](CLAIMS.md) for every public claim tagged by evidence tier with an explicit
not-claimed list. In short: covered calls only, European exercise, no implied-volatility model, no
liquidation engine, and no compliance gate — xStocks are bearer tokens with off-chain eligibility
and we do not pretend otherwise.

## Licence

MIT.
