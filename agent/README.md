# agent — Wheelwright

**A covered-call wheel operator for tokenised equities that refuses exactly where the
program refuses, and cannot sign anything.**

```bash
cd agent
pnpm install
pnpm run wheel --underlying=AAPL
```

That is the whole thing. One command, one pass: read the rail, list what is open, price
the ladder, decide, print the transactions a human would send.

---

## What it does

Four steps, in order, and it stops at step one if the rail says no.

**1. Read the rail.** Through `@stocklana/sdk`, for one xStock mint:

- `isActionable(mint)` — the nine-code gate, the SDK's line-for-line port of the
  program's `gate.rs`, evaluated on the same accounts the program would read, in one
  `getMultipleAccounts` so they describe one slot
- the live price, **divided by the effective `ScaledUiAmount` multiplier** — Scope prices
  one unscaled token, everything else in this system is quoted per share, and one token
  is `multiplier` shares
- the multiplier itself, including a change that is scheduled but has not taken effect

**2. List the open series.** From two places, labelled: `OptionSeries` accounts under the
program (`listSeries`, with the adjusted strike the program would charge right now), and
the DBC pools this repository has actually created, recorded in `market/artifacts/`.

**3. Price the ladder.** Every (moneyness, tenor) rung, built with **`buildSeriesCurve`
imported from `market/src/curve.ts`** — the same function that produces the
`ConfigParameters` a Meteora DBC pool is opened with. The Black-Scholes side is imported,
never re-implemented, so the agent's opinion of a premium and the venue's opening quote
cannot drift apart. What it reports is the price that goes on chain
(`config.sqrtStartPrice`), not the raw model number.

For each rung it prints **one line of reasoning**: the quote in shares per contract, the
annualised premium yield, and the volatility at which that quote would exactly clear the
hurdle, next to the volatility parameter the operator typed.

That last comparison is the honest form of the question. The volatility in this system is
a **parameter**, not a calibrated surface — `market/README.md` says so and so does the
top of `curve.ts`. So the agent never says a rung is cheap. It says: *this rung needs
24.12% vol to clear a 12% hurdle, and you typed 28%.* Both sides visible, the judgement
left where it belongs.

**4. Decide, and propose.**

| decision | when |
|---|---|
| **refuse** | the gate refused. Nothing is proposed. See below. |
| **roll** | an open series is inside its roll window, or its remaining yield has fallen under the hurdle while a fresh rung clears it |
| **write** | collateral is free and a rung clears the hurdle |
| **hold** | nothing clears, or there is less than one contract of collateral |

A `write` or `roll` produces `create_series` and `write` instructions with every account
resolved, and — when a wallet is given — a compiled **unsigned** wire transaction whose
signature slots are zero.

---

## How it refuses

This is the part that matters, so it gets the strongest statement in the package:

> **If the gate refuses, the wheel proposes nothing.** Not a smaller size, not a wider
> strike, not "the market reopens in four hours". `planWheel` returns `proposals: []` and
> a decision of kind `refuse` carrying the code, the Anchor error number the instruction
> would fail with, and what a caller should do about it.

An agent that trades into a closed or halted market is the failure this whole project
exists to prevent. Here it is, live, on a Sunday:

```
$ pnpm run wheel --underlying=NVDA --at=1789910100

NVDA / NVDAx  Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh
  rpc mainnet.helius-rpc.com   program DnLxRcayAcjUFFuLjobQmJ7K75EgDRGFkUj5tfWcMCaa   basis preview
  session          Closed, next regular open 2026-09-21T13:30:00Z
  gate             REFUSED 1 MarketClosed  (Anchor error 6000)
                   The committed exchange calendar says the US equity market is shut right
                   now (night, weekend, holiday or after an early close). Decided by
                   arithmetic on the clock, before any oracle is read.
  ...
  NVDA260928C234       8d  K/S 1.022  quote 0.01723259 sh/ct ($3.9450)   78.58% annualised
                       |  hurdle needs 16.84% vol, parameter is 45.00%  ->  not acted on: the gate refused
  ...
DECISION         REFUSE
                 refused 1 MarketClosed (Anchor error 6000): Market is closed for this
                 security. Nothing is proposed.
                 what to do: Wait. This is the expected state for about 81% of the week and
                 says nothing is wrong. Re-read at the next regular open, which the verdict
                 gives you as nextOpen.

proposed transactions: none.
  The gate refused, so nothing is proposed. This is the rule, not a fallback:
  there is no size, strike or tenor at which a refused security becomes writable.
```

