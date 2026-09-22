import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

/** Helius rejects JSON-RPC batches larger than this with a bare 429, so the
 *  batch size is a hard protocol limit rather than a tuning knob. */
const MAX_BATCH = 10;
const MAX_ATTEMPTS = 10;

/**
 * The endpoint rate-limits on sub-requests per second, not on HTTP requests: a batch of ten
 * getTransaction calls costs ten. Measured ceiling on this plan is ~10/s, so the client meters
 * itself rather than discovering the limit by getting 429ed. Override with SOLANA_RPC_RATE.
 */
const DEFAULT_RATE_PER_SECOND = 9;
/** Floor the adaptive rate so a burst of 429s cannot stall the scan entirely. */
const MIN_RATE = 3;
/** Ignore further 429s for this long after cutting the rate; see TokenBucket.penalise. */
const PENALTY_COOLDOWN_MS = 2_000;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export interface RpcOptions {
  /** Concurrent in-flight batches. The token bucket is the real throttle; this just keeps the pipe full. */
  concurrency?: number;
  /** Sub-requests per second. */
  ratePerSecond?: number;
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
}

/**
 * Cost-aware token bucket. Signature paging costs one unit and stays fast; transaction
 * batches cost ten and get spaced out. The rate backs off on a 429 and recovers afterwards,
 * so a plan change in either direction is absorbed without a code change.
 */
class TokenBucket {
  #capacity: number;
  #tokens: number;
  #rate: number;
  #configuredRate: number;
  #last = Date.now();
  #lastPenalty = 0;
  #queue: Promise<void> = Promise.resolve();

  constructor(ratePerSecond: number) {
    this.#configuredRate = ratePerSecond;
    this.#rate = ratePerSecond;
    this.#capacity = Math.max(ratePerSecond, MAX_BATCH);
    this.#tokens = this.#capacity;
  }

  get rate(): number {
    return this.#rate;
  }

  /** Serialised so concurrent callers cannot each observe the same tokens. */
  acquire(cost: number): Promise<void> {
    const wait = this.#queue.then(() => this.#take(cost));
    this.#queue = wait.catch(() => undefined);
    return wait;
  }

