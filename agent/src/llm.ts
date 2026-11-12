import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

import type { Env } from "./env.js";
import type { AgentTool } from "./tools.js";
import * as ui from "./ui.js";

/**
 * The LLM half, behind a tiny interface so the model can be swapped without
 * touching a scenario.
 *
 * This matters for the security claim rather than for convenience: if the
 * vault only held against one vendor's model, "the vault stopped it" would be
 * a statement about that model. The contract is the control, so any brain here
 * must produce the same on-chain outcome.
 */
export interface AgentBrain {
  readonly name: string;
  run(opts: {
    system: string;
    prompt: string;
    tools: AgentTool[];
  }): Promise<{ text: string; stopReason: string | null }>;
}

const MAX_ITERATIONS = 12;
const MAX_TOKENS = 8000;

/** Anthropic's API directly, using the SDK's own tool runner. */
class ClaudeBrain implements AgentBrain {
  readonly name: string;
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey });
    this.name = `${model} (Anthropic)`;
  }

  async run(opts: { system: string; prompt: string; tools: AgentTool[] }) {
    const tools = opts.tools.map((t) =>
      betaZodTool({
        name: t.name,
        description: t.description,
        inputSchema: t.schema,
        run: async (input) => t.run(input as Record<string, unknown>),
      }),
    );

    const runner = this.client.beta.messages.toolRunner({
      model: this.model,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      system: opts.system,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: tools as any,
      messages: [{ role: "user", content: opts.prompt }],
      max_iterations: MAX_ITERATIONS,
    });

    const final = await runner.runUntilDone();
    const text = final.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    return { text, stopReason: final.stop_reason };
  }
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

/**
 * Any OpenAI-compatible endpoint, which is how OpenRouter and NEAR AI Cloud
 * both speak. The tool loop is written out rather than taken from an SDK so
 * there is one less dependency between the poisoned invoice and the chain.
 */
class OpenAICompatibleBrain implements AgentBrain {
  readonly name: string;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl: string,
    label: string,
  ) {
    this.name = `${model} (${label})`;
  }

  private async post(body: unknown): Promise<Record<string, any>> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `${this.baseUrl} returned HTTP ${res.status}: ${text.slice(0, 400)}\n` +
          `  If this is an unknown-model error, set OPENROUTER_MODEL in .env to a model your key can reach.`,
      );
    }
    try {
      return JSON.parse(text) as Record<string, any>;
    } catch {
      throw new Error(`${this.baseUrl} returned a non-JSON body: ${text.slice(0, 200)}`);
    }
  }

  async run(opts: { system: string; prompt: string; tools: AgentTool[] }) {
    const byName = new Map(opts.tools.map((t) => [t.name, t]));
    const tools = opts.tools.map((t) => {
      const parameters = z.toJSONSchema(t.schema) as Record<string, unknown>;
      delete parameters.$schema;
      return {
        type: "function" as const,
        function: { name: t.name, description: t.description, parameters },
      };
    });

    const messages: ChatMessage[] = [
      { role: "system", content: opts.system },
      { role: "user", content: opts.prompt },
    ];

    let stopReason: string | null = null;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const data = await this.post({
        model: this.model,
        max_tokens: MAX_TOKENS,
        messages,
        tools,
        tool_choice: "auto",
      });

      const choice = data.choices?.[0];
      if (!choice) throw new Error("the model returned no choices");
      const msg = choice.message as ChatMessage;
      stopReason = choice.finish_reason ?? null;
      messages.push(msg);

      const calls = msg.tool_calls ?? [];
      if (calls.length === 0) {
        return { text: (msg.content ?? "").trim(), stopReason };
      }

      for (const call of calls) {
        const tool = byName.get(call.function.name);
        let result: string;
        if (!tool) {
          result = JSON.stringify({ error: `no such tool: ${call.function.name}` });
        } else {
          try {
            const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
            result = await tool.run(args as Record<string, unknown>);
          } catch (err) {
            // A tool error is information for the model, not a crash: a refused
            // payment must come back as a decision it has to report, not as a
            // dead run that hides what the vault did.
            result = JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }

    ui.note(`stopped after ${MAX_ITERATIONS} tool iterations`);
    const lastText = [...messages].reverse().find((m) => m.role === "assistant" && m.content);
    return { text: (lastText?.content ?? "").trim(), stopReason: stopReason ?? "max_iterations" };
  }
}

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "This scenario drives a real LLM and needs a model key in your .env:\n" +
        "    OPENROUTER_API_KEY=...     (any model, see OPENROUTER_MODEL)\n" +
        "    ANTHROPIC_API_KEY=...      (Anthropic directly)\n" +
        "  The deterministic scenarios (compromised, key-escape) need no key at all\n" +
        "  and demonstrate the same on-chain enforcement.",
    );
    this.name = "MissingApiKeyError";
  }
}

export function createBrain(env: Env): AgentBrain {
  if (env.openrouterKey) {
    return new OpenAICompatibleBrain(
      env.openrouterKey,
      env.openrouterModel,
      "https://openrouter.ai/api/v1",
      "OpenRouter",
    );
  }
  if (env.anthropicKey) return new ClaudeBrain(env.anthropicKey, env.model);
  throw new MissingApiKeyError();
}
