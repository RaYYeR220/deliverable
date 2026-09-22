# market — a Meteora DBC pool per option series, quoted in the underlying stock

One covered-call series, one Dynamic Bonding Curve pool. The quote mint is the
tokenised share the call is written on, so the price the curve prints is the
**premium in shares per contract** and the writer's premium arrives as more of
the stock they already hold. A covered call becomes share accumulation.

```
base  token   the option series token          1 token = 1 contract
quote token   the xStock it is written on      Token-2022, 8 decimals
price         quote per base                   shares per contract = the premium
x-axis        cumulative inventory sold        contracts written
```

The bonding curve is not a launch ramp here. It is an option pricing surface
sampled in inventory space.

---

## Why this is a different DBC configuration, not a launchpad clone

There are **111** live `PoolConfig` accounts on mainnet already quoted in AAPLx
and **250** in NVDAx (measured 2026-09-22 via `getProgramAccounts`, memcmp on
`quote_mint` at offset 8). Decoding 25 of each:

| | existing stock-quoted configs | this one |
|---|---|---|
| base token decimals | 6 in 23/25 AAPLx and 22/25 NVDAx | 8 |
| curve points | 1 or 2 (25/25 NVDAx are exactly 2) | 16 |
| opening price | e.g. 8.3e-9 AAPLx per token (`2h1Yf3rmDVhf4NWyRpPqjaSZfx9sgWEfRW8sn6HuA7Aa`) | 0.0126 shares per contract, from Black-Scholes |

A two-point curve opening at 8.3e-9 of a share is a memecoin with a stock as the
unit of account. This config looks nothing like it, and every difference is
forced by the instrument rather than chosen for effect.

**1. Spot cancels out of the price.** Under the share numeraire the Black-Scholes
call is

```
C/S = N(d1) - m e^{-rT} N(d2)        m = K/S
d1  = [-ln m + (r + sigma^2/2) T] / (sigma sqrt T)
d2  = d1 - sigma sqrt T
```

Spot never appears. A pool quoted in the underlying can therefore be struck
correctly at inception from moneyness, time and vol alone — no USD oracle is
in the pricing path at all. That is a property of the *quote choice*, not of
clever code.

**2. The curve breakpoints are an implied-vol ladder in inventory space.** Each
of the 16 segment boundaries is priced with Black-Scholes at a higher implied
vol than the last, from `volAnnual` at zero inventory to
`volAnnual * (1 + inventoryVolPremium)` when the whole series is sold. That is
the standard market-maker inventory markup, expressed in the only variable an
option quote actually has. Monotonicity is then a theorem rather than a sort:
vega is strictly positive, so a strictly increasing vol ladder is a strictly
increasing price ladder.

**3. The liquidity weights make the vol ladder linear in inventory.** A DBC
segment absorbs `L_i * (1/sqrtP_{i-1} - 1/sqrtP_i)` base tokens, so the weights
are set to the reciprocal of that bracket. Measured spread across the 16
segments: **0.0000%** — every rung sells the same number of contracts, so the
marginal implied vol rises linearly in contracts written.

**4. There is a hard no-arbitrage ceiling, and only this quote asset can express
it.** A call is never worth more than the share it is written on, so the premium
can never exceed `contractSize` shares per contract. The builder refuses to emit
a curve whose top price breaches it, and `verify.ts` re-checks the bound against
the bytes on chain. In a SOL-quoted pool the sentence "this token can never be
worth more than one unit of the quote" is not expressible.

**5. Supply is bounded by collateral, so the fixed-supply mode is mandatory.**
The series is fully covered: total supply is exactly the number of contracts the
writer's vault has shares for. `tokenSupply` is set, `fixedTokenSupplyFlag` reads
back as 1 on chain, and leftover goes to the vault so unsold collateral is
released rather than stranded.

