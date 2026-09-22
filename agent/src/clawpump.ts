/**
 * Clawpump, API-only.
 *
 *   pnpm run clawpump status
 *   pnpm run clawpump register
 *   pnpm run clawpump skill
 *   pnpm run clawpump preflight --quote-mint=<xStock> --payer=<wallet>
 *
 * Three things worth knowing before reading the code.
 *
 * 1. USE THE APEX DOMAIN. `agents.clawpump.tech` issues a host-wide 308 to
 *    `clawpump.tech`, and HTTP clients drop the Authorization header across a
 *    cross-host redirect, so every authenticated call sent there arrives
 *    unauthenticated and fails with 401. Clawpump documents this themselves.
 *
 * 2. THE METEORA SURFACE IS REAL BUT UNDOCUMENTED. `/api/meteora?action=...` does not
 *    appear in `/developers`, and it answers a `cpk_` bearer key for the four preview
 *    actions (catalogue, asset, pricing, funding). The write side — `action=launch` —
 *    is not exercised here and this file has no code path that could reach it. The
 *    launch is a human's browser step; see LAUNCH.md.
 *
 * 3. THE KEY IS NEVER PRINTED. It is read through the SDK's `envSetting` and every
 *    line this file writes goes through `redact` first. Nothing logs a full URL.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { envSetting } from '@stocklana/sdk';

import { parseArgs } from './args.ts';

/** The apex domain. See note 1 above: the `agents.` subdomain loses the header. */
export const CLAWPUMP_BASE = 'https://clawpump.tech';
const HERE = dirname(fileURLToPath(import.meta.url));
export const SKILL_PATH = resolve(HERE, '..', 'SKILL.md');

/** No `cpk_` value reaches a terminal, a log or a file from this process. */
export function redact(text: string): string {
  return text.replace(/cpk_[A-Za-z0-9_-]+/g, 'cpk_<redacted>');
}

function apiKey(): string {
  const key = envSetting('CLAWPUMP_API_KEY');
  if (!key) {
    throw new Error('CLAWPUMP_API_KEY is not set. Put it in the repository .env; it is a bearer secret, server-side only.');
  }
  if (!key.startsWith('cpk_')) {
    throw new Error('CLAWPUMP_API_KEY does not look like a Clawpump key: they start with cpk_.');
  }
  return key;
}

export async function call(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${CLAWPUMP_BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    // An HTML body means the path does not exist as an API route; keep the status.
    body = text.startsWith('<') ? '<html: no API route at this path>' : text;
  }
  return { status: response.status, body };
}

const show = (label: string, value: unknown) =>
  console.log(`${label}\n${redact(typeof value === 'string' ? value : JSON.stringify(value, null, 2))}\n`);

// ---------------------------------------------------------------------------
// The stdio MCP server, which is the only surface that can register a custom skill.
// There is no REST route for it: /api/v1/agents/{id}/custom-skills and every variant
// of it answers 404. `npx @clawpump/agents` reads CLAWPUMP_API_KEY from the environment
// and exposes create/update/list/delete_custom_skill among its 132 tools.
// ---------------------------------------------------------------------------

interface JsonRpcMessage {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

async function mcp(calls: ReadonlyArray<{ name: string; args: Record<string, unknown> }>): Promise<unknown[]> {
  const isWindows = process.platform === 'win32';
  const child = spawn(isWindows ? 'npx.cmd' : 'npx', ['-y', '@clawpump/agents'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, CLAWPUMP_API_KEY: apiKey() },
    shell: isWindows,
  });

