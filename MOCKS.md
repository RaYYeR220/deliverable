# What is real and what is a convention

This file draws the line. If something here is vague, treat that as a bug and open an issue.

## Real, on mainnet, no substitutes

- **The underlying.** AAPLx `XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp` and NVDAx
  `Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh` — real Token-2022 mints with real supply, real
  holders and real `ScaledUiAmount` multipliers. The program, the SDK and every test use real mints
  only, and so does everything that reads or targets mainnet: the evidence files, the test fixtures
  and the live series pool, which is quoted in AAPLx itself.
- **The oracle.** Kamino Scope `OraclePrices` `3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH`, owned
  by `HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ`. Kamino's xStocks market prices its AAPLx and
  NVDAx reserves from entries 317 and 332 of this account; we verified those two and claim no more.
  There is **no mock oracle** and no admin-signed `update_price` anywhere in this repository. The
  only hand-made oracle accounts in the tests are copies of the real one — one under another owner,
  one under the real owner at another address — planted to show that the program rejects both.

  The second of those is there because it was a real hole. `oracle::observe` checked only that a
  Scope account was *owned by* the Scope program, and `SCOPE_PRICES` was declared and never
  compared against anything: Scope hosts several `OraclePrices` feeds — five were live on
  2026-09-22, and 150 indices were populated in the bound one while simultaneously fresh in a
  sibling with completely unrelated prices — so any of them was an acceptable price source at any
  index, as was any Scope-owned account of the right length. It is now bound by **address,
  discriminator and length**, matching what the Pyth adapter already did with `feed_id`. Note what
  this did and did not cost while it was open: the oracle price is a pure gate predicate and is
  never read into a payout, so it moved no money — what it defeated were the `OracleStale` and
  `SourcesDisagree` refusals and the integrity of the rail we invite third parties to read. The
  headline calendar refusal never depended on it: `refuse_if_closed` runs before any oracle is read
  and is pure arithmetic.
- **The measurements.** Both snapshots in `docs/evidence/` were taken by
  `scripts/measure-basis.py` against mainnet, and the script is in the repository so you can take
  your own. Nothing in them is hand-written, and they are kept byte for byte as taken. Their stored
  `basis_bps` field was computed by the first version of the script, which set Scope's per-token
  price against Jupiter's per-share price and is off by the multiplier. The README tables and the
  app recompute the basis like for like from the raw `oracle_price` and `dex_price` in each file.
- **The corporate actions.** The transactions in `keeper/data/corporate-actions.json` are real
  mainnet transactions, recovered by decoding Token-2022 `UpdateMultiplier` instructions
  (`0x2B 0x01` + `f64` LE multiplier + `i64` LE effective timestamp). Signatures are clickable.
- **The tests.** They run under LiteSVM against **real mainnet account dumps** in
  `tests/fixtures/` — the real AAPLx mint, the real Scope account, a real Pyth `PriceUpdateV2`.
  The Token-2022 program in those tests is the real one, not a stand-in.

## One stand-in token, on devnet only

- **The devnet series market quotes in a stand-in.** Devnet has no xStocks, so
  `market/src/devnet-quote.ts` mints `AAPLd`
  (`8FBsKWYuBWwn2zo2viDrjdMeN8CrVH5WbaY8YaJMvJDm`, devnet): a Token-2022 mint with 8 decimals and
  on-chain metadata, and no transfer fee, no `PermanentDelegate` and no `ScaledUiAmount` multiplier.
  It is not an xStock. The devnet run of the Meteora DBC series market uses it as its quote mint, and
  `market/README.md` ("The devnet stand-in, precisely") says why. Nothing outside `market/` uses
  it.

## Conventions, models and approximations — stated plainly

- **The bonding curve is a pricing convention, not a calibrated implied-volatility surface.**
  `market/src/curve.ts` prices the premium with Black-Scholes and takes volatility as a
  **parameter**. It is not fitted to an options market, because there is no options market on these
  assets to fit to — that is the gap this project exists in. Treat the curve's opening price as a
  defensible starting quote, not as a fair value.
- **The halt attestation is ours.** `attest_halt` is signed by the attestor key recorded in the
  registry. It is not yet backed by an independently signed feed. The architecture takes an
  attestation rather than a self-declared boolean specifically so this can be replaced without a
  program change, but as shipped, a halt is asserted by us. **This is the weakest link in the
  refusal chain and we are naming it first rather than last.** What that costs is set out under
  "Three levers over other people's money" below: it is not only a credibility problem.
