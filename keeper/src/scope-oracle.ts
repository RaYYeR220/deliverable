/**
 * Kamino Scope price reader.
 *
 * Scope publishes 512 dated prices in one flat account with no labels, so reading a price is
 * easy and knowing which of the 512 slots belongs to which asset is the actual problem. This
 * module derives that map from chain state instead of trusting a hardcoded table:
 *
 *   OraclePrices -> (Configuration whose `oracle_prices` points back at it) -> TokenMetadatas
 *
 * `TokenMetadatas` carries a 32-byte ASCII name per index ("Checked AAPLx/USD",
 * "PythLazer SPYx/USD", ...), which is enough to resolve index -> symbol -> xStock mint. The
 * verified table is kept only as a cross-check and is reported whenever it disagrees.
 */
import { encodeBase58 } from './base58.ts';
import { flagValue, hasFlag, isMainModule, renderTable } from './format.ts';
import { loadMints } from './mints.ts';
import { getAccount, RpcClient } from './rpc.ts';

export const SCOPE_PROGRAM_ID = 'HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ';
/** The `OraclePrices` account the xStocks feeds are published into. */
export const SCOPE_ORACLE_PRICES = '3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH';

export const MAX_ENTRIES = 512;
const PRICES_HEADER = 8 + 32; // anchor discriminator + oracle_mappings pubkey
const DATED_PRICE_LEN = 56;
export const ORACLE_PRICES_LEN = PRICES_HEADER + MAX_ENTRIES * DATED_PRICE_LEN; // 28712

const MAPPINGS_LEN = 8 + MAX_ENTRIES * (32 + 1 + 2 + 1 + 2 + 20); // 29704
const METADATA_ENTRY_LEN = 32 + 8 + 8 + 15 * 8; // name + max_age_price_slots + group_ids_bitset + reserved
const METADATAS_LEN = 8 + MAX_ENTRIES * METADATA_ENTRY_LEN; // 86024
const CONFIGURATION_LEN = 10_240;
/** Offset of `Configuration.oracle_prices`: discriminator + admin + oracle_mappings. */
const CONFIG_ORACLE_PRICES_OFFSET = 8 + 32 + 32;

/**
 * Independently verified against the live account: each index returns the price quoted for
 * that xStock. Kept as a regression check on the derivation above, not as the source of truth.
 */
export const VERIFIED_SCOPE_INDEX: Readonly<Record<string, number>> = Object.freeze({
  AAPLx: 317,
  HOODx: 320,
  CRCLx: 323,
  GOOGLx: 324,
  METAx: 327,
  NVDAx: 332,
  TSLAx: 336,
  COINx: 341,
  SPYx: 342,
  QQQx: 345,
});

/**
 * Scope publishes several entries per symbol: the raw feeds, a `MostRecent` pick across them,
 * and a `Checked` entry that caps and floors the pick. The guarded one is what a consumer
 * should read, so the most-derived name wins.
 */
const NAME_PREFERENCE = ['Checked', 'MostRecent', 'PythLazer', 'Chainlink', 'Pyth'];

/** `OracleType` discriminants, from the Scope program's generated types. */
const ORACLE_TYPE_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0: 'Unused',
  5: 'SplStake',
  6: 'KToken',
  8: 'MsolStake',
  11: 'JupiterLpFetch',
  12: 'ScopeTwap1h',
  21: 'PythPull',
  22: 'PythPullEMA',
  23: 'FixedPrice',
  24: 'SwitchboardOnDemand',
  26: 'Chainlink',
  27: 'DiscountToMaturity',
  28: 'MostRecentOf',
  29: 'PythLazer',
  30: 'RedStone',
  32: 'Securitize',
  33: 'CappedFloored',
  34: 'ChainlinkRWA',
  35: 'ChainlinkNAV',
  37: 'ChainlinkX',
  38: 'ChainlinkExchangeRate',
  39: 'CappedMostRecentOf',
  40: 'ScopeTwap8h',
  41: 'ScopeTwap24h',
  43: 'MultiplicationChain',
  46: 'TotalMintSupply',
  47: 'Conditional',
  48: 'PythLazerEMA',
});

export interface DatedPrice {
  index: number;
  /** Raw mantissa, before the exponent is applied. */
  value: bigint;
  exponent: number;
  price: number;
  /** Solana slot the price was written at, not a wall-clock time. */
  slot: number;
  unixTimestamp: number;
}

