# Our own audit of our own program

Before this repository was made public we spent a day attacking the program in it, on the premise
that a venue holding other people's collateral should be broken by the people who wrote it first.
The exercise found **eleven defects**. **Five of them moved money that was not the attacker's** —
two reachable by any stranger with a keypair, one by a key we hold, one by the issuer's, and one by
nobody at all until a second market calendar existed. All eleven are fixed.

The reproductions are in the repository. Every attack in
[`programs/deliverable/src/tests/audit_test.rs`](programs/deliverable/src/tests/audit_test.rs) was
written to demonstrate that the exploit worked, and every one of them ran red against the program as
it was written. None of them is `#[ignore]`d and none is historical: twenty-one of them run on every
test run, and five still execute the attack step for step and assert that the *outcome* is now
refused or conserved rather than that the attack fails to start. A fix that quietly deleted the
instruction an exploit used would fail those tests too.

```bash
cargo test --manifest-path programs/deliverable/Cargo.toml
```

## What this is not

This is a self-audit. **Nothing here has been reviewed by a third party, and the program has not
been audited in the sense that word usually carries.** The people who found these eleven defects are
the people who wrote the code that contained them, working from the assumptions that produced it,
which is the population least likely to see the twelfth. `CLAIMS.md` N6 says the same thing in one
line and this file does not soften it. What follows is a record of what was tested and what was
found. It is not a clearance, and it is not a claim that the program is secure.

## How it was done

Read-only review of every instruction, every `#[derive(Accounts)]` struct and every arithmetic path,
under an exploit-chain lens (oracle binding, accounting conservation, privileged levers, rounding,
time) and an edge-case lens, with a proof-of-concept written for each candidate before it was
believed. Every surviving claim then went through a refutation pass whose only instruction was to
assume the claim false; two such passes ran. They confirmed the two worst findings and reported them
as *understated* — the assignment attack was rebuilt at roughly $17,000 and the premium attack turned
out to fit in a single atomic transaction — and they narrowed two others, which is the version
written below. No transaction was sent on any cluster. The only network use was three read-only
`getProgramAccounts` / `getMultipleAccounts` calls against mainnet to bound the oracle finding.

---

## The findings, worst first

Ordered by what was armed and exploitable, by whom, at the moment the audit ran — not by the size of
the worst case. F-06 is one finding in three parts.

| # | What it was | Severity | Moved money |
|---|---|---|---|
| F-03 | Premium split by the book *as it stands at claim time* — atomic just-in-time capture, and a freeze that costs capital to unlock | High | Yes — scales to ~100% of the premium pool |
| F-02 | Assignment floored for every writer; the shortfall clamped onto whoever settled after the vault dried | High | Yes — up to 100% of a writer's collateral return; ≈$17,000 in the worked attack |
| F-10 | The settlement clock ran while the gate was refusing, so in-the-money options expired worthless | High | Yes — $60.20 per contract at the tested strike, all of it, to the writers |
| F-11 | `settle_expired` accepted **any** calendar — settle before the window closes, drain the vault | High | Yes — the whole collateral of a series |
| F-01 | The Scope oracle account was bound by owner only, never by address, and with no discriminator | High (rail integrity) | No — the price is a pure gate predicate |
| F-06a | The re-cut strike could floor to **0** — free physical delivery | Medium (issuer-conditional) | Yes, if the multiplier authority is hostile |
| F-05 | The series PDA omitted the quote mint, the contract size, the window and the adjust flag — squatting | Medium | Griefing and user deception |
| F-07 | The calendar was keyed `MMDD`, carried no year, and never expired | Medium | No — wrong refusals, and one wrong non-refusal |
| F-09 | `probe_security` reverted instead of recording an oracle outage | Medium (refusal guarantee) | No |
| F-06c | A multiplier change stamped effective *now* skipped the quiet period entirely | Medium | No, on its own |
| F-04 | `claim_premium` was outside the gate *and* the registry pause | Low–Medium | No |
| F-06b | `checked_shl` did not detect lost high bits | Low | No |
| F-08 | The sixteen-day session scan silently truncated settlement windows longer than it could measure | Low | No |

---

### F-03 — Premium was split by the book as it stood at claim time

