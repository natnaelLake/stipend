import {
  Account,
  JsonRpcProvider,
  getTransactionLastResult,
  nearToYocto,
  teraToGas,
  yoctoToNear,
  type KeyPairString,
} from "near-api-js";
import type { Env } from "./env.js";

// request_payment schedules a transfer plus a settlement callback, so it needs
// materially more than the 30 TGas default.
const CALL_GAS = teraToGas("100");
const ONE_YOCTO = 1n;
/** Must match REPORT_BOND in the contract (0.01 NEAR). */
export const REPORT_BOND = 10_000_000_000_000_000_000_000n;

export type Decision =
  | "approved"
  | "pending"
  | "rejected"
  | "executed"
  | "failed"
  | "owner_approved"
  | "owner_rejected"
  | "expired"
  | "agent_frozen"
  | "agent_unfrozen";

export interface PaymentDecision {
  decision: Decision;
  reason: string;
  pending_id: string | null;
  log_id: string | null;
  agent_frozen: boolean;
}

export interface AgentView {
  account_id: string;
  label: string;
  active: boolean;
  spent_in_window: string;
  daily_limit: string;
  remaining_today: string;
  tx_in_hour: number;
  max_tx_per_hour: number;
  strikes: number;
  strike_limit: number;
  window_start_ms: string;
}

export interface LogEntry {
  id: string;
  ts_ms: string;
  agent: string;
  recipient: string;
  amount: string;
  memo: string;
  decision: Decision;
  reason: string;
}

export interface PendingPayment {
  id: string;
  agent: string;
  recipient: string;
  amount: string;
  memo: string;
  created_ms: string;
  reason: string;
}

export interface BalanceView {
  total: string;
  storage_reserve: string;
  safety_buffer: string;
  available: string;
}

export interface Policy {
  report_block_threshold: number;
  trust_delay_ms: number;
  max_per_tx: string;
  daily_limit: string;
  approval_threshold: string;
  new_recipient_limit: string;
  allowlist_only: boolean;
  max_tx_per_hour: number;
  strike_limit: number;
  strike_window_ms: number;
  pending_ttl_ms: number;
}

/** A decision plus the transaction it came from. */
export type RiskLevel = "blocked" | "warn" | "known";

export interface ReportView {
  reporter: string;
  category: string;
  evidence: string;
  ts_ms: string;
}

export interface RecipientView {
  account_id: string;
  risk: RiskLevel;
  reasons: string[];
  first_seen_ms: string;
  times_paid: number;
  total_paid: string;
  last_paid_ms: string;
  reports: number;
  distinct_reporters: number;
  allowlisted: boolean;
  blocklisted: boolean;
}

export interface PaymentResult extends PaymentDecision {
  txHash: string | undefined;
  explorerUrl: string | undefined;
}

export const near = {
  // The SDK types these as template-literal numerics; our values arrive as
  // plain strings off the wire, so convert at this one boundary.
  toYocto: (amount: string | number): string =>
    nearToYocto(String(amount) as `${number}`).toString(),
  toNear: (yocto: string): string => String(yoctoToNear(BigInt(yocto))),
  /** Short human form, e.g. "1.5 NEAR". */
  fmt: (yocto: string): string => {
    const n = Number(yoctoToNear(BigInt(yocto)));
    const s = Number.isInteger(n) ? n.toString() : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
    return `${s} NEAR`;
  },
};

/**
 * Read-only view access to the vault. Needs no key at all, which is why the
 * dashboard can show live data to anyone.
 */
export class VaultReader {
  protected readonly provider: JsonRpcProvider;

  constructor(
    protected readonly env: Env,
    readonly contractId = env.vaultId,
  ) {
    this.provider = new JsonRpcProvider({ url: env.rpcUrl });
  }

