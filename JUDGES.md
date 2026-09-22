# For judges

**Deliverable** is a Solana program that writes European, physically-settled covered calls on
tokenized US stocks (xStocks). It refuses, with a typed on-chain code, whenever it cannot defend the
state of the underlying: the market is closed by the committed calendar, the stock is halted, the
oracle is stale inside a session, the price sources disagree, the issuer has paused the mint, a
transfer hook has appeared, or a corporate action is about to land. Its strikes re-cut from the
mint's `ScaledUiAmount` multiplier, so a dividend or a ten-for-one split leaves the contract's
notional unchanged.

Steps 1 and 3 to 5 take about five minutes once dependencies are installed. Steps 2 and 6 add a
few more.

**You need:** Node 24 and pnpm 9 for the TypeScript parts, and Rust 1.89.0 for the program tests
(pinned in `rust-toolchain.toml`). An RPC URL is optional. Without one, `verify-onchain` uses the
public mainnet endpoint, and all ten checks completed against it on 2026-09-22. To use your own, set
`SOLANA_RPC_URL` in the environment or in the repo `.env`. Only the host is ever printed.

---

## 1. Check the chain yourself (about 2 minutes)

```bash
cd scripts
pnpm install
pnpm verify
```

The run takes about 65 seconds. It samples the oracle twice, 60 seconds apart, and runs the other
checks in between. Each of the ten checks prints PASS, FAIL or SKIP with the evidence it read. The
exit code is 1 only if a check FAILs.

| # | what it checks against mainnet now |
|---|---|
| 1 | Scope entries 317 (AAPLx) and 332 (NVDAx): whether the timestamp advanced and whether the price moved. The verdict depends on the session, which the script computes with the program's own calendar rule. |
| 2 | The oracle against the Jupiter price v3 on-chain price, as a basis in bps. It is computed like for like, the oracle divided by the mint's multiplier to a price per share, with SPYx printed as a unit witness, and prints the bare per-token-against-per-share figure next to it. |
| 3 | AAPLx and NVDAx carry `ScaledUiAmount` at the last recorded multiplier |
| 4 | NFLXx is at multiplier 10 and CRWDx at 4 |
| 5 | Six corporate-action transactions (NVDAx, METAx, QQQx, AAPLx, CRWDx, NFLXx) each contain a Token-2022 `0x2B 0x01` instruction matching `keeper/data/corporate-actions.json` |
| 6 | `transferHook.programId` is null and the authority is live, on AAPLx, NVDAx and all 112 mints in the history |
| 7 | The pinned transaction's meta reports an unscaled balance, while `getTokenSupply` scales |
| 8 | Kamino's xStocks supply, and the Scope price chain inside the AAPLx and NVDAx reserve accounts |
| 9 | That the program is deployed, when `DELIVERABLE_PROGRAM_ID` and `DELIVERABLE_CLUSTER` are set. Otherwise SKIP. |
| 10 | The committed calendar against the price publisher's published schedule |

What to expect depends on when you run it:

- **Outside regular hours** (before 09:30 ET, after 16:00 ET, weekends, holidays), check 1 is the
  headline claim. It should read `market closed: the timestamps advanced and the prices did not
  move`.
- **Inside a regular session**, the feed should move, and check 1 says so and tells you when to
  rerun. It does not report that as a failure.
- **Check 9** is SKIP until a deployment is recorded in [PROOF.md](PROOF.md).

This is a run from inside a regular session on 2026-09-22. Lines are omitted, not edited:

