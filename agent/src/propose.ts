/**
 * Turning a decision into the transactions a human would send.
 *
 * THE AGENT HOLDS NO KEY. Every signer in this file is `createNoopSigner`, which is a
 * signer that cannot sign: it contributes an address and an account meta and nothing
 * else. What comes out is an unsigned wire transaction whose signature slots are zero.
 * A human, or a wallet the human controls, fills them in. There is no code path here
 * that reads a keypair file, none that calls `sendTransaction`, and none that can be
 * given one by configuration.
 *
 * This is a design choice, not a missing feature. The venue's whole claim is that it
 * refuses to act on a security the rail has not cleared; an autonomous signer would
 * make that claim depend on the agent's own correctness instead of on the program's.
 * Proposing keeps the program as the only thing that has to be right.
 */
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase16Decoder,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type Instruction,
} from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token-2022';
import {
  OptionKind,
  TOKEN_2022_PROGRAM_ADDRESS,
  findCalendarPda,
  findCollateralVaultPda,
  findOptionMintPda,
  findSeriesPda,
  getCreateSeriesInstructionAsync,
  getWriteInstructionAsync,
  oracleAccountsFor,
  type OracleBinding,
} from '@stocklana/sdk';

import type { ProposalRequest } from './wheel.ts';

/** USDC on Solana mainnet. What exercise is paid in; the premium is paid in shares. */
export const DEFAULT_QUOTE_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address;
export const DEFAULT_QUOTE_DECIMALS = 6;
/** The classic SPL Token program, which is what USDC is issued under. */
export const TOKEN_PROGRAM_ADDRESS = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;
/** `fixed.rs` SCALE: the multiplier is carried as 1e12 fixed point. */
export const MULTIPLIER_SCALE = 1_000_000_000_000n;

export interface ProposeContext {
  programAddress: Address;
  underlyingMint: Address;
  underlyingDecimals: number;
  /** m1, 1e12 fixed point, as the program reads it off the mint. */
  multiplierFixed: bigint;
  quoteMint: Address;
  quoteDecimals: number;
  /** Who would sign. Null when no wallet was supplied: the agent still describes the call. */
  writer: Address | null;
  binding: OracleBinding;
  /** A Pyth-bound source needs its PriceUpdateV2 account supplied by the caller. */
  pythAccounts?: { primary?: Address; secondary?: Address };
  settlementWindowMinutes: number;
  calendarId: number;
  /** Fetched only when a transaction is to be compiled. */
  blockhash?: { blockhash: Blockhash; lastValidBlockHeight: bigint };
}

export interface ProposedAccount {
  name: string;
  address: string;
  signer: boolean;
  writable: boolean;
}

export interface ProposedInstruction {
  instruction: string;
  programAddress: string;
  accounts: ProposedAccount[];
  dataHex: string;
  dataBase64: string;
}

export interface Proposal {
  title: string;
  summary: string;
  instructions: ProposedInstruction[];
  /** An unsigned wire transaction, base64. Null when no fee payer or blockhash was available. */
  unsignedTransactionBase64: string | null;
  feePayer: string | null;
  blockhash: string | null;
  note: string;
}

const ACCOUNT_NAMES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  create_series: [
    'creator',
    'registry',
    'security',
    'calendar',
    'underlyingMint',
    'quoteMint',
    'series',
    'optionMint',
    'collateralVault',
    'premiumVault',
    'quoteVault',
    'underlyingTokenProgram',
    'quoteTokenProgram',
    'systemProgram',
  ],
  write: [
    'writer',
    'registry',
    'security',
    'calendar',
    'series',
    'underlyingMint',
    'optionMint',
    'collateralVault',
    'writerUnderlying',
    'writerOption',
    'position',
    'primaryOracle',
    'secondaryOracle',
    'underlyingTokenProgram',
  ],
});

/** Anchor's account-role bit flags, as Kit encodes them. */
const isSigner = (role: number) => (role & 0b10) !== 0;
const isWritable = (role: number) => (role & 0b01) !== 0;

function describe(name: string, ix: Instruction): ProposedInstruction {
  const names = ACCOUNT_NAMES[name] ?? [];
  const accounts = (ix.accounts ?? []).map((meta, i) => ({
    name: names[i] ?? `account[${i}]`,
    address: meta.address as string,
    signer: isSigner(meta.role),
    writable: isWritable(meta.role),
  }));
  const data = ix.data ?? new Uint8Array();
  return {
    instruction: name,
    programAddress: ix.programAddress as string,
    accounts,
    dataHex: getBase16Decoder().decode(data),
    dataBase64: getBase64Decoder().decode(data),
  };
}

/**
 * The strike goes on chain as quote units per *adjusted share*, and the contract size
 * goes on chain as *raw* units of the underlying. Those two units are the adjustment
 * invariant: `strike x ui_size` is what stays still when the multiplier moves, so a
 * contract that covers one share today is sized as `10^decimals / m1` raw units, and a
 * split changes `m1` without changing a single byte of the series account.
 */
export function strikeRaw(strikeUsd: number, quoteDecimals: number): bigint {
  return BigInt(Math.round(strikeUsd * 10 ** quoteDecimals));
}

export function contractRawSize(contractSize: number, underlyingDecimals: number, multiplierFixed: bigint): bigint {
  const uiRaw = BigInt(Math.round(contractSize * 10 ** underlyingDecimals));
  if (multiplierFixed <= 0n) throw new Error('multiplier must be positive');
  return (uiRaw * MULTIPLIER_SCALE) / multiplierFixed;
}

