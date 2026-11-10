import pc from "picocolors";
import { near, type Decision, type LogEntry, type PaymentResult } from "./near.js";

const WIDTH = 78;

export function title(text: string): void {
  console.log();
  console.log(pc.bold(pc.cyan("┌" + "─".repeat(WIDTH - 2) + "┐")));
  console.log(pc.bold(pc.cyan("│ ") + pc.bold(text.padEnd(WIDTH - 4)) + pc.cyan(" │")));
  console.log(pc.bold(pc.cyan("└" + "─".repeat(WIDTH - 2) + "┘")));
}

export function section(text: string): void {
  console.log();
  console.log(pc.bold(pc.white(`▸ ${text}`)));
}

export function note(text: string): void {
  console.log(pc.dim(`  ${text}`));
}

export function badge(decision: Decision): string {
  const label = ` ${decision.toUpperCase().replace(/_/g, " ")} `;
  switch (decision) {
    case "approved":
    case "executed":
    case "owner_approved":
      return pc.bgGreen(pc.black(pc.bold(label)));
    case "pending":
      return pc.bgYellow(pc.black(pc.bold(label)));
    case "rejected":
    case "failed":
    case "owner_rejected":
      return pc.bgRed(pc.white(pc.bold(label)));
    case "agent_frozen":
      return pc.bgMagenta(pc.white(pc.bold(label)));
    default:
      return pc.bgWhite(pc.black(pc.bold(label)));
  }
}

/** One payment attempt, as the demo video shows it. */
export function paymentLine(
  step: string,
  recipient: string,
  amountYocto: string,
  result: PaymentResult,
): void {
  console.log();
  console.log(`  ${pc.bold(step)}`);
  console.log(`    → ${pc.cyan(near.fmt(amountYocto))} to ${pc.cyan(recipient)}`);
  console.log(`    ${badge(result.decision)}  ${pc.dim(result.reason)}`);
  if (result.agent_frozen) {
    console.log(`    ${pc.bgMagenta(pc.white(pc.bold(" AGENT FROZEN ")))} ${pc.dim("strike limit reached — the vault cut this agent off")}`);
  }
  if (result.explorerUrl) {
    console.log(`    ${pc.dim(result.explorerUrl)}`);
  }
}

export function logTable(entries: LogEntry[]): void {
  if (entries.length === 0) {
    note("(audit log is empty)");
    return;
  }
  for (const e of entries) {
    const when = new Date(Number(e.ts_ms)).toISOString().slice(11, 19);
    const amount = e.amount === "0" ? "" : near.fmt(e.amount);
    console.log(
      `  ${pc.dim(when)}  ${badge(e.decision)} ${amount.padStart(12)}  ${pc.dim(e.reason)}`,
    );
  }
}

export function kv(key: string, value: string): void {
  console.log(`  ${pc.dim(key.padEnd(22))} ${value}`);
}

export function ok(text: string): void {
  console.log(`  ${pc.green("✓")} ${text}`);
}

export function fail(text: string): void {
  console.log(`  ${pc.red("✗")} ${text}`);
}

export function blocked(text: string): void {
  console.log(`  ${pc.red("⛔")} ${text}`);
}