export interface ScopePrice extends DatedPrice {
  symbol: string;
  /** Scope's own label for the entry, e.g. "Checked AAPLx/USD". */
  label: string | null;
  /** The xStock mint this index resolves to, when the registry knows the symbol. */
  mint: string | null;
  /** Age implied by the entry's own `unix_timestamp`, against the local clock. */
  reportedAgeSeconds: number;
  /** Age in slots against the chain tip, which is what Scope's own staleness policy is in. */
  ageSlots: number | null;
  /** False when no entry for this symbol is inside Scope's declared max age. */
  withinMaxAge: boolean;
  indexSource: 'derived' | 'verified-table';
  /** Other Scope entries for the same symbol, for auditing the choice. */
  alternates: Array<{ index: number; label: string }>;
}

/**
 * Entry layout (56 bytes): value u64 | exp u64 | last_updated_slot u64 | unix_timestamp u64 |
 * _reserved[24]. Entry i lives at `40 + i * 56`. price = value / 10^exp.
 */
export function decodeDatedPrice(data: Buffer, index: number): DatedPrice | null {
  const offset = PRICES_HEADER + index * DATED_PRICE_LEN;
  if (index < 0 || index >= MAX_ENTRIES || offset + DATED_PRICE_LEN > data.length) return null;

  const value = data.readBigUInt64LE(offset);
  const exponent = Number(data.readBigUInt64LE(offset + 8));
  return {
    index,
    value,
    exponent,
    price: Number(value) / 10 ** exponent,
    slot: Number(data.readBigUInt64LE(offset + 16)),
    unixTimestamp: Number(data.readBigUInt64LE(offset + 24)),
  };
}

export interface OraclePricesAccount {
  address: string;
  oracleMappings: string;
  data: Buffer;
}

export async function readOraclePrices(
  rpc: RpcClient,
  address: string = SCOPE_ORACLE_PRICES,
): Promise<OraclePricesAccount> {
  const account = await getAccount(rpc, address);
  if (!account) throw new Error(`Scope OraclePrices account ${address} does not exist`);
  if (account.owner !== SCOPE_PROGRAM_ID) {
    throw new Error(`${address} is owned by ${account.owner}, not the Scope program`);
  }
  if (account.data.length !== ORACLE_PRICES_LEN) {
    throw new Error(`${address} is ${account.data.length} bytes, expected ${ORACLE_PRICES_LEN}; the layout has changed`);
  }
  return { address, oracleMappings: encodeBase58(account.data.subarray(8, 40)), data: account.data };
}

export interface ScopeConfiguration {
  address: string;
  admin: string;
  oracleMappings: string;
  oraclePrices: string;
  tokensMetadata: string;
  oracleTwaps: string;
}

/**
 * Finds the Configuration that owns a given OraclePrices account. Scope runs several price
 * feeds off one program, so the link has to be looked up rather than assumed; the memcmp
 * filter makes it a single indexed query.
 */
export async function findConfigurationFor(rpc: RpcClient, oraclePrices: string): Promise<ScopeConfiguration | null> {
  const accounts = await rpc.call<Array<{ pubkey: string; account: { data: [string, string] } }>>(
    'getProgramAccounts',
    [
      SCOPE_PROGRAM_ID,
      {
        encoding: 'base64',
        commitment: 'confirmed',
        filters: [
          { dataSize: CONFIGURATION_LEN },
          { memcmp: { offset: CONFIG_ORACLE_PRICES_OFFSET, bytes: oraclePrices } },
        ],
      },
    ],
  );

  const first = accounts[0];
  if (!first) return null;

  const data = Buffer.from(first.account.data[0], 'base64');
  return {
    address: first.pubkey,
    admin: encodeBase58(data.subarray(8, 40)),
    oracleMappings: encodeBase58(data.subarray(40, 72)),
    oraclePrices: encodeBase58(data.subarray(72, 104)),
    tokensMetadata: encodeBase58(data.subarray(104, 136)),
    oracleTwaps: encodeBase58(data.subarray(136, 168)),
  };
}

export interface TokenMetadataEntry {
  index: number;
  name: string;
  maxAgePriceSlots: number;
}

