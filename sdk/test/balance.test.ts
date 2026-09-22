import { address, createSolanaRpc, type Address } from '@solana/kit';
import { describe, expect, it } from 'vitest';

import { adjustBalance, adjustTransactionTokenBalance, formatUnits, multiplierAt, type TransactionTokenBalance } from '../src/balance.js';
import { createDeliverable } from '../src/client.js';
import { decodeMintState } from '../src/mint.js';
import { fixture, fixtureJson, rpcUrl } from './helpers.js';

const SIGNATURE = '4rsX6HjrGb7i4WsG6yTVxnUZY1hyo3SLj3j2XbLXvid9Cn8s8tzk7SSEtra1yRrmvuxabtuaqZKkfaQynSJ6DCY';
const AAPLX = 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp' as Address;
const TOKEN_ACCOUNT = 'EQYSiL5i4LdYLEyYs7F9faWJpd7SzNQK49SxXjAPoWLD' as Address;
const OWNER = 'GkhTfrw9mcvGPrU6s9Qzgeu5LyHTdcQUEyVmAGu4FP7h' as Address;
const M = 1.0032690125398187;
const CORRECT = (439229 / 1e8) * M;

interface PinnedTransaction {
  slot: number;
  blockTime: number;
  meta: { preTokenBalances: TransactionTokenBalance[]; postTokenBalances: TransactionTokenBalance[] };
}

const tx = fixtureJson<PinnedTransaction>('tx-4rsX6HjrGb7i4WsG.json');
const aaplx = decodeMintState(AAPLX, fixture('aaplx_mint.bin'));
const aaplxEntry = tx.meta.postTokenBalances.find((b) => b.mint === AAPLX)!;

describe('getAdjustedBalance on the pinned transaction (offline, recorded RPC response)', () => {
  it('the recorded meta is the bug: raw 439229 reported as 0.00439229, multiplier not applied', () => {
    expect(aaplxEntry.uiTokenAmount).toEqual({ amount: '439229', decimals: 8, uiAmount: 0.00439229, uiAmountString: '0.00439229' });
    expect(tx.blockTime).toBe(1789849714);
    // the multiplier in force at that block time: the 2026-08-08 dividend step had landed
    expect(BigInt(tx.blockTime) >= aaplx.scaledUiAmount!.newMultiplierEffectiveTimestamp).toBe(true);
  });

  it('returns 439229 / 1e8 * 1.0032690125398187, with the raw amount and multiplier used', () => {
    const got = adjustTransactionTokenBalance(aaplxEntry, aaplx.scaledUiAmount, BigInt(tx.blockTime));
    expect(got.uiAmount).toBe(CORRECT);
    expect(got.raw).toBe(439229n);
    expect(got.decimals).toBe(8);
    expect(got.multiplier).toBe(M);
    expect(got.provenance).toBe('mint:new_multiplier');
    expect(got.source).toBe('transaction');
    // the token program's own string convention, which getTokenAccountBalance returns
    expect(got.uiAmountString).toBe('0.00440664');
    // and the audit trail says the RPC figure was unscaled
    expect(got.reported?.uiAmount).toBe(0.00439229);
    expect(got.reportedWasScaled).toBe(false);
    expect(got.uiAmount / 0.00439229).toBeCloseTo(M, 12);
  });

  it('a pre-split transaction uses the old multiplier, with history bounding it', () => {
    const before = aaplx.scaledUiAmount!.newMultiplierEffectiveTimestamp - 1n;
    // keeper/data/corporate-actions.json, signature 2CW1WSVjDagEDk3BkLpm...: both sides of the
    // 2026-08-08 step were written in the same transaction.
    const history = [{ mint: AAPLX, newMultiplier: M, effectiveTimestamp: 1786149000, previousMultiplier: 1.0026642075893797, previousEffectiveTimestamp: 1778293800 }];
    expect(multiplierAt(AAPLX, aaplx.scaledUiAmount, before, { history })).toEqual({ multiplier: 1.0026642075893797, provenance: 'history' });
    expect(multiplierAt(AAPLX, aaplx.scaledUiAmount, before)).toEqual({ multiplier: 1.0026642075893797, provenance: 'mint:multiplier-unbounded' });
    expect(multiplierAt(AAPLX, aaplx.scaledUiAmount, before, { current: true }).provenance).toBe('mint:multiplier');
  });

  it('a mint without the extension is unscaled and says so', () => {
    const got = adjustBalance({ raw: 1_500_000n, decimals: 6, mint: AAPLX, scaled: null, at: 0n, source: 'raw' });
    expect(got).toMatchObject({ uiAmount: 1.5, uiAmountString: '1.5', multiplier: 1, provenance: 'no-extension' });
  });

  it('formats units the way Agave trims them', () => {
    expect(formatUnits(440664n, 8)).toBe('0.00440664');
    expect(formatUnits(15426560588525n, 8)).toBe('154265.60588525');
    expect(formatUnits(100000000n, 8)).toBe('1');
    expect(formatUnits(0n, 6)).toBe('0');
  });
});

describe.skipIf(!rpcUrl)('getAdjustedBalance live, against SOLANA_RPC_URL', () => {
  const client = createDeliverable({ rpcUrl: rpcUrl! });

  it('from getTransaction: the pinned signature, corrected', async () => {
    const got = await client.getAdjustedBalance({ signature: SIGNATURE, tokenAccount: TOKEN_ACCOUNT });
    expect(got.raw).toBe(439229n);
    expect(got.multiplier).toBe(M);
    expect(got.uiAmount).toBe(CORRECT);
    expect(got.reported?.uiAmountString).toBe('0.00439229');
    expect(got.reportedWasScaled).toBe(false);
    expect(got.accounts).toEqual([TOKEN_ACCOUNT]);
  });

  it('from getTransaction: every balance in the transaction, pre and post', async () => {
    const all = await client.getAdjustedTransactionBalances(SIGNATURE);
    const aapl = all.filter((b) => b.mint === AAPLX);
    expect(aapl.map((b) => b.when).sort()).toEqual(['post', 'pre']);
    for (const b of aapl) expect(b.uiAmount).toBe(CORRECT);
  });

  it('from getTokenAccountBalance: agrees with the RPC to the last digit, because the RPC scales here', async () => {
    const got = await client.getAdjustedBalance({ tokenAccount: TOKEN_ACCOUNT });
    const direct = await createSolanaRpc(rpcUrl!).getTokenAccountBalance(TOKEN_ACCOUNT).send();
    expect(got.raw).toBe(BigInt(direct.value.amount));
    expect(got.uiAmountString).toBe(direct.value.uiAmountString);
    expect(got.reportedWasScaled).toBe(true);
  });

  it('from getTokenSupply: agrees with the RPC', async () => {
    const got = await client.getAdjustedBalance({ supply: AAPLX });
    expect(got.reported).toBeDefined();
    expect(got.uiAmountString).toBe(got.reported!.uiAmountString);
    expect(got.reportedWasScaled).toBe(true);
  });

  it('by owner and mint: the wallet that held the pinned balance', async () => {
    const got = await client.getAdjustedBalance({ owner: OWNER, mint: address(AAPLX) });
    expect(got.accounts).toContain(TOKEN_ACCOUNT);
    expect(got.uiAmount).toBe((Number(got.raw) / 1e8) * got.multiplier);
  });
});