**6. The fee schedule is clocked to the option's life, as a model-risk charge.**
`activationType = Timestamp` and `totalDuration = expiry - now`, with an
exponential decay from 200 bps to the protocol floor of 25 bps. The reasoning is
not decoration: early in the series the quoted price is almost entirely extrinsic
value and therefore almost entirely model, while at expiry the series token is a
pure intrinsic claim with no model in it. The venue charges most where its own
number is least defensible.

**7. Fees and revenue are denominated in shares.** `collectFeeMode = QuoteToken`,
so the venue and the writer's vault are paid in the underlying equity, not in a
governance token. 80% of trading fees route to the creator.

**8. Graduation means the series is fully written.** `migrationQuoteThreshold` is
not a market cap someone liked; it is the quote the curve takes in when the whole
covered inventory is sold. At that point the pool migrates to DAMM v2
(`cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`) at 25 bps and the series trades
secondary through to expiry, where time decay gets priced by arbitrage rather
than by the config.

---

## Honest limits

Read this part before believing any number above.

- **`volAnnual` is a parameter, not a market.** It is whatever the series creator
  types. There is no calibration to listed option prices, no surface, no skew by
  strike, no term structure. Two series on the same name can disagree and nothing
  in the system objects.
- **The curve is struck once and does not re-mark.** Spot moves and time passes,
  the curve does not. For an out-of-the-money series that drift favours the
  seller as expiry approaches. Mitigations: keep series short-dated, create a new
  pool per (strike, expiry), and let the post-graduation DAMM v2 book do price
  discovery. A re-marking venue is a different design and is not this one.
- **`inventoryVolPremium` is a convention too.** 50% at full inventory is a
  plausible market-maker markup; it is not derived from a risk model.
- **Default `riskFreeRate` is 0.** Over a 30-day horizon it moves the premium by
  a few tenths of a percent. Pass `--rate=0.04` if that matters to you.
- **Black-Scholes assumes European exercise, no dividends and constant vol.**
  xStocks accrue dividends through a `ScaledUiAmount` multiplier rather than cash
  payments, which the model does not see.
- **Collateral is not enforced here.** This package sizes supply to a contract
  count. Binding that supply to real deposited shares, and settling at expiry, is
  the on-chain program's job, not the market layer's.
- **About 42% of supply seeds the DAMM v2 pool rather than selling on the curve.**
  That is DBC's own split, driven by the ratio of start price to migration price;
  a tighter curve leaves more behind. Those contracts stay collateralised and the
  vault owns the migrated LP position, but they are not premium income.
- **The devnet run uses a stand-in quote mint.** See below for exactly what that
  does and does not cover.

---

## What was verified, and where

### Devnet — the full path, end to end

Wallet `4EtAFmWtCzMxyUku7NofttEPLDWniigFAEL7KmCeCYKo`, series `AAPL261016C352`
(AAPL 2026-10-16 352 call, 30% vol, 1000 contracts).

| step | signature |
|---|---|
| stand-in quote mint | `3fYZDZuH5R87ZLBWts77bgNRErBpMGVKEmEsExVyHkegV62LguSGZpsu2UxcyyGCT1hgvjpWCn6eByKoipVaEZCq` |
| `create_config` | `2744ZVuMek7NzNxLKXsScJjRjnDoHg9C27THejW78QPVmg384GNQpWsacuxG6mFyXmLT1WKvo75YrXaecZS3PRXk` |
| `initialize_virtual_pool_with_token2022` | `2KUNZatcvJWtZnoZsmkQFXfAcyoHWo9geYtZTrNRhFgR5rGtUCx957YmG8FeGTeba7UGvray3zZC4CMZdwG4VSK3` |
| `swap2` buy, 25 contracts | `4v2nkiBbWpBSYj8C53KQWFTRUNigrjqNkojfrRYcRrozqThu5YyjfitFD857UF792chXJhwAd6kVKYUmrejmJTJV` |