/** `TokenMetadatas.metadatas_array[512]`, each `name: [u8; 32]` then three u64-shaped fields. */
export function decodeTokenMetadatas(data: Buffer): TokenMetadataEntry[] {
  if (data.length !== METADATAS_LEN) {
    throw new Error(`TokenMetadatas is ${data.length} bytes, expected ${METADATAS_LEN}; the layout has changed`);
  }

  const out: TokenMetadataEntry[] = [];
  for (let index = 0; index < MAX_ENTRIES; index++) {
    const offset = 8 + index * METADATA_ENTRY_LEN;
    const name = data
      .subarray(offset, offset + 32)
      .toString('utf8')
      .replace(/\0.*$/s, '')
      .trim();
    if (!name) continue;
    out.push({ index, name, maxAgePriceSlots: Number(data.readBigUInt64LE(offset + 32)) });
  }
  return out;
}

export async function readTokenMetadatas(rpc: RpcClient, address: string): Promise<TokenMetadataEntry[]> {
  const account = await getAccount(rpc, address);
  if (!account) throw new Error(`TokenMetadatas account ${address} does not exist`);
  return decodeTokenMetadatas(account.data);
}

export interface IndexCandidate {
  symbol: string;
  index: number;
  label: string;
  mint: string;
  /** Scope's own staleness policy for this entry, in slots. */
  maxAgePriceSlots: number;
  preference: number;
}

/**
 * Groups Scope's labels by symbol. Names look like "<source> <SYMBOL>/USD"; only entries whose
 * symbol matches a known xStock mint are kept, so unrelated Scope feeds and lookalike names
 * cannot leak into the map.
 */
export function deriveCandidates(
  metadatas: TokenMetadataEntry[],
  mintBySymbol: Map<string, string>,
): Map<string, IndexCandidate[]> {
  const bySymbol = new Map<string, IndexCandidate[]>();

  for (const entry of metadatas) {
    const match = /(?:^|\s)([A-Za-z0-9.]+x)\s*\/\s*USD(?:\s|$)/.exec(entry.name);
    const symbol = match?.[1];
    if (!symbol) continue;

    const mint = mintBySymbol.get(symbol.toLowerCase());
    if (!mint) continue;

    const rank = NAME_PREFERENCE.findIndex((prefix) => entry.name.startsWith(prefix));
    const list = bySymbol.get(symbol) ?? [];
    list.push({
      symbol,
      index: entry.index,
      label: entry.name,
      mint,
      maxAgePriceSlots: entry.maxAgePriceSlots,
      preference: rank < 0 ? NAME_PREFERENCE.length : rank,
    });
    bySymbol.set(symbol, list);
  }

  for (const list of bySymbol.values()) list.sort((a, b) => a.preference - b.preference || a.index - b.index);
  return bySymbol;
}

/**
 * Slots of slack allowed before the preferred entry is abandoned. Scope's own
 * `max_age_price_slots` is around 160 (~a minute) and the guarded entries refresh a beat behind
 * the raw ones, so selecting strictly on that policy makes the index flip between two valid
 * entries run to run. An unstable index map is worse than a price a minute old, so selection
 * uses a wide margin and staleness against the declared policy is reported separately.
 */
const SELECTION_SLACK_FACTOR = 20;

/**
 * The newest slot anywhere in the snapshot, used as "now". Taking the chain tip instead would
 * charge every entry for however long the account read took.
 */
export function snapshotReferenceSlot(prices: Buffer): number {
  let newest = 0;
  for (let index = 0; index < MAX_ENTRIES; index++) {
    const entry = decodeDatedPrice(prices, index);
    if (entry && entry.slot > newest) newest = entry.slot;
  }
  return newest;
}

/**
 * Picks one entry per symbol. Scope publishes several: the raw feeds, a `MostRecent` pick
 * across them, and a `Checked` entry that caps and floors that pick. The guarded entry is what
 * a consumer should read — but they are not all refreshed on the same schedule, and a guarded
 * price two days old is worse than a fresh unguarded one. So: highest-preference entry that is
 * still being maintained, otherwise whichever candidate was updated most recently.
 */
