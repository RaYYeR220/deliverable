# @stocklana/sdk

TypeScript client for the Deliverable program, built on [`@solana/kit`](https://github.com/anza-xyz/kit) 8.
It covers rail reads, the refusal gate evaluated off-chain, a typed builder for every instruction,
and Token-2022 balances with the multiplier applied correctly.

Node 24, ESM, strict TypeScript. No web3.js v1, no `@coral-xyz/anchor`.

```bash
cd sdk
pnpm install
pnpm build        # emits dist/
pnpm typecheck
pnpm test
```

## Configuration

Neither the cluster nor the program id is hard-coded.

| setting | source, first match wins |
|---|---|
| RPC endpoint | `rpcUrl` / `rpc` option → `SOLANA_RPC_URL` env → `SOLANA_RPC_URL` in the repo `.env` |
| program id | `programAddress` option → `DELIVERABLE_PROGRAM_ID` env → the id in the IDL (`DnLxRcayAcjUFFuLjobQmJ7K75EgDRGFkUj5tfWcMCaa`) |

Every PDA helper and instruction builder takes `{ programAddress }`. `rpcHost(url)` gives the host
only, because RPC URLs carry API keys. Nothing in this package logs.

```ts
import { createDeliverable } from '@stocklana/sdk';

const d = createDeliverable(); // or { rpcUrl, programAddress, history }
```

## Multiplier-correct balances: `getAdjustedBalance`

xStocks record every dividend and split as a change to the Token-2022 `ScaledUiAmount` multiplier.
The RPC applies that multiplier on some paths and not others:

| RPC path | `uiAmount` scaled? |
|---|---|
| `getTokenAccountBalance`, `getTokenSupply`, jsonParsed accounts | yes |
| `getTransaction` → `meta.preTokenBalances` / `postTokenBalances` | **no** |

Here it is on mainnet, transaction
[`4rsX6Hjr…DCY`](https://solscan.io/tx/4rsX6HjrGb7i4WsG6yTVxnUZY1hyo3SLj3j2XbLXvid9Cn8s8tzk7SSEtra1yRrmvuxabtuaqZKkfaQynSJ6DCY).
The AAPLx balance in its meta reads `amount 439229, uiAmount 0.00439229`, but the multiplier in force
at that block time was `1.0032690125398187`. `getTokenAccountBalance` on the same account returns
`0.00440664`.

`getAdjustedBalance` ignores every reported `uiAmount` and recomputes from the raw amount. It returns
the corrected number, the raw amount and multiplier it used, how it chose that multiplier, and what
the RPC reported, so you can audit the result:

```ts
const b = await d.getAdjustedBalance({
  signature: '4rsX6HjrGb7i4WsG6yTVxnUZY1hyo3SLj3j2XbLXvid9Cn8s8tzk7SSEtra1yRrmvuxabtuaqZKkfaQynSJ6DCY',
  tokenAccount: 'EQYSiL5i4LdYLEyYs7F9faWJpd7SzNQK49SxXjAPoWLD',
});
// b.uiAmount          0.004406648451088521   (439229 / 1e8 * 1.0032690125398187)
// b.uiAmountString    "0.00440664"           (the token program's truncation, as getTokenAccountBalance prints it)
// b.raw               439229n
// b.multiplier        1.0032690125398187
// b.provenance        "mint:new_multiplier"
// b.reported          { amount: "439229", uiAmount: 0.00439229, ... }
// b.reportedWasScaled false
```

It accepts four query shapes, one per source:

```ts
d.getAdjustedBalance({ tokenAccount });                        // getTokenAccountBalance
d.getAdjustedBalance({ supply: mint });                        // getTokenSupply
d.getAdjustedBalance({ owner, mint });                         // every account owner holds, summed
d.getAdjustedBalance({ signature, tokenAccount, when: 'pre' }); // getTransaction meta
d.getAdjustedTransactionBalances(signature);                   // every pre/post balance in a tx
```

For a transaction, the multiplier is taken **at its block time**. The mint only remembers its latest
change. If the block time falls before that change, pass the keeper history
(`keeper/data/corporate-actions.json`) as `history` and the multiplier will come from it;
`provenance` says which rule was used. `adjustBalance` and `adjustTransactionTokenBalance` are the
pure versions, with no network calls.

## The refusal gate: `isActionable`

```ts
const v = await d.isActionable(mint);
// { actionable: true, ... }
// { actionable: false, code: 1, name: 'MarketClosed', reason: '...', errorCode: 6000, ... }
```

`checkActionable(inputs)` in `src/gate.ts` is `check_actionable` from `gate.rs`, ported line for
line. The checks run in the program's order, which is not numeric order: calendar, halt, issuer
pause, transfer hook, pending multiplier, staleness, confidence, single source, divergence. All
arithmetic is bigint and mirrors `fixed.rs` down to the rounding direction. The session logic
(`calendar.ts`) is a port of `calendar.rs`, DST included.

`isActionable` reads the SecurityState, registry, calendar, mint, Scope account and Clock sysvar
in a single `getMultipleAccounts` call, so the inputs all describe the same slot. A Pyth
`PriceUpdateV2` has no fixed address, so the caller passes it and it is read separately.

**The program is not deployed yet.** For an unregistered mint, `isActionable` throws
`NotRegisteredError`. Pass `{ preview: true }` and it evaluates the same gate with:

- the committed calendar (`US_EQUITY_2026_2027`)
- the program's default tolerances
- the conventional Scope binding (`Checked <SYM>/USD` checked against `PythLazer <SYM>/USD`, found
  by label in Scope's TokenMetadatas)
- the live mint, the live Scope prices and the chain clock

The result is labelled `basis: 'preview'`, and its `notes` list each assumption. The halt
attestation is the one input a preview cannot observe.

The nine codes, with their Anchor error numbers and messages, are in `REFUSALS` (`src/refusal.ts`).
`refusalFromErrorCode(6000..6008)` maps a failed transaction back to a refusal code.

## Adjusted strikes: `currentStrike`

```ts
currentStrike(series, mintState, at?)   // pure
await d.currentStrike(seriesAddress)    // fetches the series, mint and chain clock
// { strike, strike0, multiplierAtMint, multiplier, uiSize, notional, adjusted, at }
```

`strike = strike0 × m0 / m1` (rounded down), `uiSize = raw × m1 / 1e12` (rounded down): the same
integer formulas as `OptionSeries::current_strike` and `current_ui_size`. `exerciseCostAt` and
`seriesPhase` mirror `exercise_cost` and `phase`.

## Reads

```ts
d.getSecurityState(mint)                  // SecurityState + address + symbolText, or null
d.getCalendar(id)
d.getRegistry()
d.getSeries(address | { underlyingMint, expiryTs, strike0, kind })
d.listSeries(underlyingMint)              // getProgramAccounts on discriminator + mint
d.getWriterPosition(address | { series, owner })
d.listWriterPositions(owner)
d.describeSeries(series)                  // series + adjusted strike + phase
d.getMint(mint)                           // ScaledUiAmount, Pausable, TransferHook, symbol
d.programDeployed()
```

## Instructions

`src/generated/` is Codama output from `idl/deliverable.json`. It includes the account decoders,
the types, the errors, the events, the PDA helpers, and a builder for each of the 16 instructions
(`get<Name>Instruction`, plus `get<Name>InstructionAsync`, which resolves the PDAs). All of them
produce unsigned Kit instructions. There are two hand-written additions:

- `findSeriesPda({ underlyingMint, expiryTs, strike0, kind })`. Its seeds include instruction
  arguments, which Codama cannot express.
- `oracleAccountsFor(binding)`, which gives the `primary_oracle` / `secondary_oracle` accounts:
  Scope is one account, and a Pyth `PriceUpdateV2` has to be passed in.

To regenerate after an `anchor build`, run `pnpm generate`. It copies the fresh `target/idl` into
`idl/` first.

## Tests

`pnpm test` runs the whole suite. The offline tests run against real mainnet bytes kept in
`test/fixtures/`:

- `aaplx_mint.bin`, `scope_prices.bin` and `pyth_sol_usd_priceupdatev2.bin` are the same dumps the
  program tests use
- `nflxx_mint.bin` and `crwdx_mint.bin` are the real NFLXx and CRWDx mints (slots 449342998 and
  449343000). Each still records its split: `1 → 10` and `1 → 4`
- `tx-4rsX6HjrGb7i4WsG.json` is the recorded `getTransaction` response for the pinned transaction

The suite checks the following:

- the refusal numbering, messages and gate order against `error.rs`, `gate.rs`, the IDL and the
  generated error constants
- ports of the `fixed.rs`, `calendar.rs` and `gate_test.rs` cases, plus every pairwise precedence
  between refusal conditions
- the Netflix and CrowdStrike splits and an AAPLx dividend step replayed through `currentStrike`,
  with `strike × ui_size` asserted invariant, and a negative control where adjustment is off and
  the notional moves by exactly 10×
- each IDL instruction's discriminator, account order and signer and writable flags against its
  builder

The live tests use `SOLANA_RPC_URL` and are skipped when it is unset. They cover all three balance
sources, compared against the RPC's own figures, and the preview gate. Tests that need the program
on-chain skip with the reason (`program not deployed: <id> on <host>`) until it is deployed.

## What is not verified

- The series PDA seeds and every account layout come from the program source and the IDL, but none
  has been checked against a deployed account, because none exists yet.
- The preview binding is a convention (`tests/harness.rs`), not a registration. A deployed
  security may be bound differently, and `basis: 'registered'` will then show the real binding.
- The Pyth `PriceUpdateV2` path is tested against a real SOL/USD account. No xStock is bound to
  Pyth today.