  const results = new Map<number, JsonRpcMessage>();
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line) as JsonRpcMessage;
        if (typeof message.id === 'number') results.set(message.id, message);
      } catch {
        // The server prints its banner on stderr, but be tolerant of stray stdout.
      }
    }
  });

  const send = (payload: unknown) => child.stdin.write(`${JSON.stringify(payload)}\n`);
  const waitFor = async (id: number, timeoutMs: number): Promise<JsonRpcMessage> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = results.get(id);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Clawpump MCP did not answer request ${id} within ${timeoutMs}ms`);
  };

  try {
    send({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2026-06-18', capabilities: {}, clientInfo: { name: 'deliverable-wheelwright', version: '0.1.0' } },
    });
    await waitFor(0, 90_000);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const out: unknown[] = [];
    let id = 1;
    for (const c of calls) {
      send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: c.name, arguments: c.args } });
      const message = await waitFor(id, 60_000);
      if (message.error) throw new Error(`${c.name}: ${message.error.message}`);
      out.push(message.result);
      id += 1;
    }
    return out;
  } finally {
    child.kill();
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const AGENT_NAME = 'Wheelwright';

async function findAgent(name: string): Promise<{ id: string; walletAddress?: string } | null> {
  const { body } = await call('/api/v1/agents');
  const agents = (body as { agents?: Array<{ id: string; name: string; walletAddress?: string }> }).agents ?? [];
  return agents.find((a) => a.name === name) ?? null;
}

async function status(): Promise<void> {
  const agents = await call('/api/v1/agents');
  show('GET /api/v1/agents', agents.body);
  const agent = await findAgent(AGENT_NAME);
  if (agent) {
    const detail = await call(`/api/v1/agents/${agent.id}`);
    show(`GET /api/v1/agents/${agent.id}`, detail.body);
    // Older Clawpump material documents GET /api/fees/earnings?agentId=. It answers 404
    // today, as does every variant of it (/api/v1/fees/earnings, /api/v1/earnings,
    // /api/v1/agents/{id}/earnings, /api/v1/agents/{id}/fees), and the MCP server has no
    // earnings tool among its 132. Creator-fee accrual is a dashboard read for now. This
    // probe stays so the day it comes back, `status` shows it.
    const earnings = await call(`/api/fees/earnings?agentId=${agent.id}`);
    if (earnings.status === 200) {
      show(`GET /api/fees/earnings?agentId=${agent.id}`, earnings.body);
    } else {
      console.log(
        `GET /api/fees/earnings?agentId=${agent.id}  [http ${earnings.status}] — not a live REST route.\n` +
          `Read creator-fee earnings on the dashboard instead: https://clawpump.tech/agent/${agent.id}\n`,
      );
    }
  } else {
    console.log(`No agent named ${AGENT_NAME}. Run: pnpm run clawpump register\n`);
  }
}

async function register(): Promise<void> {
  const existing = await findAgent(AGENT_NAME);
  if (existing) {
    console.log(`${AGENT_NAME} already exists: ${existing.id} (wallet ${existing.walletAddress ?? 'unknown'}). Nothing to do.`);
    return;
  }
  const { status: code, body } = await call('/api/v1/agents', {
    method: 'POST',
    body: {
      name: AGENT_NAME,
      model: 'moonshotai/kimi-k2.5',
      persona:
        'A covered-call wheel operator for tokenised US equities. Quotes premium in shares, not dollars. ' +
        'Refuses to act whenever the Deliverable rail refuses, and says which of the nine refusal codes stopped it.',
      system_prompt:
        'You operate a covered-call wheel on tokenised US equities (xStocks, Token-2022). Before proposing any action ' +
        'on a security you call the Deliverable rail: isActionable(mint). If it returns a refusal you do not act; you ' +
        'report the code, its name and what a caller should do about it. You never hold a private key and never sign. ' +
        'You propose actions and print the transactions a human would send. Premium is denominated in the underlying ' +
        'share, so a written call accumulates the share itself. Strike is quoted per adjusted share and is re-derived ' +
        'from the mint ScaledUiAmount multiplier every time, so a split or dividend never changes the notional.',
      temperature: 0.3,
      skills: ['trading', 'portfolio', 'market-intelligence', 'token-launch'],
    },
  });
  show(`POST /api/v1/agents  [http ${code}]`, body);
}

