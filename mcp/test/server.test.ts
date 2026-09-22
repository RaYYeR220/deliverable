import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createDeliverable, envSetting, rpcHost } from '@stocklana/sdk';
import { beforeAll, describe, expect, it } from 'vitest';

import { filterActions, loadActionHistory } from '../src/actions.js';
import { createServer } from '../src/server.js';
import { Underlyings } from '../src/underlyings.js';

const rpcUrl = envSetting('SOLANA_RPC_URL');
const history = loadActionHistory();
const underlyings = new Underlyings(history.actions);

const EXPECTED_TOOLS = [
  'adjusted_balance',
  'corporate_actions',
  'is_actionable',
  'list_series',
  'refusal_codes',
  'security_state',
  'series_detail',
];

let client: Client;

beforeAll(async () => {
  // A client that is never asked to reach the network still needs an RPC object;
  // without SOLANA_RPC_URL the offline tests use a placeholder that is never called.
  const deliverable = createDeliverable({ rpcUrl: rpcUrl ?? 'http://127.0.0.1:1' });
  const server = createServer({ client: deliverable, history, underlyings, rpcHost: rpcUrl ? rpcHost(rpcUrl) : 'offline' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ result: CallToolResult; data: Record<string, any> }> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { result, data: (result.structuredContent ?? {}) as Record<string, any> };
}

describe('the tool surface', () => {
  it('exposes exactly the read-only tools, every one annotated read-only and non-destructive', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
    }
  });

  it('nothing on the surface can sign or send', async () => {
    const { tools } = await client.listTools();
    const schemas = JSON.stringify(tools.map((t) => t.inputSchema)).toLowerCase();
    for (const word of ['secret', 'keypair', 'private', 'signer', 'mnemonic']) expect(schemas).not.toContain(word);
    for (const tool of tools) expect(tool.name).not.toMatch(/send|sign|write|exercise|submit|transfer/);
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toMatch(/cannot sign or send transactions/);
  });

  it('refusal_codes lists the nine codes in gate order', async () => {
    const { data } = await call('refusal_codes');
    expect(data['codes'].map((c: { code: number }) => c.code)).toEqual([1, 2, 6, 7, 5, 3, 4, 9, 8]);
    expect(data['codes'][0]).toMatchObject({ name: 'MarketClosed', anchorErrorCode: 6000 });
  });

  it('an unknown underlying is a tool error that lists what is known, not a crash', async () => {
    const { result } = await call('is_actionable', { underlying: 'NOPEx' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/AAPLx/);
  });

  it('adjusted_balance with nothing to read says what it needs', async () => {
    const { result } = await call('adjusted_balance', { underlying: 'AAPLx' });
    expect(result.isError).toBe(true);
  });
});

describe('symbols and history', () => {
  it('resolves symbols, bare tickers and raw mints', () => {
    expect(underlyings.resolve('AAPLx').mint).toBe('XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp');
    expect(underlyings.resolve('aapl').mint).toBe('XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp');
    expect(underlyings.resolve('XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL').symbol).toBe('NFLXx');
  });

  it('reads the keeper history and filters it newest first', ({ skip }) => {
    if (history.error) return skip(`keeper history unavailable at ${history.path}: ${history.error}`);
    expect(history.actions.length).toBeGreaterThan(0);
    const splits = filterActions(history.actions, { kind: 'split', limit: 200 });
    const nflx = splits.find((a) => a.symbol === 'NFLXx');
    expect(nflx).toMatchObject({ newMultiplier: 10, previousMultiplier: 1, effectiveTimestamp: 1763337300 });
    for (let i = 1; i < splits.length; i++) expect(splits[i - 1]!.effectiveTimestamp >= splits[i]!.effectiveTimestamp).toBe(true);
  });
});

describe.skipIf(!rpcUrl)('tools against SOLANA_RPC_URL', () => {
  it('is_actionable returns a typed verdict, and MarketClosed whenever the calendar is shut', async () => {
    const { result, data } = await call('is_actionable', { underlying: 'AAPLx' });
    expect(result.isError).toBeFalsy();
    expect(typeof data['actionable']).toBe('boolean');
    expect(['registered', 'preview']).toContain(data['basis']);
    if (data['session'] === 'Closed') expect(data).toMatchObject({ actionable: false, code: 1, name: 'MarketClosed', anchorErrorCode: 6000 });
    if (!data['actionable']) expect(data['reason']).toEqual(expect.any(String));
  });

  it('security_state reports the live multiplier, the issuer levers and both sources', async () => {
    const { result, data } = await call('security_state', { underlying: 'AAPLx' });
    expect(result.isError).toBeFalsy();
    expect(data['underlying']).toMatchObject({ symbol: 'AAPLx', decimals: 8 });
    expect(data['corporateAction']['extension']).toBe(true);
    expect(data['issuerLevers']).toEqual({ paused: false, transferHookProgramId: null });
    expect(data['prices']['binding']).toBe('Scope #317 checked against Scope #315');
    expect(typeof data['program']['deployed']).toBe('boolean');
  });

  it('adjusted_balance corrects the pinned transaction: 439229 / 1e8 * 1.0032690125398187', async () => {
    const { result, data } = await call('adjusted_balance', {
      signature: '4rsX6HjrGb7i4WsG6yTVxnUZY1hyo3SLj3j2XbLXvid9Cn8s8tzk7SSEtra1yRrmvuxabtuaqZKkfaQynSJ6DCY',
      token_account: 'EQYSiL5i4LdYLEyYs7F9faWJpd7SzNQK49SxXjAPoWLD',
    });
    expect(result.isError).toBeFalsy();
    expect(data).toMatchObject({
      uiAmount: (439229 / 1e8) * 1.0032690125398187,
      uiAmountString: '0.00440664',
      raw: '439229',
      multiplier: 1.0032690125398187,
      source: 'transaction',
      reportedWasScaled: false,
    });
    expect(data['explanation']).toMatch(/without applying/);
  });

  it('adjusted_balance for a wallet and an xStock', async () => {
    const { result, data } = await call('adjusted_balance', { wallet: 'GkhTfrw9mcvGPrU6s9Qzgeu5LyHTdcQUEyVmAGu4FP7h', underlying: 'AAPLx' });
    expect(result.isError).toBeFalsy();
    expect(data['accounts']).toContain('EQYSiL5i4LdYLEyYs7F9faWJpd7SzNQK49SxXjAPoWLD');
  });

  it('corporate_actions for NFLXx shows the 10-for-1 and confirms the mint agrees', async () => {
    const { result, data } = await call('corporate_actions', { underlying: 'NFLXx', kind: 'split' });
    expect(result.isError).toBeFalsy();
    expect(data['actions'][0]).toMatchObject({ symbol: 'NFLXx', previousMultiplier: 1, newMultiplier: 10, kind: 'split' });
    expect(data['live']).toMatchObject({ inForce: '10', scheduled: null, historyIsCurrent: true });
  });

  it('list_series answers honestly whether or not the program is deployed', async () => {
    const { result, data } = await call('list_series', { underlying: 'AAPLx' });
    expect(result.isError).toBeFalsy();
    if (!data['program']['deployed']) {
      expect(data['series']).toEqual([]);
      expect(data['note']).toMatch(/not deployed/);
    } else {
      for (const s of data['series']) expect(s).toHaveProperty('strikeNow');
    }
  });
});
