# LAUNCH — the runbook

Everything in this file is for **you**, in a browser, with a funded wallet. Nothing in
`agent/` launches a token, creates a pool, or sends a mainnet transaction, and there is
no flag that makes it do so. The Meteora launch is a dashboard flow behind a browser
session; a `cpk_` key can read its preview actions but not drive `action=launch`.

Read section 0 first: most of the work is already done.

---

## 0. What already exists, and what is left

| | state |
|---|---|
| Clawpump account and `cpk_` key | **done** — in the repository `.env`, never printed |
| Clawpump agent | **done** — `Wheelwright`, id `d3dbfac2-ea62-44a7-8774-352df0a7492c`, agent wallet `4FmPqTwr1zJgaYd5YVXUbymWyrnjuYhC4B8RSmNjYHgD`, public page <https://clawpump.tech/agent/d3dbfac2-ea62-44a7-8774-352df0a7492c> |
| Custom skill on that agent | **done** — `SKILL.md` registered as `deliverable-rail-tokenised-equity-actionability`, skill id `7f0a0e13-7a65-429d-8a76-7ad5daf289db`, visible at <https://clawpump.tech/dashboard/skills> |
| Quote asset checked | **done** — AAPLx reports `dbcSupported: true`, `dammSupported: true`, `transfersSupported: true`, `reason: null` |
| Wallet funding | **YOURS** — the launch wallet holds 0 SOL by design |
| The launch itself | **YOURS** — sections 2 to 5 |
| AnsemHack registration and the X post | **YOURS** — section 7 |

---

## 1. Preflight, one command

```bash
cd agent
pnpm install
pnpm run clawpump preflight --quote-mint=XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp --payer=<the wallet you will connect>
```

This reads four things and prints them: the quote asset's Meteora capability flags, its
USD price and the dashboard's default initial market cap, your wallet's SOL and AAPLx
balances as Clawpump sees them, and the documented pump.fun cost for the same pair as a
fallback.

**The recon left one question open: whether an xStock reports `dbcSupported: true`, and
whether a `cpk_` key can see it at all. Both are now answered — it can.** The curated
`action=catalogue` list no longer carries xStocks (it carries Ondo `...on` tokens and
PreStocks `Pre...` tokens), but `action=asset` answers for any mint, and AAPLx comes
back as:

```json
{ "mint": "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
  "symbol": "AAPLx", "name": "Apple xStock", "decimals": 8,
  "tokenProgram": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "dbcSupported": true, "dammSupported": true,
  "dbcTokenBadge": "8VeVZe3Zxfpax2qQUp7i68FCLspLYErm2FJChc5NDuVn",
  "transfersSupported": true, "reason": null, "curated": false,
  "displayMultiplier": "1.0032690125398187" }
```

`curated: false` is the thing to understand before you are in the form: AAPLx is
**supported but not on the dashboard's default asset list**, so in the launch UI you
must pick the custom-mint option and paste the mint rather than looking for AAPLx in the
dropdown. NVDAx (`Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh`, badge
`mfacWnGh1Kn5ttHMMaNZhRZbCjvGrDQyDyZgqaR9vBM`) and TQQQx
(`XsjQP3iMAaQ3kQScQKthQpx9ALRbjKAjQtHg6TFomoc`) report the same flags, so both are
usable if AAPLx fails on screen.

### Why AAPLx and not something else

The bounty pays creator fees **in the paired asset**. Pairing against an xStock means
the agent's fees arrive as shares of that company, which is what "agents earn on RWAs"
means literally rather than as a slogan. Pick the underlying the venue's flagship series
is written on, so the token, the pool and the product are the same name:

- `market/artifacts/devnet-AAPL261016C352.json` — the series that exists, an AAPL call
- `market/README.md` — the mainnet `create_config` simulation is quoted in AAPLx
- `pnpm run wheel --underlying=AAPL` — the agent's default name

AAPLx also carries **no transfer fee**, which matters: a quote asset that charges one
makes your seed liquidity cost more, charges again when fees are collected, and again
when they are paid out. The PreStocks entries in the catalogue all carry a 1% transfer
fee and are marked "instant pool only" (`dbcSupported: false`). Do not use one.

---

## 2. Fund the wallet

Send SOL to the wallet you are going to connect in the browser. **Budget 0.02 SOL**, plus
whatever you want to spend on an initial buy.

