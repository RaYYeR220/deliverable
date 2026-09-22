/**
 * Network reads. Everything here fetches accounts and hands them to the pure modules
 * (gate, strike, balance), so each answer can be reproduced offline from the same bytes.
 */
import {
  address as toAddress,
  createSolanaRpc,
  fetchEncodedAccounts,
  getBase58Decoder,
  getBase64Encoder,
  type Address,
  type Base58EncodedBytes,
  type MaybeEncodedAccount,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
} from '@solana/kit';
import { getSysvarClockDecoder, SYSVAR_CLOCK_ADDRESS } from '@solana/sysvars';
import { getTokenDecoder } from '@solana-program/token-2022';

import {
  adjustBalance,
  adjustTransactionTokenBalance,
  type AdjustedBalance,
  type CorporateActionRecord,
  type TransactionTokenBalance,
} from './balance.js';
import { nextOpen, resolveSession, US_EQUITY_CALENDAR, type CalendarLike, type Session } from './calendar.js';
import { resolveProgramAddress, resolveRpcUrl } from './config.js';
import { checkActionable, DEFAULT_MAX_CONF_BPS, DEFAULT_MAX_DIVERGENCE_BPS, DEFAULT_MAX_PRICE_AGE_SECS, type GateVerdict } from './gate.js';
import {
  findCalendarPda,
  findPositionPda,
  findRegistryPda,
  findSecurityPda,
  getMarketCalendarDecoder,
  getOptionSeriesDecoder,
  getOptionSeriesDiscriminatorBytes,
  getOptionSeriesSize,
  getRegistryDecoder,
  getSecurityStateDecoder,
  getWriterPositionDecoder,
  getWriterPositionDiscriminatorBytes,
  getWriterPositionSize,
  type MarketCalendar,
  type OptionSeries,
  type OracleBinding,
  type OracleSource,
  type Registry,
  type SecurityState,
  type WriterPosition,
} from './generated/index.js';
import { decodeMintState, mintMultiplierAt, type MintState } from './mint.js';
import {
  decodeScopeLabels,
  observe,
  OracleReadError,
  scopePairFor,
  SCOPE_PRICES_ADDRESS,
  SCOPE_TOKEN_METADATAS_ADDRESS,
  type Observation,
  type ScopeLabel,
} from './oracle.js';
import { findSeriesPda, type SeriesSeeds } from './pda.js';
import { REFUSALS, RefusalCode } from './refusal.js';
import { currentStrike, seriesPhase, type CurrentStrike, type SeriesPhase } from './strike.js';

export interface DeliverableConfig {
  /** An existing Kit RPC. Takes precedence over `rpcUrl`. */
  rpc?: Rpc<SolanaRpcApi>;
  /** Defaults to SOLANA_RPC_URL from the environment, then the repository .env. */
  rpcUrl?: string;
  /** Defaults to DELIVERABLE_PROGRAM_ID, then the id in the IDL. */
  programAddress?: Address;
  /**
   * Multiplier-change history (keeper/data/corporate-actions.json), used to pick the
   * multiplier for a past instant that predates the mint's latest change.
   */
  history?: readonly CorporateActionRecord[];
}

export interface SecurityStateView extends SecurityState {
  address: Address;
  symbolText: string;
}

export interface SeriesView extends OptionSeries {
  address: Address;
}

export interface WriterPositionView extends WriterPosition {
  address: Address;
}

export interface SeriesDetail {
  series: SeriesView;
  strike: CurrentStrike;
  phase: SeriesPhase | null;
  /** Null when the series' calendar account could not be read. */
  calendarId: number | null;
}

/**
 * `registered`: the security account exists and every gate input came from chain.
 * `preview`: it does not (the program is not deployed or the mint is not registered),
 * and the gate ran on the committed calendar, default tolerances and the conventional
 * Scope binding. The `notes` say exactly what was assumed.
 */
export type ActionableBasis = 'registered' | 'preview';

export type ActionableResult = GateVerdict & {
  basis: ActionableBasis;
  mint: Address;
  security: Address;
  evaluatedAt: bigint;
  session: Session;
  /** Unix seconds of the next regular-session open, when the market is shut. */
  nextOpen: number | null;
  /** The registry kill switch. Not a gate code: write and exercise fail with RegistryPaused. */
  registryPaused: boolean | null;
  observations: { primary: Observation; secondary: Observation | null };
  binding: OracleBinding;
  notes: string[];
};

