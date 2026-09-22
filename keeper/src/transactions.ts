import { getSignatures, RpcClient, type SignatureRecord } from './rpc.ts';
import type { RawInstruction } from './token2022.ts';

interface CompiledInstruction {
  programIdIndex: number;
  accounts: number[];
  data: string;
}

interface TransactionResponse {
  slot: number;
  blockTime: number | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: string[];
      instructions: CompiledInstruction[];
    };
  };
  meta: {
    err: unknown;
    innerInstructions?: Array<{ index: number; instructions: CompiledInstruction[] }>;
    loadedAddresses?: { writable: string[]; readonly: string[] };
  } | null;
}

export interface FlatTransaction {
  signature: string;
  slot: number;
  blockTime: number | null;
  failed: boolean;
  /** Top-level instructions followed by every CPI, all with account indexes resolved. */
  instructions: RawInstruction[];
}

/**
 * Versioned transactions keep lookup-table addresses out of `message.accountKeys`; the
 * resolved ones come back under `meta.loadedAddresses` in writable-then-readonly order.
 */
function resolveKeys(tx: TransactionResponse): string[] {
  const loaded = tx.meta?.loadedAddresses;
  if (!loaded) return tx.transaction.message.accountKeys;
  return [...tx.transaction.message.accountKeys, ...loaded.writable, ...loaded.readonly];
}

function flatten(signature: string, tx: TransactionResponse): FlatTransaction {
  const keys = resolveKeys(tx);
  const lift = (ix: CompiledInstruction): RawInstruction => ({
    programId: keys[ix.programIdIndex] ?? '',
    accounts: ix.accounts.map((index) => keys[index] ?? ''),
    data: ix.data,
  });

  const instructions = tx.transaction.message.instructions.map(lift);
  for (const inner of tx.meta?.innerInstructions ?? []) {
    for (const ix of inner.instructions) instructions.push(lift(ix));
  }

  return {
    signature,
    slot: tx.slot,
    blockTime: tx.blockTime,
    failed: Boolean(tx.meta?.err),
    instructions,
  };
}

export async function fetchTransactions(
  rpc: RpcClient,
  signatures: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<FlatTransaction[]> {
  const out: FlatTransaction[] = [];
  const PAGE = 240;

  for (let i = 0; i < signatures.length; i += PAGE) {
    const slice = signatures.slice(i, i + PAGE);
    const responses = await rpc.batch<TransactionResponse | null>(
      slice.map((signature) => ({
        method: 'getTransaction',
        params: [signature, { maxSupportedTransactionVersion: 0, encoding: 'json', commitment: 'confirmed' }],
      })),
    );
    for (let k = 0; k < slice.length; k++) {
      const tx = responses[k];
      if (tx) out.push(flatten(slice[k]!, tx));
    }
    onProgress?.(Math.min(i + PAGE, signatures.length), signatures.length);
  }

  return out;
}

/**
 * `getSignaturesForAddress` can only be seeked with a signature, never a slot or a time. The
 * node resolves that signature to a slot and searches backwards from there, and it does NOT
 * have to belong to the address being queried — which turns "give me this address's activity
 * around a date in July" from a hundred-page walk into three calls.
 *
 * Returns null if the endpoint will not serve blocks that far back; callers fall back to paging.
 */
export async function seekSignatureAt(rpc: RpcClient, unixSeconds: number): Promise<string | null> {
  const AVERAGE_SLOT_SECONDS = 0.4;

  let slot: number;
  let slotTime: number;
  try {
    slot = await rpc.call<number>('getSlot', [{ commitment: 'confirmed' }]);
    slotTime = await rpc.call<number>('getBlockTime', [slot]);
  } catch {
    return null;
  }
  if (unixSeconds >= slotTime) return null;

  let guess = slot - Math.round((slotTime - unixSeconds) / AVERAGE_SLOT_SECONDS);
  for (let step = 0; step < 24; step++) {
    let blockTime: number | null = null;
    // Skipped slots have no block and no time; walk forward until a real one turns up.
    for (let probe = 0; probe < 40 && blockTime === null; probe++) {
      try {
        blockTime = await rpc.call<number | null>('getBlockTime', [guess + probe]);
        if (blockTime !== null) guess += probe;
      } catch {
        blockTime = null;
      }
    }
    if (blockTime === null) return null;

    const drift = blockTime - unixSeconds;
    if (Math.abs(drift) <= 180) break;
    guess -= Math.round(drift / AVERAGE_SLOT_SECONDS);
    if (guess < 0) return null;
  }

  for (let probe = 0; probe < 40; probe++) {
    try {
      const block = await rpc.call<{ signatures?: string[] } | null>('getBlock', [
        guess + probe,
        { transactionDetails: 'signatures', rewards: false, maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
      ]);
      const signature = block?.signatures?.[0];
      if (signature) return signature;
    } catch {
      // Skipped slot or a node that will not serve this range; try the next one.
    }
  }
  return null;
}

export interface SignatureScanOptions {
  /** Stop paging once the stream goes older than this unix timestamp. */
  stopAtUnixSeconds: number;
  /** Begin paging backwards from this signature rather than from the tip. */
  startBefore?: string;
  /** Optional predicate; only matching signatures are kept, but paging continues regardless. */
  keep?: (record: SignatureRecord) => boolean;
  /** Safety valve so a misconfigured window cannot page forever. */
  maxPages?: number;
  onPage?: (info: { pages: number; scanned: number; kept: number; oldestBlockTime: number | null }) => void;
}

/**
 * Pages `getSignaturesForAddress` backwards in time. Signature paging is cheap relative to
 * `getTransaction`, so the strategy is: page wide, fetch narrow.
 */
export async function scanSignaturesBackwards(
  rpc: RpcClient,
  address: string,
  options: SignatureScanOptions,
): Promise<{ kept: SignatureRecord[]; scanned: number; pages: number; oldestBlockTime: number | null }> {
  const kept: SignatureRecord[] = [];
  const maxPages = options.maxPages ?? 600;

  let before: string | undefined = options.startBefore;
  let scanned = 0;
  let pages = 0;
  let oldestBlockTime: number | null = null;

  while (pages < maxPages) {
    const page: SignatureRecord[] = await getSignatures(
      rpc,
      address,
      before === undefined ? { limit: 1000 } : { limit: 1000, before },
    );
    if (page.length === 0) break;

    pages++;
    scanned += page.length;
    for (const record of page) {
      if (record.err) continue;
      if (!options.keep || options.keep(record)) kept.push(record);
    }

    const last = page[page.length - 1]!;
    oldestBlockTime = last.blockTime ?? oldestBlockTime;
    before = last.signature;
    options.onPage?.({ pages, scanned, kept: kept.length, oldestBlockTime });

    if (last.blockTime !== null && last.blockTime < options.stopAtUnixSeconds) break;
    if (page.length < 1000) break;
  }

  return { kept, scanned, pages, oldestBlockTime };
}