Note what it still does: it prices the ladder and shows every rung. Reading is not
acting. Every line is stamped `not acted on: the gate refused`, and `proposals` is empty.

### It is a test, not a promise

`test/refusal.test.ts` builds each of the nine conditions as a set of gate inputs, pushes
them through `checkActionable` — the program's own ported gate — and asserts two things:
that the case produced the code it was built to produce, and that the wheel proposed
nothing. Plus a positive control, because a test that only ever sees refusals cannot tell
a correct agent from one that never proposes anything at all.

```
$ pnpm test

 Test Files  2 passed (2)
      Tests  38 passed (38)
```

And three attempts to work around a refusal, all asserted to fail: raising the collateral
to a million contracts, dropping the hurdle to zero, and putting an open series inside its
roll window. All still refuse, all still propose nothing.

---

## It holds no key, and that is the design

Every signer in `src/propose.ts` is `createNoopSigner` — a signer that contributes an
address and an account meta and cannot sign. What comes out is an unsigned wire
transaction for a human, or a human's wallet, to sign.

There is no code path that reads a keypair file, none that calls `sendTransaction`, and
none that can be given one by configuration. `src/args.ts` exists as its own twenty-line
flag parser instead of importing `market/src/env.ts` for exactly this reason: that module
also exports `loadKeypair`, and the cheapest way to guarantee an agent cannot sign is for
a private key never to enter its module graph. You can check the property by reading the
imports.

**This is a choice, not a limitation.** The venue's claim is that it refuses where the
rail refuses. An autonomous signer would make that claim depend on the agent's own
correctness instead of on the program's. Proposing keeps the program as the only thing
that has to be right — and the program re-runs the same gate inside the instruction, so a
proposal that goes stale between printing and signing fails with the matching Anchor
error rather than executing.

---

## Commands

```bash
pnpm install
pnpm typecheck
pnpm test

# the wheel
pnpm run wheel --underlying=AAPL
pnpm run wheel --underlying=NVDA --hurdle=0.18 --tenors=7,14,30 --moneyness=1.02,1.05
pnpm run wheel --all --json
pnpm run wheel --underlying=AAPL --at=1789910100        # evaluate the gate on a Sunday
pnpm run wheel --underlying=AAPL --writer=<pubkey>      # size on a real balance, and
                                                        # compile the unsigned transactions

# clawpump, API only
pnpm run clawpump status
pnpm run clawpump register
pnpm run clawpump skill
pnpm run clawpump preflight --quote-mint=<xStock mint> --payer=<wallet>
```

`pnpm run wheel --help` lists every flag. `SOLANA_RPC_URL` and `CLAWPUMP_API_KEY` come
from the repository `.env`; neither is ever printed, and only the RPC **host** is logged.

---

## Clawpump

`src/clawpump.ts` is the whole integration, and it is read-only apart from registering the
agent and its skill.

| call | result |
|---|---|
| `GET /api/v1/skills` | 200, nine public skill slugs |
| `GET /api/v1/agents` | 200 |
| `POST /api/v1/agents` | 201 — `Wheelwright`, `d3dbfac2-ea62-44a7-8774-352df0a7492c`, agent wallet `4FmPqTwr1zJgaYd5YVXUbymWyrnjuYhC4B8RSmNjYHgD` |
| `GET /api/meteora?action=asset&mint=<xStock>` | 200 — **this is the one the recon could not answer**: AAPLx reports `dbcSupported: true`, `dammSupported: true`, `transfersSupported: true`, `reason: null`, badge `8VeVZe3Zxfpax2qQUp7i68FCLspLYErm2FJChc5NDuVn` |
| `GET /api/meteora?action={catalogue,pricing,funding}` | 200 — all four preview actions answer a `cpk_` bearer key, contrary to the "session-gated" reading |
| `POST /api/public-launch {"action":"cost"}` | 200 — 0.009218 SOL for an AAPLx-paired pump.fun launch, the fallback |
| MCP `create_custom_skill` / `update_custom_skill` | `SKILL.md` registered on the agent as `deliverable-rail-tokenised-equity-actionability` |
| `GET /api/fees/earnings?agentId=…` | **404**, and so is every variant. Creator-fee accrual is a dashboard read today; `pnpm run clawpump status` probes it and says so. |