export class NotRegisteredError extends Error {
  constructor(
    readonly mint: Address,
    readonly security: Address,
    readonly programAddress: Address,
  ) {
    super(
      `No SecurityState for ${mint} at ${security} under program ${programAddress}. ` +
        'The program may not be deployed on this cluster, or the mint is not registered. ' +
        'Pass { preview: true } to evaluate the gate on the committed calendar and default binding.',
    );
    this.name = 'NotRegisteredError';
  }
}

export type AdjustedBalanceQuery =
  /** `getTokenAccountBalance` on one token account. */
  | { tokenAccount: Address }
  /** `getTokenSupply` on a mint. */
  | { supply: Address }
  /** Every token account `owner` holds of `mint`, summed. */
  | { owner: Address; mint: Address }
  /** One `pre/postTokenBalances` entry from `getTransaction`, selected by token account or by owner and mint. */
  | { signature: Signature | string; tokenAccount?: Address; owner?: Address; mint?: Address; when?: 'pre' | 'post' };

export interface AdjustedBalanceResult extends AdjustedBalance {
  /** The token accounts the figure covers. */
  accounts: Address[];
  signature?: string;
  slot?: bigint;
}

const symbolText = (bytes: ArrayLike<number>): string => {
  let out = '';
  for (let i = 0; i < bytes.length && bytes[i] !== 0; i++) out += String.fromCharCode(bytes[i]!);
  return out;
};

const base58 = (bytes: ArrayLike<number>) => getBase58Decoder().decode(Uint8Array.from(bytes)) as Base58EncodedBytes;
const fromBase64 = (data: string) => getBase64Encoder().encode(data);
const hex = (bytes: ArrayLike<number>) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function existing(account: MaybeEncodedAccount | undefined): (MaybeEncodedAccount & { exists: true }) | null {
  return account && account.exists ? account : null;
}

/** Scope relabels slots rarely; one read per ten minutes is plenty. */
const SCOPE_LABEL_TTL_MS = 10 * 60 * 1000;

export class Deliverable {
  readonly rpc: Rpc<SolanaRpcApi>;
  readonly programAddress: Address;
  readonly history: readonly CorporateActionRecord[];
  #scopeLabels: { at: number; labels: ScopeLabel[] } | null = null;

  constructor(config: DeliverableConfig = {}) {
    this.rpc = config.rpc ?? createSolanaRpc(config.rpcUrl ?? resolveRpcUrl());
    this.programAddress = config.programAddress ?? resolveProgramAddress();
    this.history = config.history ?? [];
  }

  private get pdaConfig() {
    return { programAddress: this.programAddress };
  }

  /** Whether an executable program account exists at `programAddress` on this cluster. */
  async programDeployed(): Promise<boolean> {
    const [account] = await fetchEncodedAccounts(this.rpc, [this.programAddress]);
    return Boolean(account?.exists && account.executable);
  }

  /** The chain's own clock, which is what the program compares against. */
  async chainTime(): Promise<bigint> {
    const [clock] = await fetchEncodedAccounts(this.rpc, [SYSVAR_CLOCK_ADDRESS]);
    if (!clock?.exists) throw new Error('Clock sysvar not returned by the RPC');
    return getSysvarClockDecoder().decode(clock.data).unixTimestamp;
  }

  async getRegistry(): Promise<(Registry & { address: Address }) | null> {
    const [pda] = await findRegistryPda(this.pdaConfig);
    const [account] = await fetchEncodedAccounts(this.rpc, [pda]);
    const found = existing(account);
    if (!found || found.programAddress !== this.programAddress) return null;
    return { ...getRegistryDecoder().decode(found.data), address: pda };
  }

  async getSecurityState(mint: Address): Promise<SecurityStateView | null> {
    const [pda] = await findSecurityPda({ underlyingMint: mint }, this.pdaConfig);
    const [account] = await fetchEncodedAccounts(this.rpc, [pda]);
    const found = existing(account);
    if (!found || found.programAddress !== this.programAddress) return null;
    const state = getSecurityStateDecoder().decode(found.data);
    return { ...state, address: pda, symbolText: symbolText(state.symbol) };
  }

  async getCalendar(id: number): Promise<(MarketCalendar & { address: Address }) | null> {
    const [pda] = await findCalendarPda({ id }, this.pdaConfig);
    const [account] = await fetchEncodedAccounts(this.rpc, [pda]);
    const found = existing(account);
    if (!found || found.programAddress !== this.programAddress) return null;
    return { ...getMarketCalendarDecoder().decode(found.data), address: pda };
  }

