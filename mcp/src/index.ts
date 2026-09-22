#!/usr/bin/env node
/**
 * stdio entry point. stdout belongs to the protocol, so every diagnostic goes to stderr,
 * and the RPC endpoint is only ever named by host because its path carries an API key.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createDeliverable, resolveRpcUrl, rpcHost } from '@stocklana/sdk';

import { loadActionHistory } from './actions.js';
import { createServer } from './server.js';
import { Underlyings } from './underlyings.js';

async function main(): Promise<void> {
  const rpcUrl = resolveRpcUrl();
  const history = loadActionHistory();
  const client = createDeliverable({ rpcUrl, history: history.actions });
  const underlyings = new Underlyings(history.actions);

  const server = createServer({ client, history, underlyings, rpcHost: rpcHost(rpcUrl) });
  await server.connect(new StdioServerTransport());

  console.error(
    `deliverable-mcp: program ${client.programAddress} via ${rpcHost(rpcUrl)}; ` +
      `${history.actions.length} corporate actions from ${history.path}${history.error ? ` (${history.error})` : ''}; ` +
      `${underlyings.size} known symbols. Read-only.`,
  );
}

main().catch((error: unknown) => {
  console.error(`deliverable-mcp: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