Two things worth carrying forward:

- **Use the apex domain.** `agents.clawpump.tech` issues a host-wide 308 to
  `clawpump.tech`, and HTTP clients drop the `Authorization` header across a cross-host
  redirect, so every authenticated call sent there arrives unauthenticated.
- **Custom skills have no REST route.** `/api/v1/agents/{id}/custom-skills` and every
  variant of it answers 404. The only surface is the stdio MCP server
  (`npx @clawpump/agents`, 132 tools), which `src/clawpump.ts` drives directly over
  JSON-RPC.

**Nothing here launches a token.** `action=launch` is not called and is not reachable
from this code. The launch is a browser step: [`LAUNCH.md`](LAUNCH.md).

---

## `SKILL.md`

[`SKILL.md`](SKILL.md) is a net-new agent skill for the rail, written for **any** agent
that touches xStocks, not only this one: how to ask whether a security is actionable, why
a price per token is not a price per share, how to read a strike that survives a split,
and what to do about each of the nine refusal codes. It references the read-only MCP
server in `mcp/`, which exposes the same seven reads as tools.

It is registered on the Clawpump agent, so an agent on their platform can use our rail
without any of our code.

---

## Files

| file | what it does |
|---|---|
| `src/cli.ts` | the one command: wire everything together and print |
| `src/rail.ts` | the three rail reads, with the multiplier applied to the price |
| `src/series.ts` | open series, from the program and from `market/artifacts/` |
| `src/yield.ts` | rung pricing, annualisation, and the hurdle-vol inversion. Imports `market/src/curve.ts` |
| `src/wheel.ts` | the decision. Pure, and the refusal rule lives here |
| `src/propose.ts` | unsigned instructions and transactions. Noop signers only |
| `src/report.ts` | the printed report |
| `src/clawpump.ts` | the Clawpump API and the MCP skill registration |
| `src/underlyings.ts` | the nine names, and the volatility parameter for each |
| `src/args.ts` | flags, deliberately not `market/src/env.ts` |
| `test/refusal.test.ts` | all nine codes stop the wheel, and the positive control |
| `test/wheel.test.ts` | the arithmetic and the three decisions |

---

## Honest limits

- **The volatility is a parameter.** `src/underlyings.ts` carries one number per name,
  typed by the operator. No calibration to listed options, no surface, no skew, no term
  structure. Every yield in the output inherits that.
- **The program is on devnet.** So `listSeries` against mainnet returns nothing, and the
  gate runs in `preview` basis: committed calendar, default tolerances, conventional
  Scope binding, and no halt attestation. The output labels every one of those.
- **The series pools are not on mainnet.** The only DBC pool the report shows is the
  devnet one in `market/artifacts/`, quoted in a stand-in mint because devnet has no
  xStocks. It is labelled `[market-artifact/devnet]`.
- **Re-pricing an open series uses the live mainnet spot** even when that series is the
  devnet artifact. That is a category mix, it is labelled, and it exists so there is a
  real series in the report rather than only hypothetical rungs.
- **Three of the nine names cannot be previewed.** A preview binds a security by finding
  `Checked <SYM>/USD` and `PythLazer <SYM>/USD` in Scope's TokenMetadatas. AAPLx, NVDAx,
  SPYx, QQQx, METAx and STRCx have what they need; NFLXx, CRWDx and KLACx do not, and
  `pnpm run wheel --all` prints them as `not read` with the reason rather than quietly
  dropping them. They stay in the list because they are the names the adjustment
  invariant is tested against.
- **STRCx refuses live**, with code 9 `SingleSource`: Scope labels one entry for it and
  one number nothing can contradict is not a price. It is a second real refusal in the
  output, next to the calendar one, and neither is synthetic.
- **The wheel is one strategy on one instrument.** Covered calls, European exercise, no
  puts, no cash-secured leg, no assignment handling beyond handing an expired series to
  `settle_expired`.
- **`--at` changes the gate's clock, not the accounts.** The price it shows is still the
  live one. It is for demonstrating the calendar, not for backtesting.