**What it was.** `claim_premium` recomputed each writer's entitlement from the vault's whole history
against the book *at the moment of the claim*: `pool × contracts / contracts_written`, minus what
that writer had already taken. There was no per-contract accumulator and no snapshot of the book at
the moment premium arrived, and `contracts_written` only ever grows.

**What an attacker got.** Writer A writes one contract; 10,000,000 raw of premium arrives; writer B
writes one contract; A claims and is paid **5,000,000**. B captured half of a premium paid for a
period in which B carried no obligation. To capture a fraction *f* of the pool, post `f/(1−f)·W`
contracts. The cost was lower than it looks: `write` was legal until the instant of expiry and
`claim_premium` had no phase check, so `open_position` + `write` + `claim_premium` was **a single
atomic transaction** — unfrontrunnable, sendable seconds before expiry — and because `write` mints
the option tokens to the writer, the attacker was long one and short one, flat, with no directional
exposure. The collateral came back thirty open minutes later.

The second half was worse than dilution. Once the denominator grew past a completed claim, the
over-claimed writer's payout saturated to zero and was rejected, while the under-claimed writer was
told he was owed 6,000,000 out of a vault holding 2,000,000 — and his transfer failed. **2,000,000
raw of premium was reachable by nobody**, in the one instruction that is the only exit from that
vault. It was stranded rather than burned — a writer with working capital could donate the
difference and recover it — but the freeze proved the real defect: `Σ payouts` could exceed the
vault balance, so conservation was broken by construction.

**The fix.** A monotone accumulator. `OptionSeries.premium_per_contract_acc` is credited from the
vault delta *before* `contracts_written` grows, and each position carries a `premium_debt`
checkpoint stamped at every `write`. A writer is paid `acc × contracts − debt`, which is
time-weighted by construction, cannot exceed what the vault received, and leaves nothing stranded:
the uncredited remainder of each integer division is picked up by the next accrual.

**Guarded by** `audit_test::premium_earned_before_a_writer_existed_is_shared_with_them` (writer one
is now paid the whole 10,000,000 he earned) and
`audit_test::premium_is_stranded_when_the_book_grows_after_a_claim` (both writers claim; the vault
ends at zero).

### F-02 — Assignment floored for every writer, and the shortfall landed on whoever settled last

**What it was.** `WriterPosition::assigned` computed `floor(contracts × exercised / written)` for
**every** writer, so `Σ assigned ≤ contracts_exercised` and the writers collectively reclaimed more
raw collateral than the vault held. `settle_expired` absorbed the excess with
`raw_back.min(vault.amount)` and set `settled = true` regardless. The excess was up to
`writers − 1` **whole contracts** — one contract is one whole AAPLx share, not dust. The code
comment that produced it said "at most one unit per writer"; the unit was a share.

**What an attacker got.** Settlement became a race, and the race could be rigged. An attacker opens
100 keypairs with one contract each against an honest whale holding 100, so `W = 200`; holders
exercise 100. `floor(1 × 100 / 200)` is **zero for all hundred dust positions** and
`floor(100 × 100 / 200)` is **fifty** for the whale. The dust reclaims a hundred contracts and
drains the vault; **the whale's return clamps to zero and he loses all fifty contracts — fifty real
AAPLx shares, about $17,000.** The dust costs nothing: `write` was legal until the instant of
expiry, so it could be posted seconds before it and settled thirty open minutes later, capital
returned in full. The attacker's only expense was abandoning his own option tokens.

The same defect fired by accident at two writers: one contract each, one exercised, `assigned = 0`
for both. The first to settle took a full share and half the strike; the second received **nothing**
back and half the strike. At the suite's exercise cost of 341,111,464 µUSDC, that is ≈$170
transferred on transaction ordering alone, and more whenever the share is above the strike — which
is the only case in which anyone exercises.

**The fix.** `WriterPosition::conserving_assignment` takes the pro-rata share rounded **up**, capped
by `contracts_exercised − contracts_assigned_total`, where `contracts_assigned_total` is a new
running counter on the series. Rounding up cannot over-assign a writer, and the cap makes the sum
exact: `Σ (contracts − assigned) == contracts_written − contracts_exercised`, which is precisely the
vault balance. The quote leg is now paid on what a writer was *assigned* rather than on what he
wrote, so the writer who delivers the share is the writer paid for it. The `.min(balance)` clamp
stays as a last-resort guard against a permanent-delegate seizure — a route this program does not
control — and any shortfall it absorbs is now emitted as `raw_shortfall` on `PositionSettled`
instead of vanishing.