export function selectIndex(
  candidates: IndexCandidate[],
  prices: Buffer,
  referenceSlot: number,
): { chosen: IndexCandidate; fresh: boolean; alternates: IndexCandidate[] } | null {
  if (candidates.length === 0) return null;

  const ageOf = (candidate: IndexCandidate): number => {
    const entry = decodeDatedPrice(prices, candidate.index);
    return entry && entry.slot > 0 ? referenceSlot - entry.slot : Number.POSITIVE_INFINITY;
  };

  const maintained = candidates.find((candidate) => ageOf(candidate) <= candidate.maxAgePriceSlots * SELECTION_SLACK_FACTOR);
  const chosen = maintained ?? [...candidates].sort((a, b) => ageOf(a) - ageOf(b))[0]!;
  return {
    chosen,
    fresh: ageOf(chosen) <= chosen.maxAgePriceSlots,
    alternates: candidates.filter((candidate) => candidate !== chosen),
  };
}

export interface ScopeReaderOptions {
  oraclePricesAddress?: string;
  /** Skip the Configuration/TokenMetadatas hop and use the verified table. */
  useVerifiedTable?: boolean;
  symbols?: string[];
}

export interface ScopeSnapshot {
  account: OraclePricesAccount;
  configuration: ScopeConfiguration | null;
  prices: ScopePrice[];
  /** Symbols where the derived index disagrees with the verified table. */
  disagreements: Array<{ symbol: string; derived: number; verified: number }>;
}

