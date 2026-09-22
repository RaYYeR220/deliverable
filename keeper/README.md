# keeper

Corporate-action feed for the xStocks tokenised equities on Solana.

xStocks express **every** corporate action — dividends, splits, reverse splits — as a change to
the Token-2022 **ScaledUiAmount** multiplier on the mint. Nothing is emitted, nothing is
labelled, and no corporate-action feed for these assets exists anywhere on Solana. The only
signal is three fields inside one mint extension, written by a single authority key.

This package reads that signal three ways:

| command | what it does |
| --- | --- |
| `pnpm watch` | current and pending multiplier for every xStock mint, with a classification |
| `pnpm history` | finds the actual transactions that changed a multiplier, with dated proof |
| `pnpm oracle` | reads the Kamino Scope price oracle and derives its index map from chain state |

## Setup

```bash
cd keeper
pnpm install
```

`SOLANA_RPC_URL` is read from the environment, falling back to the repo root `.env`. A public
endpoint will not do: the history scanner needs `getSignaturesForAddress` paging, archival
`getBlock`, and `getTransaction` volume.

The mint registry is loaded from `_internal/xstocks_mints.json` if it is present (28 mints),
otherwise from a built-in list of nine verified mints. Point `XSTOCKS_MINTS` at any JSON file
shaped either `{ "<mint>": { "symbol": "..." } }` or `[{ "mint": "...", "symbol": "..." }]`.

Every script is rate-limit aware. The client meters itself with a cost-aware token bucket
(a batch of ten `getTransaction` calls costs ten units), backs its rate off on a 429 and
recovers afterwards. Set `SOLANA_RPC_RATE` to the sub-requests per second your plan allows; the
default is 9, which is what the Helius endpoint in this repo sustains.

---

## `pnpm watch` — corporate-action scanner

Reads every mint account, decodes the ScaledUiAmount extension, and prints the multiplier that
is **actually in force**.

The trap this handles: `ScaledUiAmountConfig` has both `multiplier` and `new_multiplier`. Once
`new_multiplier_effective_timestamp` has passed, the effective multiplier is `new_multiplier`
and the `multiplier` field is a stale snapshot of the value that used to be in force. Reading
`multiplier` alone silently misprices 17 of the 28 mints today.

```bash
pnpm watch                      # human-readable table
pnpm watch -- --json            # machine-readable
pnpm watch -- --symbol AAPLx
pnpm watch -- --out data/multipliers.json
```

Classification is a heuristic on the ratio (there is no label on chain), and every row carries a
`confidence` so nothing downstream mistakes it for ground truth:

- `none` — multiplier exactly 1.0 with an effective timestamp of 0, i.e. never adjusted
- `dividend` — a positive step of at most 5%
- `split` / `reverse-split` — a ratio of 1.4x or more in either direction
- `adjustment` — anything in between, flagged low-confidence rather than guessed at

## `pnpm history` — the transactions behind the actions

Recovers the `UpdateMultiplier` transactions themselves, so an action can be shown with a date
and a link instead of asserted.

### The instruction

Token-2022 dispatches extension instructions on two bytes: the outer `TokenInstruction`
discriminant, then the extension's own sub-instruction.

```
0x2B 0x01 | multiplier: f64 LE (8) | effective_timestamp: i64 LE (8)      18 bytes
  43    1
```

`43` is `TokenInstruction::ScaledUiAmountExtension` and `1` is
`ScaledUiAmountMintInstruction::UpdateMultiplier`, both from the program's own source
(`interface/src/instruction.rs` and `interface/src/extension/scaled_ui_amount/instruction.rs`).
Accounts are `[writable] mint`, `[signer] authority`. The on-chain logs print
`ScaledUiAmountMintInstruction::UpdateScale` for this instruction.

### Why decoding is necessary

The multiplier authority `S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS` signs roughly two
thousand transactions a day, almost all of them `TransferChecked`. A signature list tells you
nothing; every instruction has to be decoded.

### How the search stays cheap

`getSignaturesForAddress` is cheap and `getTransaction` is not, so the scanner pages wide and
fetches narrow:

1. Each mint's on-chain `new_multiplier_effective_timestamp` anchors a search window
   (default: 10 hours before, 2 hours after). Across the 119 actions recovered so far the lead
   time runs from 4 minutes to 6h35m, with a median of just under four hours.
2. `getSignaturesForAddress` can only be seeked with a signature, never a slot or a timestamp —
   but that signature does not have to belong to the address being queried. So the scanner
   binary-searches `getBlockTime` to the window's end, lifts any signature out of that block
   with `getBlock`, and passes it as `before`. A hundred-page walk becomes three calls.
3. For each window it picks the cheaper haystack: the mint itself (an AMM-quoted mint can see
   70k signatures a day; an untraded one sees a few hundred) or the shared authority. One probe
   page decides.

### The issuer's pattern

