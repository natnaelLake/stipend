import { z } from "zod";
import { near, type AgentVaultClient, type PaymentResult } from "./near.js";
import * as ui from "./ui.js";

export interface ToolContext {
  client: AgentVaultClient;
  /** Called for every real payment attempt so scenarios can render + assert. */
  onPayment?: (info: { recipient: string; amountYocto: string; result: PaymentResult }) => void;
}

/**
 * A tool in a model-neutral shape.
 *
 * The scenarios must behave identically whichever model is driving, otherwise
 * "the vault stopped it" would be a claim about one vendor rather than about
 * the contract. So tools are declared once, here, and each brain in llm.ts
 * renders them into its own wire format.
 */
export interface AgentTool {
  name: string;
  description: string;
  /** Zod schema for the arguments; converted to JSON Schema per provider. */
  schema: z.ZodObject<z.ZodRawShape>;
  /** Receives validated input, returns the string handed back to the model. */
  run: (input: Record<string, unknown>) => Promise<string>;
}

function defineTool<S extends z.ZodObject<z.ZodRawShape>>(t: {
  name: string;
  description: string;
  schema: S;
  run: (input: z.infer<S>) => Promise<string>;
}): AgentTool {
  return {
    name: t.name,
    description: t.description,
    schema: t.schema,
    // Validate at the boundary: a model may send anything, including nothing.
    run: async (raw) => t.run(t.schema.parse(raw ?? {}) as z.infer<S>),
  };
}

/**
 * The tools the LLM is given.
 *
 * Note what is deliberately absent: any client-side policy check that could
 * block a payment. `pay` forwards whatever the model asks for straight to the
 * contract. That is the entire point of the project — if the agent could be
 * talked out of enforcing the rules, the rules would not be worth anything.
 * The vault decides, and the agent only reports what it was told.
 */
export function buildAgentTools(ctx: ToolContext): AgentTool[] {
  const { client } = ctx;

  const check_payment = defineTool({
    name: "check_payment",
    description:
      "Dry-run a payment against the vault's policy without sending anything. " +
      "Returns the decision the vault would make and the reason. Use this before " +
      "paying anyone you have not paid before.",
    schema: z.object({
      recipient: z.string().describe("NEAR account id to pay, e.g. merchant.example.testnet"),
      amount_near: z.string().describe('Amount in NEAR as a decimal string, e.g. "0.3"'),
    }),
    run: async (input) => {
      const amountYocto = near.toYocto(input.amount_near);
      const d = await client.simulatePayment(client.accountId, input.recipient, amountYocto);
      ui.note(`check_payment(${input.recipient}, ${input.amount_near} NEAR) → ${d.decision}`);
      return JSON.stringify({ decision: d.decision, reason: d.reason });
    },
  });

  const pay = defineTool({
    name: "pay",
    description:
      "Ask the vault to pay a recipient. The vault enforces the owner's spending " +
      "policy and may approve, hold for owner approval, or reject the request. " +
      "You cannot override its decision.",
    schema: z.object({
      recipient: z.string().describe("NEAR account id to pay"),
      amount_near: z.string().describe("Amount in NEAR as a decimal string"),
      memo: z.string().max(256).describe("Short description of what this pays for"),
    }),
    run: async (input) => {
      const amountYocto = near.toYocto(input.amount_near);
      const result = await client.requestPayment(input.recipient, amountYocto, input.memo);
      ui.paymentLine(`pay → ${input.memo}`, input.recipient, amountYocto, result);
      ctx.onPayment?.({ recipient: input.recipient, amountYocto, result });
      return JSON.stringify({
        decision: result.decision,
        reason: result.reason,
        agent_frozen: result.agent_frozen,
        pending_id: result.pending_id,
      });
    },
  });

  const get_budget = defineTool({
    name: "get_budget",
    description: "Check how much of today's spending budget is left for this agent.",
    schema: z.object({}),
    run: async () => {
      const a = await client.getAgent(client.accountId);
      if (!a) return JSON.stringify({ error: "this agent is not registered on the vault" });
      ui.note(`get_budget() → ${near.fmt(a.remaining_today)} left of ${near.fmt(a.daily_limit)}`);
      return JSON.stringify({
        active: a.active,
        spent_today_near: near.toNear(a.spent_in_window),
        daily_limit_near: near.toNear(a.daily_limit),
        remaining_today_near: near.toNear(a.remaining_today),
        transactions_this_hour: a.tx_in_hour,
        max_transactions_per_hour: a.max_tx_per_hour,
        strikes: a.strikes,
      });
    },
  });

  return [check_payment, pay, get_budget];
}
