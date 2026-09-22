import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  address,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit';
import { beforeAll, describe, expect, it } from 'vitest';

import * as generated from '../src/generated/index.js';
import { OptionKind } from '../src/generated/index.js';
import { oracleAccountsFor, seriesAccounts } from '../src/instructions.js';
import { SCOPE_PRICES_ADDRESS } from '../src/oracle.js';
import { findSeriesPda } from '../src/pda.js';
import { SDK_ROOT } from './helpers.js';

interface IdlAccount {
  name: string;
  writable?: boolean;
  signer?: boolean;
}
interface IdlInstruction {
  name: string;
  discriminator: number[];
  accounts: IdlAccount[];
}
const idl = JSON.parse(readFileSync(resolve(SDK_ROOT, 'idl', 'deliverable.json'), 'utf8')) as {
  address: string;
  instructions: IdlInstruction[];
};

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const pascal = (s: string) => camel(s).replace(/^./, (c) => c.toUpperCase());

/** Plausible arguments for each instruction; the test is about framing, not values. */
const ARGS: Record<string, Record<string, unknown>> = {
  init_registry: { attestor: address('11111111111111111111111111111111') },
  set_registry_paused: { paused: true },
  init_calendar: { id: 0, regularOpenMinute: 570, regularCloseMinute: 960 },
  append_calendar_entries: { entries: [{ dateKey: (11 << 8) | 26, kind: 0, closeMinute: 0 }] },
  register_security: {
    symbol: new Uint8Array(12),
    sources: { __kind: 'Pair', primary: { __kind: 'Scope', index: 317 }, secondary: { __kind: 'Scope', index: 315 } },
    maxPriceAge: 60,
    maxConfBps: 100,
    maxDivergenceBps: 150,
  },
  attest_halt: { halted: true, sinceTs: 1n, source: 1 },
  create_series: {
    expiryTs: 1_792_000_000n,
    strike0: 350_000_000n,
    kind: OptionKind.Call,
    contractRawSize: 100_000_000n,
    settlementWindowMinutes: 30,
    adjustOnCorporateAction: true,
  },
  write: { contracts: 1n },
  exercise: { contracts: 1n },
};

let signer: TransactionSigner;
const filler: Address[] = [];

beforeAll(async () => {
  signer = await generateKeyPairSigner();
  for (let i = 0; i < 20; i++) filler.push((await generateKeyPairSigner()).address);
});

describe('every IDL instruction has a Kit builder that frames it as the IDL says', () => {
  it('covers all sixteen instructions', () => {
    expect(idl.instructions).toHaveLength(16);
    const exported = generated as unknown as Record<string, unknown>;
    for (const ix of idl.instructions) {
      expect(typeof exported[`get${pascal(ix.name)}Instruction`], ix.name).toBe('function');
    }
  });

  for (const ix of idl.instructions) {
    it(`${ix.name}: discriminator, account order, signer and writable flags`, () => {
      const exported = generated as unknown as Record<string, (input: Record<string, unknown>, config?: unknown) => Instruction>;
      const build = exported[`get${pascal(ix.name)}Instruction`]!;
      const input: Record<string, unknown> = { ...(ARGS[ix.name] ?? {}) };
      ix.accounts.forEach((account, i) => {
        input[camel(account.name)] = account.signer ? signer : filler[i];
      });
      const programAddress = address(idl.address);
      const built = build(input, { programAddress });

      expect(built.programAddress).toBe(programAddress);
      expect([...built.data!.subarray(0, 8)]).toEqual(ix.discriminator);
      expect(built.accounts).toHaveLength(ix.accounts.length);
      ix.accounts.forEach((account, i) => {
        const meta = built.accounts![i]!;
        expect(meta.address, account.name).toBe(account.signer ? signer.address : filler[i]);
        // AccountRole: 0 readonly, 1 writable, 2 readonly signer, 3 writable signer
        expect(meta.role, account.name).toBe((account.signer ? 2 : 0) | (account.writable ? 1 : 0));
      });
    });
  }
});

