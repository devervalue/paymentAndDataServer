// Fetch legacy payout data from the public endpoint and populate legacy-btc-payouts table.
// Run with: npx ts-node scripts/fetchLegacy.ts
// Requires: AWS creds with write to legacy table, env AWS_REGION and LEGACY_PAYOUTS_TABLE

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import fetch from "node-fetch";
import crypto from "crypto";
import "dotenv/config";

const LEGACY_URL = "https://api.evervaluecoin.com/getDailyPayments";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const region = process.env.AWS_REGION || "us-east-1";
const table = required("LEGACY_PAYOUTS_TABLE");
const client = new DynamoDBClient({ region });
const doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });

function toDate(ts: number) {
  return new Date(ts).toISOString().slice(0, 10);
}
function toYearMonth(ts: number) {
  return new Date(ts).toISOString().slice(0, 7);
}

function satsToBtcString(n: number | string) {
  const bi = BigInt(n);
  const whole = bi / 100_000_000n;
  const frac = bi % 100_000_000n;
  const fracStr = frac.toString().padStart(8, "0").replace(/0+$/, "");
  return fracStr.length ? `${whole}.${fracStr}` : whole.toString();
}

async function main() {
  const resp = await fetch(LEGACY_URL);
  if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
  const data = await resp.json();
  const items = Array.isArray(data?.body) ? data.body : [];
  console.log(`Fetched ${items.length} legacy payouts`);

  for (const entry of items) {
    const ts = Number(entry.tstamp || entry.btcBlockTime);
    const date = toDate(ts);
    const yearMonth = toYearMonth(ts);
    const runId = crypto.randomUUID();
    const amountSats = entry.pago ?? 0;
    const amountBtc = satsToBtcString(amountSats);

    const item = {
      runId,
      txHash: entry.txHash,
      arbHash: entry.arbHash,
      tstamp: ts,
      date,
      yearMonth,
      isPayed: entry.isPayed,
      amountSats: amountSats.toString(),
      amountBtc,
      walletFrom: entry.walletFrom,
      destination: entry.destination || "burnVault",
      btcBlockTime: entry.btcBlockTime,
      memo: entry.memo,
    };

    await doc.send(
      new PutCommand({
        TableName: table,
        Item: item,
      })
    );
  }
  console.log("Legacy import complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

