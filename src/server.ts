import express from "express";
import cors from "cors";
import { executePayment, getIncomeDistributionWithLegacy, getIncomeHistory } from "./payments";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.post("/api/payments/execute", async (req, res) => {
  try {
    const result = await executePayment(req.body);
    res.json(result);
  } catch (err: any) {
    console.error("POST /api/payments/execute error", err?.message, err);
    res.status(400).json({ error: err?.message || "execution failed" });
  }
});

app.get("/api/income/history", async (req, res) => {
  try {
    const { startDate, endDate, page, limit } = req.query;
    const result = await getIncomeHistory({
      startDate: startDate as string | undefined,
      endDate: endDate as string | undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || "history fetch failed" });
  }
});

app.get("/api/income/distribution/:date", async (req, res) => {
  try {
    const result = await getIncomeDistributionWithLegacy(req.params.date);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || "distribution fetch failed" });
  }
});

app.get("/api/price/current", (_req, res) => {
  // Static mock response; replace with real pricing feeds when available.
  const payload = {
    timestamp: new Date().toISOString(),
    bvBoostBurnPrice: {
      usd: "17.50",
      sats: "500000",
    },
    marketPrice: {
      usd: "22.75",
      sats: "650000",
    },
    btcPrice: {
      usd: "95000.00",
    },
    premium: {
      percentage: "30.00",
      usd: "5.25",
    },
  };
  res.json(payload);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`API listening on :${port}`);
});