```
chain clock 2026-09-22 16:00:51 UTC  = Tue 2026-09-22 12:00 ET  slot 449426563
session     Regular  (US equity calendar, 12 exceptions, the program's own rule)
[1] PASS  The oracle freeze: still while the market is closed, tracking while it is open
    AAPLx  #317  price 343.2284 -> 342.9976  moved -0.230751872884158  ts +83 s  slot +310  age at 2nd read 9 s
    NVDAx  #332  price 228.8637 -> 228.8537  moved -0.010017011968041  ts +83 s  slot +310  age at 2nd read 9 s
    verdict   regular session: the feed tracks, as it should. The claim is that it freezes while the reference market is closed, which cannot be observed now. Rerun after 2026-09-22 20:00:00 UTC to see the freeze.
[2] PASS  The basis: oracle against the on-chain market price
    AAPLx  oracle 342.9976 / m 1.0032690125398187 = 341.8800 per share  usdPrice 343.3306  basis +42.4 bps like-for-like (+9.7 bps bare, per token against per share)
    NVDAx  oracle 228.8537 / m 1.001701196801074 = 228.4650 per share  usdPrice 228.0912  basis -16.4 bps like-for-like (-33.3 bps bare, per token against per share)
    SPYx*  oracle 777.3150 / m 1.005714560286254 = 772.8982 per share  usdPrice 772.8484  basis -0.6 bps like-for-like (-57.5 bps bare, per token against per share)
              * SPYx is the unit witness (largest multiplier): the gap near zero is the matching unit
    pinned    README, 2026-09-20 09:15 UTC, like-for-like: AAPLx -69.0, NVDAx -60.3 bps (bare, as first published: -101.3, -77.2)
    verdict   measured inside a regular session: AAPLx +42.4 bps, NVDAx -16.4 bps like-for-like. The headline figures were taken while closed. This check measures, it asserts no threshold.
[7] PASS  The RPC disagrees with itself about the balance
    meta      amount 439229, uiAmountString 0.00439229  (raw / 10^8 = 0.00439229)
    correct   439229 / 10^8 x 1.0032690125398187 = 0.004406648451088521  -> 0.00440664  [mint newMultiplier, in force since 2026-08-08 00:30:00 UTC]
[8] PASS  Kamino's xStocks collateral and the Scope entries it prices from
    AAPLx  reserve CKJbqakbPGyhziowm19LPYz636UszuezfkitmpRtcLSH  owner klend  market matches  Scope feed 3t4JZcue...chNH at byte 5112, price chain [317]
    NVDAx  reserve 7B66Az3tJhAo4bLkX8PzTixQ9ZGyHkkjxfVLhF26sP5q  owner klend  market matches  Scope feed 3t4JZcue...chNH at byte 5112, price chain [332]
[9] SKIP  Program deployment
10 checks: 9 PASS, 0 FAIL, 1 SKIP
```

## 2. Run the program tests (about 1 minute on a warm build)

```bash
cargo test --manifest-path programs/deliverable/Cargo.toml
```

You should see `test result: ok. 108 passed; 0 failed; 0 ignored`. On our machine a warm rebuild
finished in about 15 seconds. A cold build compiles the dependency tree first and takes longer. The
tests run under LiteSVM against real mainnet account dumps (hashes are in [PROOF.md](PROOF.md)).
Three are worth reading:

- `tests::adjustment_test::unadjusted_strike_breaks_on_a_split` is the negative control. It must
  panic, or every invariant test above it proves nothing.
- `tests::security_test::a_closed_market_is_refused_before_any_oracle_is_read` shows that a closed
  market is refused by arithmetic, before any oracle account is read.
- `tests::write_test::writing_is_refused_while_the_market_is_closed` reads the `Refused` event back
  out of the failed transaction's logs.

The SDK has its own tests, if you want them: `cd sdk && pnpm install && pnpm test`. With
`SOLANA_RPC_URL` set, the run on 2026-09-22 gave `Tests 90 passed | 2 skipped (92)`. The two skipped
tests need the program deployed, and each prints that reason.

## 3. Open the app in Replay (about 2 minutes)

```bash
cd app
pnpm install
pnpm dev
```

Open <http://localhost:3000/app?mode=replay>. The first start builds `sdk/dist` if it is missing.

The mode bar reads **REPLAY**, "Sunday 2026-09-20". The clock is set to
**2026-09-20 10:14:54 UTC**, the instant the pinned Scope entries are stamped with. Replay reads no
network. It evaluates the gate, through the SDK's TypeScript port, on account bytes recorded from
mainnet. Under "What is replayed" it
lists those files with the first 16 hex digits of each sha256 (hover for the full value), so you can
compare them against PROOF.md.

## 4. Look at the refusal (1 minute)

