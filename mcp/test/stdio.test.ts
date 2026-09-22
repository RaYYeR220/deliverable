import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { envSetting } from '@stocklana/sdk';
import { describe, expect, it } from 'vitest';

// The built server, spawned exactly as an MCP client config spawns it.
const ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const rpcUrl = envSetting('SOLANA_RPC_URL');

describe('stdio', () => {
  it('starts over stdio, lists its tools and answers a call', async ({ skip }) => {
    if (!existsSync(ENTRY)) return skip('dist/index.js not built; run pnpm build');
    if (!rpcUrl) return skip('SOLANA_RPC_URL is not set');

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      env: { ...(process.env as Record<string, string>), SOLANA_RPC_URL: rpcUrl },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '0.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(7);
      const result = (await client.callTool({ name: 'refusal_codes', arguments: {} })) as CallToolResult;
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result.structuredContent)).toContain('MarketClosed');
    } finally {
      await client.close();
    }
  });
});