async function publishSkill(): Promise<void> {
  const agent = await findAgent(AGENT_NAME);
  if (!agent) throw new Error(`No agent named ${AGENT_NAME}. Run: pnpm run clawpump register`);
  const content = readFileSync(SKILL_PATH, 'utf8');
  const name = 'Deliverable rail: tokenised-equity actionability';
  const description =
    'Ask whether a tokenised US equity can be acted on right now, read an adjusted strike, and handle each of the ' +
    'nine refusal codes. Backed by an on-chain program and a read-only MCP server.';

  // The MCP result carries its payload as an escaped JSON string inside a text block,
  // so match on the id that most recently precedes the skill's name rather than trying
  // to parse through two layers of quoting.
  const [listed] = await mcp([{ name: 'list_custom_skills', args: { agent_id: agent.id } }]);
  const text = JSON.stringify(listed);
  const at = text.indexOf(name);
  const before = at < 0 ? '' : text.slice(0, at);
  const ids = before.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g);
  const existingId = ids?.[ids.length - 1];

  const [result] = existingId
    ? await mcp([{ name: 'update_custom_skill', args: { agent_id: agent.id, skill_id: existingId, name, description, content, enabled: true } }])
    : await mcp([{ name: 'create_custom_skill', args: { agent_id: agent.id, name, description, content, enabled: true } }]);

  // The echo carries the whole document back; print the identity, not the payload.
  const echoed = JSON.stringify(result);
  const slug = /deliverable-rail[a-z-]*/.exec(echoed)?.[0] ?? '(no slug returned)';
  const id = existingId ?? /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(echoed)?.[0] ?? '(no id returned)';
  console.log(
    `${existingId ? 'update_custom_skill' : 'create_custom_skill'} ok\n` +
      `  skill   ${id}  ${slug}\n` +
      `  agent   ${agent.id}\n` +
      `  content ${content.length} bytes from ${SKILL_PATH}`,
  );
}

/**
 * Everything the launch needs, read rather than assumed. This answers the one question
 * the recon could not: whether an xStock reports `dbcSupported`, and whether a `cpk_`
 * key can see it at all.
 */
async function preflight(quoteMint: string, payer: string | undefined): Promise<void> {
  const asset = await call(`/api/meteora?action=asset&mint=${quoteMint}`);
  show(`GET /api/meteora?action=asset&mint=${quoteMint}  [http ${asset.status}]`, asset.body);

  const pricing = await call(`/api/meteora?action=pricing&mint=${quoteMint}`);
  show(`GET /api/meteora?action=pricing&mint=${quoteMint}  [http ${pricing.status}]`, pricing.body);

  if (payer) {
    const funding = await call(`/api/meteora?action=funding&mint=${quoteMint}&payerWallet=${payer}`);
    show(`GET /api/meteora?action=funding&mint=${quoteMint}&payerWallet=${payer}  [http ${funding.status}]`, funding.body);
  } else {
    console.log('No --payer given: skipping the funding read, which reports the wallet\'s SOL and quote-asset balance.\n');
  }

  // The documented pump.fun path, priced for the same pair. It is the fallback in
  // LAUNCH.md and the only launch surface a cpk_ key can actually drive.
  const cost = await fetch(`${CLAWPUMP_BASE}/api/public-launch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'cost', quoteMint }),
  });
  show(`POST /api/public-launch {"action":"cost"}  [http ${cost.status}]`, await cost.text());

  const flags = asset.body as { dbcSupported?: boolean; dammSupported?: boolean; reason?: string | null };
  console.log(
    flags.dbcSupported
      ? 'dbcSupported is true for this mint: the Meteora DBC mode in the dashboard will accept it as a custom quote.'
      : `dbcSupported is false${flags.reason ? `: ${flags.reason}` : ''}. Use damm_v2 if dammSupported, otherwise fall back to the pump.fun path.`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs();
  const command = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'status';

  switch (command) {
    case 'status':
      await status();
      break;
    case 'register':
      await register();
      break;
    case 'skill':
      await publishSkill();
      break;
    case 'preflight':
      await preflight(
        args.str('quote-mint', 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp'),
        args.str('payer'),
      );
      break;
    default:
      console.log('usage: pnpm run clawpump [status|register|skill|preflight] [--quote-mint=<mint>] [--payer=<wallet>]');
      process.exitCode = 1;
  }
}

await main();
