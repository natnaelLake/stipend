import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "./env.js";

/**
 * Kept behind a tiny interface so the LLM half can be swapped (for example for
 * an OpenAI-compatible NEAR AI Cloud endpoint) without touching the scenarios.
 * The security story does not depend on which model runs — the vault enforces
 * the policy either way.
 */
export interface AgentBrain {
  readonly name: string;
  run(opts: {
    system: string;
    prompt: string;
    tools: unknown[];
  }): Promise<{ text: string; stopReason: string | null }>;
}

class ClaudeBrain implements AgentBrain {
  readonly name: string;
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey });
    this.name = model;
  }

  async run(opts: { system: string; prompt: string; tools: unknown[] }) {
    const runner = this.client.beta.messages.toolRunner({
      model: this.model,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      system: opts.system,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: opts.tools as any,
      messages: [{ role: "user", content: opts.prompt }],
      max_iterations: 12,
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

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "This scenario drives a real LLM and needs ANTHROPIC_API_KEY in your .env.\n" +
        "  The deterministic scenarios (compromised, key-escape) need no API key and\n" +
        "  demonstrate the same on-chain enforcement.",
    );
    this.name = "MissingApiKeyError";
  }
}

export function createBrain(env: Env): AgentBrain {
  if (!env.anthropicKey) throw new MissingApiKeyError();
  return new ClaudeBrain(env.anthropicKey, env.model);
}