```
config      1prrFtvBA586zykqwzKkdqhK1zQ87PgaVzFk7kZLrJk
pool        5YbMsAxCcgTkpyhzegHLq52faiSuUNTAkVmGgCNW1H1L
series mint B9vKorB3wdL7tcxF5yNuMQbK4cS5ew6GNd13VaFBDoJ3
quote mint  8FBsKWYuBWwn2zo2viDrjdMeN8CrVH5WbaY8YaJMvJDm   (Token-2022, 8 dec, stand-in)
```

`pnpm run verify --series=AAPL261016C352` reads all of it back and passes
**78 of 78** assertions, including every one of the 16 curve points by
`sqrtPrice` and `liquidity`. A pool that has never traded is asserted to sit
*exactly* on the Black-Scholes premium; once it has traded the assertion becomes
that it only ever moved up the ladder.

The `swap2` buy: 25 contracts for 0.32912927 shares, an effective premium of
0.01316517 shares per contract against an opening curve price of 0.01262378 —
the inventory markup, working.

### Mainnet — simulated against live state, nothing spent

The real transaction, quoted in AAPLx `XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp`,
simulated against mainnet with a funded third-party fee payer and no signatures:

```
=== simulate create_config ===
  err:            null
  units consumed: 135626
    Program log: Instruction: CreateConfig
    Program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN success
```

And the negative control, the same transaction with `--no-badge`:

```
  err: {"InstructionError":[0,{"Custom":6080}]}
    Program log: AnchorError occurred. Error Code: InvalidTokenBadge.
                 Error Number: 6080. Error Message: Invalid token badge.
```

Which is the whole point of the token badge, demonstrated rather than asserted.

### Costs, measured not estimated

Devnet wallet balance deltas, and the same rent recomputed against mainnet's
rent schedule (identical, because rent parameters are cluster-independent):

| account | bytes | rent (lamports) | SOL |
|---|---|---|---|
| PoolConfig | 1048 | 5,974,080 | 0.00597408 |
| VirtualPool | 424 | 2,804,160 | 0.00280416 |
| series mint (Token-2022) | 356 | 2,458,720 | 0.00245872 |
| base vault | 165 | 1,488,440 | 0.00148844 |
| quote vault | 165 | 1,488,440 | 0.00148844 |
| **rent total** | | **14,213,840** | **0.01421384** |
| base fees, 2 tx x 2 signatures | | 20,000 | 0.00002 |
| **measured total on devnet** | | **14,233,840** | **0.01423384** |

A mainnet run costs the same 0.01423384 SOL plus whatever priority fee is
needed at the time. Nothing else is required to *open* the market: DBC mints the
series token itself, so no xStocks are needed until someone buys. `poolCreationFee`
is set to 0.

---

## Commands

```bash
pnpm install
pnpm typecheck

# pricing only, no network
pnpm run curve --selftest                       # Black-Scholes + curve invariants
pnpm run curve --strike=352 --days=30 --vol=0.30

# devnet
pnpm run devnet-quote                           # one-time Token-2022 stand-in quote mint
pnpm run series --dry-run                       # decode and print, send nothing
pnpm run series --expiry=1792180800 --strike=352 --vol=0.30 --execute
pnpm run verify --series=AAPL261016C352
pnpm run quote  --series=AAPL261016C352 --contracts=25
pnpm run quote  --series=AAPL261016C352 --contracts=25 --buy --execute

# mainnet, double-gated: --mainnet does nothing without --yes
pnpm run series --mainnet --yes --strike=352 --dry-run
pnpm run series --mainnet --yes --strike=352 --simulate --payer=<funded account>
pnpm run series --mainnet --yes --strike=352 --simulate --no-badge --payer=<funded account>
pnpm run series --mainnet --yes --strike=352 --execute     # spends real SOL
pnpm run verify --mainnet --yes --series=<SYMBOL>
```

`pnpm run` is required rather than bare `pnpm <script>`: `config` and `create`
are pnpm's own subcommands, which is why the script is named `series`.