**Guarded by** `audit_test::a_dust_swarm_cannot_drain_the_whales_collateral` (runs the hundred-dust
attack at the audit's own numbers and asserts the whale's hundred contracts come back whole),
`audit_test::assignment_rounding_leaves_the_vault_short_of_what_writers_reclaim` and
`audit_test::the_first_writer_to_settle_takes_the_second_writers_collateral`.

### F-10 — The settlement clock ran while the gate was refusing

**What it was.** `open_minutes_between` stops for a closed market, which is the case the design was
built around, and for none of the other six refusal reasons. `exercise` is gated; `settle_expired`
is deliberately not. So a refusal spanning the settlement window was not a delay. It was a total
loss for every in-the-money holder and a windfall for the writers, with no extension, grace period
or re-open anywhere in the program.

**What an attacker got.** One `attest_halt(true)`, sent once. The gate read `halt.halted` and never
looked at `attested_ts`, so a single transaction blocked exercise on that security across every
series and every expiry, indefinitely, from an attestor who never came back online. With
`contracts_exercised == 0`, every writer reclaimed 100% of their collateral, paid nothing, and kept
the premium. At the series the suite uses — 341,111,464 µUSDC to exercise, 1.00326901 AAPLx
delivered — a $400 spot makes that **$60.20 per contract, all of it, transferred from holder to
writer**. A thousand contracts is $60,196. The registry authority had the identical lever through
`set_registry_paused`, because `Exercise` carries `!registry.paused` and `SettleExpired` does not.

The second trigger needed no key of ours. The gate refused on a pending multiplier change over
`[E − 1800, E)`, so a window of `W` open minutes is swallowed whole whenever `E ∈ [X + 60W,
X + 1800]` — a band `1800 − 60W` seconds wide. At `W = 30` that is a single instant, a knife-edge
rather than a hazard; at `W = 5` it is twenty-five minutes wide and at `W = 1` twenty-nine, and
nothing stopped a series being listed with a one-minute window. A routine dividend accrual scheduled
by the issuer, aimed or not, expired every option in such a window.

**The fix.** The clock now measures *actionable* minutes, not merely open ones. `refused_window_minutes`
subtracts the intervals over which the venue provably refused, clipped to the window; the phase is
computed from `elapsed − refused`, and a settlement attempted before those minutes are spent fails
with `SettlementWindowPostponed`. Only refusals with a durable record can be subtracted, because the
instruction that hit one reverted and took its own record with it — an attested halt carries
`since_ts` and keeps it after being lifted (`lifted_ts`), and Token-2022 keeps a multiplier change's
effective timestamp on the mint. Both are read from accounts the caller cannot choose, and both are
clipped to `window_opened_ts`, the instant a gate pass after expiry succeeded, which bounds what a
backdated `since_ts` can buy. Separately, a halt attestation now goes stale after an hour
(`HALT_ATTESTATION_MAX_AGE_SECS`): holding a halt costs a transaction an hour, on chain and in
public, instead of one transaction ever.

The tempting one-liner — refuse `settle_expired` while halted — was rejected deliberately. It would
have let the attestor strand the *writers'* collateral forever instead of the holders' intrinsic
value, which is the symmetric harm the ungated `settle_expired` existed to prevent. The fix had to
be to the clock.

**Guarded by** `audit_test::an_attested_halt_across_the_window_expires_every_option_worthless` (the
halt still refuses, the writer still cannot settle, and the holder exercises once the attestation
goes stale), `audit_test::clearing_a_halt_does_not_give_back_the_window_it_consumed`, and
`audit_test::a_scheduled_corporate_action_can_swallow_the_whole_window`.

### F-11 — `settle_expired` accepted any calendar

**What it was.** Five instructions that take a `MarketCalendar` also assert it is *the security's*
calendar. `SettleExpired` was the sixth and did not, because it carried no `security` account to
compare against and `OptionSeries` stored no `calendar_id`. The only check was the PDA seed, which
every calendar satisfies for its own id — and the calendar handed in is what decides, through
`open_minutes_between`, whether the exercise window has run out.