On the same page, each gate tablet (AAPLx, NVDAx) lists every check in the program's order and
names the first one that refuses:

```
REFUSED
CODE I · MARKET CLOSED · ANCHOR ERROR 6000
The committed exchange calendar says the US equity market is shut right now ... Decided by
arithmetic on the clock, before any oracle is read. Evaluated at 2026-09-20T10:14:54.000Z.
```

Switch to **Preview** to run the same gate on live mainnet accounts now. It shows whatever the gate
decides at this moment. After 16:00 ET, on a weekend or on a calendar holiday, that is the same
refusal. The order is in `check_actionable` in
[`programs/deliverable/src/gate.rs`](programs/deliverable/src/gate.rs).

## 5. Look at the strike re-cut (1 minute)

Scroll to section III, **THE STRIKE RE-CUTS** (`/app#adjustment`). Two real splits, read from the
real mints, run through `currentStrike`:

| | before | after |
|---|---|---|
| NFLXx, 1 → 10 | strike 500.000000 USDC, 1 share per contract | strike 50.000000 USDC, 10 shares per contract |
| strike × size | 500.000000 USDC | 500.000000 USDC |
| CRWDx, 1 → 4 | strike 400.000000 USDC, 1 share | strike 100.000000 USDC, 4 shares |

Under each split, the same series written unadjusted keeps its strike while the contract grows. For
NFLXx that is a notional of 5,000.000000 USDC, ten times what the writer collateralised. Check 4
reads the same multipliers from the live mints.

## 6. Read MOCKS.md (3 minutes)

[`MOCKS.md`](MOCKS.md) draws the line between what is real and what is a convention.
[`CLAIMS.md`](CLAIMS.md) tags every public statement with its evidence tier, lists what we do not
claim, and lists the sentences we could not support as worded. [`PROOF.md`](PROOF.md) has one link
per verifiable item.

---

## What we'd want you to be skeptical of

1. **The halt attestation.** A halt is the one state that cannot be computed, so it arrives as a
   signed attestation. As shipped, the signer is our own key. The design lets an independently
   signed feed replace it without a program change, but none does today. This is the weakest link
   in the refusal chain (MOCKS.md, "Conventions").
2. **The program is not deployed.** Everything it does is shown under LiteSVM against real mainnet
   bytes. The app's Live mode has nothing to read yet, and no refusal has been observed on a live
   cluster (PROOF.md, "Deployments"; CLAIMS.md N15).
3. **Replay is the SDK's port of the gate, not the compiled program.** The port is tested
   case-for-case against `gate.rs`, a drift test pins it to the program's check order and refusal
   codes, and the program tests run the Rust gate against the same Scope and AAPLx bytes. It is
   still a port (CLAIMS.md M13).
4. **The two price sources are assumed independent.** `Checked` is bounded by Chainlink and
   `PythLazer` is Pyth's price, according to Scope's mapping types. Neither vendor's upstream has
   been audited (CLAIMS.md R28).
5. **The first published basis figures were wrong by the multiplier.** They set Scope's per-token
   price against Jupiter's per-share `usdPrice`, which is the ScaledUiAmount mistake this project
   exists to prevent. The README, the landing, the app and `scripts/measure-basis.py` now divide the
   oracle by the mint's multiplier first, and the README says so beside its tables: AAPLx on the
   weekend is −69.0 bps, not −101.3. CRCLx, HOODx and COINx have multiplier 1.0 and were
   unaffected. The pinned files are unchanged, so their `basis_bps` field is still the bare figure
   (CLAIMS.md R50, R55).
6. **The basis is measured against an aggregate price.** Jupiter's `usdPrice` is not an executable
   quote at size (CLAIMS.md N10).
7. **Volatility on the curve is a parameter**, not a fitted surface (MOCKS.md; CLAIMS.md N2).
8. **Some sentences in the public copy were ahead of the evidence.** They were corrected on
   2026-09-22, and CLAIMS.md, "Corrections made on 2026-09-22", lists each one with what replaced
   it. One example: "sixty-six of a hundred" xStocks accruing dividends became a live count, 388 of
   the 930 xStock mints on Jupiter's verified list carrying a multiplier other than 1.0.
