import { createHash } from 'node:crypto';

import type { Address } from '@solana/kit';
import { describe, expect, it } from 'vitest';

import { f64ToFixed } from '../src/fixed.js';
import { decodeMintState, mintMultiplierAt } from '../src/mint.js';
import { decodePriceUpdateV2, decodeScopeEntry, observePyth, PRICE_UPDATE_V2_DISCRIMINATOR, PYTH_RECEIVER_PROGRAM_ADDRESS } from '../src/oracle.js';
import { fixture } from './helpers.js';

describe('Token-2022 mint decode against the real AAPLx dump', () => {
  const mint = decodeMintState('XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp' as Address, fixture('aaplx_mint.bin'));

  it('reads the ScaledUiAmount config, the issuer levers and the symbol', () => {
    expect(mint.decimals).toBe(8);
    expect(mint.symbol).toBe('AAPLx');
    expect(mint.scaledUiAmount).toEqual({
      authority: 'S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS',
      multiplier: 1.0026642075893797,
      newMultiplier: 1.0032690125398187,
      newMultiplierEffectiveTimestamp: 1786149000n,
    });
    expect(mint.paused).toBe(false);
    // the hook authority is live, the program id is empty: HookAttached must not fire
    expect(mint.transferHookProgramId).toBeNull();
  });

  it('selects the multiplier the way effective_from_cfg does, inclusive at the timestamp', () => {
    const cfg = mint.scaledUiAmount!;
    const before = mintMultiplierAt(cfg, 1786149000n - 1n);
    expect(before.effective).toBe(f64ToFixed(1.0026642075893797));
    expect(before.pending).toEqual({ multiplier: f64ToFixed(1.0032690125398187), effectiveTs: 1786149000n });
    const at = mintMultiplierAt(cfg, 1786149000n);
    expect(at).toEqual({ effective: f64ToFixed(1.0032690125398187), pending: null, epochKey: 1786149000n });
  });
});

describe('oracle decode', () => {
  it('the PriceUpdateV2 discriminator is sha256("account:PriceUpdateV2")[..8], and the real account starts with it', () => {
    const digest = createHash('sha256').update('account:PriceUpdateV2').digest();
    expect([...PRICE_UPDATE_V2_DISCRIMINATOR]).toEqual([...digest.subarray(0, 8)]);
    expect([...fixture('pyth_sol_usd_priceupdatev2.bin').subarray(0, 8)]).toEqual([...digest.subarray(0, 8)]);
  });

  it('decodes the real SOL/USD PriceUpdateV2 and applies get_price_no_older_than', () => {
    const data = fixture('pyth_sol_usd_priceupdatev2.bin');
    const update = decodePriceUpdateV2(data);
    expect(update.verificationLevel).toEqual({ kind: 'Full' });
    expect(update.exponent).toBe(-8);
    expect(update.price > 0n).toBe(true);
    // SOL/USD feed id, Pyth's published constant
    expect(Buffer.from(update.feedId).toString('hex')).toBe('ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d');

    const fresh = observePyth(PYTH_RECEIVER_PROGRAM_ADDRESS, data, update.feedId, 60, update.publishTime + 60n);
    expect(fresh).toEqual({ price: update.price, conf: update.conf, expo: -8, publishTs: update.publishTime });
    expect(() => observePyth(PYTH_RECEIVER_PROGRAM_ADDRESS, data, update.feedId, 60, update.publishTime + 61n)).toThrow(/older/);
    expect(() => observePyth(PYTH_RECEIVER_PROGRAM_ADDRESS, data, new Uint8Array(32), 60, update.publishTime)).toThrow(/different feed/);
    expect(() => observePyth('11111111111111111111111111111111' as Address, data, update.feedId, 60, update.publishTime)).toThrow(/owned/);
  });

  it('decodes Scope entries as scope.rs does, and rejects an unwritten slot', () => {
    const scope = fixture('scope_prices.bin');
    expect(scope.length).toBe(28_712);
    const aapl = decodeScopeEntry(scope, 317);
    expect(aapl.conf).toBe(0n);
    expect(aapl.expo).toBe(-15);
    expect(aapl.price).toBe(336702096953425855n);
    expect(aapl.publishTs).toBe(1789899294n);
    expect(() => decodeScopeEntry(scope, 512)).toThrow(/out of range/);
    const unwritten = [...Array(512).keys()].find((i) => {
      try {
        decodeScopeEntry(scope, i);
        return false;
      } catch {
        return true;
      }
    });
    expect(unwritten).toBeDefined();
  });
});