**What an attacker got.** A writer hands in whichever calendar says the window is already over,
calls `settle_expired` **while the real window is still open**, and takes the collateral back before
any holder can exercise. Every subsequent `exercise` then fails with `InsufficientCollateral` for
everybody: every in-the-money option becomes unexercisable and the writer keeps the share and the
premium. The whole collateral of a series, in one transaction.

**Precondition, stated as the audit stated it.** A second `MarketCalendar` had to exist, and only id
0 did, so this was never armed on a live cluster. But `MarketCalendar::id` exists precisely so that
several can, `init_calendar` is a shipped instruction, and `MOCKS.md` tells operators that a later
year requires appending a new calendar. The first day a second calendar was created, it would have
become an unconditional drain of every open series.

**The fix.** `SettleExpired` now carries `security`, constrained `security.key() == series.security`
as `Write` and `Exercise` already were, plus `constraint = calendar.id == security.calendar_id`.

**Guarded by** `audit_test::a_writer_settles_early_by_handing_in_a_different_calendar`, which still
creates the second calendar and still sends the settlement.

### F-01 — The Scope oracle was bound by owner, never by address

**What it was.** `oracle::observe` checked only that a Scope account was *owned by* the Scope
program. `constants::SCOPE_PRICES` was declared and compared against nothing, and
`OracleSource::Scope` stored an index and no pubkey, so there was nothing to compare against even if
the code had wanted to. The decoder read no discriminator either, and its length check was weaker
than the real account. The full acceptance predicate was: owned by Scope, long enough, a non-zero
`u64` at the right offset, and a second `u64` at most 30.

**What an attacker got.** The `OracleStale` refusal was defeated by handing in a substitute
Scope-owned account. The two-source corroboration requirement — this project's stand-in for a
confidence band — was satisfied by **one** substitute account serving both legs. And `sync_security`
is permissionless, so anyone could write an arbitrary price onto the `SecurityState` the README
advertises as a rail readable without a CPI. A read-only mainnet survey on 2026-09-22 found **five**
live `OraclePrices` accounts under the Scope program, of which one is the feed we bind; **150
indices were populated in the bound feed and simultaneously fresh in a sibling with completely
unrelated prices** — index 1 read $118.25 in ours against $2,753.18 in theirs, index 2 $118.25
against $86,566.68. Any security registered at one of those indices was spoofable that day, at zero
cost, with an account that already existed.

**Bounded honestly, twice.** No payout moved: the gate's observed price is never read into a cost, a
delivery or a strike, so a forged price produced an action during a condition the venue promised to
refuse, not a mispriced fill. And the headline refusal survived it intact — `refuse_if_closed` runs
before any oracle account is read and is pure calendar arithmetic. What this cost was the two
oracle-derived refusals and the integrity of the rail we invite third parties to read. The two
securities we actually register were not exploitable through an existing sibling, by luck rather
than design: their indices are zero in all four siblings and the decoder rejects a zero.

**The fix.** The adapter binds the account by address before it checks the owner, and the decoder
now checks the Scope discriminator and the exact account length — the same bind the Pyth adapter
already performed with its 32-byte `feed_id`. Two related holes closed with it:
`register_security` now requires the two bound sources to be distinct (`SourcesNotIndependent`),
since `Pair { Scope{317}, Scope{317} }` used to register fine and yield a divergence of zero
forever; and the staleness and divergence tolerances, previously bounded only from below, are now
bounded above as well, so `u32::MAX` can no longer make a refusal decorative for a security that has
no update instruction.

**Guarded by** `audit_test::a_forged_scope_account_defeats_the_staleness_refusal`,
`audit_test::anyone_can_publish_an_arbitrary_price_onto_the_rail`,
`audit_test::one_forged_account_corroborates_itself`, and
`security_test::a_correctly_owned_scope_account_at_the_wrong_address_is_refused` — the last of these
exists because the old fixture only ever rewrote the account's **owner**, which is structurally why
this was missed. Two shipped sentences in `README.md` and `MOCKS.md`, and the evidence behind
`CLAIMS.md` R48, were corrected at the same time; they had claimed a binding the code did not
perform.