async function compile(
  ctx: ProposeContext,
  instructions: Instruction[],
): Promise<{ base64: string | null; blockhash: string | null }> {
  if (!ctx.writer || !ctx.blockhash) return { base64: null, blockhash: null };
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(ctx.writer as Address, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(ctx.blockhash as NonNullable<ProposeContext['blockhash']>, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return {
    base64: getBase64EncodedWireTransaction(compileTransaction(message)),
    blockhash: ctx.blockhash.blockhash as string,
  };
}

export async function buildProposals(
  requests: readonly ProposalRequest[],
  ctx: ProposeContext,
): Promise<Proposal[]> {
  const out: Proposal[] = [];
  const signer = createNoopSigner(ctx.writer ?? ('11111111111111111111111111111111' as Address));

  for (const request of requests) {
    const rung = request.rung;
    const expiryTs = BigInt(rung.expiryTs);
    const strike0 = strikeRaw(rung.strikeUsd, ctx.quoteDecimals);
    const [series] = await findSeriesPda(
      { underlyingMint: ctx.underlyingMint, expiryTs, strike0, kind: OptionKind.Call },
      { programAddress: ctx.programAddress },
    );

    if (request.kind === 'create_series') {
      const [calendar] = await findCalendarPda({ id: ctx.calendarId }, { programAddress: ctx.programAddress });
      const ix = await getCreateSeriesInstructionAsync(
        {
          creator: signer,
          calendar,
          underlyingMint: ctx.underlyingMint,
          quoteMint: ctx.quoteMint,
          series,
          underlyingTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
          quoteTokenProgram: ctx.quoteMint === DEFAULT_QUOTE_MINT ? TOKEN_PROGRAM_ADDRESS : TOKEN_2022_PROGRAM_ADDRESS,
          expiryTs,
          strike0,
          kind: OptionKind.Call,
          contractRawSize: contractRawSize(rung.contractSize, ctx.underlyingDecimals, ctx.multiplierFixed),
          settlementWindowMinutes: ctx.settlementWindowMinutes,
          adjustOnCorporateAction: true,
        },
        { programAddress: ctx.programAddress },
      );
      const compiled = await compile(ctx, [ix as Instruction]);
      out.push({
        title: `create_series ${rung.symbol}`,
        summary:
          `strike0 ${strike0} (${rung.strikeUsd} per adjusted share, ${ctx.quoteDecimals} quote decimals), ` +
          `expiry ${new Date(rung.expiryTs * 1000).toISOString()}, ` +
          `contract_raw_size ${contractRawSize(rung.contractSize, ctx.underlyingDecimals, ctx.multiplierFixed)} ` +
          `(= ${rung.contractSize} adjusted share at m1 ${(Number(ctx.multiplierFixed) / 1e12).toFixed(12)}), ` +
          'adjust_on_corporate_action true',
        instructions: [describe('create_series', ix as Instruction)],
        unsignedTransactionBase64: compiled.base64,
        feePayer: ctx.writer,
        blockhash: compiled.blockhash,
        note:
          'Opens the series. It mints nothing and moves no collateral; `write` does that.' +
          (ctx.writer ? '' : ' No --writer was given, so `creator` shows the all-zero address and no transaction is compiled.'),
      });
      continue;
    }

    if (!ctx.writer) {
      out.push({
        title: `write ${rung.symbol} x${request.contracts}`,
        summary: `${request.contracts} contracts against ${request.contracts * rung.contractSize} adjusted shares of collateral`,
        instructions: [],
        unsignedTransactionBase64: null,
        feePayer: null,
        blockhash: null,
        note: 'Not built: `write` needs the writer\'s address to resolve their token accounts. Pass --writer=<pubkey>.',
      });
      continue;
    }

    const [optionMint] = await findOptionMintPda({ series }, { programAddress: ctx.programAddress });
    const [collateralVault] = await findCollateralVaultPda({ series }, { programAddress: ctx.programAddress });
    const [calendar] = await findCalendarPda({ id: ctx.calendarId }, { programAddress: ctx.programAddress });
    const [writerUnderlying] = await findAssociatedTokenPda({
      owner: ctx.writer,
      mint: ctx.underlyingMint,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
    // The option mint is created with `mint::token_program = underlying_token_program`
    // (instructions/series.rs), so the writer's option account lives under Token-2022 too.
    const [writerOption] = await findAssociatedTokenPda({
      owner: ctx.writer,
      mint: optionMint,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
    const oracles = oracleAccountsFor(ctx.binding, ctx.pythAccounts ?? {});

    const ix = await getWriteInstructionAsync(
      {
        writer: signer,
        calendar,
        series,
        underlyingMint: ctx.underlyingMint,
        optionMint,
        collateralVault,
        writerUnderlying,
        writerOption,
        primaryOracle: oracles.primaryOracle,
        secondaryOracle: oracles.secondaryOracle,
        underlyingTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
        contracts: BigInt(request.contracts),
      },
      { programAddress: ctx.programAddress },
    );
    const compiled = await compile(ctx, [ix as Instruction]);
    out.push({
      title: `write ${rung.symbol} x${request.contracts}`,
      summary:
        `${request.contracts} contracts, ${request.contracts * rung.contractSize} adjusted shares of collateral moved into the vault, ` +
        `premium quoted at ${rung.quoteSharesPerContract.toFixed(8)} shares per contract`,
      instructions: [describe('write', ix as Instruction)],
      unsignedTransactionBase64: compiled.base64,
      feePayer: ctx.writer,
      blockhash: compiled.blockhash,
      note:
        'The program re-runs the gate inside this instruction. If the rail refuses between this proposal and the signature, ' +
        'the transaction fails with the matching Anchor error rather than executing.',
    });
  }
  return out;
}
