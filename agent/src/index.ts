import { loadEnv, resolveRpc } from "./env.js";
import { MissingApiKeyError } from "./llm.js";
import * as ui from "./ui.js";

import * as compromised from "./scenarios/compromised.js";
import * as normal from "./scenarios/normal.js";
import * as reported from "./scenarios/reported.js";
import * as bigPurchase from "./scenarios/big-purchase.js";
import * as injection from "./scenarios/injection.js";
import * as keyEscape from "./scenarios/key-escape.js";

interface Scenario {
  description: string;
  run: (env: ReturnType<typeof loadEnv>) => Promise<void>;
}

const SCENARIOS: Record<string, Scenario> = {
  normal,
  "big-purchase": bigPurchase,
  injection,
  compromised,
  reported,
  "key-escape": keyEscape,
};

function usage(): void {
  console.log();
  console.log("  npm run scenario -- <name>");
  console.log();
  for (const [name, s] of Object.entries(SCENARIOS)) {
    console.log(`    ${name.padEnd(14)} ${s.description}`);
  }
  console.log();
  console.log("  compromised and key-escape are deterministic and need no API key.");
  console.log();
}

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name || name === "--help" || name === "-h") {
    usage();
    process.exit(name ? 0 : 1);
  }

  const scenario = SCENARIOS[name];
  if (!scenario) {
    console.error(`Unknown scenario: ${name}`);
    usage();
    process.exit(1);
  }

  const env = await resolveRpc(loadEnv());
  await scenario.run(env);
  console.log();
}

main().catch((err: unknown) => {
  console.log();
  if (err instanceof MissingApiKeyError) {
    ui.fail(err.message);
  } else {
    ui.fail(err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack && process.env.DEBUG) {
      console.error(err.stack);
    }
  }
  console.log();
  process.exit(1);
});
