# Claims

This ledger lists every public statement the project makes in [`README.md`](README.md),
[`MOCKS.md`](MOCKS.md) and the landing page ([`app/src/app/page.tsx`](app/src/app/page.tsx)). Each
one gets exactly one evidence tier and a pointer to its proof. The links themselves are in
[PROOF.md](PROOF.md).

| tier | meaning |
|---|---|
| `REPRODUCIBLE` | You can re-derive it now with a command in this repository. |
| `VERIFIED-LIVE` | It was checked against mainnet at the stated time and may have drifted since. |
| `TESTED` | A named test proves it. Program tests: `cargo test --manifest-path programs/deliverable/Cargo.toml`. Their names are module paths inside the crate, with the `tests::` prefix dropped for files under `src/tests/`. Any of them works as a `cargo test` filter. SDK tests: `cd sdk && pnpm test`. |
| `MODELED` | It is a convention, an estimate or an argument, and its assumption is stated. |
| `NOT-CLAIMED` | We do not claim it. The list is at the end. |

"verify-onchain N" means check N of `cd scripts && pnpm verify`. The live figures below come from
runs on 2026-09-22 between 14:22 and 16:15 UTC, all inside a regular session. Each figure gives its
own time.

---

## README.md

| id | statement | tier | proof |
|---|---|---|---|
| R1 | "Reads real Solana mainnet accounts · the program targets devnet for the live demonstration" (tagline) | `VERIFIED-LIVE` | The underlying, the oracle, the Kamino reserves and the corporate actions are mainnet accounts, read 2026-09-22 (verify-onchain 1–8). The program is not on mainnet. Devnet is its target; whether a deployment exists is recorded in PROOF.md, Deployments, and nowhere else. See N5. |
| R2 | "physically settled in the real share" | `TESTED` | `settle_test::the_covered_call_survives_the_weekend_and_settles_in_the_share`, run under LiteSVM against the real AAPLx mint bytes |
| R3 | Pyth's `PriceUpdateV2` "has no status field" | `REPRODUCIBLE` | After `cargo fetch`, read `pyth-solana-receiver-sdk-2.0.0/src/price_update.rs` (the struct is `write_authority`, `verification_level`, `price_message`, `posted_slot`) and `pythnet-sdk-3.0.0/src/messages.rs` (`PriceFeedMessage`: `feed_id`, `price`, `conf`, `exponent`, `publish_time`, `prev_publish_time`, `ema_price`, `ema_conf`). Neither has a status field. The versions are pinned in `Cargo.lock`. |
| R4 | The market is closed "~81% of the week"; "the regular session is 32.5 of 168 hours" | `REPRODUCIBLE` | 5 × 6.5 h = 32.5 h, and 1 − 32.5/168 = 80.7%. The weekly hours are `REGULAR_OPEN_MINUTE`/`REGULAR_CLOSE_MINUTE` in `constants.rs`. Holidays are excluded, so a holiday week is closed for more of its hours. |
| R5 | Early closes happen "twice a year" | `REPRODUCIBLE` | `US_EQUITY_2026_2027` in `state/registry.rs` has two `early(...)` entries, 11-27 and 12-24. This matches the publisher's schedule (verify-onchain 10). |
| R6 | `get_price_no_older_than` is "structurally wrong for equities" | `MODELED` | This is an argument from R4. Assumption: a max-age check shorter than the longest closed stretch either refuses on every closed stretch or, if it is longer, accepts a stale print. |
| R7 | Kamino's xStocks market holds "$22.8M" of tokenized-equity collateral (read 2026-09-22) | `VERIFIED-LIVE` | verify-onchain 8: `totalSupplyUsd` summed over the 10 xStocks reserves came to $22.77M at 14:22 UTC and $22.72M at 15:24 UTC on 2026-09-22. The figure drifts. |
| R8 | Kamino's AAPLx and NVDAx reserves "price from entries 317 and 332" of Scope | `REPRODUCIBLE` | verify-onchain 8 reads each reserve's Scope price chain: `[317]` and `[332]`. |
| R9 | The weekend table: eight rows, sampled 90 s apart at 2026-09-20 09:15 UTC, with a multiplier column and a like-for-like basis | `VERIFIED-LIVE` | `docs/evidence/weekend-2026-09-20.json`. Every oracle price, market price, move, timestamp and slot figure is in that file. The per-share and basis columns are recomputed from the file's `oracle_price` and `dex_price` with the multiplier each mint had in force at the read (R56). The file's own `basis_bps` field is bare (R55). |
| R10 | "thirty-seven hours after the NYSE closed" | `REPRODUCIBLE` | The close was Friday 2026-09-18 16:00 ET, which is 20:00 UTC. The calendar has no exception on 09-18. From then to 09:15 UTC Sunday is 37 h 15 m. |
| R11 | "The timestamp advances. The slot advances. The price does not: AAPLx, NVDAx, CRCLx, HOODx and COINx did not move at all, and SPYx, QQQx and METAx moved by cents. Every freshness check a program can perform passes." | `REPRODUCIBLE` | Run verify-onchain 1 outside regular hours; it checks AAPLx and NVDAx. The pinned case for all eight is `docs/evidence/weekend-2026-09-20.json` (`oracle_price_moved`: 0.0 for the five, +0.00735266, +0.14972711 and −0.02376853 for SPYx, QQQx and METAx), and `oracle_test::scope_timestamp_is_fresh_while_the_market_has_been_shut_for_days` checks the same thing on the fixture. |
| R12 | "CRCLx sat 2.7% below the oracle and HOODx 2.4% below it. Those two are the headline." | `VERIFIED-LIVE` | −268.9 and −235.6 bps in `weekend-2026-09-20.json`. Both mints carry multiplier 1.0 in both fields (read 2026-09-22), so the unit correction does not change them. |
| R13 | The Tuesday table, 2026-09-22 08:11 UTC: eight rows, like-for-like basis | `VERIFIED-LIVE` | `docs/evidence/overnight-2026-09-22.json`, recomputed as in R9. CRCLx −324.0, COINx −268.3, HOODx −235.7, NVDAx −42.7, AAPLx −22.3, SPYx −0.3, QQQx +5.0, METAx +8.0 bps. |
| R14 | "five hours before the opening bell" | `REPRODUCIBLE` | From 08:11 UTC to the 13:30 UTC open is 5 h 19 m. |
| R15 | "It recurs every night, not once a week." | `MODELED` | There are two pinned nights, a Sunday and a Tuesday. Assumption: the behaviour generalises to every closed window. You can test any night with verify-onchain 1. |
| R16 | "NVDAx 222.35 → 227.71, METAx 669.79 → 747.24" | `VERIFIED-LIVE` | The weekend and overnight files. METAx is 669.78533359 in the weekend file. |
| R17 | "While the reference market is shut it holds still: over ninety seconds, in both pinned reads, AAPLx, NVDAx, CRCLx, HOODx and COINx did not move at all, and SPYx, QQQx and METAx moved by cents (+0.0074, +0.1497 and −0.0238 on Sunday; −0.0089, −0.0389 and +0.5612 on Tuesday)." | `VERIFIED-LIVE` | The `oracle_price_moved` field of both pinned files. The earlier wording, "It freezes exactly while the reference market is shut", is withdrawn (N22). |
| R18 | "Every corporate action on an xStock ... is a change to the Token-2022 ScaledUiAmount multiplier" | `MODELED` | Assumption: this is how the issuer implements corporate actions. All 119 actions the keeper recovered are `UpdateMultiplier` writes, and no other channel was observed. |
| R19 | "There is no event, no label" | `REPRODUCIBLE` | verify-onchain 5 decodes the instruction. It is 18 bytes, `0x2B 0x01` followed by `f64` and `i64`, with no type field. The feed-absence half of this sentence is N9. |
| R20 | "Netflix went ten-for-one on-chain as 1.0 → 10.0. CrowdStrike ... 1.0 → 4.0." | `REPRODUCIBLE` | verify-onchain 4 reads the mints and verify-onchain 5 reads the transactions. |
| R21 | "On 2026-09-22, 388 of the 930 xStock mints on Jupiter's verified token list carried a multiplier other than 1.0." | `VERIFIED-LIVE` | Read at chain clock 2026-09-22 15:51:37 UTC, slot 449424491. `lite-api.jup.ag/tokens/v2/tag?query=verified` returned 3,488 tokens; 930 carry the `xstocks` tag, and those 930 are exactly the `Xs…` mints on the list, all Token-2022, all with `ScaledUiAmount` authority `S7vY…`. Each mint was read with `getMultipleAccounts` (base64) and decoded with the layout in `keeper/src/token2022.ts`; the multiplier is the one in force at the chain clock. 387 are above 1.0, one is below (AZNx, 0.5111), 542 are exactly 1.0, and none had a change pending. Eight of the 387 are at 2.0 or more. The count moves with every corporate action. It replaces "Sixty-six of a hundred xStocks are accruing dividends right now", which could not be reproduced (N19). |
| R22 | Raw-amount arithmetic "on a split ... is wrong by a factor of ten" | `TESTED` | `adjustment_test::the_unadjusted_series_is_wrong_by_exactly_the_split_factor` |
| R23 | `getTokenSupply` and `getTokenAccountBalance` apply the multiplier and `getTransaction` meta does not | `REPRODUCIBLE` | verify-onchain 7: meta `0.00439229`, corrected `0.00440664`, supply scaled. Also the SDK test `balance.test.ts`, "the recorded meta is the bug". |
| R24 | "There is no options market on tokenized equities on Solana." | `MODELED` | Assumption: this reflects the builders' search of Solana venues during the build. An absence cannot be proven by a command. See N9. |
| R25 | The session is computed on-chain from `Clock`, with "the real DST rule" and a committed calendar | `TESTED` | `calendar::tests::dst_boundaries_are_correct`, `session_survives_the_spring_forward`, `half_days_close_early`, `full_holidays_are_closed_all_day` |
| R26 | "The calendar we commit is the price publisher's own published schedule" | `REPRODUCIBLE` | verify-onchain 10 compares `registry.rs` with Hermes `Equity.US.AAPL/USD`. The weekly hours match and every listed exception matches. |
| R27 | Price comes "from a pluggable source, with a required second source" | `TESTED` | `gate_test::refuses_a_security_bound_to_one_source`, `oracle_test::observe_reads_scope_through_the_source_enum`, `oracle_test::prices_with_different_exponents_normalise_to_the_same_scale` |
| R28 | Scope's two entries per security are "independently-sourced" and "their divergence is the confidence signal" | `MODELED` | Assumption: `Checked` is a `CappedFloored` entry bounded by Chainlink and `PythLazer` is Pyth's price, per Scope's mapping types (`cd keeper && pnpm oracle -- --mappings`). We have not audited either vendor's upstream. `oracle_test::the_paired_entries_are_two_prices_not_one` shows that they are two different numbers. |
| R29 | The multiplier is read "straight off the mint, including the change that has been scheduled" | `TESTED` | `scaled_ui_test::pending_carries_the_value_and_the_time_it_lands`, `scaled_ui_test::effective_multiplier_flips_at_the_effective_timestamp` |
| R30 | "Halt, attested separately" | `TESTED` | `security_test::attest_halt_rejects_a_signature_from_anyone_but_the_attestor`, `security_test::the_attestor_can_set_and_clear_a_halt`. Who signs the attestation is N3. |
| R31 | "European, physically-settled covered calls" | `TESTED` | `settle_test::exercising_before_expiry_is_refused_because_the_style_is_european`, `series_test::cash_secured_puts_are_rejected_rather_than_half_built` |
| R32 | A closed market "is decided by arithmetic before any oracle is read" | `TESTED` | `security_test::a_closed_market_is_refused_before_any_oracle_is_read`, `gate_test::the_calendar_is_checked_before_any_oracle` |
| R33 | Staleness is "evaluated only inside an open session" | `TESTED` | `gate_test::refuses_on_a_stale_price_inside_an_open_session`, `gate_test::refuses_when_the_market_is_closed_even_if_the_price_looks_fresh` |
| R34 | The default tolerances (60 s max age, 150 bps divergence, 100 bps confidence) | `MODELED` | These are defaults in `constants.rs` and can be overridden per security. Assumption behind the 60 s: Scope re-stamps the entries often enough inside a session. It was sampled every 3 s from 2026-09-22 14:24 to 14:29 UTC and re-stamped entries 317 and 332 every 41–43 s. The largest age observed was 44 s, which leaves 16 s of headroom under 60 s. The comment on `DEFAULT_MAX_PRICE_AGE_SECS` states the same measurement. |
| R35 | Divergence between the two sources refuses | `TESTED` | `gate_test::refuses_when_two_sources_disagree` |
| R36 | The issuer's `Pausable` flag refuses | `TESTED` | `gate_test::refuses_when_the_issuer_pauses_the_mint` |
| R37 | A non-null `transferHook.programId` refuses | `TESTED` | `gate_test::refuses_when_a_transfer_hook_appears` |
| R38 | "Every xStock carries an initialised-but-empty transfer hook whose authority is live" | `REPRODUCIBLE` | verify-onchain 6 checks AAPLx and NVDAx and sweeps the 112 mints in the keeper history, finding 112 of 112. A wider read on 2026-09-22 of all 930 `Xs…` Token-2022 mints on Jupiter's verified list gave 930 of 930. |
| R39 | "Every refusal is a typed code emitted as an on-chain event" | `TESTED` | `write_test::writing_is_refused_while_the_market_is_closed` and `security_test::probe_security_counts_the_refusal_the_weekend_produces` read the `Refused` event from the transaction logs. This is under LiteSVM only; see N15. |
| R40 | `strike × ui_size` is invariant across `m₀ → m₁` | `TESTED` | `adjustment_test::survives_the_netflix_ten_for_one`, `survives_the_crowdstrike_four_for_one`, `survives_a_real_dividend_step`, `survives_a_split_that_carries_accrued_dividends_with_it`. SDK: `strike.test.ts`. |
| R41 | "one option on one share at $500 into one option on ten shares at $50: same dollars, same tokens delivered" | `TESTED` | `adjustment_test::survives_the_netflix_ten_for_one`, `adjustment_test::the_deliverable_is_raw_and_therefore_never_moves` |
| R42 | "That is the OCC's adjusted-deliverable rule in one line of integer arithmetic." | `MODELED` | This is an analogy. Assumption: like the OCC, we keep the aggregate exercise price constant. We do not reproduce OCC rounding or cash-in-lieu rules. |
| R43 | "Correctness does not depend on anyone calling an adjustment instruction" | `TESTED` | `settle_test::exercising_across_a_corporate_action_pays_the_adjusted_strike` |
| R44 | `acknowledge_adjustment` "only emits an event" | `TESTED` | `series_test::acknowledging_an_adjustment_publishes_the_re_cut` |
| R45 | "tested against history, with a negative control" | `TESTED` | `adjustment_test::unadjusted_strike_breaks_on_a_split` (`should_panic`). SDK: `strike.test.ts`, "NEGATIVE CONTROL". |
| R46 | "No floating-point arithmetic is used"; `f64` bits are decoded into 1e12 fixed point | `TESTED` | `fixed::tests::decodes_real_multipliers`. Outside `#[cfg(test)]`, no `f64` value is declared in the program. The only non-test matches for `grep -rn f64 programs/deliverable/src` are doc comments and the name `f64_bits_to_fixed`, which takes the bits as a `u64`. |
| R47 | Tests run under LiteSVM "against real mainnet account dumps" | `TESTED` | `harness::tests::fixtures_are_the_real_mainnet_accounts` asserts the dump sizes. `litesvm_hosts_the_real_token2022_mint` and `litesvm_hosts_the_real_scope_and_pyth_accounts` assert that they load. On provenance: the Scope dump's entries 317 and 332 equal the independently pinned weekend measurement, and the AAPLx dump's multiplier fields equal the live mint (verify-onchain 3). Hashes are in PROOF.md. |
| R48 | "There is no mock oracle: the only Scope account the tests accept is the real dump ... The program, the SDK and the tests use real mints only. The one stand-in token in the repository is in `market/` ... a Token-2022 stand-in with 8 decimals (`AAPLd`). Everything that reads or targets mainnet uses the real mints." | `REPRODUCIBLE` | `grep -rni "update_price\|mock" programs/` finds only the comment in `tests/mod.rs` that says there is none. `security_test::plant_impostor_oracle` and `security_test::an_oracle_account_from_the_wrong_program_is_refused` copy the real Scope account under a new owner, and the tests assert it is rejected. The only quote-mint creation in the repository is `market/src/devnet-quote.ts` (`createInitializeMintInstruction`, `DECIMALS`), recorded in `market/artifacts/devnet-quote.json`. The mainnet series flow quotes in AAPLx and has been simulated, not sent (PROOF.md, Deployments). |
| R49 | Honest limits: "covered calls only, European exercise, no implied-volatility model, no liquidation engine, and no compliance gate" | `TESTED` | Puts and American exercise are refused by the tests in R31. The other three are absences, listed as N2, N16 and N17. |
| R50 | "The first version of these tables set Scope's price for one unscaled token against Jupiter's price for one share ... AAPLx: −101.3 bps first version, −69.0 bps corrected. CRCLx, HOODx and COINx are unaffected: their multiplier is 1.0." | `REPRODUCIBLE` | From `weekend-2026-09-20.json`: (333.2898240617244 − 336.70209695342584) / 336.70209695342584 = −101.3 bps; 336.70209695342584 / 1.0032690125398187 = 335.6050 per share, and (333.2898240617244 − 335.6050) / 335.6050 = −69.0 bps. The unit is witnessed in session by SPYx, the largest multiplier (R54). The three unaffected mints carry 1.0 in both `ScaledUiAmount` fields, read 2026-09-22. |
| R51 | "The ETFs, SPYx and QQQx, trade within 8 bps of it, because market makers hold them there while the reference market is shut." | `MODELED` | The figures are `VERIFIED-LIVE`: SPYx −7.6 and QQQx −0.5 bps on Sunday, −0.3 and +5.0 bps on Tuesday. The cause is an inference from that closeness. No market-maker quote was observed. |
| R52 | "The single names with crypto beta drift away from it: CRCLx 2.7%, HOODx 2.4% ... COINx 0.9%, AAPLx 0.7%, NVDAx 0.6%"; Tuesday "CRCLx 3.2%, HOODx 2.4%, COINx 2.7%" | `VERIFIED-LIVE` | The two pinned files, recomputed as in R9. "Crypto beta" describes the three issuers' businesses (Circle, Robinhood, Coinbase). No beta was estimated. |
| R53 | "Inside a regular session the gap is far smaller, though not zero ... in-session reads on 2026-09-22 between 15:54 and 16:15 UTC put SPYx between −8.5 and +2.2 bps and QQQx between −8.9 and +11.1 bps like for like, and every other entry within 50 bps except one COINx read of +111.3 bps at 16:13 UTC" | `VERIFIED-LIVE` | Like-for-like bps at each chain clock. 15:54:18, `scripts/measure-basis.py`: AAPLx −20.0, NVDAx +3.7, SPYx +2.2, QQQx +11.1, METAx −9.9, CRCLx −3.1, HOODx −38.4, COINx −1.9. 15:59:07, the app's basis panel (`/api/rail?mode=preview`, slot 449426173): +5.7, +5.9, −1.4, +9.1, −5.5, +0.4, +27.5, +28.0. 16:01:51, verify-onchain 2: AAPLx +42.4, NVDAx −16.4, SPYx −0.6. 16:13:37, the panel: −6.0, −2.9, −2.0, −8.9, +11.2, −3.7, −10.8, +111.3. 16:14:49, the panel: +1.7, −3.9, −8.5, −1.8, +48.2, +6.5, −6.5, −19.6. |
| R54 | "SPYx ... across five in-session reads on 2026-09-22 between 15:54 and 16:15 UTC it sat between −8.5 and +2.2 bps from the oracle like for like, and between −54.6 and −65.3 bps bare" | `VERIFIED-LIVE` | The reads of R53, bare in brackets: +2.2 (−54.6), −1.4 (−58.2), −0.6 (−57.5), −2.0 (−58.8), −8.5 (−65.3). Earlier verify-onchain 2 runs at 15:25 and 15:30 UTC read +0.7 and +1.1 against −56.2 and −55.8. The bare gap sits near −57 bps, which is what the multiplier alone predicts: 1 / 1.005714560286254 − 1 = −56.8 bps. |
| R55 | "The pinned JSON files are untouched. Their stored `basis_bps` field was computed bare." | `REPRODUCIBLE` | In all 16 rows of the two files, `basis_bps` equals (`dex_price` − `oracle_price`) / `oracle_price` × 10⁴ rounded to 0.1, with no multiplier. The files are served as they are (`/evidence/<file>` in the app). |
| R56 | "every one of those multipliers took effect before 2026-09-20 09:15 UTC (the latest, QQQx, at 2026-09-19 23:00 UTC), read from the mints on 2026-09-22" | `VERIFIED-LIVE` | The eight mints read at chain clock 2026-09-22 15:49:12 UTC: `newMultiplierEffectiveTimestamp` is 2026-08-08 00:30 (AAPLx), 2026-09-10 00:30 (NVDAx), 2026-06-18 04:00 (SPYx), 2026-09-19 23:00 (QQQx), 2026-09-19 00:30 (METAx) and 0 (CRCLx, HOODx, COINx), with no change pending. The same values are in `app/src/lib/server/feeds.ts` (`PINNED_MULTIPLIERS`). |

