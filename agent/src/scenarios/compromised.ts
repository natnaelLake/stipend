/**
 * The core demo: an attacker has the agent's key and tries to drain the vault.
 *
 * Deliberately contains no LLM. Everything here is a direct, deterministic
 * sequence of signed calls, which is exactly what a stolen key gives an
 * attacker — and which is why this scenario reproduces identically every run.
 */
import { near, AgentVaultClient } from "../near.js";
import type { Env } from "../env.js";
import * as ui from "../ui.js";
import { showLog, showVaultState } from "./common.js";

export const description = "Attacker holds the agent key and tries to drain the vault";

export async function run(env: Env): Promise<void> {
  const client = new AgentVaultClient(env);

  ui.title("Scenario: compromised agent");
  ui.note("The agent's key has been stolen. The attacker can sign request_payment");
  ui.note("as the agent. Everything below is signed with that key.");

  await showVaultState(client);
  const before = await client.getBalance();

  ui.section("Drain attempts");

  const attempts = [
    {
      step: "1. Take everything at once",
      recipient: env.merchantId,
      amount: "15",
      memo: "urgent supplier settlement",
    },
    {
      step: "2. Send it somewhere the owner blocked",
      recipient: env.attackerId,
      amount: "0.1",
      memo: "account verification fee",
    },
    {
      step: "3. Pay the agent's own account and withdraw later",
      recipient: env.agentId,
      amount: "0.1",
      memo: "internal rebalance",
    },
  ];

  let frozen = false;
  for (const a of attempts) {
    const amountYocto = near.toYocto(a.amount);
    const result = await client.requestPayment(a.recipient, amountYocto, a.memo);
    ui.paymentLine(a.step, a.recipient, amountYocto, result);
    if (result.decision !== "rejected") {
      throw new Error(
        `Expected the vault to reject "${a.step}" but it returned ${result.decision}. ` +
          `This is a real failure, not a demo quirk.`,
      );
    }
    frozen ||= result.agent_frozen;
  }

  ui.section("After three strikes");
  const legit = near.toYocto("0.2");
  const result = await client.requestPayment(env.merchantId, legit, "api credits");
  ui.paymentLine(
    "4. A completely legitimate payment the agent makes every day",
    env.merchantId,
    legit,
    result,
  );

  const agent = await client.getAgent(client.accountId);
  const after = await client.getBalance();

  await showLog(client, 10);

  ui.section("Result");
  if (!frozen || agent?.active !== false) {
    ui.fail("the agent was NOT frozen — check strike_limit in the policy");
    process.exitCode = 1;
    return;
  }
  ui.blocked("every drain attempt was rejected on chain, by the contract");
  ui.blocked(`the agent is now frozen and cannot pay anyone, not even ${env.merchantId}`);

  if (before.total !== after.total) {
    ui.fail(
      `vault balance moved: ${near.fmt(before.total)} → ${near.fmt(after.total)} — funds should not have left`,
    );
    process.exitCode = 1;
    return;
  }
  ui.ok(`not one yoctoNEAR left the vault: still ${near.fmt(after.total)}`);

  // Writing each rejection to the audit log costs storage, so the *spendable*
  // figure dips slightly. Worth naming rather than glossing over, because the
  // two numbers do differ on screen.
  const storageDelta = BigInt(after.storage_reserve) - BigInt(before.storage_reserve);
  if (storageDelta > 0n) {
    ui.note(
      `(spendable balance dipped ${near.fmt(storageDelta.toString())} — on-chain storage for the new audit entries, not a payout)`,
    );
  }
  ui.note("");
  ui.note("The agent's own code was never consulted. The policy is the contract's.");
}
