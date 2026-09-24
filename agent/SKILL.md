---
name: Deliverable rail — tokenised-equity actionability
description: Ask whether a tokenised US equity can be acted on right now, read a strike that survives corporate actions, and handle each of the eleven refusal codes. For any agent that touches xStocks, not only this venue's.
---

# Deliverable rail

You are about to touch a tokenised US equity. Before you do, there is a question you
cannot answer from a price feed: **is this security actionable right now?**

Nothing on Solana answers it today. Pyth's on-chain `PriceUpdateV2` has no status field,
so "market closed", "stock halted", "oracle outage" and "early close" are the same
observation: a timestamp that stopped moving. And the unit itself moves — every dividend
and every split on an xStock is a change to the Token-2022 `ScaledUiAmount` multiplier
on the mint, with no event, no label and no corporate-action feed anywhere on the chain.
On 2026-09-22, 388 of the 930 xStock mints on Jupiter's verified list carried a
multiplier other than 1.0.

This skill is how you ask, and what to do with each answer.

---

## 1. The one call that matters

```ts
import { createDeliverable } from '@stocklana/sdk';

const d = createDeliverable();                       // SOLANA_RPC_URL, or { rpcUrl }
const verdict = await d.isActionable(mint, { preview: true });

if (!verdict.actionable) {
  // verdict.code      1..9
  // verdict.name      'MarketClosed' | 'Halted' | ...
  // verdict.reason    plain English, with the numbers that tripped it
  // verdict.errorCode the Anchor error the on-chain instruction fails with
  return;                                            // <- do not act. See section 4.
}
```

`isActionable` reads the SecurityState, its calendar, the mint, the Scope price account
and the Clock sysvar in **one `getMultipleAccounts`**, so every input describes the same
slot. It then runs `checkActionable`, which is `check_actionable` from the program's
`gate.rs`, ported line for line — same order, same integer arithmetic, same rounding.
The verdict you get off-chain is the verdict the instruction will reach on-chain.

Or through MCP, with no code at all:

```jsonc
// mcp/ in this repository: a read-only stdio MCP server
// tools: is_actionable, security_state, list_series, series_detail,
//        adjusted_balance, corporate_actions, refusal_codes
{ "name": "is_actionable", "arguments": { "underlying": "AAPLx" } }
```

`basis` tells you what you are looking at. `registered` means every input came from a
SecurityState on chain. `preview` means the mint is not registered under this program
yet, and the gate ran on the committed calendar, the program's default tolerances and
the conventional Scope binding; `notes` lists each assumption. A preview cannot observe
a halt attestation — that is the one input it does not have, and it says so.

---

## 2. Prices are per token. Strikes are per share. They are not the same number.

Scope publishes the price of **one unscaled token**. A strike, a spot and a premium are
quoted per **share** — the thing a human means. One token is `multiplier` shares.

```
price_per_share = scope_price / effective_multiplier
```

The effective multiplier is `newMultiplier` once `newMultiplierEffectiveTimestamp` has
passed, and `multiplier` before it. Skip the division and you are 33 bps wrong on AAPLx
today, and wrong by a factor of ten on a name that has split. This repository made that
exact mistake in the first version of its own measurement and left the correction in the
README, so take it seriously.

The RPC does not help you: `getTokenAccountBalance` and `getTokenSupply` apply the
multiplier, and `getTransaction`'s `preTokenBalances` / `postTokenBalances` do not. Use
`getAdjustedBalance`, which ignores every reported `uiAmount` and recomputes from the raw
amount, and tells you which multiplier it used and why:

```ts
const b = await d.getAdjustedBalance({ owner, mint });
// b.uiAmount, b.raw, b.multiplier, b.provenance, b.reported, b.reportedWasScaled
```

---

## 3. Adjusted strikes: read them, never store them

A contract covers a fixed **raw** amount. The strike is quoted per **UI** unit. When the
multiplier moves `m0 -> m1`:

```
strike  = strike0 * m0 / m1
ui_size = raw_size * m1

=> strike * ui_size is invariant
```