- **Scope publishes no confidence band.** It carries a price and a timestamp, and nothing that says
  how sure it is. We do **not** synthesise one, and we do not let `conf == 0` pass as certainty.
  Instead a security must be bound to two independently-sourced Scope entries — one `PythLazer`, one
  `Checked` — and their divergence is the confidence signal. A security bound to a single source
  refuses with `SingleSource` rather than acting on an uncorroborated number.
- **The exchange calendar covers a twelve-month window.** It is committed from the price publisher's
  own published schedule. That schedule is published in `MMDD` form, and the table used to be keyed
  that way — which meant every entry fired in every subsequent year: 7 September is Labor Day in
  2026 and an ordinary Tuesday in 2027, and Labor Day 2027 is the 6th, which was not in the table at
  all, so the program reported a regular session on a day the exchange is shut. Entries are now
  keyed `(year << 16) | (month << 8) | day` and the committed table carries the year each holiday
  was published for, plus Labor Day 2027. Moveable holidays past the window still require appending
  a new calendar; the program does not guess them. What it no longer does is apply last year's.

## The demo, and what "replay" means

The application has three modes and always labels which one is active.

- **Preview** evaluates the gate off-chain through the SDK, against live mainnet accounts, using the
  committed calendar and the program's default tolerances. It is what you see until a program id is
  configured. It cannot see a halt, and says so.
- **Live** reads the deployed program's own `SecurityState`. During US market hours the rail reports
  *actionable*, because that is the truth. Nothing is staged.
- **Replay** runs the gate against a **pinned snapshot** — the real Scope account as it stood at
  2026-09-20 10:14:54 UTC, the moment its entries are stamped with — with the clock set to that
  moment. This exists because judging happens on weekdays, when the headline refusal would not
  otherwise fire.

The headline measurement in the README (09:15 UTC) and the replay snapshot (10:14:54 UTC) are two
different reads taken an hour apart on the same Sunday. Both fall in the same closed-market window.

Replay evaluates real recorded account bytes with a controlled clock. What evaluates them is the
**SDK's TypeScript port** of the gate (`checkActionable`, `sdk/src/gate.ts`), not the compiled
program. The compiled program runs against the same Scope and AAPLx bytes (`tests/fixtures/`) in the
LiteSVM tests. A drift test, `sdk/test/refusal-codes.test.ts`, pins the port to the program's check
order in `gate.rs` and its refusal codes in `error.rs`, and `sdk/test/gate.test.ts` checks the port
case by case. Replay is labelled in the interface and names the snapshot it is replaying. Its basis
panel shows the 09:15 UTC measurement recomputed like for like from the pinned file's raw prices. If
you want the refusal without the replay, open the app after 16:00 ET, on a weekend, or on any of the
holidays in the committed calendar.

## Not in scope, deliberately

- **Cash-secured puts.** The enum has the variant; the venue rejects it at runtime. Half-built
  instruments are worse than absent ones.
- **American exercise.** European only. Early assignment interacts with dividend timing in ways that
  deserve more than a hackathon week.
- **An implied-volatility surface.** See above.
- **A liquidation engine.** This venue is fully collateralised by construction; there is nothing to
  liquidate. The oracle failure we document is fatal to *lending*, and fixing lending is not what we
  built.
- **A compliance or KYC gate.** xStocks are bearer tokens whose eligibility is enforced off-chain at
  the distributor. On-chain they are freely transferable, `defaultAccountState` is `initialized`, and
  there is no allowlist. Pretending otherwise would be theatre.
- **A second chain.** Solana only. The mechanism depends on Token-2022 `ScaledUiAmount`, which has no
  EVM equivalent.

## Three levers over other people's money

Refusing is not always the safe direction, and this file used to read as though it were. A refusal
that spans a settlement window is not a delay: it is the difference between an in-the-money option
and a worthless one, and the money goes to the writers. Said plainly, because it belongs here rather
than in a footnote — and because two of the three keys are ours.

