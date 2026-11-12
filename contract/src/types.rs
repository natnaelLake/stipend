use near_sdk::json_types::U64;
use near_sdk::{near, AccountId, NearToken};

/// Owner-defined rules the vault enforces on every payment request.
///
/// Amounts are yoctoNEAR at the JSON boundary (`NearToken` serialises as a
/// decimal string), durations are milliseconds.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    /// Hard cap on a single payment.
    pub max_per_tx: NearToken,
    /// Per agent, per rolling 24h window.
    pub daily_limit: NearToken,
    /// Above this, a payment waits for the owner instead of executing.
    pub approval_threshold: NearToken,
    /// Payments to non-allowlisted recipients above this wait for the owner.
    pub new_recipient_limit: NearToken,
    /// When true, non-allowlisted recipients are rejected outright.
    pub allowlist_only: bool,
    /// Rate limit per agent, per rolling hour.
    pub max_tx_per_hour: u32,
    /// Rejections inside `strike_window_ms` before the agent is auto-frozen.
    pub strike_limit: u32,
    /// Rolling window over which strikes accumulate.
    pub strike_window_ms: u64,
    /// Pending requests older than this can be expired by anyone.
    pub pending_ttl_ms: u64,
    /// Distinct reporters needed before a recipient is rejected outright.
    /// One report only sends the payment to the owner; abuse of the open
    /// report list must not become a kill switch anyone can pull.
    pub report_block_threshold: u32,
    /// How long after a recipient is first seen before payments already made
    /// to it count as trust. Stops an attacker establishing a "known" payee
    /// and draining through it inside one session.
    pub trust_delay_ms: u64,
}

impl Policy {
    /// Panics on a policy that would make the vault unusable or unsafe.
    pub fn assert_valid(&self) {
        assert!(
            !self.max_per_tx.is_zero(),
            "policy.max_per_tx must be greater than zero"
        );
        assert!(
            !self.daily_limit.is_zero(),
            "policy.daily_limit must be greater than zero"
        );
        assert!(
            self.max_tx_per_hour >= 1,
            "policy.max_tx_per_hour must be at least 1"
        );
        assert!(
            self.strike_limit >= 1,
            "policy.strike_limit must be at least 1"
        );
        assert!(
            self.strike_window_ms >= 60_000,
            "policy.strike_window_ms must be at least 60000 (1 minute)"
        );
        assert!(
            self.pending_ttl_ms >= 60_000,
            "policy.pending_ttl_ms must be at least 60000 (1 minute)"
        );
        assert!(
            self.report_block_threshold >= 1,
            "policy.report_block_threshold must be at least 1"
        );
    }
}

/// Per-agent spending state. Windows roll forward lazily on each request.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentState {
    /// `false` means frozen: every request is rejected until the owner unfreezes.
    pub active: bool,
    pub label: String,
    pub window_start_ms: u64,
    pub spent_in_window: NearToken,
    pub hour_start_ms: u64,
    pub tx_in_hour: u32,
    pub strikes: u32,
    pub strike_window_start_ms: u64,
}

impl AgentState {
    pub fn new(label: String, now_ms: u64) -> Self {
        Self {
            active: true,
            label,
            window_start_ms: now_ms,
            spent_in_window: NearToken::from_yoctonear(0),
            hour_start_ms: now_ms,
            tx_in_hour: 0,
            strikes: 0,
            strike_window_start_ms: now_ms,
        }
    }
}

/// A payment held for the owner's decision.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingPayment {
    pub id: U64,
    pub agent: AccountId,
    pub recipient: AccountId,
    pub amount: NearToken,
    pub memo: String,
    pub created_ms: U64,
    /// Which rule sent this to the queue.
    pub reason: String,
}

/// What the vault decided.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    /// Passed every rule; a transfer receipt was scheduled.
    Approved,
    /// Held for the owner.
    Pending,
    /// Blocked by a rule.
    Rejected,
    /// Transfer landed.
    Executed,
    /// Transfer receipt failed; the reserved spend was refunded.
    Failed,
    /// Owner released a pending payment.
    OwnerApproved,
    /// Owner rejected a pending payment.
    OwnerRejected,
    /// Pending payment passed its TTL.
    Expired,
    /// Agent hit `strike_limit` and was frozen.
    AgentFrozen,
    /// Owner unfroze an agent.
    AgentUnfrozen,
}

impl Decision {
    pub fn as_str(&self) -> &'static str {
        match self {
            Decision::Approved => "approved",
            Decision::Pending => "pending",
            Decision::Rejected => "rejected",
            Decision::Executed => "executed",
            Decision::Failed => "failed",
            Decision::OwnerApproved => "owner_approved",
            Decision::OwnerRejected => "owner_rejected",
            Decision::Expired => "expired",
            Decision::AgentFrozen => "agent_frozen",
            Decision::AgentUnfrozen => "agent_unfrozen",
        }
    }
}

