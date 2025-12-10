import crypto from "crypto";
import { z } from "zod";
import { ethers } from "ethers";
import { config } from "./config";
import { getFactoryContract, getSlsPayerContract, getWallet } from "./clients/ethers";
import {
  putPaymentRun,
  updatePaymentRun,
  getDistribution,
  putDistribution,
  scanDistributions,
  queryLegacyByDate,
  queryDistributionsByMonth,
} from "./clients/dynamo";
import { ExecutePaymentInput, IncomeDistribution, MiningPayout, PaymentRun } from "./types";

const executeSchema = z.object({
  date: z.string(),
  miningPayouts: z
    .array(
      z.object({
        payoutNumber: z.number(),
        amountBtc: z.string(),
        btcTxHash: z.string(),
        walletFrom: z.string().optional(),
        destination: z.string().optional(),
        blockNumber: z.number().optional(),
        memo: z.string().optional(),
      })
    )
    .nonempty(),
  slsShareBps: z.number().int().min(0).max(10_000),
  increaseSLS: z.boolean(),
  additionalEva: z.string(),
  amount: z.string(),
  callerId: z.string().optional(),
  idempotencyKey: z.string().optional(),
  dryRun: z.boolean().optional(),
});

function sumBtc(payouts: MiningPayout[]) {
  return payouts
    .reduce((acc, p) => acc + Number(p.amountBtc), 0)
    .toString();
}

function now() {
  return Date.now();
}

