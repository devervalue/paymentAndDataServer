import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { config } from "../config";
import { IncomeDistribution, PaymentRun } from "../types";

const ddb = new DynamoDBClient({ region: config.awsRegion });
export const docClient = DynamoDBDocumentClient.from(ddb, { marshallOptions: { removeUndefinedValues: true } });

export async function putPaymentRun(item: PaymentRun) {
  await docClient.send(
    new PutCommand({
      TableName: config.tables.paymentRuns,
      Item: item,
    })
  );
}

export async function updatePaymentRun(runId: string, updates: Partial<PaymentRun>) {
  const ExpressionAttributeNames: Record<string, string> = {};
  const ExpressionAttributeValues: Record<string, unknown> = {};
  const setParts: string[] = [];
  Object.entries(updates).forEach(([k, v], idx) => {
    const nameKey = `#k${idx}`;
    const valueKey = `:v${idx}`;
    ExpressionAttributeNames[nameKey] = k;
    ExpressionAttributeValues[valueKey] = v;
    setParts.push(`${nameKey} = ${valueKey}`);
  });
  if (!setParts.length) return;
  await docClient.send(
    new UpdateCommand({
      TableName: config.tables.paymentRuns,
      Key: { runId },
      UpdateExpression: `SET ${setParts.join(", ")}`,
      ExpressionAttributeNames,
      ExpressionAttributeValues,
    })
  );
}

export async function getDistribution(date: string) {
  const res = await docClient.send(
    new GetCommand({
      TableName: config.tables.incomeDistributions,
      Key: { date },
    })
  );
  return res.Item as IncomeDistribution | undefined;
}

export async function putDistribution(item: IncomeDistribution) {
  await docClient.send(
    new PutCommand({
      TableName: config.tables.incomeDistributions,
      Item: item,
    })
  );
}

export async function scanDistributions(startDate?: string, endDate?: string) {
  // Fallback scan (not preferred). Used when no date range is provided.
  const res = await docClient.send(
    new ScanCommand({
      TableName: config.tables.incomeDistributions,
    })
  );
  return {
    items: (res.Items || []) as IncomeDistribution[],
    lastEvaluatedKey: res.LastEvaluatedKey,
  };
}

export async function queryLegacyByDate(date: string) {
  const res = await docClient.send(
    new QueryCommand({
      TableName: config.tables.legacyPayouts,
      IndexName: "date-index",
      KeyConditionExpression: "#d = :date",
      ExpressionAttributeNames: { "#d": "date" },
      ExpressionAttributeValues: { ":date": date },
    })
  );
  return res.Items || [];
}

export async function queryDistributionsByMonth(
  yearMonth: string,
  limit: number,
  startKey?: Record<string, unknown>
) {
  const res = await docClient.send(
    new QueryCommand({
      TableName: config.tables.incomeDistributions,
      IndexName: "yearMonth-index",
      KeyConditionExpression: "#ym = :ym",
      ExpressionAttributeNames: { "#ym": "yearMonth" },
      ExpressionAttributeValues: { ":ym": yearMonth },
      Limit: limit,
      ExclusiveStartKey: startKey,
    })
  );
  return {
    items: (res.Items || []) as IncomeDistribution[],
    lastEvaluatedKey: res.LastEvaluatedKey,
  };
}