### F-06 — The multiplier had no bound, and the re-cut strike was never checked for zero

**F-06a — the re-cut strike could floor to zero.** `current_strike` computed
`floor(strike0 × m0 / m1)` and nothing required the result to be positive. `exercise_cost` multiplies
by it, so a large enough multiplier made a contract cost **nothing** and the holder took physical
delivery of a real share for free; `current_ui_size` was the mirror case on a large reverse split.
The reproduction drives it through the compiled program against the real AAPLx mint at a multiplier
of 1e10: *the holder paid 0 and received 100000000 raw AAPLx.* The magnitudes required are not
reachable by any real corporate action — the largest real xStock multipliers are KLACX at 10.016833
and VUGX at 6.004668 — so this needed the mint's `ScaledUiAmount` authority, which is the issuer.
That lever is strictly more powerful than the pause already named in `MOCKS.md`, and it was not
named there. **Fixed** by flooring both the re-cut strike and the re-cut UI size at one unit, and by
`require_multiplier_in_band`, which refuses (`MultiplierOutOfBand`) once the multiplier has moved
more than a thousandfold in either direction from the one captured at listing. A thousandfold band
admits every corporate action in recorded history. Guarded by
`audit_test::a_hostile_multiplier_hands_the_collateral_over_for_nothing` — the issuer still moves
the multiplier and the venue now declines to price the contract at all — and
`audit_test::a_large_multiplier_floors_the_strike_to_zero`.

**F-06c — an immediately-effective change skipped the quiet period.** The extension reader reported
`pending: None` the instant a change took force, so the `MultiplierPending` refusal only ever saw
changes the issuer scheduled ahead. A change stamped effective *now* moved the multiplier underneath
an open settlement window in the same slot and the gate reported nothing. **Fixed** by reporting the
change as pending through the instant it lands. Guarded by
`audit_test::an_immediately_effective_multiplier_change_is_never_quiet`.

**F-06b — `checked_shl` did not detect lost high bits.** Rust's `u128::checked_shl` returns `None`
only when the *shift amount* is 128 or more; it says nothing about significant bits leaving the top
of the word. Above roughly 2^87 the decoded multiplier wrapped modulo 2^128 instead of failing —
measured, 2^90 decoded to `217_092_938_522_564_884_509_000_401_704_695_365_632`. Not separately
exploitable, but a decoder that silently disagrees with Token-2022 about the same mint is the bug
this project exists to prevent, and we wrote it. **Fixed** by multiplying by the power of two rather
than shifting, so the overflow is caught. Guarded by
`audit_test::a_huge_multiplier_wraps_instead_of_failing`.

### F-05 — The series PDA omitted the terms a writer cares about

**What it was.** The seed was `(mint, expiry, strike, kind)`. The quote mint, the contract raw size,
the settlement window and `adjust_on_corporate_action` were instruction arguments outside the
address, and `create_series` is permissionless. Whoever listed first fixed all four for that
canonical slot forever, because re-listing collides.

**What an attacker got.** A squatter lists the canonical "AAPLx $340 call, expiry X" quoted in a
worthless token of their choosing, one raw unit per contract, a one-minute settlement window and the
strike adjustment switched off — and the honest listing can never be created. A writer reading
"AAPLx $340 call" in an interface, or an SDK deriving the PDA from the four published terms as ours
does, lands on the squatter's terms. The unadjusted variant deserves its own line: on a reverse
split an unadjusted series charges the holder a fraction of the notional for the same raw delivery,
which is a loss for the writer rather than a curiosity.

**The fix.** All four terms are in the seeds, so two different sets of terms are two different
series and the canonical name means what it says. `create_series` also rejects
`quote_mint == underlying_mint` (`SelfQuotedSeries`), which was one of the squatter's tools.

**Guarded by** `audit_test::a_squatter_fixes_the_terms_of_the_canonical_series`, which still sends
the squat, and by `constraints_test::every_series_is_derived_from_all_of_its_terms`, which asserts
every term appears in the seeds on every instruction that takes a series.

### F-07 — The calendar was keyed `MMDD` and never expired

