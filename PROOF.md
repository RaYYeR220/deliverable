# Proof

Every verifiable item behind the project's claims, one link each. Everything is on Solana mainnet
unless it is marked **devnet**. To re-check the headline items against mainnet in about a minute, run
`scripts/verify-onchain.ts` ([JUDGES.md](JUDGES.md), step 1). [CLAIMS.md](CLAIMS.md) gives the
evidence tier for each claim.

---

## Deployments

This section is empty because nothing has been deployed yet.

- **The program** targets devnet. The IDL declares `DnLxRcayAcjUFFuLjobQmJ7K75EgDRGFkUj5tfWcMCaa`.
  When this was written (2026-09-22, devnet slot 502466130), that address held no account on
  devnet.
- **The series pool** is a Meteora DBC pool for one covered-call series, quoted in AAPLx. It targets
  mainnet. Its two transactions have been simulated against live mainnet state and not sent
  ([`market/README.md`](market/README.md), "Mainnet — simulated against live state"). No mainnet
  signature exists yet. The same flow runs end to end on devnet with a stand-in quote mint (see
  [Devnet: the series market](#devnet-the-series-market-end-to-end) below).

Once each deployment exists, this section will list its address, deploy signature and slot. You can
check them yourself:

```bash
cd scripts && DELIVERABLE_PROGRAM_ID=<id> DELIVERABLE_CLUSTER=devnet pnpm verify   # check 9
cd market  && pnpm run verify --mainnet --yes --series=<SYMBOL>                     # the pool
```

---

## The oracle

| item | account |
|---|---|
| Kamino Scope `OraclePrices`, 28,712 bytes, entry *i* at byte `40 + 56i` | [`3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH`](https://solscan.io/account/3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH) |
| Scope program, owner of the account above | [`HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ`](https://solscan.io/account/HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ) |
| Scope `TokenMetadatas`, the entry labels: 317 `Checked AAPLx/USD`, 315 `PythLazer AAPLx/USD`, 332 `Checked NVDAx/USD`, 330 `PythLazer NVDAx/USD` | [`3wHxoHowen78mskgqKQmaYVQV8Mqd5PUFXja2xcfviSV`](https://solscan.io/account/3wHxoHowen78mskgqKQmaYVQV8Mqd5PUFXja2xcfviSV) |
| The price publisher's schedule, which the program's calendar commits | [`hermes.pyth.network/v2/price_feeds?query=AAPL&asset_type=equity`](https://hermes.pyth.network/v2/price_feeds?query=AAPL&asset_type=equity) (field `schedule` of `Equity.US.AAPL/USD`) |

Pinned reads of the oracle:

| file | what it is |
|---|---|
| [`docs/evidence/weekend-2026-09-20.json`](docs/evidence/weekend-2026-09-20.json) | `scripts/measure-basis.py`, 2026-09-20 09:15:28 UTC, two samples 90 s apart, eight entries |
| [`docs/evidence/overnight-2026-09-22.json`](docs/evidence/overnight-2026-09-22.json) | the same script, 2026-09-22 08:11:08 UTC |
| [`tests/fixtures/scope_prices.bin`](tests/fixtures/scope_prices.bin) | the account bytes the program tests and the app's Replay read; entries 317 and 332 are stamped 2026-09-20 10:14:54 UTC |

The two evidence files are kept as taken. Their `basis_bps` field was computed by the first version
of the script, per-token oracle against per-share market price, with no multiplier. The README tables
recompute the basis like for like from each file's `oracle_price` and `dex_price`
([CLAIMS.md](CLAIMS.md) R50, R55).

## Kamino

| item | account |
|---|---|
| xStocks lending market | [`5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua`](https://solscan.io/account/5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua) |
| AAPLx reserve; its Scope price chain reads `[317]` | [`CKJbqakbPGyhziowm19LPYz636UszuezfkitmpRtcLSH`](https://solscan.io/account/CKJbqakbPGyhziowm19LPYz636UszuezfkitmpRtcLSH) |
| NVDAx reserve; its Scope price chain reads `[332]` | [`7B66Az3tJhAo4bLkX8PzTixQ9ZGyHkkjxfVLhF26sP5q`](https://solscan.io/account/7B66Az3tJhAo4bLkX8PzTixQ9ZGyHkkjxfVLhF26sP5q) |
| klend program, owner of both reserves | [`KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD`](https://solscan.io/account/KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD) |
| Reserve metrics, the source of the collateral figure. Across the ten xStocks reserves, `totalSupplyUsd` summed to $22.77M at 2026-09-22 14:22 UTC | [`api.kamino.finance/.../reserves/metrics`](https://api.kamino.finance/kamino-market/5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua/reserves/metrics?env=mainnet-beta) |

To find the price chain, the verifier locates the `OraclePrices` key inside the reserve account and
reads the four `u16` values that follow it (`TokenInfo.scope_configuration`).

## The underlying and the issuer's levers

| item | account |
|---|---|
| AAPLx mint. Multiplier 1.0032690125398187, in force since 2026-08-08 00:30 UTC | [`XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp`](https://solscan.io/token/XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp) |
| NVDAx mint. Multiplier 1.001701196801074, in force since 2026-09-10 00:30 UTC | [`Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh`](https://solscan.io/token/Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh) |
| `ScaledUiAmount` authority. It was the same key on all 930 xStock mints read on 2026-09-22 | [`S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS`](https://solscan.io/account/S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS) |
| Transfer-hook authority on AAPLx and NVDAx; permanent delegate on AAPLx | [`5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq`](https://solscan.io/account/5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq) |
| `Pausable` authority on AAPLx | [`JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs`](https://solscan.io/account/JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs) |

The Solscan token page shows the extensions. The raw form comes from any RPC with
`getAccountInfo <mint> {"encoding":"jsonParsed"}`, under `extensions`.

## Splits, as the mints record them

| | mint | multiplier | effective | transaction |
|---|---|---|---|---|
| NFLXx, 10-for-1 | [`XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL`](https://solscan.io/token/XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL) | 1 → 10 | 2025-11-16 23:55 UTC | [`ibYRj5Za…iwej`](https://solscan.io/tx/ibYRj5Za4VezuyjKTijwPLZK7vG9GT9hGZ5SEA7vjrWnupr5SnwEDBqB4boMb2nmzfsYeoy7r3F8NPWCxABiwej) |
| CRWDx, 4-for-1 | [`Xs7xXqkcK7K8urEqGg52SECi79dRp2cEKKuYjUePYDw`](https://solscan.io/token/Xs7xXqkcK7K8urEqGg52SECi79dRp2cEKKuYjUePYDw) | 1 → 4 | 2026-07-02 13:30 UTC | [`2HBgFSMV…Lcro`](https://solscan.io/tx/2HBgFSMV8FrpEbrBkLBtd1yhTxrJMof6Eb8YnxKSBytrpCZtMTKmdmEhH3p5kn1NsL3ibtxspXwNd5C3c6jFLcro) |

## Corporate-action transactions

Each transaction carries a Token-2022 `UpdateMultiplier` instruction:
`0x2B 0x01 | multiplier f64 LE | effective timestamp i64 LE`, 18 bytes. The issuer sends two per
transaction. The first re-asserts the multiplier in force and the second schedules the new one, so
both sides of the change are on chain.

| | kind | multiplier | effective | transaction, block time |
|---|---|---|---|---|
| NVDAx | dividend | 1.0009180758490996 → 1.001701196801074 | 2026-09-10 00:30 UTC | [`42RcDnjP…eBXk`](https://solscan.io/tx/42RcDnjPb4NAhaXZv2bgttqLxZYu1MhnGcfsrZsY8qE5HVVvE5USH1dWc2oyjAWFFM5BJKRGFYXv3h9tQGaZeBXk), 2026-09-09 20:29:51 UTC |
| METAx | dividend | 1.002298265651938 → 1.0028515433272898 | 2026-09-19 00:30 UTC | [`36ooX62V…bgSa`](https://solscan.io/tx/36ooX62VH815qs9w6Cvgr2baqA5L6FFiaEceTq3sqeX1tw4bCzgGD5NS9cxVck1NQceQqq6qGaYyKFKE2FNebgSa), 2026-09-18 20:30:22 UTC |
| QQQx | dividend | 1.0027250296551051 → 1.0034560758968376 | 2026-09-19 23:00 UTC | [`66CzTFZ9…iobW`](https://solscan.io/tx/66CzTFZ9LJ6mCTN4fzduzwE9DkrsXh9FsQRWnRbEWuBmJTYiW3Bk1EMP2QMD7ELHy2oYY8Rg4N7LUQFcYNbNiobW), 2026-09-19 17:27:35 UTC |
| AAPLx | dividend | 1.0026642075893797 → 1.0032690125398187 | 2026-08-08 00:30 UTC | [`2CW1WSVj…bxWY`](https://solscan.io/tx/2CW1WSVjDagEDk3BkLpmqrwwpcNEie9wCMYoL2kDkCGeJvKdzrjtxGKjs75qRbVS7BSPJniLko1FVKMFP8fWbxWY), 2026-08-07 20:21:57 UTC |
| CRWDx | split | 1 → 4 | 2026-07-02 13:30 UTC | [`2HBgFSMV…Lcro`](https://solscan.io/tx/2HBgFSMV8FrpEbrBkLBtd1yhTxrJMof6Eb8YnxKSBytrpCZtMTKmdmEhH3p5kn1NsL3ibtxspXwNd5C3c6jFLcro), 2026-07-02 11:59:46 UTC |

The full record is [`keeper/data/corporate-actions.json`](keeper/data/corporate-actions.json):
119 actions across 112 mints, each row with its `explorerUrl`. Of these, 35 actions across 34 mints
took effect between 2026-09-11 and 2026-09-25. To rebuild it: `cd keeper && pnpm history`.

## The RPC disagreement

| item | link |
|---|---|
| Transaction, 2026-09-19 20:28:34 UTC. The meta reports AAPLx `amount 439229`, `uiAmountString 0.00439229`, with no multiplier applied | [`4rsX6Hjr…6DCY`](https://solscan.io/tx/4rsX6HjrGb7i4WsG6yTVxnUZY1hyo3SLj3j2XbLXvid9Cn8s8tzk7SSEtra1yRrmvuxabtuaqZKkfaQynSJ6DCY) |
| The token account. On 2026-09-22 `getTokenAccountBalance` returned `0.00440664`, which is 439229 / 10^8 × 1.0032690125398187, truncated | [`EQYSiL5i4LdYLEyYs7F9faWJpd7SzNQK49SxXjAPoWLD`](https://solscan.io/account/EQYSiL5i4LdYLEyYs7F9faWJpd7SzNQK49SxXjAPoWLD) |
| The recorded `getTransaction` response the SDK tests run against | [`sdk/test/fixtures/tx-4rsX6HjrGb7i4WsG.json`](sdk/test/fixtures/tx-4rsX6HjrGb7i4WsG.json) |

## Devnet: the series market, end to end

This is series `AAPL261016C352` (AAPL 2026-10-16 352 call, 30% vol, 1000 contracts), created by
wallet [`4EtAFmWt…CYKo`](https://solscan.io/account/4EtAFmWtCzMxyUku7NofttEPLDWniigFAEL7KmCeCYKo?cluster=devnet).
All four transactions were `finalized` with no error when read on 2026-09-22.

| step | account | transaction |
|---|---|---|
| stand-in quote mint `AAPLd` (Token-2022, 8 decimals, **not an xStock**) | [`8FBsKWYu…vJDm`](https://solscan.io/token/8FBsKWYuBWwn2zo2viDrjdMeN8CrVH5WbaY8YaJMvJDm?cluster=devnet) | [`3fYZDZuH…EZCq`](https://solscan.io/tx/3fYZDZuH5R87ZLBWts77bgNRErBpMGVKEmEsExVyHkegV62LguSGZpsu2UxcyyGCT1hgvjpWCn6eByKoipVaEZCq?cluster=devnet) |
| `create_config` | [`1prrFtvB…LrJk`](https://solscan.io/account/1prrFtvBA586zykqwzKkdqhK1zQ87PgaVzFk7kZLrJk?cluster=devnet) | [`2744ZVuM…PRXk`](https://solscan.io/tx/2744ZVuMek7NzNxLKXsScJjRjnDoHg9C27THejW78QPVmg384GNQpWsacuxG6mFyXmLT1WKvo75YrXaecZS3PRXk?cluster=devnet) |
| `initialize_virtual_pool_with_token2022`: pool, then series mint | [`5YbMsAxC…1H1L`](https://solscan.io/account/5YbMsAxCcgTkpyhzegHLq52faiSuUNTAkVmGgCNW1H1L?cluster=devnet), [`B9vKorB3…DoJ3`](https://solscan.io/token/B9vKorB3wdL7tcxF5yNuMQbK4cS5ew6GNd13VaFBDoJ3?cluster=devnet) | [`2KUNZatc…VSK3`](https://solscan.io/tx/2KUNZatcvJWtZnoZsmkQFXfAcyoHWo9geYtZTrNRhFgR5rGtUCx957YmG8FeGTeba7UGvray3zZC4CMZdwG4VSK3?cluster=devnet) |
| `swap2` buy, 25 contracts | | [`4v2nkiBb…JTJV`](https://solscan.io/tx/4v2nkiBbWpBSYj8C53KQWFTRUNigrjqNkojfrRYcRrozqThu5YyjfitFD857UF792chXJhwAd6kVKYUmrejmJTJV?cluster=devnet) |

The artifacts are [`market/artifacts/devnet-AAPL261016C352.json`](market/artifacts/devnet-AAPL261016C352.json)
and [`market/artifacts/devnet-quote.json`](market/artifacts/devnet-quote.json). Run
`cd market && pnpm run verify --series=AAPL261016C352` to read the config, pool and curve back off
devnet.

## Test fixtures: real mainnet bytes

The program tests, the SDK tests and the app's Replay read these files. Any copy can be checked with
`sha256sum`.

| file | account | sha256 |
|---|---|---|
| `tests/fixtures/aaplx_mint.bin` | AAPLx mint | `06ce71b440351ae1089a2959836979f1f04f58160ec7389f9bbcd56fc1076904` |
| `tests/fixtures/scope_prices.bin` | Scope `OraclePrices` | `3a22bdb5ac838ada70ceca11c4930407f84723bf48c602b54afa02f3107126d9` |
| `tests/fixtures/pyth_sol_usd_priceupdatev2.bin` | Pyth `PriceUpdateV2`, [`7UVimffx…jLiE`](https://solscan.io/account/7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE) | `5ca18b56559738fa4af1e5b9a0270c8c78d2c2c84f8b306801322b223991fc64` |
| `tests/fixtures/usdc_mint.bin` | USDC mint | `a5c9f24dfd58d2a5348a36c3660ed8fa5ad44651f6ddda3946ddfb2c95d877b5` |
| `sdk/test/fixtures/nflxx_mint.bin` | NFLXx mint, slot 449342998 | `b1a31a613b253a1ecd4bd0736b111d7a7ad4757c899eafbb3b8a37c14b1597b4` |
| `sdk/test/fixtures/crwdx_mint.bin` | CRWDx mint, slot 449343000 | `389bdbdb1a0c4c862b9ad194e8cfe8335d923e579b14df8bf5cb18d6188f76df` |
| `app/data/replay/nvdax_mint.bin` | NVDAx mint, slot 449352952 | `2b34e6902b29a8c68dba81acfc74bb91b98dd003b809b4d9d83d2d2b62e6cc94` |
| `app/data/replay/scope_token_metadatas.bin` | Scope `TokenMetadatas` | `27054c48c0d0f62ddcf02bdcb899417d3e536642d760774756a081bcef0a4904` |

The fixtures can be cross-checked against each other and against the chain. In `scope_prices.bin`,
entries 317 and 332 hold 336.70209695342584 and 222.3476146539344. The weekend measurement recorded
exactly those values an hour earlier, using a different script. The `ScaledUiAmount` fields in
`aaplx_mint.bin` match the live mint as verify-onchain read it on 2026-09-22 (check 3).