  /** By address, or by the seeds `create_series` derives it from. */
  async getSeries(series: Address | SeriesSeeds): Promise<SeriesView | null> {
    const at = typeof series === 'string' ? series : (await findSeriesPda(series, this.pdaConfig))[0];
    const [account] = await fetchEncodedAccounts(this.rpc, [at]);
    const found = existing(account);
    if (!found || found.programAddress !== this.programAddress) return null;
    return { ...getOptionSeriesDecoder().decode(found.data), address: at };
  }

  /**
   * Every series on `underlying`. `OptionSeries` is fixed-size and its first two
   * fields are `security` and `underlying_mint`, so the mint sits at byte 8 + 32.
   */
  async listSeries(underlying: Address): Promise<SeriesView[]> {
    const accounts = await this.rpc
      .getProgramAccounts(this.programAddress, {
        encoding: 'base64',
        filters: [
          { dataSize: BigInt(getOptionSeriesSize()) },
          { memcmp: { offset: 0n, bytes: base58(getOptionSeriesDiscriminatorBytes()), encoding: 'base58' } },
          { memcmp: { offset: 40n, bytes: underlying as string as Base58EncodedBytes, encoding: 'base58' } },
        ],
      })
      .send();
    return accounts
      .map(({ pubkey, account }) => ({
        ...getOptionSeriesDecoder().decode(fromBase64(account.data[0])),
        address: pubkey,
      }))
      .sort((a, b) => (a.expiryTs === b.expiryTs ? Number(a.strike0 - b.strike0) : Number(a.expiryTs - b.expiryTs)));
  }

  /** By address, or by `{ series, owner }`. */
  async getWriterPosition(position: Address | { series: Address; owner: Address }): Promise<WriterPositionView | null> {
    const at =
      typeof position === 'string'
        ? position
        : (await findPositionPda({ series: position.series, writer: position.owner }, this.pdaConfig))[0];
    const [account] = await fetchEncodedAccounts(this.rpc, [at]);
    const found = existing(account);
    if (!found || found.programAddress !== this.programAddress) return null;
    return { ...getWriterPositionDecoder().decode(found.data), address: at };
  }

  /** Every position `owner` holds. `owner` is the first field after the discriminator. */
  async listWriterPositions(owner: Address): Promise<WriterPositionView[]> {
    const accounts = await this.rpc
      .getProgramAccounts(this.programAddress, {
        encoding: 'base64',
        filters: [
          { dataSize: BigInt(getWriterPositionSize()) },
          { memcmp: { offset: 0n, bytes: base58(getWriterPositionDiscriminatorBytes()), encoding: 'base58' } },
          { memcmp: { offset: 8n, bytes: owner as string as Base58EncodedBytes, encoding: 'base58' } },
        ],
      })
      .send();
    return accounts.map(({ pubkey, account }) => ({
      ...getWriterPositionDecoder().decode(fromBase64(account.data[0])),
      address: pubkey,
    }));
  }

  async getMint(mint: Address): Promise<MintState> {
    const [account] = await fetchEncodedAccounts(this.rpc, [mint]);
    const found = existing(account);
    if (!found) throw new Error(`mint ${mint} does not exist on this cluster`);
    return decodeMintState(mint, found.data);
  }

  /** The strike `series` carries now, from the mint's live multiplier. */
  async currentStrike(series: Address | SeriesView, mint?: Address): Promise<CurrentStrike> {
    const view = typeof series === 'string' ? await this.getSeries(series) : series;
    if (!view) throw new Error(`series ${String(series)} does not exist under ${this.programAddress}`);
    const [mintState, now] = await Promise.all([this.getMint(mint ?? view.underlyingMint), this.chainTime()]);
    return currentStrike(view, mintState, now);
  }

