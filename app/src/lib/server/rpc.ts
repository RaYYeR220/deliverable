import 'server-only';

import { createDeliverable, DELIVERABLE_PROGRAM_ADDRESS, type Deliverable, type DeliverableConfig } from '@stocklana/sdk';

import { PROGRAM_ID } from '@/lib/config';

export type Address = NonNullable<DeliverableConfig['programAddress']>;

/** The program the instrument asks about: the configured deployment, else the IDL's id. */
export const PROGRAM_ADDRESS = (PROGRAM_ID ?? DELIVERABLE_PROGRAM_ADDRESS) as Address;

export class SourceUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceUnavailable';
  }
}

let instance: Deliverable | null = null;

/**
 * The SDK client, built once per server instance. SOLANA_RPC_URL is read here and only
 * here; it never leaves the server, and nothing derived from it is sent to a browser.
 */
export function deliverable(): Deliverable {
  const url = process.env.SOLANA_RPC_URL?.trim();
  if (!url) throw new SourceUnavailable('The server has no RPC endpoint configured, so mainnet cannot be read.');
  instance ??= createDeliverable({ rpcUrl: url, programAddress: PROGRAM_ADDRESS });
  return instance;
}

/**
 * An error, reduced to something safe to show. RPC URLs carry API keys in the path or the
 * query, so the endpoint, its host and anything shaped like a key are removed before a
 * message is allowed out of the server.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof SourceUnavailable) return error.message;
  let message = error instanceof Error ? error.message : String(error);
  const url = process.env.SOLANA_RPC_URL?.trim();
  if (url) {
    message = message.split(url).join('<rpc>');
    try {
      const { host, pathname, search } = new URL(url);
      for (const secret of [search, pathname.length > 1 ? pathname : '', host]) {
        if (secret) message = message.split(secret).join('<rpc>');
      }
    } catch {
      // an unparseable endpoint has already been removed whole
    }
  }
  message = message.replace(/(api[-_]?key|token|secret)=[^&\s"']+/gi, '$1=<redacted>');
  message = message.replace(/https?:\/\/[^\s"')]+/g, (m) => (m.includes('jup.ag') ? m : '<endpoint>'));
  return message.length > 280 ? `${message.slice(0, 277)}...` : message;
}