The cost is measured, not estimated. The one live Clawpump + Meteora DBC stock-paired
launch on mainnet is `WASB` quoted in TQQQx, transaction
[`HW8p4pQj…82nWr`](https://solscan.io/tx/HW8p4pQj9GXQygoJA7ZTvHngEm7mbhYCgjs93xnEpXfUrVdFEDafFMgSfVGHgt7vfaWjqPDvv5f34bFEAS82nWr).
Decoded against mainnet, its payer `Dz1ogtkE…HLzc` paid:

| | lamports | SOL |
|---|---:|---:|
| base fee, 2 signatures + compute budget | 23,000 | 0.000023 |
| series/base mint rent (Token-2022, metadata pointer) | 2,763,520 | 0.00276352 |
| VirtualPool rent (424 bytes) | 2,804,160 | 0.00280416 |
| base vault rent | 1,488,440 | 0.00148844 |
| quote vault rent | 1,539,240 | 0.00153924 |
| **total** | **8,618,360** | **0.00861836** |

One transaction, one instruction: `InitializeVirtualPoolWithToken2022` on
`dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`. No `create_config` in it — that pool's
`PoolConfig` is a shared Clawpump account with more than a thousand transactions across
eight days, so Clawpump reuses one config per quote asset rather than creating one per
launch.

**The one thing this does not tell you** is whether Clawpump already holds a config
quoted in AAPLx. If it does not, a fresh `PoolConfig` is 1,048 bytes = **0.00597408 SOL**
more (the same account type this repository created on devnet and priced in
`market/README.md`). 0.02 SOL covers both cases with room for a priority fee. The
dashboard shows you the exact SOL cost before you sign — read it, and stop if it is not
in this range.

In DBC mode the graduation reserve is funded by trading, so **no AAPLx is required to
open the pool.** You only need AAPLx if you want an initial buy.

---

## 3. The launch, step by step

1. Go to **<https://clawpump.tech/launch>** and connect the funded wallet. (Sign-in by
   wallet is a free message signature and sends no transaction.)
2. Select the agent **Wheelwright** (`d3dbfac2-ea62-44a7-8774-352df0a7492c`). The token
   must be attached to the agent, or the fee split has nothing to pay into.
3. Set **launch platform / mode** to **`dbc`** (Meteora Dynamic Bonding Curve). Not
   pump.fun. `dbc` is the literal requirement — "using clawpump **and** Meteora" — and
   the pump.fun path never touches a Meteora program.
4. For the **quote asset**, choose the **custom mint** option and paste
   `XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp`. The UI should resolve it to
   **AAPLx · Apple xStock · 8 decimals** and show DBC as available. If it shows only
   DAMM v2, see section 6.
5. Fill the token fields:
   - **Name** — `Wheelwright`
   - **Symbol** — `WHEEL`
   - **Description** — one sentence, and make it the real one, not "pair stocks":
     *"Covered-call wheel operator for tokenised equities. Reads the Deliverable rail
     before it acts, refuses on any of nine typed refusal codes, and is paid its premium
     in the share itself. Quoted in AAPLx so its creator fees accrue in Apple."*
   - **Image** — any square PNG you own.
   - **Twitter / website** — the X account you will register with in section 7, and the
     repository or app URL. The X handle is what auto-attaches the token to your
     AnsemHack entry, so it has to match.
6. **Graduation target** (DBC only) is entered **in the quote asset**, i.e. in AAPLx.
   Leave the dashboard's default unless you have a reason; its default initial market cap
   is $8,000, which at the AAPLx price the preflight printed is the number it converts
   from. A larger target means the series takes longer to graduate to DAMM v2.
7. **Initial buy** — `0` is fine and keeps the cost at section 2's figure. If you want a
   first print, enter a small AAPLx amount; you must hold that AAPLx already, or use
   Clawpump's funding swap, which builds an unsigned SOL → AAPLx swap for you to sign.
8. **Creator fee** — if the form offers a basis-point field, take the highest it allows.
   Creator fees accrue **in AAPLx**, and that accrual is the evidence for the bounty.
9. Review the SOL cost the dashboard prints. It should be close to **0.0086 SOL**, or
   about **0.0146 SOL** if it is also creating a `PoolConfig`. Sign.
10. Wait for the transaction to confirm and copy its signature.

---

## 4. Verify it is actually Meteora

Do not skip this. Five of the six stock-paired tokens launched on Clawpump in the week
before this was written used the pump.fun path, which arguably does not satisfy the
bounty at all.

Open the transaction on Solscan and confirm **both** of these appear:

- program `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` (Meteora DBC)
- log line `Program log: Instruction: InitializeVirtualPoolWithToken2022`

If instead you see `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` and `CreateV2`, you
launched on pump.fun. That is the fallback, not the target.

Then confirm the quote asset on chain: the pool's quote vault should hold
`XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp`, and the token page should show AAPLx as
the pair.

---

## 5. The four links to capture

Paste these four into the submission. They are the whole evidence chain.

| # | link | what it proves |
|---|---|---|
| 1 | `https://clawpump.tech/agent/d3dbfac2-ea62-44a7-8774-352df0a7492c` | the agent exists on Clawpump, with our custom skill attached |
| 2 | `https://clawpump.tech/tokens/<mint>` | the token exists, paired with AAPLx, attached to that agent |
| 3 | `https://solscan.io/tx/<signature>` | the Meteora DBC `InitializeVirtualPoolWithToken2022` transaction — "using clawpump **and** Meteora", on chain |
| 4 | ~~`https://solscan.io/tx/<fee claim signature>`~~ | **not obtainable — see below** |