/** Typed reader: resolves the index map, then pulls every price out of one account snapshot. */
export async function readScopePrices(rpc: RpcClient, options: ScopeReaderOptions = {}): Promise<ScopeSnapshot> {
  const account = await readOraclePrices(rpc, options.oraclePricesAddress ?? SCOPE_ORACLE_PRICES);
  const registry = loadMints();
  const mintBySymbol = new Map(registry.mints.map((entry) => [entry.symbol.toLowerCase(), entry.mint]));

  let configuration: ScopeConfiguration | null = null;
  const resolved = new Map<
    string,
    {
      index: number;
      label: string | null;
      source: 'derived' | 'verified-table';
      withinMaxAge: boolean;
      alternates: Array<{ index: number; label: string }>;
    }
  >();

  const referenceSlot = snapshotReferenceSlot(account.data);

  if (!options.useVerifiedTable) {
    configuration = await findConfigurationFor(rpc, account.address);
    if (configuration) {
      const candidates = deriveCandidates(await readTokenMetadatas(rpc, configuration.tokensMetadata), mintBySymbol);
      for (const [symbol, list] of candidates) {
        const pick = selectIndex(list, account.data, referenceSlot);
        if (!pick) continue;
        resolved.set(symbol, {
          index: pick.chosen.index,
          label: pick.chosen.label,
          source: 'derived',
          withinMaxAge: pick.fresh,
          alternates: pick.alternates.map((entry) => ({ index: entry.index, label: entry.label })),
        });
      }
    }
  }

  const disagreements: Array<{ symbol: string; derived: number; verified: number }> = [];
  for (const [symbol, info] of resolved) {
    const verified = VERIFIED_SCOPE_INDEX[symbol];
    if (verified !== undefined && verified !== info.index) {
      disagreements.push({ symbol, derived: info.index, verified });
    }
  }
  for (const [symbol, index] of Object.entries(VERIFIED_SCOPE_INDEX)) {
    if (!resolved.has(symbol)) {
      resolved.set(symbol, { index, label: null, source: 'verified-table', withinMaxAge: true, alternates: [] });
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const wanted = options.symbols?.map((symbol) => symbol.toLowerCase());

  const prices: ScopePrice[] = [];
  for (const [symbol, info] of resolved) {
    if (wanted && !wanted.includes(symbol.toLowerCase())) continue;
    const entry = decodeDatedPrice(account.data, info.index);
    if (!entry) continue;
    prices.push({
      ...entry,
      symbol,
      label: info.label,
      mint: mintBySymbol.get(symbol.toLowerCase()) ?? null,
      reportedAgeSeconds: now - entry.unixTimestamp,
      ageSlots: referenceSlot - entry.slot,
      withinMaxAge: info.withinMaxAge,
      indexSource: info.source,
      alternates: info.alternates,
    });
  }
  prices.sort((a, b) => a.symbol.localeCompare(b.symbol));

  return { account, configuration, prices, disagreements };
}

export interface OracleMappingEntry {
  index: number;
  priceInfoAccount: string;
  priceType: number;
  priceTypeName: string;
  twapSourceOrRefPriceToleranceBps: number;
  twapEnabled: boolean;
  refPriceIndex: number;
  genericData: string;
  /** Decoded `generic` bytes for the price types that carry structured configuration. */
  detail: string | null;
}

/**
 * `OracleMappings` is a struct of parallel arrays, not an array of structs:
 *   price_info_accounts:                 [Pubkey; 512]  (16384 bytes)
 *   price_types:                         [u8; 512]
 *   twap_source_or_ref_price_tolerance:  [u16; 512]
 *   twap_enabled_bitmask:                [u8; 512]
 *   ref_price:                           [u16; 512]
 *   generic:                             [[u8; 20]; 512]
 * 8 + 16384 + 512 + 1024 + 512 + 1024 + 10240 = 29704, the exact on-chain size.
 */
export function decodeOracleMappings(data: Buffer, indexes: number[]): OracleMappingEntry[] {
  if (data.length !== MAPPINGS_LEN) {
    throw new Error(`OracleMappings is ${data.length} bytes, expected ${MAPPINGS_LEN}; the layout has changed`);
  }

  const PUBKEYS = 8;
  const TYPES = PUBKEYS + MAX_ENTRIES * 32;
  const TWAP_SOURCE = TYPES + MAX_ENTRIES;
  const TWAP_ENABLED = TWAP_SOURCE + MAX_ENTRIES * 2;
  const REF_PRICE = TWAP_ENABLED + MAX_ENTRIES;
  const GENERIC = REF_PRICE + MAX_ENTRIES * 2;

  return indexes
    .filter((index) => index >= 0 && index < MAX_ENTRIES)
    .map((index) => {
      const generic = data.subarray(GENERIC + index * 20, GENERIC + index * 20 + 20);
      const priceType = data[TYPES + index]!;
      return {
        index,
        priceInfoAccount: encodeBase58(data.subarray(PUBKEYS + index * 32, PUBKEYS + index * 32 + 32)),
        priceType,
        priceTypeName: ORACLE_TYPE_NAMES[priceType] ?? `unknown(${priceType})`,
        twapSourceOrRefPriceToleranceBps: data.readUInt16LE(TWAP_SOURCE + index * 2),
        twapEnabled: data[TWAP_ENABLED + index] !== 0,
        refPriceIndex: data.readUInt16LE(REF_PRICE + index * 2),
        genericData: generic.toString('hex'),
        detail: describeGeneric(priceType, generic),
      };
    });
}

function describeGeneric(priceType: number, generic: Buffer): string | null {
  // PythLazer: feed_id u16 | exponent u8 | bid_ask_spread_factor u32 | ema_enabled bool | ...
  if (priceType === 29 || priceType === 48) {
    return `lazerFeedId=${generic.readUInt16LE(0)} exponent=${generic[2]} spreadFactor=${generic.readUInt32LE(3)}`;
  }
  // CappedFloored: source_entry u16 | Option<u16> cap | Option<u16> floor, borsh-tagged.
  if (priceType === 33) {
    const source = generic.readUInt16LE(0);
    let offset = 2;
    const readOption = (): number | null => {
      const tag = generic[offset];
      offset += 1;
      if (tag !== 1) return null;
      const value = generic.readUInt16LE(offset);
      offset += 2;
      return value;
    };
    const cap = readOption();
    const floor = readOption();
    return `source=${source} cap=${cap ?? 'none'} floor=${floor ?? 'none'}`;
  }
  return null;
}

export async function readOracleMappings(
  rpc: RpcClient,
  address: string,
  indexes: number[],
): Promise<OracleMappingEntry[]> {
  const account = await getAccount(rpc, address);
  if (!account) throw new Error(`OracleMappings account ${address} does not exist`);
  return decodeOracleMappings(account.data, indexes);
}

async function main(): Promise<void> {
  const rpc = new RpcClient(undefined, {
    onRetry: ({ attempt, delayMs, reason }) => process.stderr.write(`  rpc retry ${attempt} in ${delayMs}ms (${reason})\n`),
  });

  const symbolFilter = flagValue('symbol');
  const snapshot = await readScopePrices(rpc, {
    ...(symbolFilter ? { symbols: [symbolFilter] } : {}),
    ...(hasFlag('no-derive') ? { useVerifiedTable: true } : {}),
  });
  if (snapshot.prices.length === 0) throw new Error(`no Scope index resolved${symbolFilter ? ` for ${symbolFilter}` : ''}`);

  const payload = {
    generatedAt: new Date().toISOString(),
    rpcHost: rpc.host,
    oraclePrices: snapshot.account.address,
    oracleMappings: snapshot.account.oracleMappings,
    configuration: snapshot.configuration,
    indexMapDerived: snapshot.configuration !== null,
    disagreements: snapshot.disagreements,
    prices: snapshot.prices.map(({ value, ...rest }) => ({ ...rest, value: value.toString() })),
  };

  if (hasFlag('json')) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`Kamino Scope prices @ ${payload.generatedAt}\n`);
    process.stdout.write(`oracle_prices    ${snapshot.account.address}\n`);
    process.stdout.write(`oracle_mappings  ${snapshot.account.oracleMappings}\n`);
    if (snapshot.configuration) {
      process.stdout.write(`configuration    ${snapshot.configuration.address}\n`);
      process.stdout.write(`tokens_metadata  ${snapshot.configuration.tokensMetadata}  (index map derived from this)\n`);
    } else {
      process.stdout.write('configuration    not resolved; falling back to the verified index table\n');
    }
    process.stdout.write('\n');
    process.stdout.write(
      renderTable(snapshot.prices, [
        { header: 'SYMBOL', get: (row) => row.symbol },
        { header: 'IDX', get: (row) => String(row.index), align: 'right' },
        { header: 'PRICE', get: (row) => row.price.toFixed(Math.min(8, Math.max(2, row.exponent))), align: 'right' },
        { header: 'EXP', get: (row) => String(row.exponent), align: 'right' },
        { header: 'SLOT', get: (row) => String(row.slot), align: 'right' },
        { header: 'PUBLISHED (UTC)', get: (row) => new Date(row.unixTimestamp * 1000).toISOString().replace('.000Z', 'Z') },
        { header: 'AGE', get: (row) => `${row.reportedAgeSeconds}s`, align: 'right' },
        { header: 'STALE', get: (row) => (row.withinMaxAge ? '' : 'yes') },
        { header: 'SCOPE LABEL', get: (row) => row.label ?? '(verified table)' },
        { header: 'MINT', get: (row) => row.mint ?? '-' },
      ]),
    );
    process.stdout.write('\n');

    if (snapshot.disagreements.length > 0) {
      process.stdout.write('\nindex map: derived choice differs from the verified table for some symbols.\n');
      process.stdout.write('both indexes are real Scope entries for the same asset; the derived one is preferred.\n');
      for (const row of snapshot.disagreements) {
        const price = snapshot.prices.find((entry) => entry.symbol === row.symbol);
        const other = decodeDatedPrice(snapshot.account.data, row.verified);
        process.stdout.write(
          `  ${row.symbol.padEnd(7)} derived ${row.derived} "${price?.label ?? '?'}"` +
            ` vs table ${row.verified}${other ? ` (${(Number(other.value) / 10 ** other.exponent).toFixed(4)}, slot ${other.slot})` : ''}\n`,
        );
      }
    } else if (snapshot.configuration) {
      process.stdout.write('index map derived from TokenMetadatas; matches the verified table exactly.\n');
    }

    const stale = snapshot.prices.filter((row) => !row.withinMaxAge);
    if (stale.length > 0) {
      process.stdout.write(
        `\n${stale.length} symbol(s) have no Scope entry inside the declared max age; the freshest entry was used.\n`,
      );
    }
  }

  if (hasFlag('mappings')) {
    const entries = await readOracleMappings(
      rpc,
      snapshot.account.oracleMappings,
      snapshot.prices.map((row) => row.index),
    );
    process.stdout.write('\nOracleMappings decode\n\n');
    process.stdout.write(
      renderTable(entries, [
        { header: 'SYMBOL', get: (row) => snapshot.prices.find((p) => p.index === row.index)?.symbol ?? '?' },
        { header: 'IDX', get: (row) => String(row.index), align: 'right' },
        { header: 'PRICE TYPE', get: (row) => `${row.priceTypeName} (${row.priceType})` },
        { header: 'PRICE_INFO_ACCOUNT', get: (row) => row.priceInfoAccount },
        { header: 'DETAIL', get: (row) => row.detail ?? row.genericData },
      ]),
    );
    process.stdout.write(
      '\nxStock entries are composed price types: CappedFloored wraps another Scope entry with a\n' +
        'cap and a floor, PythLazer carries a Pyth Lazer feed id rather than an account. Neither\n' +
        'stores a mint, which is why the index map is derived from TokenMetadatas instead.\n',
    );
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
