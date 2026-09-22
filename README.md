# Deliverable

**Options on tokenized US stocks that survive corporate actions and the closing bell.**

Solana mainnet · Token-2022 · physically settled in the real share · MIT

---

## The problem, stated exactly

A Solana program cannot find out what is true about a tokenized stock.

Pyth's on-chain `PriceUpdateV2` account has **no status field** — the legacy
`PriceStatus::{Trading,Halted,Auction}` enum did not survive into the pull-oracle model. So the only
on-chain signal that a US equity market is closed is `publish_time` going stale, and four completely
different conditions are indistinguishable from one another:

| condition | danger | how often |
|---|---|---|
| market closed — nights, weekends, holidays | none, expected | ~70% of the week |
| stock halted — LULD, news pending | extreme | rare, unpredictable |
| oracle outage | extreme | rare |
| early close — the half-day before Thanksgiving and Christmas Eve | moderate | twice a year |

The standard defence, `get_price_no_older_than`, is therefore **structurally wrong for equities**.
Reject stale prices and your product is dead 70% of the week. Accept them and you transact at
Friday's close during a Monday gap.

### And the other failure mode is worse, because it is invisible

Tokenized-equity lending on Solana marks against Kamino's Scope oracle. Here is that account,
sampled twice ninety seconds apart on Sunday 2026-09-20 at 09:15 UTC — sixty-one hours after the
NYSE closed:

| | oracle price | moved in 90s | timestamp advanced | slot advanced | on-chain market price | basis |
|---|---:|---:|---:|---:|---:|---:|
| CRCLx | 91.8400 | **0.0000** | +82 s | +312 | 89.3708 | **−269 bps** |
| HOODx | 119.8650 | **0.0000** | +82 s | +312 | 117.0405 | **−236 bps** |
| AAPLx | 336.7021 | **0.0000** | +82 s | +312 | 333.2898 | **−101 bps** |
| COINx | 194.2150 | **0.0000** | +82 s | +312 | 192.4424 | −91 bps |
| NVDAx | 222.3476 | **0.0000** | +82 s | +312 | 220.6316 | −77 bps |
| SPYx | 766.4572 | 0.0074 | +82 s | +312 | 761.5214 | −64 bps |

The timestamp advances. The slot advances. The price does not. **Every freshness check a program can
perform passes**, on a number that is economically sixty-one hours old, while the same asset trades
on-chain 2.7% away from it.

Reproduce it yourself — the two-sample gap is the point:

```bash
SOLANA_RPC_URL=<your rpc> python scripts/measure-basis.py --gap 90
```

Pinned snapshot: [`docs/evidence/weekend-2026-09-20.json`](docs/evidence/weekend-2026-09-20.json).
Your numbers will differ, and inside a regular session the basis should be small across the board.
That is the mechanism, not a retraction.

**This is not a weekend artifact.** Here is the same command on a Tuesday, at 08:11 UTC, in the
ordinary overnight window five hours before the opening bell
([`docs/evidence/overnight-2026-09-22.json`](docs/evidence/overnight-2026-09-22.json)):

| | oracle price | moved in 90s | timestamp advanced | on-chain market price | basis |
|---|---:|---:|---:|---:|---:|
| CRCLx | 94.4700 | **0.0000** | +84 s | 91.4093 | **−324 bps** |
| COINx | 200.9850 | **0.0000** | +85 s | 195.5922 | **−268 bps** |
| HOODx | 123.3000 | **0.0000** | +84 s | 120.3939 | **−236 bps** |
| NVDAx | 227.7117 | **0.0000** | +84 s | 226.3548 | −60 bps |
| AAPLx | 340.0982 | **0.0000** | +84 s | 338.2346 | −55 bps |

It recurs every night, not once a week.

And to be precise about what is and is not being claimed: **the oracle is not broken and it is not
permanently frozen.** Between those two snapshots it moved a great deal — NVDAx 222.35 → 227.71,
METAx 669.75 → 747.24 — because the market opened on Monday and it tracked. It freezes exactly while
the reference market is shut, which is correct behaviour for a reference feed and catastrophic
behaviour for anything that settles against it without knowing the difference. Telling those two
situations apart is what this program does.

### Meanwhile the unit itself moves

Every corporate action on an xStock — dividend, split, reverse split — is a change to the Token-2022
**ScaledUiAmount** multiplier on the mint. There is no event, no label, and no corporate-action feed
anywhere on Solana. Netflix went ten-for-one on-chain as `1.0 → 10.0`. CrowdStrike went four-for-one
as `1.0 → 4.0`. Sixty-six of a hundred xStocks are accruing dividends right now.

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
multiplier, the real Scope oracle account. There is no mock oracle and no mock token anywhere in
this repository.

## Honest limits

See [`MOCKS.md`](MOCKS.md) for the exact line between what is real and what is a convention, and
[`CLAIMS.md`](CLAIMS.md) for every public claim tagged by evidence tier with an explicit
not-claimed list. In short: covered calls only, European exercise, no implied-volatility model, no
liquidation engine, and no compliance gate — xStocks are bearer tokens with off-chain eligibility
and we do not pretend otherwise.

## Licence

MIT.
