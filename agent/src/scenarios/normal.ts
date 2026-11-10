/** The boring, happy path: a well-behaved agent buying what it is meant to buy. */
import { near, AgentVaultClient } from "../near.js";
import type { Env } from "../env.js";
import * as ui from "../ui.js";
import { showLog, showVaultState, waitForSettlement } from "./common.js";

export const description = "A well-behaved agent buys API credits from an allowlisted merchant";

export async function run(env: Env): Promise<void> {
  const client = new AgentVaultClient(env);

  ui.title("Scenario: normal operation");
  await showVaultState(client);

  ui.section("Payments");
  const purchases = [
    { amount: "0.25", memo: "api credits - batch 1" },
    { amount: "0.4", memo: "api credits - batch 2" },
  ];

  let lastLogId: string | undefined;
  for (const p of purchases) {
    const amountYocto = near.toYocto(p.amount);
    const result = await client.requestPayment(env.merchantId, amountYocto, p.memo);
    ui.paymentLine(p.memo, env.merchantId, amountYocto, result);
    if (result.decision !== "approved") {
      ui.fail(`expected approval, got ${result.decision}: ${result.reason}`);
      process.exitCode = 1;
      return;
    }
    lastLogId = result.log_id ?? lastLogId;
  }

  if (lastLogId) {
    ui.section("Settlement");
    ui.note("the transfer settles in a later receipt; waiting for the callback...");
    const settled = await waitForSettlement(client, lastLogId);
    if (settled?.decision === "executed") {
      ui.ok(`transfer settled: ${settled.reason}`);
    } else if (settled?.decision === "failed") {
      ui.fail(`transfer failed: ${settled.reason}`);
      process.exitCode = 1;
    } else {
      ui.note("still settling — check the dashboard or re-run to see the executed entry");
    }
  }

  await showLog(client, 8);

  const agent = await client.getAgent(client.accountId);
  if (agent) {
    ui.section("Budget");
    ui.kv("spent today", `${near.fmt(agent.spent_in_window)} of ${near.fmt(agent.daily_limit)}`);
    ui.kv("remaining", near.fmt(agent.remaining_today));
  }
}