/// One append-only audit entry.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogEntry {
    pub id: U64,
    pub ts_ms: U64,
    pub agent: AccountId,
    pub recipient: AccountId,
    pub amount: NearToken,
    pub memo: String,
    pub decision: Decision,
    /// Human-readable rule that fired, e.g. "exceeds max_per_tx (2.00 NEAR)".
    pub reason: String,
}

/// Returned by `request_payment` and `simulate_payment`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentDecision {
    pub decision: Decision,
    pub reason: String,
    /// Set when `decision == Pending`: the approval-queue id.
    pub pending_id: Option<U64>,
    /// Set for anything written to the audit log.
    pub log_id: Option<U64>,
    /// True when this request pushed the agent over `strike_limit`.
    pub agent_frozen: bool,
}

/// Agent state plus derived numbers, for the dashboard.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct AgentView {
    pub account_id: AccountId,
    pub label: String,
    pub active: bool,
    pub spent_in_window: NearToken,
    pub daily_limit: NearToken,
    pub remaining_today: NearToken,
    pub tx_in_hour: u32,
    pub max_tx_per_hour: u32,
    pub strikes: u32,
    pub strike_limit: u32,
    pub window_start_ms: U64,
}

/// Vault balance split, for the dashboard.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct BalanceView {
    /// Total account balance.
    pub total: NearToken,
    /// Locked for state storage.
    pub storage_reserve: NearToken,
    /// Gas/rounding buffer the vault refuses to spend below.
    pub safety_buffer: NearToken,
    /// What payments may actually draw on.
    pub available: NearToken,
}

/// Everything the dashboard needs, in a single view call.
///
/// Reading these nine pieces separately costs nine round trips against a
/// public RPC's rate limit, and the answers can straddle blocks — so a
/// dashboard could show a balance from one block beside a log from another.
/// This is one request and one consistent snapshot.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct DashboardView {
    pub owner: AccountId,
    pub paused: bool,
    pub policy: Policy,
    pub agents: Vec<AgentView>,
    pub pending: Vec<PendingPayment>,
    pub log: Vec<LogEntry>,
    pub balance: BalanceView,
    pub allowlist: Vec<AccountId>,
    pub blocklist: Vec<AccountId>,
    /// Recipients carrying at least one abuse report, worst first.
    pub flagged: Vec<RecipientView>,
    /// Block timestamp of this snapshot.
    pub as_of_ms: U64,
}

/// One abuse report about a recipient.
///
/// Anyone may file one, which is the point: a blocklist only the owner can
/// write is worth nothing to an agent meeting a scammer the owner has never
/// heard of. Reports are bonded so filing costs something, and a single report
/// never blocks on its own.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report {
    pub reporter: AccountId,
    /// Free-form label, e.g. "drainer", "phishing", "fake-invoice".
    pub category: String,
    /// URL or content hash. Stored verbatim; the contract never fetches it.
    pub evidence: String,
    pub ts_ms: U64,
}

/// What this vault knows about a recipient from its own payment history.
///
/// Deliberately the vault's own history rather than global account age: a
/// contract cannot read another account's creation height, and inventing an
/// oracle for it would put the decision back off chain, which is the one thing
/// this project exists to avoid.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecipientRecord {
    /// First time this vault was ever asked to pay this account.
    pub first_seen_ms: u64,
    /// Payments that actually settled, not requests.
    pub times_paid: u32,
    pub total_paid: NearToken,
    pub last_paid_ms: u64,
}

impl RecipientRecord {
    pub fn new(now_ms: u64) -> Self {
        Self {
            first_seen_ms: now_ms,
            times_paid: 0,
            total_paid: NearToken::from_yoctonear(0),
            last_paid_ms: 0,
        }
    }
}

/// The counterparty verdict: allow, warn, or block, with reasons.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RiskLevel {
    /// Owner blocked it, or enough independent reporters did.
    Blocked,
    /// Reported, or never paid before: a human should look.
    Warn,
    /// Allowlisted, or paid before and past the trust delay.
    Known,
}

impl RiskLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            RiskLevel::Blocked => "blocked",
            RiskLevel::Warn => "warn",
            RiskLevel::Known => "known",
        }
    }
}

/// Everything known about one recipient, for the dashboard and for agents
/// that want to check before asking.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct RecipientView {
    pub account_id: AccountId,
    pub risk: RiskLevel,
    /// Why, in the order the rules considered it. Never empty.
    pub reasons: Vec<String>,
    pub first_seen_ms: U64,
    pub times_paid: u32,
    pub total_paid: NearToken,
    pub last_paid_ms: U64,
    pub reports: u32,
    /// Reports from distinct accounts; this is what the threshold counts.
    pub distinct_reporters: u32,
    pub allowlisted: bool,
    pub blocklisted: bool,
}
