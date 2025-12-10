export interface MiningPayout {
  payoutNumber: number;
  amountBtc: string;
  btcTxHash: string;
  walletFrom?: string;
  destination?: string;
  blockNumber?: number;
  memo?: string;
  legacy?: boolean;
}

export interface PaymentRun {
  runId: string;
  status: "pending" | "success" | "failed";
  txHash?: string;
  chainId?: number;
  payerAddress?: string;
  backingToken?: string;
  burnVault?: string;
  activeVaultAtRun?: string;
  slsShareBps?: number;
  increaseSLS?: boolean;
  effectiveSlsShareBps?: number;
  effectiveIncreaseSLS?: boolean;
  route?: "normal" | "burn_only_no_active_vault";
  additionalEva?: string;
  amount?: string;
  burnAmount?: string;
  slsAmount?: string;
  startedAt: number;
  completedAt?: number;
  error?: string;
  callerId?: string;
  requestPayloadHash?: string;
  btcPayouts?: MiningPayout[];
  btcTotalIncome?: string;
  notes?: string;
}

export interface IncomeDistribution {
  date: string; // YYYY-MM-DD
  yearMonth?: string; // YYYY-MM for GSI
  totalBTCIncome: string;
  miningPayouts: MiningPayout[];
  burnAmount?: string;
  slsAmount?: string;
  paymentTxHash?: string;
  burnVaultCore?: Array<{
    amount: string;
    txHash: string;
    percentage: string;
  }>;
  bvBoost?: Array<{
    amount: string;
    txHash: string;
    percentage: string;
  }>;
  breakdown?: {
    miningTotal?: string;
    miningPercentage?: string;
    corePercentage?: string;
    boostPercentage?: string;
  };
  paymentRunId?: string;
  paymentTxHash?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ExecutePaymentInput {
  date: string;
  miningPayouts: MiningPayout[];
  slsShareBps: number;
  increaseSLS: boolean;
  additionalEva: string;
  amount: string;
  callerId?: string;
  idempotencyKey?: string;
  dryRun?: boolean;
}

