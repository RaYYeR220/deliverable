// Step 2: a Token-2022 stand-in for AAPLx on devnet.
//
//   pnpm tsx create-standin-mint.ts
//
// There are no xStocks mints on devnet. This creates a mint WE control that
// carries the same Token-2022 extension set as mainnet AAPLx
// (XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp, dumped in
// tests/fixtures/aaplx_mint.bin), so the program's mint reads (ScaledUiAmount,
// Pausable, TransferHook) run against the real extension layouts:
//
//   MetadataPointer          -> the mint itself
//   PermanentDelegate        -> the deploy wallet
//   DefaultAccountState      -> Initialized
//   ScaledUiAmount           -> multiplier 1.0032690125398187 (mainnet AAPLx's)
//   Pausable                 -> not paused
//   ConfidentialTransferMint -> authority set, no auto-approve, no auditor
//   TransferHook             -> initialised with a null program id
//   TokenMetadata            -> symbol AAPLd, name "AAPLx devnet stand-in"
//
// It is labelled a stand-in in its own on-chain metadata. It is not an xStock,
// it is not backed by anything, and its supply is zero.

import {
  AccountState,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createInitializeDefaultAccountStateInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMint2Instruction,
  createInitializePausableConfigInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeScaledUiAmountConfigInstruction,
  createInitializeTransferHookInstruction,
  getMintLen,
} from '@solana/spl-token';
import {
  createInitializeInstruction as createInitializeMetadataInstruction,
  createUpdateFieldInstruction,
  pack as packMetadata,
  type TokenMetadata,
} from '@solana/spl-token-metadata';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';

import { connection, explorer, localKeypair, recordField, rpcHost, send, wallet } from './lib.ts';

export const STANDIN = {
  name: 'AAPLx devnet stand-in',
  symbol: 'AAPLd',
  uri: '',
  decimals: 8, // as mainnet AAPLx
  multiplier: 1.0032690125398187, // mainnet AAPLx's ScaledUiAmount multiplier
  additional: [
    ['standin_for', 'AAPLx XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp (Solana mainnet)'],
    ['note', 'Devnet test mint created for the Deliverable deployment. Not an xStock, not backed, no value.'],
  ] as [string, string][],
};

/** Token-2022 `ConfidentialTransferExtension::InitializeMint`, which spl-token 0.4 has no builder for. */
function initializeConfidentialTransferMintIx(mint: PublicKey, authority: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(2 + 32 + 1 + 32);
  data.writeUInt8(27, 0); // TokenInstruction::ConfidentialTransferExtension
  data.writeUInt8(0, 1); // ConfidentialTransferInstruction::InitializeMint
  authority.toBuffer().copy(data, 2); // OptionalNonZeroPubkey
  data.writeUInt8(0, 34); // auto_approve_new_accounts = false, as mainnet AAPLx
  // auditor_elgamal_pubkey: 32 zero bytes = none, as mainnet AAPLx
  return new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [{ pubkey: mint, isSigner: false, isWritable: true }],
    data,
  });
}

async function main() {
  const conn = connection();
  const payer = wallet();
  const mint = localKeypair('standin-mint');
  const authority = payer.publicKey;
  console.log(`rpc    ${rpcHost()}`);
  console.log(`mint   ${mint.publicKey.toBase58()} (keys/standin-mint.json)`);

  if (await conn.getAccountInfo(mint.publicKey)) {
    console.log('mint already exists, nothing to do');
    recordField('standinMint', mint.publicKey.toBase58());
    return;
  }

  const extensions = [
    ExtensionType.MetadataPointer,
    ExtensionType.PermanentDelegate,
    ExtensionType.DefaultAccountState,
    ExtensionType.ScaledUiAmountConfig,
    ExtensionType.PausableConfig,
    ExtensionType.ConfidentialTransferMint,
    ExtensionType.TransferHook,
  ];
  const mintLen = getMintLen(extensions);
  const metadata: TokenMetadata = {
    updateAuthority: authority,
    mint: mint.publicKey,
    name: STANDIN.name,
    symbol: STANDIN.symbol,
    uri: STANDIN.uri,
    additionalMetadata: STANDIN.additional,
  };
  // TokenMetadata is written after InitializeMint and reallocs the account, so
  // the account is funded for its final size up front: TLV header + packed body.
  const metadataLen = 4 + packMetadata(metadata).length;
  const lamports = await conn.getMinimumBalanceForRentExemption(mintLen + metadataLen);

  const ixs = [
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeMetadataPointerInstruction(mint.publicKey, authority, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    createInitializePermanentDelegateInstruction(mint.publicKey, authority, TOKEN_2022_PROGRAM_ID),
    createInitializeDefaultAccountStateInstruction(mint.publicKey, AccountState.Initialized, TOKEN_2022_PROGRAM_ID),
    createInitializeScaledUiAmountConfigInstruction(mint.publicKey, authority, STANDIN.multiplier, TOKEN_2022_PROGRAM_ID),
    createInitializePausableConfigInstruction(mint.publicKey, authority, TOKEN_2022_PROGRAM_ID),
    initializeConfidentialTransferMintIx(mint.publicKey, authority),
    // A null hook program id: the extension is present and its authority live,
    // exactly the state every xStock is in today.
    createInitializeTransferHookInstruction(mint.publicKey, authority, PublicKey.default, TOKEN_2022_PROGRAM_ID),
    createInitializeMint2Instruction(mint.publicKey, STANDIN.decimals, authority, authority, TOKEN_2022_PROGRAM_ID),
  ];
  await send(conn, 'create_standin_mint', ixs, [payer, mint]);

  const metaIxs = [
    createInitializeMetadataInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      metadata: mint.publicKey,
      updateAuthority: authority,
      mint: mint.publicKey,
      mintAuthority: authority,
      name: STANDIN.name,
      symbol: STANDIN.symbol,
      uri: STANDIN.uri,
    }),
    ...STANDIN.additional.map(([field, value]) =>
      createUpdateFieldInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        metadata: mint.publicKey,
        updateAuthority: authority,
        field,
        value,
      }),
    ),
  ];
  await send(conn, 'standin_mint_metadata', metaIxs, [payer]);

  recordField('standinMint', mint.publicKey.toBase58());
  console.log(`\nStand-in mint ${mint.publicKey.toBase58()}`);
  console.log(`  ${explorer('address', mint.publicKey.toBase58())}`);
}

main().catch((err) => {
  console.error(err);
  if (err?.logs) console.error(err.logs.join('\n'));
  process.exit(1);
});
