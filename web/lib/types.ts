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

export interface Policy {
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

export interface PaymentDecision {
  decision: Decision;
  reason: string;
  pending_id: string | null;
  log_id: string | null;
  agent_frozen: boolean;
}

/** What `get_dashboard` returns: the whole vault in one consistent snapshot. */
export interface VaultSnapshot {
  as_of_ms: string;
  owner: string;
  paused: boolean;
  policy: Policy;
  agents: AgentView[];
  pending: PendingPayment[];
  log: LogEntry[];
  balance: BalanceView;
  allowlist: string[];
  blocklist: string[];
}