An update arrives as **two** `UpdateMultiplier` instructions in one transaction: the first
re-asserts the multiplier currently in force along with its original effective timestamp, the
second schedules the new one. That makes both sides of the move provable from the transaction
alone — every one of the 119 actions recovered so far carries
`previousMultiplierSource: "same-transaction"`. Where only one instruction is present the old
value is reconstructed from the mint's stored `multiplier` field or from the preceding recovered
action, and the source field says which.

Scanning also turns up mints the registry has never heard of — the authority manages well over a
hundred. Those get their symbol read out of the mint's own Token-2022 `TokenMetadata` extension
rather than being left as `?`.

```bash
pnpm history                                   # every mint, windows anchored on chain state
pnpm history -- --symbol CRWDx                 # one mint
pnpm history -- --symbol CRWDx --via mint      # force the haystack (auto | mint | authority)
pnpm history -- --since 2026-09-01             # flat range instead of anchored windows
pnpm history -- --lookback-hours 24 --grace-hours 4
pnpm history -- --concurrency 2                # in-flight batches; the token bucket is the real throttle
pnpm history -- --fresh                        # ignore the existing file instead of merging
pnpm history -- --json --out data/corporate-actions.json
```

Results accumulate into `data/corporate-actions.json` (deduplicated by signature and mint), so
repeated narrow runs build up a history rather than replacing it:

```json
{
  "mint": "Xs7xXqkcK7K8urEqGg52SECi79dRp2cEKKuYjUePYDw",
  "symbol": "CRWDx",
  "signature": "2HBgFSMV8FrpEbrBkLBtd1yhTxrJMof6Eb8YnxKSBytrpCZtMTKmdmEhH3p5kn1NsL3ibtxspXwNd5C3c6jFLcro",
  "blockTime": 1782993586,
  "slot": 430302432,
  "newMultiplier": 4,
  "effectiveTimestamp": 1782999000,
  "leadTimeSeconds": 5414,
  "previousMultiplier": 1,
  "previousMultiplierSource": "same-transaction",
  "percentChange": 300,
  "classification": "split",
  "blockTimeIso": "2026-07-02T11:59:46Z",
  "effectiveIso": "2026-07-02T13:30:00Z",
  "explorerUrl": "https://solscan.io/tx/2HBgFSMV8FrpEbrBkLBtd1yhTxrJMof6Eb8YnxKSBytrpCZtMTKmdmEhH3p5kn1NsL3ibtxspXwNd5C3c6jFLcro"
}
```

## `pnpm oracle` — Kamino Scope reader

Scope publishes 512 dated prices in one flat account with no labels, so reading a price is easy
and knowing which slot holds which asset is the real problem. Entry *i* sits at `40 + i*56`:
`value u64 | exp u64 | last_updated_slot u64 | unix_timestamp u64 | _reserved[24]`, and
`price = value / 10^exp`.

The index map is **derived from chain state**, not hardcoded:

```
OraclePrices (3t4JZcue…)
  -> Configuration whose oracle_prices points back at it   (getProgramAccounts + memcmp)
  -> TokenMetadatas                                        (32-byte ASCII name per index)
```

`TokenMetadatas` names entries `"Checked AAPLx/USD"`, `"PythLazer SPYx/USD"` and so on, which
resolves index → symbol → xStock mint. Scope publishes several entries per symbol (raw feeds, a
`MostRecent` pick, a `Checked` entry that caps and floors that pick); the most-derived one wins,
because that is the guarded price a consumer should read. The independently verified table is
kept only as a regression check and any disagreement is printed.

```bash
pnpm oracle
pnpm oracle -- --json
pnpm oracle -- --symbol NVDAx
pnpm oracle -- --mappings      # also decode OracleMappings for those indexes
pnpm oracle -- --no-derive     # skip the derivation, use the verified table
```

`--mappings` decodes `OracleMappings`, which is a struct of parallel arrays rather than an array
of structs. It also shows why the mint cannot be recovered from that account: every xStock entry
is a composed price type (`CappedFloored` wrapping another Scope entry, or `PythLazer` carrying a
Pyth Lazer feed id), so there is no external oracle pubkey to reverse and no mint stored.

## Layout

```
src/base58.ts          base58 codec (no runtime dependencies)
src/rpc.ts             JSON-RPC client: batching, cost-aware token bucket, 429 backoff, .env loading
src/token2022.ts       mint + TLV parsing, ScaledUiAmountConfig, UpdateMultiplier decoding
src/transactions.ts    signature paging, time-seeking, instruction flattening (incl. CPIs)
src/mints.ts           mint registry
src/classify.ts        ratio -> action-kind heuristic
src/format.ts          tables, durations, CLI flags
src/multiplier-watch.ts
src/action-history.ts
src/scope-oracle.ts
```

`pnpm typecheck` runs `tsc --noEmit`. There are no runtime dependencies; `tsx` and `typescript`
are dev-only.