## MOCKS.md

| id | statement | tier | proof |
|---|---|---|---|
| M1 | AAPLx and NVDAx are real Token-2022 mints with real `ScaledUiAmount` multipliers | `REPRODUCIBLE` | verify-onchain 3 |
| M2 | The oracle is Scope `3t4JZ…` owned by `HFn8…`. Kamino prices AAPLx and NVDAx from 317 and 332, "we verified those two and claim no more" | `REPRODUCIBLE` | verify-onchain 1 asserts the owner, and verify-onchain 8 reads the price chains |
| M3 | "no admin-signed `update_price` anywhere" | `REPRODUCIBLE` | `grep -rn update_price programs/` returns nothing |
| M4 | Both snapshots were taken by `scripts/measure-basis.py` against mainnet, "nothing in them is hand-written", and they are kept byte for byte; their `basis_bps` field was computed bare | `VERIFIED-LIVE` | Taken 2026-09-20 09:15 UTC and 2026-09-22 08:11 UTC. The files have the first version's exact output schema, and the Scope fixture corroborates the weekend prices (R47). For the bare `basis_bps`, see R55. The files are not signed; see N8. |
| M5 | Corporate actions are real transactions, decoded from `0x2B 0x01 + f64 + i64` | `REPRODUCIBLE` | verify-onchain 5 checks six of them. For all 119: `cd keeper && pnpm history` |
| M6 | "The Token-2022 program in those tests is the real one" | `TESTED` | `harness::tests::litesvm_hosts_the_real_token2022_mint` |
| M7 | The bonding curve is a Black-Scholes pricing convention with volatility as a parameter | `MODELED` | `market/src/curve.ts`. Assumption: vol is whatever the series creator passes (`--vol`, default 0.30). See N2. |
| M8 | `attest_halt` is signed by the registry's attestor key | `TESTED` | `security_test::attest_halt_rejects_a_signature_from_anyone_but_the_attestor`. The key is ours; see N3. |
| M9 | Scope carries no confidence band. None is synthesised, and a single source refuses with `SingleSource` | `TESTED` | `oracle_test::scope_carries_no_confidence_so_we_do_not_invent_one`, `gate_test::a_source_that_reports_no_confidence_is_not_treated_as_certain`, `gate_test::refuses_a_security_bound_to_one_source` |
| M10 | The calendar covers a twelve-month window in `MMDD` form | `REPRODUCIBLE` | `US_EQUITY_2026_2027` in `state/registry.rs`, compared with the publisher by verify-onchain 10 |
| M11 | Replay runs against "the real Scope account as it stood at 2026-09-20 10:14:54 UTC" | `REPRODUCIBLE` | Entries 317 and 332 in `tests/fixtures/scope_prices.bin` carry `unix_timestamp` 1789899294, which is 2026-09-20 10:14:54 UTC (read `u64` at `40 + 56i + 24`). The app shows `MARKET CLOSED`, code 1, evaluated at that instant. |
| M12 | The headline read (09:15 UTC) and the Replay snapshot (10:14:54 UTC) are two reads on the same Sunday | `REPRODUCIBLE` | The same timestamps as M11 and R9. Both are closed under the committed calendar (`calendar::tests::the_measurement_window_was_closed`). |
| M13 | Replay runs the SDK's TypeScript port of the gate, not the compiled program; the compiled program runs against the same Scope and AAPLx bytes in the LiteSVM tests; a drift test pins the port to the program's check order and refusal codes | `TESTED` | The port is `checkActionable` in `sdk/src/gate.ts`, called from `app/src/lib/server/replay.ts`. The drift test is `sdk/test/refusal-codes.test.ts` ("GATE_CHECK_ORDER is the order check_actionable evaluates in gate.rs", and the code tests against `error.rs` and the IDL). `sdk/test/gate.test.ts` checks the port case by case. The program tests load `tests/fixtures/scope_prices.bin` and `aaplx_mint.bin` (`programs/deliverable/src/tests/harness.rs`). The NVDAx mint Replay uses (`app/data/replay/nvdax_mint.bin`) is not in the program tests. |
| M14 | Cash-secured puts are rejected at runtime, and exercise is European only | `TESTED` | `series_test::cash_secured_puts_are_rejected_rather_than_half_built`, `settle_test::exercising_before_expiry_is_refused_because_the_style_is_european` |
| M15 | xStocks are bearer tokens: `defaultAccountState` is `initialized` and there is no allowlist | `VERIFIED-LIVE` | The AAPLx mint read with `jsonParsed` on 2026-09-22: `defaultAccountState.accountState = "initialized"` |
| M16 | `ScaledUiAmount` "has no EVM equivalent" | `MODELED` | Assumption: this is our reading of the EVM token standards. ERC-20 has no UI-multiplier field. It is not a survey of every EVM token contract. |
| M17 | The issuer holds `PermanentDelegate` and `Pausable` | `VERIFIED-LIVE` | The AAPLx mint on 2026-09-22 had `permanentDelegate` `5aMNN…` and `pausableConfig.authority` `JDq14…` (PROOF.md). The gate's refusal on pause is R36. |
| M18 | `transferHook.programId` is null on every xStock and the authority is held by the issuer | `REPRODUCIBLE` | Same as R38 |
| M19 | One stand-in token, on devnet only: `AAPLd`, Token-2022, 8 decimals, on-chain metadata, no transfer fee, no `PermanentDelegate`, no `ScaledUiAmount`; nothing else uses it | `REPRODUCIBLE` | `market/src/devnet-quote.ts` sizes the mint with `getMintLen([ExtensionType.MetadataPointer])` and refuses `--mainnet`. `market/artifacts/devnet-quote.json` records mint `8FBsKWYu…vJDm` and 8 decimals. PROOF.md, "Devnet: the series market". |
| M20 | Replay's basis panel shows the 09:15 UTC measurement recomputed like for like from the pinned file's raw prices | `REPRODUCIBLE` | `pinnedBasis` in `app/src/lib/server/replay.ts` computes it with `perShareBasis` and `PINNED_MULTIPLIERS` (`app/src/lib/server/feeds.ts`) and does not read the file's `basis_bps`. The built page carries AAPLx −68.99, SPYx −7.62, QQQx −0.52 bps. |