function hashPayload(obj: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

function deriveAmounts(amountWei: bigint, slsShareBps: number) {
  const slsAmount = (amountWei * BigInt(slsShareBps)) / 10_000n;
  const burnAmount = amountWei - slsAmount;
  return { slsAmount, burnAmount };
}

function normalizeDate(dateStr: string) {
  return dateStr.slice(0, 10);
}

function yearMonthFromDate(dateStr: string) {
  return normalizeDate(dateStr).slice(0, 7);
}

function mapLegacy(date: string, raw: any): MiningPayout {
  return {
    payoutNumber: raw.payoutNumber || 0,
    amountBtc: (raw.pago ?? raw.amountBtc ?? "0").toString(),
    btcTxHash: raw.txHash || raw.btcTxHash || "",
    walletFrom: raw.walletFrom,
    destination: raw.destination || "burnVault",
    blockNumber: raw.blockNumber,
    memo: raw.arbHash || raw.memo,
    legacy: true,
  };
}

export async function executePayment(input: ExecutePaymentInput) {
  const parsed = executeSchema.parse(input);
  const runId = parsed.idempotencyKey || crypto.randomUUID();
  const requestPayloadHash = hashPayload(parsed);

  const wallet = getWallet();
  const payer = getSlsPayerContract(wallet);
  const factory = getFactoryContract(wallet);

  const activeVault: string = await factory.activeVault();
  const hasActiveVault = activeVault && activeVault !== ethers.ZeroAddress;
  const route = hasActiveVault ? "normal" : "burn_only_no_active_vault";
  const effectiveSlsShare = hasActiveVault ? parsed.slsShareBps : 0;
  const effectiveIncrease = hasActiveVault ? parsed.increaseSLS : false;

  const amountWei = BigInt(parsed.amount);
  const { slsAmount, burnAmount } = deriveAmounts(amountWei, effectiveSlsShare);
  const startedAt = now();

  const paymentRun: PaymentRun = {
    runId,
    status: "pending",
    startedAt,
    chainId: config.chainId,
    payerAddress: wallet.address,
    backingToken: config.contract.backingToken,
    burnVault: config.contract.burnVault,
    activeVaultAtRun: hasActiveVault ? activeVault : ethers.ZeroAddress,
    slsShareBps: parsed.slsShareBps,
    increaseSLS: parsed.increaseSLS,
    effectiveSlsShareBps: effectiveSlsShare,
    effectiveIncreaseSLS: effectiveIncrease,
    route,
    additionalEva: parsed.additionalEva,
    amount: parsed.amount,
    burnAmount: burnAmount.toString(),
    slsAmount: slsAmount.toString(),
    callerId: parsed.callerId,
    requestPayloadHash,
    btcPayouts: parsed.miningPayouts,
    btcTotalIncome: sumBtc(parsed.miningPayouts),
  };

  await putPaymentRun(paymentRun);

  if (parsed.dryRun) {
    return { ...paymentRun, status: "pending", dryRun: true };
  }

  try {
    const tx = await payer.pay(parsed.amount, effectiveSlsShare, effectiveIncrease, parsed.additionalEva);
    await updatePaymentRun(runId, { txHash: tx.hash });
    const receipt = await tx.wait();
    const completedAt = now();
    await updatePaymentRun(runId, { status: "success", completedAt });

    await upsertDistribution(parsed.date, parsed.miningPayouts, paymentRun.btcTotalIncome!, runId, tx.hash);

    return {
      ...paymentRun,
      status: "success",
      txHash: tx.hash,
      completedAt,
      effectiveSlsShare,
      effectiveIncrease,
      receipt,
    };
  } catch (err: any) {
    const completedAt = now();
    await updatePaymentRun(runId, {
      status: "failed",
      completedAt,
      error: err?.message || "payment failed",
    });
    throw err;
  }
}

async function upsertDistribution(
  date: string,
  miningPayouts: MiningPayout[],
  btcTotalIncome: string,
  runId: string,
  txHash: string
) {
  const normalizedDate = normalizeDate(date);
  const yearMonth = yearMonthFromDate(date);
  const existing = await getDistribution(normalizedDate);
  const nowTs = now();
  const mergedPayouts = [...(existing?.miningPayouts || []), ...miningPayouts];
  const mergedTotal = (
    Number(existing?.totalBTCIncome || 0) + Number(btcTotalIncome)
  ).toString();

  const item: IncomeDistribution = {
    date: normalizedDate,
    yearMonth,
    miningPayouts: mergedPayouts,
    totalBTCIncome: mergedTotal,
    burnVaultCore: existing?.burnVaultCore,
    bvBoost: existing?.bvBoost,
    breakdown: existing?.breakdown,
    paymentRunId: runId,
    paymentTxHash: txHash,
    createdAt: existing?.createdAt || nowTs,
    updatedAt: nowTs,
  };
  await putDistribution(item);
}

export async function getIncomeDistributionWithLegacy(date: string) {
  const normalizedDate = normalizeDate(date);
  const base = (await getDistribution(normalizedDate)) || {
    date: normalizedDate,
    totalBTCIncome: "0",
    miningPayouts: [],
    createdAt: now(),
    updatedAt: now(),
  };

  const legacyItems = await queryLegacyByDate(normalizedDate);
  const legacyPayouts = legacyItems.map((l) => mapLegacy(normalizedDate, l));
  const total = (Number(base.totalBTCIncome) + Number(sumBtc(legacyPayouts))).toString();

  return {
    ...base,
    miningPayouts: [...base.miningPayouts, ...legacyPayouts],
    totalBTCIncome: total,
  };
}

export async function getIncomeHistory(params: { startDate?: string; endDate?: string; page?: number; limit?: number }) {
  const { startDate, endDate } = params;
  const page = params.page && params.page > 0 ? params.page : 1;
  const limit = params.limit && params.limit > 0 ? params.limit : 10;

  const ymStart = startDate ? yearMonthFromDate(startDate) : undefined;
  const ymEnd = endDate ? yearMonthFromDate(endDate) : ymStart;

  let collected: IncomeDistribution[] = [];
  let lastKey: any | undefined;
  let months: string[] = [];

  if (ymStart && ymEnd && ymStart !== ymEnd) {
    // Range across months: assemble list (naive, but bounded by usage)
    const [startY, startM] = ymStart.split("-").map((v) => Number(v));
    const [endY, endM] = ymEnd.split("-").map((v) => Number(v));
    for (let y = startY; y <= endY; y++) {
      const mStart = y === startY ? startM : 1;
      const mEnd = y === endY ? endM : 12;
      for (let m = mStart; m <= mEnd; m++) {
        months.push(`${y.toString().padStart(4, "0")}-${m.toString().padStart(2, "0")}`);
      }
    }
  } else if (ymStart) {
    months = [ymStart];
  }

  if (months.length) {
    for (const ym of months) {
      const { items } = await queryDistributionsByMonth(ym, 500);
      collected.push(...items);
    }
  } else {
    const scanRes = await scanDistributions();
    collected = scanRes.items;
  }

  if (startDate) collected = collected.filter((i) => i.date >= normalizeDate(startDate));
  if (endDate) collected = collected.filter((i) => i.date <= normalizeDate(endDate));

  collected.sort((a, b) => (a.date < b.date ? 1 : -1));

  const start = (page - 1) * limit;
  const slice = collected.slice(start, start + limit);

  const withLegacy = await Promise.all(slice.map((item) => getIncomeDistributionWithLegacy(item.date)));

  return {
    distributions: withLegacy,
    pagination: {
      currentPage: page,
      totalPages: Math.ceil(collected.length / limit),
      totalItems: collected.length,
    },
  };
}

