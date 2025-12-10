import "dotenv/config";
import { addresses } from "../contracts/addresses";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

export const config = {
  awsRegion: process.env.AWS_REGION || "us-east-1",
  rpcUrl: required("RPC_URL"),
  chainId: Number(required("CHAIN_ID")),
  payerPrivateKey: required("PAYER_PRIVATE_KEY"),
  contract: {
    // Read canonical addresses from contracts/addresses.ts
    slsPayer: addresses.SLSPayer,
    factory: addresses.SLSburnVaultFactory,
    backingToken: addresses.WBTCMock,
    burnVault: addresses.EVABurnVault,
  },
  tables: {
    paymentRuns: required("PAYMENT_RUNS_TABLE"),
    incomeDistributions: required("INCOME_DISTRIBUTIONS_TABLE"),
    legacyPayouts: required("LEGACY_PAYOUTS_TABLE"),
  },
};

