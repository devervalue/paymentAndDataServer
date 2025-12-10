// Utility script to create DynamoDB tables for payments, income distributions, and legacy payouts.
// Run with: ts-node scripts/createTables.ts (or compile to JS and run with node).
// Prereq: npm install @aws-sdk/client-dynamodb

import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";

const region = process.env.AWS_REGION || "us-east-1";
const client = new DynamoDBClient({ region });

async function createPaymentRuns() {
  await client.send(
    new CreateTableCommand({
      TableName: "payment-runs",
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "runId", AttributeType: "S" },
        { AttributeName: "txHash", AttributeType: "S" },
      ],
      KeySchema: [{ AttributeName: "runId", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [
        {
          IndexName: "txHash-index",
          KeySchema: [
            { AttributeName: "txHash", KeyType: "HASH" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ],
    })
  );
}

async function createIncomeDistributions() {
  await client.send(
    new CreateTableCommand({
      TableName: "income-distributions",
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "date", AttributeType: "S" },
        { AttributeName: "yearMonth", AttributeType: "S" } // add this
      ],
      KeySchema: [{ AttributeName: "date", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [
        {
          IndexName: "yearMonth-index",
          KeySchema: [
            { AttributeName: "yearMonth", KeyType: "HASH" },
            { AttributeName: "date", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ],
    })
  );
}

async function createLegacyPayouts() {
  await client.send(
    new CreateTableCommand({
      TableName: "legacy-btc-payouts",
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "runId", AttributeType: "S" },
        { AttributeName: "txHash", AttributeType: "S" },
        { AttributeName: "date", AttributeType: "S" },
        { AttributeName: "tstamp", AttributeType: "N" },
        { AttributeName: "yearMonth", AttributeType: "S" },
      ],
      KeySchema: [{ AttributeName: "runId", KeyType: "HASH" }],
      GlobalSecondaryIndexes: [
        {
          // Lookup by txHash; SK allows duplicate txHash values across multiple legacy entries.
          IndexName: "txHash-index",
          KeySchema: [
            { AttributeName: "txHash", KeyType: "HASH" },
            { AttributeName: "runId", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
        {
          // Query by date and order by timestamp within the date.
          IndexName: "date-index",
          KeySchema: [
            { AttributeName: "date", KeyType: "HASH" },
            { AttributeName: "tstamp", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
        {
          IndexName: "yearMonth-index",
          KeySchema: [
            { AttributeName: "yearMonth", KeyType: "HASH" },
            { AttributeName: "date", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ],
    })
  );
}

async function main() {
  await createPaymentRuns();
  console.log("Created payment-runs");
  await createIncomeDistributions();
  console.log("Created income-distributions");
  await createLegacyPayouts();
  console.log("Created legacy-btc-payouts");
}

main().catch((err) => {
  console.error("Table creation failed:", err);
  process.exit(1);
});