## The landing page (`app/src/app/page.tsx`)

| id | statement | tier | proof |
|---|---|---|---|
| L1 | "READS SOLANA MAINNET · PROGRAM TARGETS DEVNET" (header and footer) | `VERIFIED-LIVE` | The same as R1 |
| L2 | "Covered calls on real tokenized shares, settled in the share itself" | `TESTED` | Same as R2 |
| L3 | "we built the field that can [read the closing bell], and the venue will not act without it" | `TESTED` | `write_test::writing_is_refused_while_the_market_is_closed`, `gate_test::refuses_when_the_market_is_closed_even_if_the_price_looks_fresh` |
| L4 | The four conditions "arrive at the program as the same bytes" | `MODELED` | Measured only for the closed-market case (R11). A halt and an outage are argued from the account layout (R3), not observed. |
| L5 | "32.5 ⁄ 168 ... roughly eighty per cent of the week" | `REPRODUCIBLE` | Same as R4 |
| L6 | Record I: +82 s, +312 slots, "Price moved, 5 of 8 entries 0.0000"; CRCLx −268.9, HOODx −235.6, AAPLx −69.0, SPYx −7.6, QQQx −0.5 bps; AAPLx 336.7021 per token ÷ 1.00326901 = 335.6050 per share against 333.2898 | `VERIFIED-LIVE` | `weekend-2026-09-20.json`, recomputed as in R9. The five that did not move and the three that moved by cents are R17. |
| L7 | "Thirty-seven hours after the New York close" | `REPRODUCIBLE` | Same as R10 |
| L8 | Record II: CRCLx −324.0, COINx −268.3, HOODx −235.7, AAPLx −22.3, SPYx −0.3, QQQx +5.0 bps | `VERIFIED-LIVE` | `overnight-2026-09-22.json`, recomputed as in R13 |
| L9 | "IT RECURS EVERY NIGHT, NOT ONCE A WEEK" | `MODELED` | Same as R15 |
| L10 | "NVDAx 222.35 → 227.71", "METAx 669.79 → 747.24" | `VERIFIED-LIVE` | Same as R16 |
| L11 | "$22.8M of collateral in Kamino's xStocks market, whose AAPLx and NVDAx reserves price from this feed" | `VERIFIED-LIVE` | R7 and R8. The $22.8M covers the xStocks reserves only; the same market's USDC, cbBTC and USDG reserves are excluded. |
| L12 | The session is computed on chain "with holidays and half-days carried as explicit exceptions on the calendar account" | `TESTED` | R25, and `calendar::tests::open_minutes_skip_holidays_and_stop_early_on_a_half_day` |
| L13 | The calendar is "the only check that still works when every price feed on chain is lying" | `TESTED` | `security_test::a_closed_market_is_refused_before_any_oracle_is_read`, `security_test::the_same_impostor_oracle_is_rejected_once_the_market_is_open` |
| L14 | Halt, outage and early close are answered by attestation, by in-session staleness and by the calendar's exceptions | `TESTED` | `gate_test::refuses_when_a_halt_is_attested`, R33, `gate_test::the_half_day_close_refuses_while_a_naive_clock_would_not` |
| L15 | The multiplier is "unlabelled, set by a single keypair, emitting no event" | `REPRODUCIBLE` | For unlabelled, see R19. For the single keypair, verify-onchain 3 shows authority `S7vY…` on both mints; the same key was on all 930 mints read on 2026-09-22 and it signs transactions directly (`keeper/README.md`). |
| L16 | One formula covers "a six-basis-point dividend accrual and a ten-for-one split" | `TESTED` | `adjustment_test::survives_a_real_dividend_step` (AAPLx, +6.0 bps), `adjustment_test::survives_the_netflix_ten_for_one` |
| L17 | "The raw quantity delivered on exercise is stored raw" | `TESTED` | `adjustment_test::the_deliverable_is_raw_and_therefore_never_moves` |
| L18 | Netflix 1.0 → 10.0, CrowdStrike 1.0 → 4.0 | `REPRODUCIBLE` | Same as R20 |
| L19 | "A series can also be written unadjusted, ignoring the mint entirely" | `TESTED` | `adjustment_test::the_unadjusted_series_is_wrong_by_exactly_the_split_factor` |
| L20 | "A series can also be written unadjusted, ignoring the mint entirely. The program's tests write one and show that across a split it is wrong by exactly the split factor." | `TESTED` | `adjustment_test::the_unadjusted_series_is_wrong_by_exactly_the_split_factor`, `adjustment_test::unadjusted_strike_breaks_on_a_split`. This replaces "Every options venue on tokenized equities today writes one of those by omission", which is withdrawn (N20). |
| L21 | "Nine reasons, numbered and stable ... so the reason survives the revert" | `TESTED` | `gate_test::refusal_codes_are_the_integers_the_sdk_publishes`. For the event in a failed transaction's logs, see R39. |
| L22 | The nine refusal descriptions | `TESTED` | One `gate_test::refuses_*` test per code. The order is checked by `sdk/test/refusal-codes.test.ts`. |
| L23 | "Two readings taken off Solana mainnet, against the on-chain market price of the same tokenized shares, per share on both sides. No simulation, no backtest." | `VERIFIED-LIVE` | The two pinned evidence files, which come from R9 and R13. "Per share on both sides" is the R50 correction. |
| L24 | Footer: "2026-09-20 09:15 UTC · 37 H AFTER THE CLOSE · ΔT +82 S · ΔSLOT +312 · AAPLX ΔPX 0.0000" | `VERIFIED-LIVE` | `weekend-2026-09-20.json`, AAPLx row. The 37 h is R10. |
| L25 | "The ETFs held within eight basis points of the oracle; the single names with crypto beta did not" | `MODELED` | The figures are R51 and R52. The contrast is a reading of them. |
| L26 | "Our first version of these figures set a per-token oracle price against a per-share market price and was off by the `ScaledUiAmount` multiplier ... CRCLx, HOODx and COINx, whose multiplier is 1.0, were unaffected." | `REPRODUCIBLE` | Same as R50 |
| L27 | "In both readings five of the eight entries did not move at all and the other three moved by cents" | `VERIFIED-LIVE` | Same as R17 |
| L28 | "Its Replay mode runs the SDK's TypeScript port of the gate on the pinned account bytes; the compiled program runs against the same Scope and AAPLx bytes in the LiteSVM tests, and a drift test pins the port to the program's check order and refusal codes." | `TESTED` | Same as M13 |