**What it was.** The schedule is published in `MMDD` form and the table was keyed that way, with no
year and no expiry, so every entry fired in every subsequent year until someone rewrote it. Both
directions were already live in the shipped table: `closed(9, 7)` is Labor Day 2026, and in 2027 the
7th of September is an ordinary Tuesday on which the program refused all day; Labor Day 2027 is the
6th, which was not in the table, so the program reported a regular session on a day the exchange is
shut. The first is a safe-but-wrong refusal. The second is the dangerous one: the session gate
passes and the refusal falls through to the staleness check, which is the exact fallback this
project calls structurally wrong for equities.

**The fix.** `date_key` is now `(year << 16) | (month << 8) | day`, the committed table carries the
year each holiday was published for, and Labor Day 2027 is in it. `append_calendar_entries` also
validates what it is handed — the year, month, day, the entry kind and an early close inside the
session — rather than accepting any bytes from the authority.

**Guarded by** `audit_test::the_committed_calendar_misreads_the_following_year`, which holds both
directions.

### F-09 — The refusal ledger could not count an oracle outage

**What it was.** `probe_security` is the only path that can write a refusal down, because every
other caller reverts and takes its own counter with it. But it read the oracle *before* it reached
the gate, and a read that failed hard — a Scope entry gone to zero, which is exactly what an
unpublished slot looks like — reverted the whole instruction. So the refusal ledger could not count
the one condition this project exists to advertise: a feed that has stopped publishing. The
counters stayed silent precisely when they mattered.

**The fix.** `probe_security` is total. Each oracle read and each multiplier read is matched rather
than propagated, and a failure is recorded as `OracleUnreadable` or `MultiplierUnreadable`. Both
codes were appended at the end of the enum rather than renumbered, so every integer a published
failed transaction already carries still means what it meant.

**Guarded by** `audit_test::the_refusal_ledger_cannot_count_an_oracle_outage`.

### F-04 — Claiming premium was outside the gate and the registry pause

**What it was.** `ClaimPremium` carried no registry account and never called the gate. It moved the
**underlying share** — the same asset as the collateral — out of a series-owned vault while the
venue was paused, the market shut, the issuer's `Pausable` set, or a transfer hook attached. That
made `README`'s sentence about the kill switch ("set it and every gated action refuses") false of
the one instruction that could empty a vault. It was also one of two paths that forwarded
caller-supplied `remaining_accounts` into `transfer_checked_forwarding` without first refusing on
`transfer_hook.is_some()` — harmless while the hook is null on every xStock, and exactly the
scenario the gate was written for.

**The fix.** `ClaimPremium` now carries the registry with `!registry.paused`, the security and the
calendar, and takes the full gate. `settle_expired` stays ungated on purpose — a paused venue must
not be able to strand a writer's collateral — and that exception is now asserted, with its reason,
rather than merely commented.

**Guarded by** `audit_test::premium_leaves_the_vault_while_the_venue_is_paused_and_the_market_is_shut`
and `constraints_test::the_kill_switch_reaches_every_value_moving_instruction_but_one`.

### F-08 — The sixteen-day scan truncated long settlement windows

**What it was.** `open_minutes_between` returns `u32::MAX` once two instants are more than sixteen
calendar days apart, and the accumulator tops out at 3,910 open minutes before it does.
`settlement_window_minutes` is a `u16` validated only as `> 0`, so anything above about 3,900 behaved
as "sixteen calendar days" and the phase jumped from `Settling` past the rest of the intended window.

**The fix.** Not a wider clock — the scan bound is deliberate, and it is what stops a settlement call
being made expensive by leaving a series unsettled. Instead `MAX_SETTLEMENT_WINDOW_MINUTES` is
*derived* from `MAX_SESSION_SCAN_DAYS` (3,900 minutes) so the two cannot drift apart, and a longer
window is refused at listing with `SettlementWindowTooLong`.

**Guarded by** `audit_test::a_long_settlement_window_is_cut_short_by_the_scan_bound`, which holds
both halves: the measurement showing where the clock tops out, and the refusal that keeps a listing
inside it.

---

## The pattern

**Six of the eleven were the same shape: a rule applied correctly everywhere but one sibling.**

- The calendar bound on five instructions and not the sixth (F-11).
- The address bound on the Pyth adapter and not on Scope (F-01).
- The registry pause on four value-moving paths and not on two (F-04, F-10).
- The `> 0` check on `strike0` at listing and not on the re-cut strike at settlement (F-06a).

