/**
 * Pin the mainnet accounts Replay needs that the repository's test fixtures do not
 * already carry: the NVDAx mint and Scope's TokenMetadatas (the slot labels the
 * conventional binding is found by). Everything is read in one getMultipleAccounts
 * together with the Clock sysvar, so the manifest records the slot and chain time
 * the bytes describe.
 *
 *   node scripts/capture-replay.mjs
 *
 * The RPC URL comes from SOLANA_RPC_URL, then the repository .env. It is never printed:
 * it carries an API key.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(APP_ROOT, 'data', 'replay');

const ACCOUNTS = [
  { name: 'nvdax_mint.bin', pubkey: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', what: 'NVDAx Token-2022 mint' },
  { name: 'scope_token_metadatas.bin', pubkey: '3wHxoHowen78mskgqKQmaYVQV8Mqd5PUFXja2xcfviSV', what: 'Scope TokenMetadatas (slot labels)' },
];
const CLOCK = 'SysvarC1ock11111111111111111111111111111111';

function rpcUrl() {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  try {
    const raw = readFileSync(join(APP_ROOT, '..', '.env'), 'utf8');
    const m = /^\s*SOLANA_RPC_URL\s*=\s*(.+)$/m.exec(raw);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch {}
  throw new Error('SOLANA_RPC_URL is not set');
}

const res = await fetch(rpcUrl(), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'getMultipleAccounts',
    params: [[...ACCOUNTS.map((a) => a.pubkey), CLOCK], { encoding: 'base64', commitment: 'confirmed' }],
  }),
});
if (!res.ok) throw new Error(`RPC returned HTTP ${res.status}`);
const body = await res.json();
if (body.error) throw new Error(`RPC error: ${body.error.message}`);
const { context, value } = body.result;

const clock = Buffer.from(value[ACCOUNTS.length].data[0], 'base64');
const unixTimestamp = Number(clock.readBigInt64LE(32));

mkdirSync(OUT, { recursive: true });
const manifest = {
  capturedAtSlot: context.slot,
  capturedAtUnix: unixTimestamp,
  capturedAtIso: new Date(unixTimestamp * 1000).toISOString(),
  accounts: ACCOUNTS.map((a, i) => {
    const account = value[i];
    if (!account) throw new Error(`${a.pubkey} does not exist`);
    const data = Buffer.from(account.data[0], 'base64');
    writeFileSync(join(OUT, a.name), data);
    return {
      file: a.name,
      pubkey: a.pubkey,
      what: a.what,
      owner: account.owner,
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
    };
  }),
};
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`slot ${manifest.capturedAtSlot} at ${manifest.capturedAtIso}`);
for (const a of manifest.accounts) console.log(`  ${a.file}  ${a.bytes} bytes  ${a.sha256.slice(0, 16)}`);