  /** A series with its adjusted strike and derived phase. */
  async describeSeries(series: Address | SeriesView): Promise<SeriesDetail> {
    const view = typeof series === 'string' ? await this.getSeries(series) : series;
    if (!view) throw new Error(`series ${String(series)} does not exist under ${this.programAddress}`);
    const [securityPda] = await findSecurityPda({ underlyingMint: view.underlyingMint }, this.pdaConfig);
    const [mintAccount, clockAccount, securityAccount] = await fetchEncodedAccounts(this.rpc, [
      view.underlyingMint,
      SYSVAR_CLOCK_ADDRESS,
      securityPda,
    ]);
    const mint = existing(mintAccount);
    const clock = existing(clockAccount);
    if (!mint || !clock) throw new Error('mint or clock not returned by the RPC');
    const now = getSysvarClockDecoder().decode(clock.data).unixTimestamp;
    const strike = currentStrike(view, decodeMintState(view.underlyingMint, mint.data), now);

    const security = existing(securityAccount);
    let phase: SeriesPhase | null = null;
    let calendarId: number | null = null;
    if (security) {
      calendarId = getSecurityStateDecoder().decode(security.data).calendarId;
      const calendar = await this.getCalendar(calendarId);
      if (calendar) phase = seriesPhase(view, calendar, now);
    }
    return { series: view, strike, phase, calendarId };
  }