### Flags

| flag | default | meaning |
|---|---|---|
| `--underlying=AAPL` | AAPL | ticker; resolves the xStock quote mint |
| `--quote-mint=<pubkey>` | — | any other badged xStock |
| `--spot=335` | per ticker | reference spot, USD. Only sets moneyness and the USD column |
| `--strike=352` | 1.05 x spot | strike, USD |
| `--moneyness=1.05` | — | sets the strike from spot instead |
| `--days=30` / `--expiry=<unix>` | 30 days | expiry |
| `--vol=0.30` | 0.30 | annualised vol. **A parameter.** |
| `--rate=0.04` | 0 | risk-free rate |
| `--contract-size=1` | 1 | underlying shares per contract |
| `--contracts=1000` | 1000 | total contracts, i.e. total supply |
| `--vol-premium=0.5` | 0.5 | inventory vol markup at full size |
| `--segments=16` | 16 | curve segments, DBC caps the stored curve at 16 |
| `--starting-fee-bps` / `--ending-fee-bps` | 200 / 25 | fee schedule endpoints |
| `--creator-fee-pct=80` | 80 | trading-fee share to the writer's vault |
| `--dry-run` / `--simulate` / `--execute` | dry-run | what to actually do |
| `--mainnet --yes` | devnet | cluster, double-gated |
| `--payer=<pubkey>` | wallet | plan for another fee payer; `--simulate` only |
| `--no-badge` | — | omit the token badge, to demonstrate `InvalidTokenBadge` |
| `--keypair=<path>` | `~/.config/solana/id.json` | signer |

---

## The parameters, and what each one means here

Printed in full by `--dry-run`. This is the whole `ConfigParameters` struct as it
goes on chain.

| field | value | why |
|---|---|---|
| `sqrtStartPrice` | Black-Scholes premium in shares | the opening quote is derived, not chosen |
| `curve[0..15]` | implied-vol ladder | 16 rungs, equal contracts per rung |
| `tokenDecimal` | 8 | see "Decimals" below |
| `tokenType` | Token2022 | leaves the transfer-hook socket open for a future exercise gate |
| `collectFeeMode` | QuoteToken (0) | fees accrue in shares |
| `activationType` | Timestamp (1) | the fee clock is wall-clock time to expiry |
| `baseFeeMode` | FeeSchedulerExponential (1) | model-risk charge, decaying over the option's life |
| `cliffFeeNumerator` | 20,000,000 = 200 bps | opening fee |
| ending fee | 25 bps | DBC's floor, reached at expiry |
| `migrationOption` | MET_DAMM_V2 (1) | DAMM v1 is deprecated; Token-2022 must use v2 anyway |
| `migrationFeeOption` | FixedBps25 (0) | post-graduation the series is a near-linear claim, so keep it tight |
| `migrationFee` | 0 / 0 | do not skim collateral at graduation |
| `tokenSupply` | fixed, = contracts | supply is bounded by collateral |
| `tokenUpdateAuthority` | Immutable (1) | a series' terms must not be editable after it is sold |
| `creatorLiquidityPercentage` | 90 | claimable by the writer's vault to settle at expiry |
| `creatorPermanentLockedLiquidityPercentage` | 10 | DBC's floor: 10% of migrated liquidity stays locked |
| `creatorTradingFeePercentage` | 80 | fee split to the writer |
| `poolCreationFee` | 0 | no extra SOL toll on opening a series |

### Decimals

Quote is fixed at 8 because every xStock is Token-2022 with 8 decimals.

Base is deliberately **also 8**, not the 6 that almost every existing
stock-quoted config uses. The reason is settlement: one contract exercises into `contractSize` shares,
so at `contractSize = 1` the smallest divisible unit of the series token maps
exactly onto the smallest divisible unit of the share it settles into. Nine
decimals would mint dust that can never be exercised — 1e-9 of a contract owes
1e-9 of a share, below the xStock's 1e-8 granularity. Six would make the contract
100x coarser than its own collateral for nothing. Eight is also the identity case
for DBC's price scaling (equal base and quote decimals), so a raw Q64 sqrt price
maps to shares-per-contract with no decimal correction at all.