None of them was a subtle algorithm. Every one was a missing line that existed a few files away, and
a per-instruction happy-path test cannot see a missing sibling, because the happy path does not
exercise the constraint. Eleven tests for eleven findings would have caught eleven bugs; the shape
needed a different kind of test.

[`constraints_test.rs`](programs/deliverable/src/tests/constraints_test.rs) is that test. It does
not test behaviour. It parses every `#[derive(Accounts)]` struct out of the program source and
asserts, rule by rule, that every account of a given kind carries the constraints accounts of that
kind carry — every calendar bound to its security, every series derived from all of its terms, every
vault pinned to the one its series names, every participant token account checked on both mint and
owner, every value-moving instruction reached by the kill switch. Every exemption is written next to
the reason it is allowed, `SettleExpired` among them. Two of its assertions have no exemption at
all: one enumerates every account struct in the program and fails when a new one appears undeclared,
and one enumerates every account *name* and fails when a field nobody has written a rule for is
added. It is a parser rather than a macro on purpose — a proc-macro reflection could only report
what Anchor understood, and the defect being guarded against is an attribute that was never written.

## What is still exposed

Fixing eleven findings is not the same as having none, and these are the ones we know about and have
not closed. They are stated here rather than in a footnote.

**A registry authority that pauses across a settlement window can still expropriate holders.** The
settlement clock defends against a halt and against a scheduled multiplier change because both leave
a durable, retrospective record — `since_ts` on the halt, the effective timestamp on the mint.
`registry.paused` leaves no such record. It is a boolean with no memory of when it was set, so the
minutes it refused over cannot be reconstructed afterwards and are not given back. A pause held
across a settlement window is therefore the same trade a halt used to be: the holder's intrinsic
value moves to the writers. This is the most valuable lever in the system, it belongs to the deployer
wallet, and on devnet that wallet is also the upgrade authority. It is named in `MOCKS.md`, "Three
levers over other people's money", in the same words.

**A multiplier change stamped effective in the past still slips the quiet period.** The gate now
refuses through the instant a change lands, but a change the issuer stamps with a timestamp already
behind us is not distinguishable from an old one by reading the mint. Refusing for a period *after*
the fact would itself consume a settlement window, which is the exact harm F-10 is about, so we
declined to do it. What bounds the residual is the thousandfold band and the floors on the re-cut
strike and UI size: the issuer can still move the number inside the band and we still price against
it, which is the trust assumption the whole design rests on.

**Assignment is conserving but order-dependent.** `Σ assigned == contracts_exercised` exactly, and
every writer's collateral return is now independent of where they settle in the queue — that is what
was broken and is fixed. But *who* is assigned still depends on settlement order: the rounding
remainder lands on the earliest settlers, who are assigned the extra contract and paid the strike
for it, and the last settlers are assigned nothing. Both outcomes are fully funded and fully paid,
so nobody is short; the distribution of assignment within a series is still a race. Largest-remainder
would be fairer and needs every position in one transaction.

**The clock credits a quiet period whether or not the gate actually refused for it.** The multiplier
quiet interval is subtracted from the settlement window whenever the mint carries an effective
timestamp inside it, without checking whether the gate would have refused over those particular
minutes — the market may have been closed anyway, or the window may not have opened yet. The error
is bounded by the quiet period itself and runs in the holder's favour: at most thirty minutes of
settlement postponed for a writer who was not in fact refused.

**An attestor who keeps re-signing can still postpone settlement.** A halt attestation now expires
after an hour, so nobody can be expropriated by one signature. An attestor willing to re-attest
indefinitely can still hold a series' settlement open until sixteen calendar days after expiry, at
which point the session accumulator saturates, the writers get their collateral back and the
holder's option does expire. That bound is deliberate: the alternative is a refusal nobody lifts
freezing the writers' collateral permanently. Nobody is expropriated by one signature; a determined
attestor can still make everyone wait.

**The refusal counters are attacker-writable in both directions.** `probe_security` and
`sync_security` are permissionless by design. Anyone can inflate `refusals` by spamming a condition
that refuses, and anyone can suppress it by never probing. The counters are for display, and the
interface presents them as evidence.