  /**
   * The refusal gate, evaluated off-chain on the same accounts the program would read.
   *
   * With a registered security every input comes from chain: the SecurityState (halt,
   * binding, tolerances), its calendar, the mint, the Scope account and the Clock sysvar,
   * read in one `getMultipleAccounts` so they describe one slot. A Pyth-bound source's
   * account is fetched separately because its address is the caller's.
   * `preview` is for a security that is not registered yet; see ActionableBasis.
   */
  async isActionable(
    mint: Address,
    options: {
      preview?: boolean;
      /** Unix seconds; defaults to the chain clock. */
      now?: bigint;
      /** Oracle accounts for Pyth-bound sources, which have no fixed address. */
      oracleAccounts?: { primary?: Address; secondary?: Address };
    } = {},
  ): Promise<ActionableResult> {
    const [securityPda] = await findSecurityPda({ underlyingMint: mint }, this.pdaConfig);
    const [registryPda] = await findRegistryPda(this.pdaConfig);
    const [calendar0Pda] = await findCalendarPda({ id: 0 }, this.pdaConfig);

    // Scope is where every xStock is priced from today, so its account rides in the same
    // request: security, mint, oracle and clock then all describe the same slot.
    const [securityAcc, registryAcc, calendarAcc, mintAcc, clockAcc, scopeAcc] = await fetchEncodedAccounts(this.rpc, [
      securityPda,
      registryPda,
      calendar0Pda,
      mint,
      SYSVAR_CLOCK_ADDRESS,
      SCOPE_PRICES_ADDRESS,
    ]);

    const mintFound = existing(mintAcc);
    if (!mintFound) throw new Error(`mint ${mint} does not exist on this cluster`);
    const clock = existing(clockAcc);
    const now = options.now ?? (clock ? getSysvarClockDecoder().decode(clock.data).unixTimestamp : BigInt(Math.floor(Date.now() / 1000)));
    const mintState = decodeMintState(mint, mintFound.data);
    if (!mintState.scaledUiAmount) {
      // read_multiplier fails with MissingScaledUiAmount before the gate runs.
      throw new Error(`mint ${mint} has no ScaledUiAmount extension; the program will not gate it`);
    }
    const multiplier = mintMultiplierAt(mintState.scaledUiAmount, now);

    const security = existing(securityAcc);
    const notes: string[] = [];
    let basis: ActionableBasis;
    let calendar: CalendarLike;
    let binding: OracleBinding;
    let halted: boolean;
    let tolerances: { maxAge: number; maxConfBps: number; maxDivergenceBps: number };
    let registryPaused: boolean | null = null;

    if (security && security.programAddress === this.programAddress) {
      basis = 'registered';
      const state = getSecurityStateDecoder().decode(security.data);
      let cal: MarketCalendar | null = null;
      const cal0 = existing(calendarAcc);
      if (state.calendarId === 0 && cal0) cal = getMarketCalendarDecoder().decode(cal0.data);
      else if (state.calendarId !== 0) cal = await this.getCalendar(state.calendarId);
      if (!cal) throw new Error(`calendar ${state.calendarId} for ${mint} is missing`);
      calendar = cal;
      binding = state.sources;
      halted = state.halt.halted;
      tolerances = { maxAge: state.maxPriceAge, maxConfBps: state.maxConfBps, maxDivergenceBps: state.maxDivergenceBps };
      const registry = existing(registryAcc);
      if (registry) registryPaused = getRegistryDecoder().decode(registry.data).paused;
    } else if (options.preview) {
      basis = 'preview';
      calendar = US_EQUITY_CALENDAR;
      halted = false;
      tolerances = {
        maxAge: DEFAULT_MAX_PRICE_AGE_SECS,
        maxConfBps: DEFAULT_MAX_CONF_BPS,
        maxDivergenceBps: DEFAULT_MAX_DIVERGENCE_BPS,
      };
      binding = await this.conventionalBinding(mintState);
      notes.push(
        `No SecurityState for this mint under ${this.programAddress}; this is a preview, not the program's verdict.`,
        'Calendar: the committed US equity schedule (state/registry.rs US_EQUITY_2026_2027).',
        `Tolerances: program defaults (max age ${DEFAULT_MAX_PRICE_AGE_SECS}s, confidence ${DEFAULT_MAX_CONF_BPS} bps, divergence ${DEFAULT_MAX_DIVERGENCE_BPS} bps).`,
        'Halt: no attestation can exist for an unregistered security, so the halt check reads "not halted". It is the one input this preview cannot observe.',
        `Binding: ${describeBinding(binding)}.`,
      );
    } else {
      throw new NotRegisteredError(mint, securityPda, this.programAddress);
    }

    const primarySource = binding.primary;
    const secondarySource = binding.__kind === 'Pair' ? binding.secondary : null;
    const oracleAddresses = [
      oracleAddressFor(primarySource, options.oracleAccounts?.primary),
      secondarySource ? oracleAddressFor(secondarySource, options.oracleAccounts?.secondary) : null,
    ] as const;
    const byAddress = new Map<Address, (MaybeEncodedAccount & { exists: true }) | null>([[SCOPE_PRICES_ADDRESS, existing(scopeAcc)]]);
    const toFetch = [...new Set(oracleAddresses.filter((a): a is Address => a !== null && !byAddress.has(a)))];
    if (toFetch.length > 0) {
      const fetched = await fetchEncodedAccounts(this.rpc, toFetch);
      toFetch.forEach((a, i) => byAddress.set(a, existing(fetched[i])));
    }

    const read = (source: OracleSource, at: Address): Observation => {
      const account = byAddress.get(at);
      if (!account) throw new OracleReadError('OracleSourceMismatch', `oracle account ${at} does not exist`);
      return observe(source, { address: at, owner: account.programAddress, data: account.data }, now);
    };

    let primary: Observation;
    let secondary: Observation | null = null;
    try {
      primary = read(primarySource, oracleAddresses[0]);
      if (secondarySource && oracleAddresses[1]) secondary = read(secondarySource, oracleAddresses[1]);
    } catch (error) {
      // assert_security_actionable reads both oracles before the gate runs, so a Pyth
      // update that `get_price_no_older_than` rejects fails the instruction with
      // OracleStale whatever the calendar says, and without a Refused event.
      if (error instanceof OracleReadError && error.variant === 'OracleStale') {
        const info = REFUSALS[RefusalCode.OracleStale];
        const session = resolveSession(calendar, Number(now));
        notes.push(`The oracle read failed before the gate ran (${error.message}); the program reports this as OracleStale.`);
        return {
          actionable: false,
          code: info.code,
          name: info.name,
          reason: `${info.explanation} ${error.message}.`,
          errorCode: info.errorCode,
          basis,
          mint,
          security: securityPda,
          evaluatedAt: now,
          session,
          nextOpen: session === 'Closed' ? nextOpen(calendar, Number(now)) : null,
          registryPaused,
          observations: { primary: { price: 0n, conf: 0n, expo: 0, publishTs: 0n }, secondary: null },
          binding,
          notes,
        };
      }
      throw error;
    }

    const verdict = checkActionable({
      now,
      calendar,
      halt: { halted },
      mintPaused: mintState.paused,
      transferHook: mintState.transferHookProgramId,
      multiplier,
      primarySource,
      primary,
      secondary: secondarySource && secondary ? { source: secondarySource, observation: secondary } : null,
      ...tolerances,
    });

    const session = resolveSession(calendar, Number(now));
    if (registryPaused) notes.push('The registry kill switch is set: write and exercise fail with RegistryPaused regardless of this verdict.');
    return {
      ...verdict,
      basis,
      mint,
      security: securityPda,
      evaluatedAt: now,
      session,
      nextOpen: session === 'Closed' ? nextOpen(calendar, Number(now)) : null,
      registryPaused,
      observations: { primary, secondary },
      binding,
      notes,
    };
  }