describe('getProgramAccounts filters match the account layouts', () => {
  it('OptionSeries: fixed size, underlying_mint at byte 40 (listSeries filters on it)', () => {
    const mint = filler[3]!;
    const bytes = generated.getOptionSeriesEncoder().encode({
      security: filler[2]!,
      underlyingMint: mint,
      quoteMint: filler[4]!,
      optionMint: filler[5]!,
      collateralVault: filler[6]!,
      premiumVault: filler[7]!,
      quoteVault: filler[8]!,
      creator: filler[9]!,
      kind: OptionKind.Call,
      expiryTs: 1n,
      strike0: 1n,
      multiplierAtMint: 1n,
      contractRawSize: 1n,
      settlementWindowMinutes: 30,
      adjustOnCorporateAction: true,
      underlyingDecimals: 8,
      quoteDecimals: 6,
      bump: 255,
      contractsWritten: 0n,
      contractsExercised: 0n,
      quoteCollected: 0n,
      premiumClaimedTotal: 0n,
      windowOpenedTs: 0n,
      acknowledgedMultiplier: 1n,
    });
    expect(bytes.length).toBe(generated.getOptionSeriesSize());
    expect([...bytes.subarray(0, 8)]).toEqual([...generated.getOptionSeriesDiscriminatorBytes()]);
    expect([...bytes.subarray(40, 72)]).toEqual([...getAddressEncoder().encode(mint)]);
  });

  it('WriterPosition: fixed size, owner at byte 8 (listWriterPositions filters on it)', () => {
    const owner = filler[10]!;
    const bytes = generated.getWriterPositionEncoder().encode({
      owner,
      series: filler[11]!,
      contracts: 0n,
      rawCollateral: 0n,
      premiumClaimed: 0n,
      settled: false,
      bump: 255,
    });
    expect(bytes.length).toBe(generated.getWriterPositionSize());
    expect([...bytes.subarray(8, 40)]).toEqual([...getAddressEncoder().encode(owner)]);
  });
});

describe('PDAs', () => {
  const mint = address('XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp');
  const seeds = { underlyingMint: mint, expiryTs: 1_792_000_000n, strike0: 350_000_000n, kind: OptionKind.Call };

  it('the series PDA uses the seeds create_series declares', async () => {
    const [pda] = await findSeriesPda(seeds);
    const le = (v: bigint, n: number) => {
      const out = new Uint8Array(n);
      new DataView(out.buffer).setBigUint64(0, v, true);
      return out;
    };
    const [expected] = await getProgramDerivedAddress({
      programAddress: address(idl.address),
      seeds: [new TextEncoder().encode('series'), getAddressEncoder().encode(mint), le(1_792_000_000n, 8), le(350_000_000n, 8), new Uint8Array([0])],
    });
    expect(pda).toBe(expected);
    const [put] = await findSeriesPda({ ...seeds, kind: OptionKind.Put });
    expect(put).not.toBe(pda);
  });

  it('the program id is configuration: a different id derives different accounts', async () => {
    const other = address('11111111111111111111111111111112');
    const [a] = await findSeriesPda(seeds);
    const [b] = await findSeriesPda(seeds, { programAddress: other });
    expect(a).not.toBe(b);
    const [sa] = await generated.findSecurityPda({ underlyingMint: mint });
    const [sb] = await generated.findSecurityPda({ underlyingMint: mint }, { programAddress: other });
    expect(sa).not.toBe(sb);
  });

  it('the async builders resolve the PDAs the program checks', async () => {
    const [series] = await findSeriesPda(seeds);
    const derived = await seriesAccounts(series, mint);
    const [calendar] = await generated.findCalendarPda({ id: 0 });
    const ix = await generated.getCreateSeriesInstructionAsync({
      creator: signer,
      calendar,
      underlyingMint: mint,
      quoteMint: filler[0]!,
      series,
      underlyingTokenProgram: address('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
      quoteTokenProgram: address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      ...(ARGS['create_series'] as { expiryTs: bigint; strike0: bigint; kind: OptionKind; contractRawSize: bigint; settlementWindowMinutes: number; adjustOnCorporateAction: boolean }),
    });
    const [registry] = await generated.findRegistryPda();
    const addresses = ix.accounts.map((a) => a.address);
    expect(addresses).toEqual([
      signer.address,
      registry,
      derived.security,
      calendar,
      mint,
      filler[0],
      series,
      derived.optionMint,
      derived.collateralVault,
      derived.premiumVault,
      derived.quoteVault,
      'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      '11111111111111111111111111111111',
    ]);
  });

  it('oracle accounts: Scope is one account, a single source passes the primary twice, Pyth must be supplied', () => {
    expect(oracleAccountsFor({ __kind: 'Pair', primary: { __kind: 'Scope', index: 317 }, secondary: { __kind: 'Scope', index: 315 } })).toEqual({
      primaryOracle: SCOPE_PRICES_ADDRESS,
      secondaryOracle: SCOPE_PRICES_ADDRESS,
    });
    const pyth = { __kind: 'Pyth' as const, feedId: new Uint8Array(32), maxAge: 60 };
    expect(() => oracleAccountsFor({ __kind: 'SingleDeclared', primary: pyth })).toThrow(/PriceUpdateV2/);
    expect(oracleAccountsFor({ __kind: 'SingleDeclared', primary: pyth }, { primary: filler[1]! })).toEqual({
      primaryOracle: filler[1],
      secondaryOracle: filler[1],
    });
  });
});