**The registry authority can still shape the calendar**, within validated bounds, and can still
upgrade the program. Nothing in this audit mitigates an upgrade.

## What was examined, and what was ruled out

An audit that reports nothing should say what it looked at. These were examined and found sound.

- **Anchor account validation**, every `#[derive(Accounts)]` struct, everything outside F-11 and
  F-01. Vaults are PDA-seeded *and* cross-checked against `series.*`; participant token accounts are
  constrained on both mint and owner in all six places; positions are seeded `(series, writer)` with
  their stored bump; the option mint's authority is the series PDA, so option tokens cannot be
  minted outside `write`. `constraints_test.rs` now holds all of it.
- **`contracts_exercised ≤ contracts_written`** is enforced, and option tokens are minted 1:1 in
  `write` and burned in `exercise`, so the exercised count cannot be inflated.
- **Rounding direction on the exercise path.** `exercise_cost` rounds up per contract while the
  strike and UI size round down, so the holder never underpays by more than the truncation.
  Quantified: **under one quote unit per adjusted share delivered** — $0.000001 per share per
  contract for an 8-decimal underlying against 6-decimal USDC. **The adjustment invariant itself
  holds across a 10× split to within that truncation**, which is what `adjustment_test.rs` asserts
  against the Netflix ten-for-one, the CrowdStrike four-for-one and a real AAPLx dividend, with an
  unadjusted control that must fail.
- **Dust positions across a split.** At a contract size of 1e-8 share, pre-split cost and post-split
  cost are both four quote units. The split is notional-neutral at dust size; the free-delivery
  cases required an absurd multiplier (F-06a), not a small position.
- **The multiplier boundary between two instructions in the same slot.** `Clock::unix_timestamp` is
  constant within a slot, so two instructions in one transaction read the same multiplier. Across
  slots the invariant holds in both directions: crossing an effective timestamp between a `write`
  and an `exercise` is not profitable, because the cost and the delivery move together.
- **The small end of the fixed-point decoder.** Subnormals, zero, NaN, infinities and negatives are
  all rejected, and the rounding-half addition cannot overflow. Only the large end was wrong
  (F-06b).
- **Calendar arithmetic.** The civil-date conversions round-trip, including across the 2000 leap
  year and negative day numbers; the DST instants are correct; the `[open, close)` convention is
  applied consistently; the sixteen-day scan covers the longest real run of consecutive closed days
  with room to spare.
- **Token-2022 specifics.** `transfer_checked` is called with the mint's raw decimals on every path,
  which is correct for a `ScaledUiAmount` mint — the extension changes the display, not the transfer
  unit. `remaining_accounts` are forwarded with their metas preserved. A `Pausable` flip mid-flow
  fails the transfer and the transaction reverts atomically, with no half-state. A permanent-delegate
  seizure is unpreventable by any third-party program and is named as such in `MOCKS.md`.
- **Reentrancy.** Solana forbids re-entering a program already on the call stack, and every
  value-moving path writes its state after a revert-on-failure CPI inside one atomic transaction.
  The only external-code surface is an attached transfer hook, which the gate refuses.
- **The Pyth adapter.** Properly bound: owner, discriminator, `VerificationLevel::Full`, and the
  32-byte `feed_id`. No staleness *selection* is possible, because the caller cannot choose a price
  older than the account holds. **This is the correctly content-bound model, and it is the one the
  Scope adapter was fixed to copy.**
- **The quote side of settlement.** `Σ floor(quote_collected × cᵢ / W) ≤ quote_collected`, so the
  quote vault was never over-subscribed. Only the raw side was, which was F-02.
- **Double-claiming premium** by the same writer was blocked. The premium defect was F-03, which is
  a different shape.

A further thirteen hygiene items were recorded alongside the eleven: dead constants that
documentation described as enforced, `/// CHECK` comments that overstated what was checked, a
capacity check that counted replacements as additions, a struct field computed and never read. None
of them cost anyone money. The ones that propped up a stated guarantee were closed with the findings
above; the rest are cosmetic and some are still open — a failed vault-address check, for instance,
still reports `MintMismatch`, which costs a reader of a published failed transaction real debugging
time and nothing else.