  async #take(cost: number): Promise<void> {
    const want = Math.min(cost, this.#capacity);
    for (;;) {
      const now = Date.now();
      this.#tokens = Math.min(this.#capacity, this.#tokens + ((now - this.#last) / 1000) * this.#rate);
      this.#last = now;
      if (this.#tokens >= want) {
        this.#tokens -= want;
        return;
      }
      await sleep(Math.ceil(((want - this.#tokens) / this.#rate) * 1000) + 5);
    }
  }

  /**
   * With several batches in flight, one rate-limit event comes back as several 429s. Cutting the
   * rate once per 429 compounds them and collapses throughput for minutes, so penalties are
   * rate-limited themselves: responses that were already on the wire when the first one landed
   * are not charged again.
   */
  penalise(): void {
    const now = Date.now();
    if (now - this.#lastPenalty < PENALTY_COOLDOWN_MS) return;
    this.#lastPenalty = now;
    this.#rate = Math.max(MIN_RATE, this.#rate * 0.7);
    this.#tokens = 0;
  }

  reward(): void {
    if (this.#rate < this.#configuredRate) this.#rate = Math.min(this.#configuredRate, this.#rate * 1.08 + 0.1);
  }
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

function loadDotEnv(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Process env wins; the repo `.env` is the fallback so the keeper works from a bare checkout. */
export function resolveRpcUrl(): string {
  const fromProcess = process.env['SOLANA_RPC_URL'];
  if (fromProcess) return fromProcess;

  for (const candidate of [join(REPO_ROOT, '.env'), join(HERE, '..', '.env')]) {
    const url = loadDotEnv(candidate)['SOLANA_RPC_URL'];
    if (url) return url;
  }

  throw new Error(
    'SOLANA_RPC_URL is not set. Export it, or put it in the repo root .env. ' +
      'A public endpoint will not work: this tool needs getSignaturesForAddress paging and large getTransaction volume.',
  );
}

/** The endpoint carries an API key in the path/query, so only the host is ever printable. */
export function rpcHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '<unparseable endpoint>';
  }
}

export class RpcClient {
  readonly url: string;
  readonly host: string;

  #nextId = 0;
  #concurrency: number;
  #onRetry: RpcOptions['onRetry'];
  #callCount = 0;
  #bucket: TokenBucket;

  constructor(url: string = resolveRpcUrl(), options: RpcOptions = {}) {
    this.url = url;
    this.host = rpcHost(url);
    this.#concurrency = Math.max(1, options.concurrency ?? 3);
    this.#onRetry = options.onRetry;

    const fromEnv = Number(process.env['SOLANA_RPC_RATE']);
    this.#bucket = new TokenBucket(
      options.ratePerSecond ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_RATE_PER_SECOND),
    );
  }

  get callCount(): number {
    return this.#callCount;
  }

  /** Current sub-requests-per-second budget, after any 429 backpressure. */
  get rate(): number {
    return this.#bucket.rate;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    const [only] = await this.#sendBatch([{ method, params }]);
    return only as T;
  }

  /** Fans a list of calls out over batched, rate-limited requests, preserving order. */
  async batch<T>(calls: Array<{ method: string; params: unknown[] }>): Promise<Array<T | null>> {
    const chunks: Array<{ start: number; calls: typeof calls }> = [];
    for (let i = 0; i < calls.length; i += MAX_BATCH) {
      chunks.push({ start: i, calls: calls.slice(i, i + MAX_BATCH) });
    }

    const results = new Array<T | null>(calls.length).fill(null);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(this.#concurrency, chunks.length) }, async () => {
      while (true) {
        const index = cursor++;
        const chunk = chunks[index];
        if (!chunk) return;
        const part = await this.#sendBatch(chunk.calls);
        for (let i = 0; i < part.length; i++) results[chunk.start + i] = part[i] as T | null;
      }
    });

    await Promise.all(workers);
    return results;
  }

  async #sendBatch(calls: Array<{ method: string; params: unknown[] }>): Promise<unknown[]> {
    const ids = calls.map(() => this.#nextId++);
    const body = JSON.stringify(
      calls.map((call, i) => ({ jsonrpc: '2.0', id: ids[i], method: call.method, params: call.params })),
    );

    for (let attempt = 0; ; attempt++) {
      await this.#bucket.acquire(calls.length);

      let response: Response;
      try {
        this.#callCount += calls.length;
        response = await fetch(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
      } catch (cause) {
        if (attempt >= MAX_ATTEMPTS) throw new Error(`RPC transport failure after ${attempt} retries`, { cause });
        await this.#backoff(attempt, 'network', null);
        continue;
      }

      if (response.status === 429 || response.status >= 500) {
        if (response.status === 429) this.#bucket.penalise();
        if (attempt >= MAX_ATTEMPTS) {
          throw new Error(`RPC gave up after ${attempt} retries (last status ${response.status})`);
        }
        await this.#backoff(attempt, `http ${response.status}`, response.headers.get('retry-after'));
        continue;
      }

      this.#bucket.reward();

      if (!response.ok) {
        throw new Error(`RPC returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      }

      const payload = (await response.json()) as JsonRpcResponse | JsonRpcResponse[];
      const entries = Array.isArray(payload) ? payload : [payload];

      // A single node-level error (e.g. "rate limit exceeded") can come back as one object
      // for the whole batch rather than per-call. Retry those instead of mis-aligning results.
      if (!Array.isArray(payload) && calls.length > 1) {
        const message = payload.error?.message ?? 'malformed batch response';
        if (attempt >= MAX_ATTEMPTS) throw new Error(`RPC batch error: ${message}`);
        await this.#backoff(attempt, message, null);
        continue;
      }

      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      const out: unknown[] = [];
      let retryable = false;
      for (const id of ids) {
        const entry = byId.get(id);
        if (!entry) {
          retryable = true;
          break;
        }
        if (entry.error) {
          // -32004 / -32014: block not yet available on this node. Everything else is a real bug.
          if (entry.error.code === -32004 || entry.error.code === -32014 || entry.error.code === -32005) {
            retryable = true;
            break;
          }
          throw new Error(`RPC error ${entry.error.code}: ${entry.error.message}`);
        }
        out.push(entry.result ?? null);
      }

      if (retryable) {
        if (attempt >= MAX_ATTEMPTS) throw new Error('RPC gave up: node kept returning incomplete results');
        await this.#backoff(attempt, 'incomplete batch', null);
        continue;
      }

      return out;
    }
  }

  async #backoff(attempt: number, reason: string, retryAfter: string | null): Promise<void> {
    const header = retryAfter ? Number(retryAfter) * 1000 : NaN;
    const base = Number.isFinite(header) ? header : Math.min(250 * 2 ** attempt, 8_000);
    const delayMs = Math.round(base * (0.75 + Math.random() * 0.5));
    this.#onRetry?.({ attempt: attempt + 1, delayMs, reason });
    await sleep(delayMs);
  }
}

export interface AccountInfo {
  data: [string, string];
  owner: string;
  lamports: number;
  executable: boolean;
  rentEpoch: number;
  space?: number;
}

export async function getAccount(rpc: RpcClient, address: string): Promise<{ data: Buffer; owner: string } | null> {
  const result = await rpc.call<{ value: AccountInfo | null }>('getAccountInfo', [
    address,
    { encoding: 'base64', commitment: 'confirmed' },
  ]);
  if (!result.value) return null;
  return { data: Buffer.from(result.value.data[0], 'base64'), owner: result.value.owner };
}

export async function getAccounts(
  rpc: RpcClient,
  addresses: string[],
): Promise<Array<{ address: string; data: Buffer; owner: string } | null>> {
  const groups: string[][] = [];
  for (let i = 0; i < addresses.length; i += 100) groups.push(addresses.slice(i, i + 100));

  const responses = await rpc.batch<{ value: Array<AccountInfo | null> }>(
    groups.map((group) => ({
      method: 'getMultipleAccounts',
      params: [group, { encoding: 'base64', commitment: 'confirmed' }],
    })),
  );

  const out: Array<{ address: string; data: Buffer; owner: string } | null> = [];
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g]!;
    const values = responses[g]?.value ?? [];
    for (let i = 0; i < group.length; i++) {
      const info = values[i];
      out.push(
        info ? { address: group[i]!, data: Buffer.from(info.data[0], 'base64'), owner: info.owner } : null,
      );
    }
  }
  return out;
}

export interface SignatureRecord {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
  confirmationStatus?: string;
}

export interface SignaturePageOptions {
  limit?: number;
  before?: string;
  until?: string;
}

export async function getSignatures(
  rpc: RpcClient,
  address: string,
  options: SignaturePageOptions = {},
): Promise<SignatureRecord[]> {
  const params: Record<string, unknown> = { limit: options.limit ?? 1000, commitment: 'confirmed' };
  if (options.before) params['before'] = options.before;
  if (options.until) params['until'] = options.until;
  return rpc.call<SignatureRecord[]>('getSignaturesForAddress', [address, params]);
}