---

## Statements not supported as written

None at present. The eight listed here before 2026-09-22 16:00 UTC were corrected in the public copy
on that day. The next section records what each said and what replaced it.

---

## Corrections made on 2026-09-22

1. **The basis figures, and the unit behind them** (README tables, landing Records I and II, the
   app's basis panel, `scripts/measure-basis.py`). Scope prices one unscaled token; Jupiter's
   `usdPrice` prices one share, and a token is `multiplier` shares. The first version compared them
   bare. Every basis figure now uses `oracle_per_share = scope_price / effective_multiplier` and
   `basis = (dex − oracle_per_share) / oracle_per_share` (R50). The pinned files are unchanged and
   their `basis_bps` is bare (R55).

   | | weekend, first version | weekend, like for like | overnight, first version | overnight, like for like |
   |---|---:|---:|---:|---:|
   | AAPLx | −101.3 | −69.0 | −54.8 | −22.3 |
   | NVDAx | −77.2 | −60.3 | −59.6 | −42.7 |
   | SPYx | −64.4 | −7.6 | −57.1 | −0.3 |
   | QQQx | −35.0 | −0.5 | −29.5 | +5.0 |
   | METAx | +2.8 | +31.3 | −20.4 | +8.0 |

   CRCLx, HOODx and COINx carry multiplier 1.0, so their figures did not change: −268.9, −235.6 and
   −91.3 bps on Sunday, −324.0, −235.7 and −268.3 bps on Tuesday.
2. **"Sixty-six of a hundred xStocks are accruing dividends right now."** Not reproducible as
   written. Replaced by a live count with its date and denominator: 388 of 930 (R21). The same
   figure is gone from the comment in `gate_test.rs`.
3. **"There is no mock oracle and no mock token anywhere in this repository"** (README) and
   **"There is no mock token in this repository"** (MOCKS). `market/` mints a devnet stand-in quote
   token. Both files now say exactly that (R48, M19).
4. **"Replay is not a simulation. It is the same code path ..."** (MOCKS, and the instrument's
   Replay line). Replay runs the SDK's TypeScript port. The text now says so, names the drift test,
   and says the compiled program runs against the same Scope and AAPLx bytes in the LiteSVM tests
   (M13, L28).
5. **"Solana mainnet"** (README tagline; landing header and footer). It read as if the program ran
   on mainnet. Now: reads Solana mainnet accounts; the program targets devnet for the live
   demonstration (R1, L1).
6. **"It freezes exactly while the reference market is shut"** (README) and "It freezes while the
   reference market is shut" (landing). Five of the eight entries did not move at all; SPYx, QQQx
   and METAx moved by cents. The text now says which (R17, L27).
7. **"Every options venue on tokenized equities today writes one of those by omission"** (landing,
   and a comment in `adjustment_test.rs`). No survey supports it. Removed; the landing now states
   what the tests show (L20).
8. **Source comments with superseded figures.** `gate.rs` "~70% of the week" is now about 81% (R4),
   with the same fix in `gate_test.rs`. `oracle_test.rs` "61 hours" is now 38 hours, the gap from
   Friday's 20:00 UTC close to the fixture's 10:14:54 UTC Sunday stamp; `settle_test.rs` "61 hours"
   is now 37 hours, the gap to its 09:15 UTC clock. `constants.rs` no longer says Scope "refreshes
   every few slots"; it states the 41–43 s cadence and 44 s largest age of R34.
   `DEFAULT_MAX_PRICE_AGE_SECS` is unchanged at 60. No program logic changed, and
   `cargo test --manifest-path programs/deliverable/Cargo.toml` passed 108 of 108 after the edit.

---

## Not claimed

We do not claim any of the following, including the ones a reader might assume.

- **N1.** That anything here complies with SEC Release 34-106402, or with any other securities rule.
  We make no claim about the regulatory status of writing options on tokenized equities, or about
  who may hold xStocks. Eligibility is enforced off-chain by the distributor.
- **N2.** That the bonding curve is a calibrated implied-volatility surface. Volatility is a
  parameter, and nothing is fitted to a market.
- **N3.** That the halt feed is independently signed. As shipped, the attestor key is ours, and this
  is the weakest link in the refusal chain.
- **N4.** That all of Kamino's reserves price from Scope. We checked only the AAPLx and NVDAx
  reserves. The market's other eight xStocks reserves and its USDC, cbBTC and USDG reserves were
  not checked.
- **N5.** That the program is on mainnet. It is not. It targets devnet for the live demonstration,
  and only the market layer (the DBC series pool) targets mainnet. Whether either deployment exists
  is recorded in PROOF.md, Deployments, and nowhere else.
- **N6.** That anything has been audited. The program, SDK, MCP server, keeper, market layer and app
  have had no external review.
- **N7.** That a deployed binary is a verified build of this source. No verifiable build is
  recorded.
- **N8.** That the pinned evidence files are attested. They are unsigned JSON. The script that made
  them is in the repository so you can take your own reads.
- **N9.** That we have surveyed all of Solana. "No corporate-action feed" and "no options market on
  tokenized equities" describe what we found. They are not proofs of absence.
- **N10.** That Jupiter's `usdPrice` is an executable quote at size. The basis figures compare the
  oracle to an aggregate price and ignore liquidity and slippage.
- **N11.** That Kamino has lost funds or can be exploited. We document how the oracle behaves while
  the market is closed. We do not claim a loss, a profitable trade or a vulnerability.
- **N12.** That the corporate-action history is complete. It holds 119 recovered actions. The
  multiplier authority manages at least 930 mints, and the scanner searches windows anchored on each
  mint's current state.
- **N13.** That the dividend and split labels are ground truth. Nothing on chain labels an action;
  the keeper classifies by ratio and marks its confidence.
- **N14.** That a Preview verdict is what the deployed program would say. Preview uses conventional
  bindings and default tolerances, and it cannot see a halt.
- **N15.** That a refusal event has been observed on a live cluster. Refusal events are tested under
  LiteSVM only, because the program is not deployed.
- **N16.** That there is a liquidation engine. The venue is fully collateralised and nothing is
  liquidated. The oracle failure we document is fatal to lending, and we did not build a fix for
  lending.
- **N17.** That there is a compliance or KYC gate. There is none.
- **N18.** That the Black-Scholes premium is a fair value. It is a defensible opening quote under a
  stated volatility.
- **N19.** That sixty-six of a hundred xStocks are accruing dividends. An earlier README said so, and
  it could not be reproduced. A multiplier above 1.0 records corporate actions already applied, not
  dividends accruing now. The live count is R21.
- **N20.** That every options venue on tokenized equities writes unadjusted series. An earlier
  landing page said so. No venue survey is in the repository.
- **N21.** That Replay runs the compiled program. It runs the SDK's TypeScript port (M13).
- **N22.** That the oracle freezes exactly while the market is shut, for every entry. Five of the
  eight entries measured held still; SPYx, QQQx and METAx moved by cents (R17).
- **N23.** That the `basis_bps` field in the pinned evidence files is like for like. It is bare
  (R55). The README tables and the app recompute it.
