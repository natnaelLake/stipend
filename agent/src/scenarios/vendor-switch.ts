/**
 * Invoice fraud, the way it actually happens.
 *
 * Real attacks on accounts payable rarely introduce a new supplier. They take
 * a supplier you already pay and change the account number. The amount is
 * unremarkable, the description is the one you have approved a hundred times,
 * and every limit in the policy is satisfied. What changed is the destination.
 *
 * The vault remembers which account a memo settled to, so that change is the
 * thing it can see.
 */
import { AgentVaultClient, OwnerVaultClient, near } from "../near.js";
import type { Env } from "../env.js";
import * as ui from "../ui.js";
import { showLog, showVaultState } from "./common.js";

export const description = "A known supplier's invoice, with the account number changed";

const MEMO = "CloudCompute API credits, monthly";

export async function run(env: Env): Promise<void> {
  if (!env.vendorId || !env.vendor2Id) {
    throw new Error(
      "This scenario needs VENDOR_ACCOUNT_ID and VENDOR2_ACCOUNT_ID in .env.\n" +
        "  They are two ordinary accounts: the supplier, and the account an attacker swaps in.",
    );
  }

  const client = new AgentVaultClient(env);
  ui.title("Scenario: the supplier's account number changed");
  await showVaultState(client);

  ui.section("Month one — the invoice the company always pays");
  ui.note(`memo: "${MEMO}"`);
  const first = await client.requestPayment(env.vendorId, near.toYocto("0.1"), MEMO);
  ui.paymentLine(`pay → ${MEMO}`, env.vendorId, near.toYocto("0.1"), first);
  if (first.decision !== "approved") {
    throw new Error(`expected the first payment to be routine, got ${first.decision}: ${first.reason}`);
  }

  const bound = await client.getMemoPayee(MEMO);
  ui.note(`the vault now associates this memo with ${bound}`);

  ui.section("Month two — same supplier, same amount, same description");
  ui.note(`but the invoice now carries ${env.vendor2Id}`);
  ui.note("every limit in the policy is still satisfied: 0.1 NEAR is small, the");
  ui.note("agent is inside its budget, and nobody has reported this account");

  const dry = await client.simulatePayment(client.accountId, env.vendor2Id, near.toYocto("0.1"), MEMO);
  ui.note(`dry run → ${dry.decision}: ${dry.reason}`);

  const second = await client.requestPayment(env.vendor2Id, near.toYocto("0.1"), MEMO);
  ui.paymentLine(`pay → ${MEMO}`, env.vendor2Id, near.toYocto("0.1"), second);

  if (second.decision !== "pending") {
    throw new Error(`expected the switch to be held for the owner, got ${second.decision}: ${second.reason}`);
  }
  if (dry.decision !== second.decision) {
    throw new Error(`dry run said ${dry.decision} but the chain said ${second.decision}`);
  }

  ui.section("In the approval queue");
  const queue = await client.getPending();
  for (const p of queue) {
    ui.note(`#${p.id}  ${near.fmt(p.amount)} → ${p.recipient}`);
    ui.note(`      ${p.reason}`);
  }

  await showLog(client, 5);

  ui.section("Result");
  ui.blocked(`held, not paid: ${second.reason}`);
  ui.ok("the amount was ordinary, the memo was familiar, only the account moved");
  ui.note("A human now decides. If the supplier really did change banks, the owner");
  ui.note("releases it and the vault remembers the new account from then on.");
  ui.note("");
  ui.note(`left in the queue on purpose — open the dashboard to see it waiting`);

  if (!env.ownerKey) ui.note("(set OWNER_PRIVATE_KEY to let the owner release it)");
}