**What link 4 turned out to be.** The pool traded and took 2,110,851 raw AAPLx in fees, which
is the accrual this bounty is about and is readable off `quoteVault`
[`9wrCMWAy…L3jkH`](https://solscan.io/account/9wrCMWAyo1bfAN4q51j98PhGnHfrpuUE7g2ABmzL3jkH).
There is no claim transaction to link, because ClawPump sets **itself** as both `creator` and
`feeClaimer` on the pool config and sets `creatorTradingFeePercentage` to 0. The launching
wallet holds no authority over any of it. The accrual is the evidence; the claim is ClawPump's
to make, and a screenshot of someone else's claim would not be ours either way.

Read the earnings on the dashboard at
<https://clawpump.tech/agent/d3dbfac2-ea62-44a7-8774-352df0a7492c>, not over the API:
`GET /api/fees/earnings?agentId=...` is documented in older Clawpump material but returns
**404** today, and so does every variant of it (`/api/v1/fees/earnings`,
`/api/v1/earnings`, `/api/v1/agents/{id}/earnings`, `/api/v1/agents/{id}/fees`). The MCP
server has no earnings tool among its 132 either. All of that was checked;
`pnpm run clawpump status` probes the endpoint and tells you which case you are in.

**This is the link no competitor has**, so it is worth the extra ten minutes.

---

## 6. If something on screen disagrees with this file

| what you see | what to do |
|---|---|
| AAPLx resolves but only **DAMM v2** is offered | Use `damm_v2`. It needs **real AAPLx seed liquidity up front and locks the LP principal permanently** — size it as something you are willing to never see again. Still Meteora, still satisfies the bounty. |
| The custom mint is rejected outright | Try NVDAx `Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh`, then TQQQx `XsjQP3iMAaQ3kQScQKthQpx9ALRbjKAjQtHg6TFomoc` — TQQQx is the one asset a Meteora DBC launch is *known* to have worked with. |
| No Meteora mode appears at all | Fall back to the documented pump.fun path: `POST /api/v1/launch` with `pumpQuoteMint` = the AAPLx mint and `pumpCreatorFeeBps` = 300. It costs **0.009218 SOL** (read live from `POST /api/public-launch {"action":"cost"}`), it still pays creator fees in AAPLx, and it still satisfies "launch your token with a stock-paired liquidity pool using clawpump". Say plainly in the submission that the Meteora half is carried by the venue's own DBC pools (`market/`), which are quoted in AAPLx by construction. |
| The dashboard quotes a cost far above 0.02 SOL | Stop and re-read the form. Something is set to seed liquidity. |

Do not spend more than an hour fighting the UI. A working pump.fun launch plus an honest
sentence beats an unlaunched token.

---

## 7. AnsemHack — ten minutes, separate prize pool, same token

The same launch is the entry ticket to the AnsemHack Clawrena. All three of these must
be done by **1 October 2026, 24:00 EST**. Missing any one of them disqualifies the entry
however good the build is.

- [ ] **Register** at <https://clawpump.tech/ansemhack>. One entry per project. Pick the
      **ClawPump × pump.fun** track (Builder and Trader are judged together; stack the
      other ClawPump tracks freely, but **do not** pick EasyA Kickstart — it is exclusive
      with the ClawPump tracks). Four fields plus track selection.
- [ ] **Post the pre-written announcement on X and follow [@clawpumptech](https://x.com/clawpumptech).**
      There is no confirmation email: **the post is the receipt.** Use the same X handle
      you registered with and that you put on the token in step 5, because that handle is
      what attaches the token to your entry automatically.
- [ ] **Tokenize by 1 October.** Section 3 does this. The token can also be attached
      afterwards at <https://clawpump.tech/ansemhack/entry>.

Worth knowing: there is no exclusivity clause against entering the Solana Foundation
Stocklana hackathon with the same project — the only exclusivity on the page is internal
(EasyA Kickstart vs the ClawPump tracks). Clawpump keeps 25% of trading fees; the rest is
yours win or lose.

---

## 8. What could not be verified from here

Stated plainly rather than guessed at.

- **The write side of the Meteora API.** `GET /api/meteora?action={catalogue,asset,pricing,funding}`
  answers a `cpk_` bearer key — verified, all four. `POST /api/meteora?action=launch` was
  **not** called and is not reachable from any code in `agent/`. Whether it accepts a
  `cpk_` key or requires a browser session is unknown, and finding out would mean
  risking a real launch.
- **Whether Clawpump holds a `PoolConfig` quoted in AAPLx.** If not, add 0.00597408 SOL.
  The dashboard's own cost preview settles this before you sign.
- **The exact field labels in the launch form.** They come from reading Clawpump's
  JavaScript bundle (`mode`, `quoteMint`, `customQuote`, `graduationQuoteRaw`,
  `initialBuyQuoteRaw`), not from a logged-in session. The concepts are right; the words
  on screen may differ.
- **The creator-fee basis points on the Meteora path.** `pumpCreatorFeeBps` (100–300) is
  documented for the pump.fun path only. Whether DBC exposes an equivalent is unknown.
- **Fee accrual in AAPLx.** Observed, and it is real: `partnerQuoteFee` 1,688,682 and
  `protocolQuoteFee` 422,169, both denominated in AAPLx. What was wrong in the pre-launch
  version of this note is who receives it — see the evidence table above.
