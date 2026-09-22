import BN from "bn.js";
import { Decimal } from "decimal.js";
import { PublicKey } from "@solana/web3.js";
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  FEE_DENOMINATOR,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenType,
  feeNumeratorToBps,
  getPriceFromSqrtPrice,
  type ConfigParameters,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { BASE_DECIMALS, QUOTE_DECIMALS } from "./curve.ts";

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** BN / PublicKey / nested objects -> plain JSON, so artifacts diff cleanly. */
export function toJson(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (value instanceof BN) return value.toString();
  if (value instanceof PublicKey) return value.toBase58();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toJson);
  if (typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toJson(v);
    return out;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

const enumName = (e: Record<string, string | number>, v: number): string =>
  (Object.entries(e).find(([, val]) => val === v)?.[0] as string | undefined) ?? `unknown(${v})`;

export function bpsFromNumerator(numerator: BN): number {
  return feeNumeratorToBps(numerator);
}

export function sharesPerContract(sqrtPrice: BN): string {
  return getPriceFromSqrtPrice(sqrtPrice, BASE_DECIMALS, QUOTE_DECIMALS).toFixed(10);
}

export function rawToUi(raw: BN | string, decimals: number): string {
  return new Decimal(raw.toString()).div(new Decimal(10).pow(decimals)).toFixed(decimals);
}

/**
 * Full decode of the ConfigParameters that go on chain. This is what --dry-run
 * prints: every field, with the enums named and the fixed-point numbers
 * converted, so the parameter set can be read without a decoder.
 */
export function describeConfigParameters(params: ConfigParameters): string {
  const lines: string[] = [];
  const row = (k: string, v: string, note = "") =>
    lines.push(`  ${k.padEnd(44)} ${v}${note ? `   # ${note}` : ""}`);

  const baseFee = params.poolFees.baseFee;
  lines.push("poolFees.baseFee");
  row("cliffFeeNumerator", baseFee.cliffFeeNumerator.toString(), `${bpsFromNumerator(baseFee.cliffFeeNumerator)} bps opening fee, charged in the quote asset`);
  row("baseFeeMode", `${baseFee.baseFeeMode} (${enumName(BaseFeeMode as unknown as Record<string, number>, baseFee.baseFeeMode)})`);
  row("firstFactor (numberOfPeriod)", String(baseFee.firstFactor));
  row("secondFactor (periodFrequency)", baseFee.secondFactor.toString(), "seconds per fee step");
  row("thirdFactor (reductionFactor)", baseFee.thirdFactor.toString());
  row("poolFees.dynamicFee", params.poolFees.dynamicFee === null ? "null" : JSON.stringify(toJson(params.poolFees.dynamicFee)));

  lines.push("mode");
  row("collectFeeMode", `${params.collectFeeMode} (${enumName(CollectFeeMode as unknown as Record<string, number>, params.collectFeeMode)})`, "fees accrue in the tokenised share");
  row("migrationOption", `${params.migrationOption} (${enumName(MigrationOption as unknown as Record<string, number>, params.migrationOption)})`);
  row("activationType", `${params.activationType} (${enumName(ActivationType as unknown as Record<string, number>, params.activationType)})`, "fee schedule runs on wall-clock time to expiry");
  row("tokenType", `${params.tokenType} (${enumName(TokenType as unknown as Record<string, number>, params.tokenType)})`, "series token");
  row("tokenDecimal", String(params.tokenDecimal), "matches the xStock quote, so a contract unit maps 1:1 onto a share unit");
  row("tokenUpdateAuthority", `${params.tokenUpdateAuthority} (${enumName(TokenAuthorityOption as unknown as Record<string, number>, params.tokenUpdateAuthority)})`);
  row("migrationFeeOption", `${params.migrationFeeOption} (${enumName(MigrationFeeOption as unknown as Record<string, number>, params.migrationFeeOption)})`);
  row("enableFirstSwapWithMinFee", String(params.enableFirstSwapWithMinFee));

  lines.push("price and size");
  row("sqrtStartPrice", params.sqrtStartPrice.toString(), `${sharesPerContract(params.sqrtStartPrice)} shares per contract`);
  row("migrationQuoteThreshold", params.migrationQuoteThreshold.toString(), `${rawToUi(params.migrationQuoteThreshold, QUOTE_DECIMALS)} shares taken in before graduation`);
  row("tokenSupply.preMigration", params.tokenSupply?.preMigrationTokenSupply.toString() ?? "null", params.tokenSupply ? `${rawToUi(params.tokenSupply.preMigrationTokenSupply, BASE_DECIMALS)} contracts, fixed supply` : "");
  row("tokenSupply.postMigration", params.tokenSupply?.postMigrationTokenSupply.toString() ?? "null");
  row("poolCreationFee", params.poolCreationFee.toString(), "lamports");

  lines.push("liquidity distribution at graduation (must sum to 100)");
  row("partnerLiquidityPercentage", String(params.partnerLiquidityPercentage));
  row("partnerPermanentLockedLiquidityPercentage", String(params.partnerPermanentLockedLiquidityPercentage));
  row("creatorLiquidityPercentage", String(params.creatorLiquidityPercentage));
  row("creatorPermanentLockedLiquidityPercentage", String(params.creatorPermanentLockedLiquidityPercentage), "DBC floor is 10%");
  row("creatorTradingFeePercentage", String(params.creatorTradingFeePercentage), "share of trading fees to the writer's vault");
  row("migrationFee", JSON.stringify(toJson(params.migrationFee)));
  row("migratedPoolFee", JSON.stringify(toJson(params.migratedPoolFee)));
  row("lockedVesting", JSON.stringify(toJson(params.lockedVesting)));

  lines.push(`curve (${params.curve.length} points, sqrtPrice ascending)`);
  lines.push("    #   sqrtPrice (Q64)                       liquidity                                 shares/contract");
  params.curve.forEach((point, i) => {
    lines.push(
      `   ${String(i).padStart(2)}   ${point.sqrtPrice.toString().padStart(24)}   ${point.liquidity.toString().padStart(34)}   ${sharesPerContract(point.sqrtPrice)}`,
    );
  });

  return lines.join("\n");
}

export const FEE_DENOMINATOR_VALUE = FEE_DENOMINATOR;
