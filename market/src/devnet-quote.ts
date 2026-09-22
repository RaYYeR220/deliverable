/**
 * devnet-quote.ts — mint the devnet stand-in for an xStock.
 *
 *   pnpm run devnet-quote [--supply=5000] [--symbol=AAPLd]
 *
 * Devnet carries no xStocks and no xStock token badges: enumerating DBC's
 * `TokenBadge` accounts on devnet returns exactly four, none of them an `Xs…`
 * mint. So the devnet rehearsal of the whole path needs a quote mint we control.
 *
 * What this mint copies from a real xStock: Token-2022, 8 decimals, a metadata
 * pointer and on-chain metadata, and no transfer fee.
 *
 * What it deliberately does NOT copy: the PermanentDelegate extension. That
 * extension is precisely what puts xStocks outside DBC's permissionless
 * Token-2022 allowlist and therefore what makes the operator-issued token badge
 * mandatory on mainnet. A devnet mint carrying it would be unusable, because
 * only a Meteora operator can issue the badge that would unlock it. The devnet
 * run therefore validates everything except the single extra remaining account,
 * and config.ts adds that account automatically whenever the badge PDA exists.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import {
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
} from "@solana/spl-token";
import {
  createInitializeInstruction,
  pack,
  type TokenMetadata,
} from "@solana/spl-token-metadata";
import { connect, isEntrypoint, loadKeypair, parseArgs, rpcHost } from "./env.ts";
import { DEVNET_QUOTE_FILE } from "./underlyings.ts";
import { ARTIFACT_DIR } from "./config.ts";

const DECIMALS = 8;

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.has("mainnet")) throw new Error("devnet-quote only runs on devnet; it mints a stand-in token.");

  const connection = connect("devnet");
  const wallet = loadKeypair(args.str("keypair"));
  const symbol = args.str("symbol", "AAPLd") as string;
  const supply = args.num("supply", 5000) as number;

  const mint = Keypair.generate();
  const metadata: TokenMetadata = {
    mint: mint.publicKey,
    name: "Devnet xStock stand-in (AAPL)",
    symbol,
    uri: "",
    additionalMetadata: [["note", "devnet only, not a real tokenised share"]],
  };

  const mintLen = getMintLen([ExtensionType.MetadataPointer]);
  const metadataLen = pack(metadata).length + 4 + 64;
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen + metadataLen);

  const ata = getAssociatedTokenAddressSync(mint.publicKey, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const rawSupply = BigInt(Math.round(supply * 10 ** DECIMALS));

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: wallet.publicKey,
      newAccountPubkey: mint.publicKey,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeMetadataPointerInstruction(
      mint.publicKey,
      wallet.publicKey,
      mint.publicKey,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeMintInstruction(mint.publicKey, DECIMALS, wallet.publicKey, null, TOKEN_2022_PROGRAM_ID),
    createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      mint: mint.publicKey,
      metadata: mint.publicKey,
      name: metadata.name,
      symbol: metadata.symbol,
      uri: metadata.uri,
      mintAuthority: wallet.publicKey,
      updateAuthority: wallet.publicKey,
    }),
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey,
      ata,
      wallet.publicKey,
      mint.publicKey,
      TOKEN_2022_PROGRAM_ID,
    ),
    createMintToInstruction(mint.publicKey, ata, wallet.publicKey, rawSupply, [], TOKEN_2022_PROGRAM_ID),
  );

  console.log(`cluster          devnet via ${rpcHost("devnet")}`);
  console.log(`wallet           ${wallet.publicKey.toBase58()}`);
  const before = await connection.getBalance(wallet.publicKey);
  const signature = await sendAndConfirmTransaction(connection, tx, [wallet, mint], { commitment: "confirmed" });
  const after = await connection.getBalance(wallet.publicKey);

  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(
    DEVNET_QUOTE_FILE,
    `${JSON.stringify(
      {
        mint: mint.publicKey.toBase58(),
        decimals: DECIMALS,
        symbol,
        createdAt: new Date().toISOString(),
        signature,
        note: "Devnet-only Token-2022 stand-in for an xStock. 8 decimals, no transfer fee, no PermanentDelegate (see devnet-quote.ts).",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log(`mint             ${mint.publicKey.toBase58()}  (Token-2022, ${DECIMALS} decimals)`);
  console.log(`minted           ${supply} to ${ata.toBase58()}`);
  console.log(`signature        ${signature}`);
  console.log(`cost             ${before - after} lamports (${((before - after) / 1e9).toFixed(9)} SOL)`);
  console.log(`written          ${DEVNET_QUOTE_FILE}`);
}

if (isEntrypoint(import.meta.url)) {
  await main();
}