One formula covers a six-basis-point dividend and a ten-for-one split identically, so
**the corporate action never has to be classified**. A ten-for-one split turns one option
on one share at $500 into one option on ten shares at $50: same dollars, same tokens
delivered.

```ts
const s = await d.currentStrike(seriesAddress);
// s.strike, s.strike0, s.multiplierAtMint, s.multiplier, s.uiSize, s.notional, s.adjusted
```

The rule for you as an agent: **derive the strike at the moment you use it**. Do not
cache it, do not carry it between turns, and do not wait for anyone to call an adjustment
instruction — there is one, `acknowledge_adjustment`, but it only emits an event for
indexers. Correctness comes from reading the mint, not from being told.

---

## 4. The eleven refusal codes, and what to do about each

Every refusal is a typed code, emitted as an on-chain `Refused` event and written onto
`SecurityState.last_refusal_code`. The failure is the artifact. Map a failed transaction
back to a refusal with `refusalFromErrorCode`, which is a lookup rather than arithmetic:
`errorCode = 6000 + code - 1` holds for the first nine, and codes 10 and 11 were appended
after the audit with their Anchor variants at the end of the enum, so they are 6033 and
6034.

The first nine are what the gate itself decides. Codes 10 and 11 are failures to *read*
an input, recorded by `probe_security`, which stays total so the refusal ledger can count
a feed that has stopped publishing.

The nine are **not** evaluated in numeric order. `gate.rs` checks the calendar first because
it is the cheapest check and it holds for most of the week, then the issuer levers, and
only then reads an oracle:

```
MarketClosed -> Halted -> IssuerPaused -> HookAttached -> MultiplierPending
             -> OracleStale -> ConfidenceBlown -> SingleSource -> SourcesDisagree
```

| # | name | what it means | what you should do |
|---|---|---|---|
| 1 | `MarketClosed` | The committed exchange calendar says the US equity market is shut: night, weekend, holiday, or after an early close. Decided by arithmetic on `Clock::unix_timestamp`, before any oracle is read. | **Wait.** This is the expected state for about 81% of the week and says nothing is wrong. The verdict hands you `nextOpen`; re-read then. Do not treat a stale price as a closed market, and do not treat a closed market as an outage. |
| 2 | `Halted` | A trading halt has been attested for this security by the registry attestor. | **Stop, and do not retry on a timer.** A halt is attested, not computed: it clears when the attestor says so. Escalate rather than poll. |
| 3 | `OracleStale` | The market is open but a source has not published inside the security's staleness tolerance. Inside a session that means an outage, not a closed market. | **Do not fall back to the last price.** Retry once the source publishes. If it persists, treat the security as unpriceable and say so. |
| 4 | `ConfidenceBlown` | A source that publishes a confidence band published one wider than `maxConfBps`, or printed a price that is not usable at all. | **Wait for the band to narrow. Widen nothing.** The tolerance is the security's own registered bound; an agent that raises it is choosing to trade on a number the venue already called unusable. |
| 5 | `MultiplierPending` | A `ScaledUiAmount` change — dividend, split or reverse split — takes effect within the 30-minute quiet period. | **Wait out the window, then re-read the strike.** Every strike on this name is about to be re-cut by `m0/m1`. Acting inside the window prices in the old unit and settles in the new one. |
| 6 | `IssuerPaused` | The issuer has set the mint's `Pausable` extension; the token cannot move. | **Stop.** No transfer of the collateral can settle. This is an issuer action and retrying does not move it. |
| 7 | `HookAttached` | The mint's `transferHook.programId` is no longer empty. | **Stop permanently until a human reviews it.** Every xStock ships an initialised-but-empty transfer hook whose authority is live. A non-null program id means arbitrary code now runs inside every transfer of the collateral. |
| 8 | `SourcesDisagree` | The two independent sources the security is bound to disagree by more than `maxDivergenceBps`. | **Do not pick the one you like.** Disagreement is the only signal that either of them is wrong, and choosing between them discards it. Wait for convergence. |
| 9 | `SingleSource` | The security is registered against one price source and nothing corroborates it. | **Treat the security as unpriced.** One number that nothing can contradict is not a price. The fix is registration-side: bind a second, independent source. |
| 10 | `OracleUnreadable` | A bound price account could not be read at all: an unpublished Scope entry, an account that is not the one this security is bound to, or an update past its own outer age bound. Distinct from `OracleStale`, which is a price you could read and would not act on. | **Do not substitute another account.** The binding names one account; a different one that decodes is not the same feed. Recorded by `probe_security` rather than thrown, so a feed that has stopped publishing shows up in the refusal count instead of vanishing. |
| 11 | `MultiplierUnreadable` | The mint's `ScaledUiAmount` multiplier could not be read or decoded, so there is no defensible re-cut of the strike. | **Do not assume 1.0.** A multiplier you cannot read is not a multiplier of one; every strike on the name depends on it. Treat the security as unpriceable until the mint decodes. |