- **The attestor can refuse a security.** `attest_halt(true)` makes every `exercise` on that
  security fail with `Halted`. Held across a settlement window it converts every in-the-money option
  in every series on that security to zero and pays the difference to the writers; at the strike the
  test suite uses, that is **$60.20 per contract, all of it, transferred from holder to writer**.
  Two things now bound it. The settlement clock counts only minutes in which the venue was actually
  actionable, so a halt postpones settlement instead of consuming it. And a halt attestation goes
  stale after an hour: it stops being honoured unless somebody keeps re-signing it, which turns a
  single transaction into a continuous, visible, on-chain assertion. The residual is real and is
  stated in `_internal/audit.md`: an attestor who re-attests indefinitely can postpone a series'
  settlement until sixteen calendar days after expiry, at which point the writers get their
  collateral back and the holder's option does expire. Nobody can be expropriated by one signature;
  a determined attestor can still make everyone wait.
- **The registry authority has the same lever.** `set_registry_paused(true)` makes `exercise` refuse
  through the `!registry.paused` constraint. It does not stop `settle_expired`, which is deliberate
  — a paused venue must not be able to strand a writer's collateral — so a pause held across a
  settlement window is the same trade as a halt, from a different key. The clock does **not** defend
  against this one: unlike a halt and unlike a scheduled multiplier change, `registry.paused` leaves
  no durable record of *when* it was set, so the minutes it refused over cannot be reconstructed
  afterwards and are not given back. This is the most valuable lever in the system and it belongs to
  the deployer wallet, which on devnet is also the upgrade authority.
- **The issuer's multiplier authority is a third, and a stronger one.** Beyond `PermanentDelegate`
  and `Pausable` named below, whoever holds the mint's `ScaledUiAmount` authority sets the number
  the strike is re-cut against, and can set it effective immediately. A large enough multiplier used
  to floor the re-cut strike to zero and hand over physical delivery of a real share for nothing —
  strictly more powerful than the pause, which only stops transfers. The program now refuses to
  price a contract whose multiplier has moved more than a thousandfold from the one captured at
  listing (`MultiplierOutOfBand`; a thousandfold band admits every corporate action in recorded
  history, the largest real xStock multipliers being KLACX at 10.016833 and VUGX at 6.004668), and
  the re-cut strike and UI size are floored at one unit rather than zero. Inside the band the
  issuer still moves the number and we still price against it — that is the trust assumption, and
  it is the same one the whole design rests on.

## State outlives code, and ours did

This is the project's own thesis turned on the project. On 2026-09-22 the devnet program was
upgraded to carry the audit fixes. Two account layouts changed with it — `HaltState` gained a field,
and the calendar's `date_key` widened from `u16` to `u32` — and **the accounts already on chain did
not change with them.** Anchor accounts are bytes at a fixed size; an upgrade rewrites the code and
leaves the state where it is.

The consequences were not cosmetic. The `SecurityState` was eight bytes short of the new layout, so
the new build read a halt timestamp out of two old tolerance fields and ran the gate with a
divergence bound of 3,000,934,913 basis points. The calendar was 373 bytes where the new layout
needs 501, so **every one of its holiday exceptions decoded as a date that cannot occur, and the
calendar silently behaved as though no holiday existed**. A refusal counter that appeared not to
increment was the visible symptom; those were the causes.

Both accounts were replaced under new seeds — calendar id 1, and a new stand-in mint, since a PDA
cannot be closed without an instruction to close it, and the program has none. That leaves two
things true that we will not paper over:

- **The pre-upgrade accounts still exist and are still callable.** `probe_security` against the old
  `SecurityState` will return a confirmed transaction computed from garbage tolerances, and the old
  calendar still reads as having no holidays. Roughly 0.0048 SOL of rent is stranded in them
  permanently.
- **Refusals recorded before the upgrade belong to a different binary.** `PROOF.md` labels them that
  way rather than presenting them as the current program's work.

`scripts/devnet/lib.ts` now checks every account's length against `8 + INIT_SPACE` before decoding
it, which is the check that would have caught this at the first read instead of the third symptom.

## Known upstream risks we do not control

- **The issuer can freeze or pause.** xStocks carry `PermanentDelegate` and `Pausable`, both held by
  the issuer. Collateral in our vault is subject to both. The gate refuses while `Pausable` is set,
  but a permanent-delegate transfer is not something a third-party program can prevent. Note that
  the gate refusing while `Pausable` is set is a protection *outside* a settlement window and a
  hazard inside one, for the reason given above.
- **The transfer hook is empty but the authority is live.** `transferHook.programId` is currently
  `null` on every xStock while the authority remains held by the issuer. If a hook is ever attached,
  arbitrary code runs on every transfer. We refuse when we see one appear, which is the most a
  counterparty can do.
