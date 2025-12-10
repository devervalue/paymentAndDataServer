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
  scanAllDistributions,
  scanAllLegacy,
  queryAllLegacyByDate,
  queryAllDistributionsByMonth,
  queryAllLegacyByMonth,
  getPaymentRun,
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
  // Optional: if omitted, we derive from miningPayouts as BTC total converted to backing token units.
  amount: z.string().optional(),
  callerId: z.string().optional(),
  idempotencyKey: z.string().optional(),
  dryRun: z.boolean().optional(),
});

function sumBtc(payouts: MiningPayout[]) {
  return payouts
    .reduce((acc, p) => acc + Number(p.amountBtc), 0)
    .toString();
}

// Backing token decimals (WBTC mock uses 8 decimals)
const BACKING_DECIMALS = 8;

function parseAmountToUnits(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  if (!trimmed) throw new Error("amount is empty");
  const [wholeStr, fracStrRaw = ""] = trimmed.split(".");
  if (!/^\d+$/.test(wholeStr || "0") || !/^\d*$/.test(fracStrRaw)) {
    throw new Error("invalid amount format");
  }
  if (fracStrRaw.length > decimals) {
    throw new Error(`too many decimal places (max ${decimals})`);
  }
  const fracStr = fracStrRaw.padEnd(decimals, "0");
  const combined = `${wholeStr || "0"}${fracStr}`;
  return BigInt(combined);
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

function mapLegacy(date: string, raw: any, idx?: number): MiningPayout {
  return {
    payoutNumber: raw.payoutNumber ?? idx ?? 0,
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

  const btcTotalIncome = sumBtc(parsed.miningPayouts);
  const derivedAmountWei = parsed.amount
    ? BigInt(parsed.amount)
    : parseAmountToUnits(btcTotalIncome, BACKING_DECIMALS);
  if (derivedAmountWei <= 0) throw new Error("amount must be greater than zero");

  const amountWei = derivedAmountWei;
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
    amount: amountWei.toString(),
    burnAmount: burnAmount.toString(),
    slsAmount: slsAmount.toString(),
    callerId: parsed.callerId,
    requestPayloadHash,
    btcPayouts: parsed.miningPayouts,
    btcTotalIncome,
  };

  await putPaymentRun(paymentRun);

  if (parsed.dryRun) {
    return { ...paymentRun, status: "pending", dryRun: true };
  }

  try {
    const tx = await payer.pay(amountWei, effectiveSlsShare, effectiveIncrease, parsed.additionalEva);
    await updatePaymentRun(runId, { txHash: tx.hash });
    const receipt = await tx.wait();
    const completedAt = now();
    await updatePaymentRun(runId, { status: "success", completedAt });

    await upsertDistribution(
      parsed.date,
      parsed.miningPayouts,
      paymentRun.btcTotalIncome!,
      runId,
      tx.hash,
      paymentRun.burnAmount!,
      paymentRun.slsAmount!
    );

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
    console.error("executePayment failed", err?.message, err);
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
  txHash: string,
  burnAmount: string,
  slsAmount: string
) {
  const normalizedDate = normalizeDate(date);
  const yearMonth = yearMonthFromDate(date);
  const existing = await getDistribution(normalizedDate);
  const nowTs = now();
  const mergedPayouts = [...(existing?.miningPayouts || []), ...miningPayouts];
  const mergedTotal = (
    Number(existing?.totalBTCIncome || 0) + Number(btcTotalIncome)
  ).toString();

  const totalNum = Number(mergedTotal || "0");
  const burnNum = Number(burnAmount || "0");
  const slsNum = Number(slsAmount || "0");
  const miningTotal = mergedPayouts.reduce(
    (acc, p) => acc + Number((p as any).amount || (p as any).amountBtc || "0"),
    0
  );
  const pct = (part: number) => (totalNum > 0 ? ((part / totalNum) * 100).toFixed(2) : "0");

  const item: IncomeDistribution = {
    date: normalizedDate,
    yearMonth,
    miningPayouts: mergedPayouts,
    totalBTCIncome: mergedTotal,
    burnAmount: burnAmount.toString(),
    slsAmount: slsAmount.toString(),
    burnVaultCore: [
      {
        amount: burnAmount.toString(),
        txHash,
        percentage: pct(burnNum),
      },
    ],
    bvBoost:
      slsNum > 0
        ? [
            {
              amount: slsAmount.toString(),
              txHash,
              percentage: pct(slsNum),
            },
          ]
        : [],
    breakdown: {
      miningTotal: miningTotal.toString(),
      miningPercentage: pct(miningTotal),
      corePercentage: pct(burnNum),
      boostPercentage: pct(slsNum),
    },
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
  const baseYearMonth = base.yearMonth || yearMonthFromDate(normalizedDate);
  const basePaymentTxHash = (base as any).paymentTxHash || "";
  const basePaymentRunId = (base as any).paymentRunId || "";
  let inferredBurnAmount = base.totalBTCIncome || "0";
  let inferredSlsAmount = "0";

  // Pull legacy items by date; if none, fallback to month query then filter
  let legacyItems = await queryAllLegacyByDate(normalizedDate);
  if (!legacyItems.length) {
    const ym = yearMonthFromDate(normalizedDate);
    const monthly = await queryAllLegacyByMonth(ym);
    legacyItems = monthly.filter((m) => normalizeDate(m.date) === normalizedDate);
  }

  const legacyPayouts = legacyItems.map((l, idx) => mapLegacy(normalizedDate, l, idx));
  const total = (Number(base.totalBTCIncome) + Number(sumBtc(legacyPayouts))).toString();

  const mergedPayouts = [...base.miningPayouts, ...legacyPayouts].map((p, idx) => ({
    payoutNumber: p.payoutNumber ?? idx,
    amount: p.amountBtc,
    txHash: p.btcTxHash,
    destination: p.destination || "EVA",
  }));

  const miningTotal = mergedPayouts.reduce((acc, p) => acc + Number(p.amount || "0"), 0).toString();

  // Build burnVaultCore and bvBoost as arrays
  const totalNum = Number(total || "0");
  const pct = (part: number) => (totalNum > 0 ? ((part / totalNum) * 100).toFixed(2) : "0");

  const legacyCoreList =
    legacyPayouts.length > 0
      ? legacyPayouts.map((p) => ({
          amount: p.amountBtc,
          txHash: p.memo || p.btcTxHash || "",
          percentage: pct(Number(p.amountBtc || "0")),
        }))
      : [];

  // Merge legacy burn entries with any stored burnVaultCore (keeping all per-transaction items)
  let burnVaultCore = [
    ...(legacyCoreList || []),
    ...(Array.isArray(base.burnVaultCore)
      ? base.burnVaultCore
      : base.burnVaultCore
      ? [base.burnVaultCore]
      : []),
  ];
  if (!Array.isArray(burnVaultCore)) burnVaultCore = burnVaultCore ? [burnVaultCore] : [];

  let bvBoost = base.bvBoost || [];
  if (!Array.isArray(bvBoost)) bvBoost = bvBoost ? [bvBoost] : [];

  // Try to enrich from payment run when bvBoost is empty (new data split)
  if (bvBoost.length === 0 && basePaymentRunId) {
    try {
      const pr = await getPaymentRun(basePaymentRunId);
      if (pr) {
        if (pr.burnAmount) inferredBurnAmount = pr.burnAmount;
        if (pr.slsAmount) inferredSlsAmount = pr.slsAmount;
        if (pr.txHash && inferredSlsAmount !== "0") {
          bvBoost = [
            {
              amount: inferredSlsAmount,
              txHash: pr.txHash,
              percentage:
                Number(total || "0") > 0
                  ? ((Number(inferredSlsAmount || "0") / Number(total || "0")) * 100).toFixed(2)
                  : "0",
            },
          ];
        }
        if (burnVaultCore.length === 0 && pr.txHash) {
          const burnAmt = inferredBurnAmount || base.totalBTCIncome || total;
          burnVaultCore = [
            {
              amount: burnAmt,
              txHash: pr.txHash,
              percentage:
                Number(total || "0") > 0
                  ? ((Number(burnAmt || "0") / Number(total || "0")) * 100).toFixed(2)
                  : "0",
            },
          ];
        }
      }
    } catch (e) {
      // best-effort; ignore fetch errors
    }
  }

  // Legacy fallback (only if still empty)
  if (burnVaultCore.length === 0 && basePaymentTxHash) {
    const burnAmount = base.totalBTCIncome || total;
    const burnPct =
      Number(total || "0") > 0 ? ((Number(burnAmount || "0") / Number(total || "0")) * 100).toFixed(2) : "0";
    burnVaultCore = [
      {
        amount: burnAmount,
        txHash: basePaymentTxHash,
        percentage: burnPct,
      },
    ];
  }

  if (bvBoost.length === 0 && basePaymentTxHash && base.slsAmount) {
    const boostPct =
      Number(total || "0") > 0 ? ((Number(base.slsAmount || "0") / Number(total || "0")) * 100).toFixed(2) : "0";
    bvBoost = [
      {
        amount: base.slsAmount,
        txHash: basePaymentTxHash,
        percentage: boostPct,
      },
    ];
  }

  // Derive breakdown percentages from amounts if available
  const coreAmountNum = burnVaultCore.reduce((acc, b) => acc + Number(b.amount || "0"), 0);
  const boostAmountNum = bvBoost.reduce((acc, b) => acc + Number(b.amount || "0"), 0);
  const miningNum = Number(miningTotal || "0");

  return {
    date: normalizedDate,
    yearMonth: baseYearMonth,
    totalBTCIncome: total,
    miningPayouts: mergedPayouts,
    burnVaultCore,
    bvBoost,
    breakdown: {
      miningTotal,
      miningPercentage: pct(miningNum),
      corePercentage: pct(coreAmountNum || (burnVaultCore[0]?.percentage ? (Number(burnVaultCore[0].percentage) / 100) * totalNum : 0)),
      boostPercentage: pct(boostAmountNum || (bvBoost[0]?.percentage ? (Number(bvBoost[0].percentage) / 100) * totalNum : 0)),
    },
  };
}

export async function getIncomeHistory(params: { startDate?: string; endDate?: string; page?: number; limit?: number }) {
  const { startDate, endDate } = params;
  const page = params.page && params.page > 0 ? params.page : 1;
  const limit = params.limit && params.limit > 0 ? params.limit : 10;

  const ymStart = startDate ? yearMonthFromDate(startDate) : undefined;
  const ymEnd = endDate ? yearMonthFromDate(endDate) : ymStart;

  let collected: IncomeDistribution[] = [];
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

  const rangeMonths = () => {
    if (!months.length) {
      // Default: last 3 months if no range provided
      const today = new Date();
      const ymList: string[] = [];
      for (let i = 0; i < 3; i++) {
        const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
        ymList.push(`${d.getUTCFullYear().toString().padStart(4, "0")}-${(d.getUTCMonth() + 1).toString().padStart(2, "0")}`);
      }
      return ymList;
    }
    return months;
  };

  const targetMonths = rangeMonths();

  // Pull distributions by month
  for (const ym of targetMonths) {
    const items = await queryAllDistributionsByMonth(ym);
    collected.push(...items);
  }

  // Build a set of dates already present in income-distributions
  const baseDates = new Set(collected.map((i) => normalizeDate(i.date)));

  // Pull legacy by month (no full scan)
  const legacyByDate: Record<string, any[]> = {};
  for (const ym of targetMonths) {
    const legItems = await queryAllLegacyByMonth(ym);
    for (const item of legItems) {
      const d = normalizeDate(item.date);
      legacyByDate[d] = legacyByDate[d] || [];
      legacyByDate[d].push(item);
    }
  }

  // Create stub distributions for legacy-only dates not in base
  const legacyOnly: IncomeDistribution[] = Object.entries(legacyByDate)
    .filter(([d]) => !baseDates.has(d))
    .map(([d, items]) => {
      const payouts = items.map((l) => mapLegacy(d, l));
      const total = sumBtc(payouts);
      const burnVaultCore = payouts.map((p) => ({
        amount: p.amountBtc,
        txHash: p.memo || p.btcTxHash || "",
        percentage: "100",
      }));
      return {
        date: d,
        yearMonth: yearMonthFromDate(d),
        miningPayouts: payouts,
        totalBTCIncome: total,
        burnAmount: total,
        slsAmount: "0",
        burnVaultCore,
        bvBoost: [],
        breakdown: {
          miningTotal: total,
          miningPercentage: "100",
          corePercentage: "100",
          boostPercentage: "0",
        },
        createdAt: now(),
        updatedAt: now(),
      };
    });

  // Normalize date filter
  const startNorm = startDate ? normalizeDate(startDate) : undefined;
  const endNorm = endDate ? normalizeDate(endDate) : undefined;

  let merged = [...collected, ...legacyOnly];
  if (startNorm) merged = merged.filter((i) => i.date >= startNorm);
  if (endNorm) merged = merged.filter((i) => i.date <= endNorm);

  merged.sort((a, b) => (a.date < b.date ? 1 : -1));

  const startIdx = (page - 1) * limit;
  const slice = merged.slice(startIdx, startIdx + limit);

  const withLegacy = await Promise.all(slice.map((item) => getIncomeDistributionWithLegacy(item.date)));

  return {
    distributions: withLegacy,
    pagination: {
      currentPage: page,
      totalPages: Math.ceil(merged.length / limit),
      totalItems: merged.length,
    },
  };
}

