import { address } from '@solana/kit';
import { describe, expect, it } from 'vitest';

import { resolveSession, US_EQUITY_CALENDAR } from '../src/calendar.js';
import { createDeliverable, NotRegisteredError } from '../src/client.js';
import { rpcHost } from '../src/config.js';
import { rpcUrl } from './helpers.js';

// Runs against whichever cluster SOLANA_RPC_URL points at. Anything that needs the
// program deployed skips with the reason when it is not; the preview path and the
// Scope/mint reads run regardless, because they only touch accounts that exist today.

const AAPLX = address('XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp');
const client = rpcUrl ? createDeliverable({ rpcUrl }) : null;
const deployed = client ? await client.programDeployed() : false;
const where = rpcUrl ? `${client!.programAddress} on ${rpcHost(rpcUrl)}` : 'no SOLANA_RPC_URL';

describe.skipIf(!client)('live reads', () => {
  it('reports whether the program is deployed on this cluster', async () => {
    expect(typeof deployed).toBe('boolean');
    if (!deployed) console.warn(`[live] program not deployed: ${where}; registered-security tests will skip`);
  });

  it('isActionable without preview names the missing registration instead of guessing', async ({ skip }) => {
    if (deployed && (await client!.getSecurityState(AAPLX))) return skip(`AAPLx is registered at ${where}`);
    await expect(client!.isActionable(AAPLX)).rejects.toBeInstanceOf(NotRegisteredError);
  });

  it('preview: evaluates the gate on live AAPLx, live Scope and the chain clock', async () => {
    const result = await client!.isActionable(AAPLX, { preview: true });
    const session = resolveSession(US_EQUITY_CALENDAR, Number(result.evaluatedAt));
    expect(result.session).toBe(session);
    if (result.basis === 'preview') {
      expect(result.binding).toEqual({
        __kind: 'Pair',
        primary: { __kind: 'Scope', index: 317 },
        secondary: { __kind: 'Scope', index: 315 },
      });
      expect(result.notes.join(' ')).toMatch(/preview/);
    }
    if (session === 'Closed') {
      expect(result).toMatchObject({ actionable: false, code: 1, name: 'MarketClosed' });
      expect(result.nextOpen).toBeGreaterThan(Number(result.evaluatedAt));
    } else {
      // Inside a session the verdict depends on the feeds; whatever it is, it is typed.
      if (!result.actionable) expect(result.code).toBeGreaterThanOrEqual(2);
    }
  });

  it('listSeries / getCalendar / getRegistry on a deployed program', async ({ skip }) => {
    if (!deployed) return skip(`program not deployed: ${where}`);
    const registry = await client!.getRegistry();
    expect(registry).not.toBeNull();
    const calendar = await client!.getCalendar(0);
    expect(calendar?.regularOpenMinute).toBe(570);
    const series = await client!.listSeries(AAPLX);
    for (const s of series) {
      const detail = await client!.describeSeries(s);
      expect(detail.strike.notional).toBe(detail.strike.strike * detail.strike.uiSize);
    }
  });

  it('isActionable on a registered security reads every input from chain', async ({ skip }) => {
    if (!deployed) return skip(`program not deployed: ${where}`);
    const state = await client!.getSecurityState(AAPLX);
    if (!state) return skip(`AAPLx is not registered at ${where}`);
    const result = await client!.isActionable(AAPLX);
    expect(result.basis).toBe('registered');
    expect(result.binding).toEqual(state.sources);
  });
});