  /**
   * The Scope pair a security is registered with by convention: `Checked <SYM>/USD`
   * primary, `PythLazer <SYM>/USD` secondary, found by label in Scope's TokenMetadatas.
   */
  async conventionalBinding(mint: MintState): Promise<OracleBinding> {
    if (!mint.symbol) throw new Error(`mint ${mint.address} carries no token metadata symbol to find a Scope feed by`);
    const pair = scopePairFor(await this.scopeLabels(), mint.symbol);
    if (pair.checked !== undefined && pair.lazer !== undefined) {
      return { __kind: 'Pair', primary: { __kind: 'Scope', index: pair.checked }, secondary: { __kind: 'Scope', index: pair.lazer } };
    }
    const only = pair.checked ?? pair.lazer;
    if (only === undefined) throw new Error(`Scope publishes no Checked or PythLazer entry for ${mint.symbol}`);
    return { __kind: 'SingleDeclared', primary: { __kind: 'Scope', index: only } };
  }

  /** Scope's slot labels, from its TokenMetadatas account. */
  async scopeLabels(): Promise<ScopeLabel[]> {
    if (this.#scopeLabels && Date.now() - this.#scopeLabels.at < SCOPE_LABEL_TTL_MS) return this.#scopeLabels.labels;
    const [account] = await fetchEncodedAccounts(this.rpc, [SCOPE_TOKEN_METADATAS_ADDRESS]);
    const found = existing(account);
    if (!found) throw new Error('Scope TokenMetadatas account not found');
    const labels = decodeScopeLabels(found.data);
    this.#scopeLabels = { at: Date.now(), labels };
    return labels;
  }

  /**
   * Multiplier-correct balance from any of the three RPC shapes (see balance.ts for why
   * they disagree). The result carries the raw amount, the multiplier and how the
   * multiplier was chosen, and whatever the RPC itself reported.
   */
  async getAdjustedBalance(query: AdjustedBalanceQuery): Promise<AdjustedBalanceResult> {
    if ('signature' in query) return this.adjustedFromTransaction(query);

    if ('supply' in query) {
      const [supply, [mintAcc, clockAcc]] = await Promise.all([
        this.rpc.getTokenSupply(query.supply).send(),
        fetchEncodedAccounts(this.rpc, [query.supply, SYSVAR_CLOCK_ADDRESS]),
      ]);
      const mint = decodeMintState(query.supply, requireAccount(mintAcc, 'mint').data);
      const now = getSysvarClockDecoder().decode(requireAccount(clockAcc, 'clock').data).unixTimestamp;
      return {
        ...adjustBalance({
          raw: BigInt(supply.value.amount),
          decimals: supply.value.decimals,
          mint: query.supply,
          scaled: mint.scaledUiAmount,
          at: now,
          current: true,
          source: 'token-supply',
          reported: { ...supply.value, amount: supply.value.amount },
        }),
        accounts: [],
        slot: supply.context.slot,
      };
    }

    if ('tokenAccount' in query) {
      const [tokenAcc, clockAcc] = await fetchEncodedAccounts(this.rpc, [query.tokenAccount, SYSVAR_CLOCK_ADDRESS]);
      const token = getTokenDecoder().decode(requireAccount(tokenAcc, 'token account').data);
      const [balance, mint] = await Promise.all([
        this.rpc.getTokenAccountBalance(query.tokenAccount).send(),
        this.getMint(token.mint),
      ]);
      const now = getSysvarClockDecoder().decode(requireAccount(clockAcc, 'clock').data).unixTimestamp;
      return {
        ...adjustBalance({
          raw: BigInt(balance.value.amount),
          decimals: balance.value.decimals,
          mint: token.mint,
          scaled: mint.scaledUiAmount,
          at: now,
          current: true,
          source: 'token-account',
          reported: { ...balance.value, amount: balance.value.amount },
        }),
        accounts: [query.tokenAccount],
        slot: balance.context.slot,
      };
    }

    const { owner, mint } = query;
    const [response, mintState, now] = await Promise.all([
      this.rpc.getTokenAccountsByOwner(owner, { mint }, { encoding: 'base64' }).send(),
      this.getMint(mint),
      this.chainTime(),
    ]);
    const accounts = response.value.map(({ pubkey, account }) => ({
      address: pubkey,
      token: getTokenDecoder().decode(fromBase64(account.data[0])),
    }));
    const raw = accounts.reduce((sum, a) => sum + a.token.amount, 0n);
    return {
      ...adjustBalance({
        raw,
        decimals: mintState.decimals,
        mint,
        scaled: mintState.scaledUiAmount,
        at: now,
        current: true,
        source: 'token-account',
      }),
      accounts: accounts.map((a) => a.address),
      slot: response.context.slot,
    };
  }

  /** Every token balance in a transaction's meta, multiplier-corrected at its block time. */
  async getAdjustedTransactionBalances(
    signature: Signature | string,
  ): Promise<Array<AdjustedBalanceResult & { when: 'pre' | 'post'; owner: string | null }>> {
    const tx = await this.rpc
      .getTransaction(signature as Signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
      .send();
    if (!tx) throw new Error(`transaction ${signature} not found on this cluster`);
    if (tx.blockTime === null) throw new Error(`transaction ${signature} has no block time`);
    const meta = tx.meta;
    if (!meta) throw new Error(`transaction ${signature} has no meta`);

    const keys: string[] = [
      ...tx.transaction.message.accountKeys,
      ...(meta.loadedAddresses?.writable ?? []),
      ...(meta.loadedAddresses?.readonly ?? []),
    ];
    const entries: Array<{ when: 'pre' | 'post'; balance: TransactionTokenBalance }> = [
      ...(meta.preTokenBalances ?? []).map((b) => ({ when: 'pre' as const, balance: b as unknown as TransactionTokenBalance })),
      ...(meta.postTokenBalances ?? []).map((b) => ({ when: 'post' as const, balance: b as unknown as TransactionTokenBalance })),
    ];
    const mints = [...new Set(entries.map((e) => e.balance.mint))].map((m) => toAddress(m));
    const mintAccounts = await fetchEncodedAccounts(this.rpc, mints);
    const scaledByMint = new Map(
      mints.map((m, i) => {
        const acc = existing(mintAccounts[i]);
        return [m as string, acc ? decodeMintState(m, acc.data).scaledUiAmount : null];
      }),
    );

    return entries.map(({ when, balance }) => ({
      ...adjustTransactionTokenBalance(balance, scaledByMint.get(balance.mint) ?? null, tx.blockTime!, this.history),
      accounts: keys[balance.accountIndex] ? [keys[balance.accountIndex] as Address] : [],
      signature: String(signature),
      slot: tx.slot,
      when,
      owner: balance.owner ?? null,
    }));
  }

  private async adjustedFromTransaction(query: Extract<AdjustedBalanceQuery, { signature: unknown }>): Promise<AdjustedBalanceResult> {
    const when = query.when ?? 'post';
    const all = await this.getAdjustedTransactionBalances(query.signature);
    const matches = all.filter(
      (b) =>
        b.when === when &&
        (query.tokenAccount === undefined || b.accounts[0] === query.tokenAccount) &&
        (query.owner === undefined || b.owner === query.owner) &&
        (query.mint === undefined || b.mint === query.mint),
    );
    if (matches.length !== 1) {
      throw new Error(
        `${matches.length} ${when}-balances in ${query.signature} match; narrow with tokenAccount, or owner and mint`,
      );
    }
    const { when: _when, owner: _owner, ...only } = matches[0]!;
    return only;
  }
}

function requireAccount(account: MaybeEncodedAccount | undefined, what: string): MaybeEncodedAccount & { exists: true } {
  const found = existing(account);
  if (!found) throw new Error(`${what} not returned by the RPC`);
  return found;
}

function oracleAddressFor(source: OracleSource, override: Address | undefined): Address {
  if (override) return override;
  if (source.__kind === 'Scope') return SCOPE_PRICES_ADDRESS;
  throw new Error('a Pyth-bound source needs its PriceUpdateV2 account passed in oracleAccounts');
}

export function describeSource(source: OracleSource): string {
  return source.__kind === 'Scope' ? `Scope #${source.index}` : `Pyth feed 0x${hex(source.feedId)}`;
}

export function describeBinding(binding: OracleBinding): string {
  return binding.__kind === 'Pair'
    ? `${describeSource(binding.primary)} checked against ${describeSource(binding.secondary)}`
    : `${describeSource(binding.primary)} only (declared single source)`;
}

export function createDeliverable(config: DeliverableConfig = {}): Deliverable {
  return new Deliverable(config);
}