There is one more thing that is not a gate code. `Registry.paused` is a kill switch:
`write` and `exercise` fail with `RegistryPaused` whatever the gate says.
`isActionable` reports it as `registryPaused` and notes it.

### The rule

**If the gate refuses, do not act.** Not at a smaller size, not at a wider strike, not
because the market reopens in four hours. There is no size, strike or tenor at which a
refused security becomes writable. Report the code, the reason and the guidance above,
and stop. If you build a transaction anyway, the program refuses it again in the same
transaction and you have spent a fee to be told what you already knew.

---

## 5. The venue: covered calls whose premium is paid in shares

The rail is useful on its own. The venue built on it writes European,
physically-settled covered calls against it, and one design choice changes what an
agent can do with them:

**the option series trades on a Meteora Dynamic Bonding Curve pool quoted in the
underlying tokenised share.** Base is the series token — one token is one contract.
Quote is the xStock. So the price the curve prints is *shares per contract*, which is
the premium, and the writer is paid in more of the stock they already hold. A covered
call becomes share accumulation.

Two consequences that only exist because of the quote choice:

- **Spot cancels.** In the share numeraire the Black-Scholes call is
  `C/S = N(d1) - m e^{-rT} N(d2)` with `m = K/S`. Spot never appears, so the pool can be
  struck correctly at inception from moneyness, time and vol alone — no USD oracle is in
  the pricing path.
- **There is a hard ceiling you can check.** A call is never worth more than the share it
  is written on, so the premium can never exceed `contractSize` shares per contract. In a
  SOL-quoted pool that sentence is not expressible.

```ts
await d.listSeries(underlyingMint);     // every series on a name
await d.describeSeries(address);        // + adjusted strike + phase
```

**Honest limits, because an agent should not learn them the hard way.** The volatility is
a parameter someone typed, not a calibrated surface: no skew, no term structure. The
curve is struck once and does not re-mark as spot moves. The series pool is on mainnet but
the program is on devnet. Covered calls only, European exercise, no liquidation
engine, and no compliance gate — xStocks are bearer tokens with off-chain eligibility.

---

## 6. Where this lives

| | |
|---|---|
| program | `DnLxRcayAcjUFFuLjobQmJ7K75EgDRGFkUj5tfWcMCaa` (devnet) |
| SDK | `@stocklana/sdk` — `isActionable`, `currentStrike`, `getAdjustedBalance`, `REFUSALS`, typed instruction builders |
| MCP server | `mcp/` — read-only stdio server: `is_actionable`, `security_state`, `list_series`, `series_detail`, `adjusted_balance`, `corporate_actions`, `refusal_codes` |
| market layer | `market/` — the DBC curve for a series, quoted in the xStock |
| the wheel agent | `agent/` — reads the rail, prices the ladder, proposes, and refuses where the program refuses |
| licence | MIT |

An agent using this skill **does not need a key**. Everything above is a read. The
reference implementation in `agent/` holds no key and signs nothing by construction: it
builds unsigned transactions with a noop signer and prints them for a human to sign.
That is a design choice, not a limitation — the venue's claim is that it refuses where
the rail refuses, and an autonomous signer would make that claim depend on the agent
rather than on the program.
