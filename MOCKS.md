# What is real and what is a convention

This file draws the line. If something here is vague, treat that as a bug and open an issue.

## Real, on mainnet, no substitutes

- **The underlying.** AAPLx `XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp` and NVDAx
  `Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh` — real Token-2022 mints with real supply, real
  holders and real `ScaledUiAmount` multipliers. There is **no mock token** in this repository.
- **The oracle.** Kamino Scope `OraclePrices` `3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH`, owned
  by `HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ`. Kamino's xStocks market prices its AAPLx and
  NVDAx reserves from entries 317 and 332 of this account; we verified those two and claim no more.
  There is **no mock oracle** and no admin-signed `update_price` anywhere in this repository.
- **The measurements.** Both snapshots in `docs/evidence/` were taken by
  `scripts/measure-basis.py` against mainnet, and the script is in the repository so you can take
  your own. Nothing in them is hand-written.
- **The corporate actions.** The transactions in `keeper/data/corporate-actions.json` are real
  mainnet transactions, recovered by decoding Token-2022 `UpdateMultiplier` instructions
  (`0x2B 0x01` + `f64` LE multiplier + `i64` LE effective timestamp). Signatures are clickable.
- **The tests.** They run under LiteSVM against **real mainnet account dumps** in
  `tests/fixtures/` — the real AAPLx mint, the real Scope account, a real Pyth `PriceUpdateV2`.
  The Token-2022 program in those tests is the real one, not a stand-in.

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
  refusal chain and we are naming it first rather than last.**
- **Scope publishes no confidence band.** It carries a price and a timestamp, and nothing that says
  how sure it is. We do **not** synthesise one, and we do not let `conf == 0` pass as certainty.
  Instead a security must be bound to two independently-sourced Scope entries — one `PythLazer`, one
  `Checked` — and their divergence is the confidence signal. A security bound to a single source
  refuses with `SingleSource` rather than acting on an uncorroborated number.
- **The exchange calendar covers a twelve-month window.** It is committed from the price publisher's
  own published schedule, in `MMDD` form, which is how that schedule is published. Moveable holidays
  in a later year require appending a new calendar. The program does not guess them.

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

Replay is **not a simulation**. It is the same code path executing against real recorded account
data with a controlled clock, which is exactly what the tests do. It is labelled in the interface
and it names the snapshot it is replaying. If you want the refusal without the replay, open the app
after 16:00 ET, on a weekend, or on any of the holidays in the committed calendar.

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

## Known upstream risks we do not control

- **The issuer can freeze or pause.** xStocks carry `PermanentDelegate` and `Pausable`, both held by
  the issuer. Collateral in our vault is subject to both. The gate refuses while `Pausable` is set,
  but a permanent-delegate transfer is not something a third-party program can prevent.
- **The transfer hook is empty but the authority is live.** `transferHook.programId` is currently
  `null` on every xStock while the authority remains held by the issuer. If a hook is ever attached,
  arbitrary code runs on every transfer. We refuse when we see one appear, which is the most a
  counterparty can do.