---

## Files

| file | what it does |
|---|---|
| `src/curve.ts` | Black-Scholes in the share numeraire, the inventory-vol ladder, `buildSeriesCurve()`, `--selftest` |
| `src/config.ts` | builds and submits `create_config` + `initialize_virtual_pool_with_token2022`, token badge at remaining index 0, `--dry-run` / `--simulate` / `--execute` |
| `src/quote.ts` | reads a live pool, quotes buy and sell through `swap2`, optionally executes a buy |
| `src/verify.ts` | reads a created series back off chain and asserts field by field |
| `src/devnet-quote.ts` | one-time devnet stand-in for an xStock |
| `src/underlyings.ts` | xStock mints, and the devnet quote resolution |
| `src/format.ts` | the full `ConfigParameters` decode that `--dry-run` prints |
| `src/env.ts` | `.env`, RPC, cluster gating, CLI flags |
| `artifacts/` | what was created, with signatures. Committed as evidence. |

---

## The devnet stand-in, precisely

Devnet has no xStocks and no xStock token badges — enumerating DBC's `TokenBadge`
accounts on devnet returns exactly four, none of them an `Xs…` mint, and the
derived badge PDAs for AAPLx and NVDAx are empty there. So `devnet-quote.ts`
mints a Token-2022 stand-in with the same 8 decimals, a metadata pointer and
on-chain metadata, and no transfer fee.

It deliberately does **not** carry the `PermanentDelegate` extension. That
extension is precisely what puts xStocks outside DBC's permissionless Token-2022
allowlist and therefore what makes the operator-issued token badge mandatory on
mainnet — and only a Meteora operator can issue one, so a devnet mint carrying it
would be unusable.

The devnet run therefore validates everything except that single extra remaining
account. That account is covered separately by the two mainnet simulations above:
one with the badge (succeeds) and one without (`InvalidTokenBadge`).

---

## Notes and gotchas found while building this

- `@meteora-ag/dynamic-bonding-curve-sdk@1.5.12`, DBC IDL version 0.2.1.
- `creator.createPool()` fetches the `PoolConfig` off chain to read `tokenType`
  and `quoteMint`, so it cannot build a pool for a config that does not exist yet.
  `partner.createConfigAndPool()` is the only builder that assembles both offline.
- A 16-point curve makes both instructions together **1442 bytes**, over the
  1232-byte legacy transaction limit. They are built together and then sent as
  two transactions carrying the identical instructions: `create_config` at 1110
  bytes, `initialize_virtual_pool_with_token2022` at 658.
- `swapQuote2` throws `Insufficient Liquidity` for a sell larger than the quote
  the pool has already taken in. That is correct for a one-sided curve with no
  reserve yet, not a bug; `quote.ts` reports it as such.
- The `tokenAuthorityOption` field in the SDK's builder input is named
  `tokenUpdateAuthority` in the on-chain struct.
- `decimal.js` ships a CJS-typed `.d.ts` against an ESM entry point, so under
  `moduleResolution: NodeNext` the default import types as the module namespace.
  Use `import { Decimal } from "decimal.js"`.
- `bigint: Failed to load bindings, pure JS will be used` on every run is
  `bigint-buffer` inside the Solana stack falling back to JS. Harmless.
- The config account and the series mint are both signers, and their keypairs are
  derived deterministically from `sha256(payer | series symbol | role)`. A
  `--dry-run` prints the exact addresses a later `--execute` will create, and
  running `--execute` twice fails loudly instead of quietly opening a second
  market for the same series.
- `SOLANA_RPC_URL` is read from the repo `.env` and never printed; only the host
  is logged. Devnet reuses the same Helius key under the devnet host.
