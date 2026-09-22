/**
 * Capture a mainnet account's raw data as a test fixture.
 *
 *   tsx scripts/fixtures.ts <pubkey> <output-path>
 *
 * Tests in this repo run against real account dumps rather than mocks, so every
 * fixture has to be reproducible by anyone with an RPC endpoint. The endpoint
 * comes from SOLANA_RPC_URL in .env and is never echoed — it usually carries an
 * API key in the path.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadRpcUrl(): string {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  let raw: string;
  try {
    raw = readFileSync(resolve(repoRoot, ".env"), "utf8");
  } catch {
    throw new Error("SOLANA_RPC_URL is not set and .env is missing");
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*SOLANA_RPC_URL\s*=\s*(.*)$/.exec(line);
    if (m) {
      const value = m[1].trim().replace(/^["']|["']$/g, "");
      if (value) return value;
    }
  }
  throw new Error("SOLANA_RPC_URL is empty in .env");
}

async function main() {
  const [pubkey, outPath] = process.argv.slice(2);
  if (!pubkey || !outPath) {
    console.error("usage: tsx scripts/fixtures.ts <pubkey> <output-path>");
    process.exit(2);
  }

  const res = await fetch(loadRpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [pubkey, { encoding: "base64", commitment: "confirmed" }],
    }),
  });
  if (!res.ok) throw new Error(`RPC returned HTTP ${res.status}`);

  const body = (await res.json()) as {
    error?: { message: string };
    result?: { value: { data: [string, string]; owner: string; lamports: number } | null };
  };
  if (body.error) throw new Error(`RPC error: ${body.error.message}`);
  const value = body.result?.value;
  if (!value) throw new Error(`account ${pubkey} does not exist`);

  const data = Buffer.from(value.data[0], "base64");
  const target = resolve(repoRoot, outPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data);

  console.log(`${pubkey}\n  owner     ${value.owner}\n  lamports  ${value.lamports}\n  bytes     ${data.length}\n  written   ${outPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