  private view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.provider.callFunction({ contractId: this.contractId, method, args }) as Promise<T>;
  }

  getPolicy() {
    return this.view<Policy>("get_policy");
  }
  getOwner() {
    return this.view<string>("get_owner");
  }
  isPaused() {
    return this.view<boolean>("is_paused");
  }
  getAgents() {
    return this.view<AgentView[]>("get_agents");
  }
  getAgent(accountId: string) {
    return this.view<AgentView | null>("get_agent", { account_id: accountId });
  }
  getPending() {
    return this.view<PendingPayment[]>("get_pending");
  }
  getRecentLog(limit = 20) {
    return this.view<LogEntry[]>("get_recent_log", { limit });
  }
  getBalance() {
    return this.view<BalanceView>("get_balance");
  }
  getRecipient(accountId: string) {
    return this.view<RecipientView>("get_recipient", { account_id: accountId });
  }
  getReports(accountId: string) {
    return this.view<ReportView[]>("get_reports", { account_id: accountId });
  }
  getFlagged() {
    return this.view<RecipientView[]>("get_flagged");
  }
  getAllowlist() {
    return this.view<string[]>("get_allowlist");
  }
  getBlocklist() {
    return this.view<string[]>("get_blocklist");
  }

  /** Dry-run. Shares the on-chain policy engine, so it cannot disagree. */
  simulatePayment(agent: string, recipient: string, amountYocto: string) {
    return this.view<PaymentDecision>("simulate_payment", {
      agent,
      recipient,
      amount: amountYocto,
    });
  }
}

/**
 * The agent's view of the vault.
 *
 * Signs with the function-call access key only. That key is restricted by the
 * protocol to `request_payment` on this one contract and cannot attach a
 * deposit, so none of the owner methods are reachable from here — not because
 * this class declines to expose them, but because the chain refuses to sign.
 */
export class AgentVaultClient extends VaultReader {
  private readonly account: Account;

  constructor(env: Env) {
    super(env);
    this.account = new Account(env.agentId, this.provider, env.agentKey as KeyPairString);
  }

  get accountId(): string {
    return this.env.agentId;
  }

  async requestPayment(
    recipient: string,
    amountYocto: string,
    memo: string,
  ): Promise<PaymentResult> {
    const outcome = await this.account.callFunctionRaw({
      contractId: this.contractId,
      methodName: "request_payment",
      args: { recipient, amount: amountYocto, memo },
      gas: CALL_GAS,
    });

    const decision = getTransactionLastResult(outcome) as PaymentDecision;
    const txHash = outcome.transaction?.hash as string | undefined;
    return {
      ...decision,
      txHash,
      explorerUrl: txHash ? `${this.env.explorerTxBase}${txHash}` : undefined,
    };
  }

  /** Raw escape-hatch call, used by the key-escape scenario to prove refusal. */
  async callRaw(methodName: string, args: Record<string, unknown>, deposit = 0n) {
    return this.account.callFunctionRaw({
      contractId: this.contractId,
      methodName,
      args,
      gas: CALL_GAS,
      deposit,
    });
  }

  /** Plain NEAR transfer out of the agent account — should be unsignable. */
  async transferRaw(receiver: string, amountYocto: string) {
    return this.account.transfer({ receiverId: receiver, amount: BigInt(amountYocto) });
  }
}

/** Owner-side client. Needs a full-access key, so it only exists in demos. */
export class OwnerVaultClient extends VaultReader {
  private readonly account: Account;

  constructor(env: Env, ownerKey: string) {
    super(env);
    this.account = new Account(env.ownerId, this.provider, ownerKey as KeyPairString);
  }

  private send(methodName: string, args: Record<string, unknown>) {
    return this.account.callFunctionRaw({
      contractId: this.contractId,
      methodName,
      args,
      gas: CALL_GAS,
      deposit: ONE_YOCTO,
    });
  }

  approvePending(id: string) {
    return this.send("approve_pending", { id });
  }
  rejectPending(id: string) {
    return this.send("reject_pending", { id });
  }
  unfreezeAgent(accountId: string) {
    return this.send("unfreeze_agent", { account_id: accountId });
  }
  freezeAgent(accountId: string) {
    return this.send("freeze_agent", { account_id: accountId });
  }
  pause() {
    return this.send("pause", {});
  }
  unpause() {
    return this.send("unpause", {});
  }
  clearReports(accountId: string) {
    return this.send("clear_reports", { account_id: accountId });
  }
}

/**
 * Files abuse reports as an arbitrary account.
 *
 * Reporting is deliberately open to anyone, so this takes whichever account
 * and key you hand it rather than assuming the owner. The bond is what keeps
 * that openness from being free.
 */
export class ReporterClient extends VaultReader {
  private readonly account: Account;

  constructor(
    env: Env,
    readonly accountId: string,
    key: string,
  ) {
    super(env);
    this.account = new Account(accountId, this.provider, key as KeyPairString);
  }

  report(target: string, category: string, evidence: string) {
    return this.account.callFunctionRaw({
      contractId: this.contractId,
      methodName: "report_recipient",
      args: { account_id: target, category, evidence },
      gas: CALL_GAS,
      deposit: REPORT_BOND,
    });
  }
}
