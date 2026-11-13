//! # Stipend vault
//!
//! A policy-enforced spending vault for AI agents on NEAR.
//!
//! The agent never holds the funds and never holds a full-access key. It holds
//! a NEAR **function-call access key** restricted to exactly one method on this
//! contract: [`Vault::request_payment`]. Every request is checked against
//! owner-defined rules *by the chain*, so a compromised or prompt-injected
//! agent cannot talk its way past them.
//!
//! Policy violations never panic. A panic would revert state and erase the
//! audit log and the strike counter — exactly what an attacker would want. The
//! vault records the rejection, emits an event, and returns a verdict.

use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::U64;
use near_sdk::store::{IterableMap, IterableSet, LookupMap};
use near_sdk::{
    assert_one_yocto, env, near, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise,
};

pub mod events;
pub mod policy;
pub mod types;

use policy::{classify, evaluate, roll_windows, Context, Counterparty, Eval};
use types::{
    AgentState, AgentView, BalanceView, DashboardView, Decision, LogEntry, PaymentDecision,
    PendingPayment, Policy, RecipientRecord, RecipientView, Report,
};

/// Longest accepted memo, in bytes.
pub const MAX_MEMO_LEN: usize = 256;
/// Audit entries kept on chain. Oldest are dropped past this.
pub const LOG_CAPACITY: u64 = 2_000;
/// Never spend the account down to its storage floor.
pub const SAFETY_BUFFER: NearToken = NearToken::from_millinear(100);
/// Gas reserved for `on_transfer_complete`.
pub const GAS_FOR_TRANSFER_CALLBACK: Gas = Gas::from_tgas(10);

/// Bond required to file an abuse report. Filing must cost something, or the
/// open report list becomes a free denial-of-service against any recipient.
/// It also pays for the storage the report occupies, and is not refunded.
pub const REPORT_BOND: NearToken = NearToken::from_millinear(10);

pub const MAX_CATEGORY_LEN: usize = 32;
pub const MAX_EVIDENCE_LEN: usize = 256;
/// Bounded so one recipient cannot be used to grow state without limit.
pub const MAX_REPORTS_PER_RECIPIENT: usize = 32;

/// How much of a memo is used as the vendor key. Long enough to identify an
/// invoice line, short enough that trailing detail does not defeat the match.
pub const MEMO_KEY_LEN: usize = 48;

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    Agents,
    Allowlist,
    Blocklist,
    Pending,
    Log,
    Recipients,
    Reports,
    MemoPayees,
}

/// The state layout before `memo_payees` was added.
///
/// Kept so a deployed vault can be upgraded in place instead of being
/// redeployed under a new account: NEAR refuses to delete an account whose
/// state is large, and an audit log is exactly that. Every collection keeps
/// its original storage prefix, so the entries move across untouched.
#[near(serializers = [borsh])]
pub struct VaultV1 {
    owner: AccountId,
    paused: bool,
    policy: Policy,
    agents: IterableMap<AccountId, AgentState>,
    allowlist: IterableSet<AccountId>,
    blocklist: IterableSet<AccountId>,
    pending: IterableMap<u64, PendingPayment>,
    log: LookupMap<u64, LogEntry>,
    log_start: u64,
    next_log_id: u64,
    next_pending_id: u64,
    recipients: IterableMap<AccountId, RecipientRecord>,
    reports: IterableMap<AccountId, Vec<Report>>,
}

#[near]
impl Vault {
    /// Upgrade a V1 vault in place, adding the memo index.
    ///
    /// `#[private]` means only the contract account itself can call it, which
    /// is the account the deploy transaction is signed as.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: VaultV1 = env::state_read().unwrap_or_else(|| {
            env::panic_str("no existing state to migrate")
        });
        Self {
            owner: old.owner,
            paused: old.paused,
            policy: old.policy,
            agents: old.agents,
            allowlist: old.allowlist,
            blocklist: old.blocklist,
            pending: old.pending,
            log: old.log,
            log_start: old.log_start,
            next_log_id: old.next_log_id,
            next_pending_id: old.next_pending_id,
            recipients: old.recipients,
            reports: old.reports,
            memo_payees: LookupMap::new(StorageKey::MemoPayees),
        }
    }
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    owner: AccountId,
    paused: bool,
    policy: Policy,
    agents: IterableMap<AccountId, AgentState>,
    allowlist: IterableSet<AccountId>,
    blocklist: IterableSet<AccountId>,
    pending: IterableMap<u64, PendingPayment>,
    /// Ring buffer of audit entries keyed by absolute id.
    log: LookupMap<u64, LogEntry>,
    /// Oldest id still retained.
    log_start: u64,
    next_log_id: u64,
    next_pending_id: u64,
    /// What this vault has seen of each account it was asked to pay.
    recipients: IterableMap<AccountId, RecipientRecord>,
    /// Open abuse reports, newest last, bounded per recipient.
    reports: IterableMap<AccountId, Vec<Report>>,
    /// Normalised memo -> the account it was first paid to.
    memo_payees: LookupMap<String, AccountId>,
}

#[near]
impl Vault {
    #[init]
    pub fn new(owner: AccountId, policy: Policy) -> Self {
        policy.assert_valid();
        Self {
            owner,
            paused: false,
            policy,
            agents: IterableMap::new(StorageKey::Agents),
            allowlist: IterableSet::new(StorageKey::Allowlist),
            blocklist: IterableSet::new(StorageKey::Blocklist),
            pending: IterableMap::new(StorageKey::Pending),
            log: LookupMap::new(StorageKey::Log),
            log_start: 0,
            next_log_id: 0,
            next_pending_id: 0,
            recipients: IterableMap::new(StorageKey::Recipients),
            reports: IterableMap::new(StorageKey::Reports),
            memo_payees: LookupMap::new(StorageKey::MemoPayees),
        }
    }

    // ---------------------------------------------------------------------
    // Agent method — the only one the function-call access key may call.
    // ---------------------------------------------------------------------

    /// Ask the vault to pay `recipient`.
    ///
    /// Returns the verdict. Panics only on malformed input or an unregistered
    /// caller; a policy violation is a recorded `Rejected`, never a panic.
    pub fn request_payment(
        &mut self,
        recipient: AccountId,
        amount: NearToken,
        memo: String,
    ) -> PaymentDecision {
        assert!(!amount.is_zero(), "amount must be greater than zero");
        assert!(
            memo.len() <= MAX_MEMO_LEN,
            "memo must be at most {MAX_MEMO_LEN} bytes"
        );

        let agent_id = env::predecessor_account_id();
        let now = env::block_timestamp_ms();

        let mut st = self
            .agents
            .get(&agent_id)
            .unwrap_or_else(|| {
                env::panic_str("caller is not a registered agent on this vault")
            })
            .clone();
        roll_windows(&mut st, now, &self.policy);

        // Seeing an account at all is the signal, whether or not we pay it:
        // the trust delay has to start from first contact, not first payment,
        // or it could be skipped by requesting early and paying later.
        if !self.recipients.contains_key(&recipient) {
            self.recipients
                .insert(recipient.clone(), RecipientRecord::new(now));
        }

        let memo_payee = Self::memo_key(&memo).and_then(|k| self.memo_payees.get(&k).cloned());

        let eval = {
            let vault_id = env::current_account_id();
            let ctx = Context {
                policy: &self.policy,
                paused: self.paused,
                counterparty: self.counterparty(&recipient),
                vault_id: &vault_id,
                owner_id: &self.owner,
                agent_id: &agent_id,
                recipient: &recipient,
                amount,
                available_balance: self.available_balance(),
                now_ms: now,
                memo_bound_to: memo_payee.as_ref(),
            };
            evaluate(&ctx, &st)
        };

        match eval {
            Eval::Approve => {
                // Reserve the spend before the transfer receipt goes out; the
                // callback refunds it if the transfer fails.
                st.spent_in_window = st.spent_in_window.saturating_add(amount);
                st.tx_in_hour = st.tx_in_hour.saturating_add(1);
                self.agents.insert(agent_id.clone(), st);

                // Bind the memo to this account now; the next request using the
                // same description against a different account has to be seen.
                self.bind_memo(&memo, &recipient, false);

                let reason = "within policy".to_string();
                let log_id = self.append_log(
                    &agent_id,
                    &recipient,
                    amount,
                    &memo,
                    Decision::Approved,
                    reason.clone(),
                );
                self.schedule_transfer(log_id, agent_id, recipient, amount, true);

                PaymentDecision {
                    decision: Decision::Approved,
                    reason,
                    pending_id: None,
                    log_id: Some(U64(log_id)),
                    agent_frozen: false,
                }
            }
            Eval::Pending { reason } => {
                self.agents.insert(agent_id.clone(), st);

                let pending_id = self.next_pending_id;
                self.next_pending_id += 1;
                self.pending.insert(
                    pending_id,
                    PendingPayment {
                        id: U64(pending_id),
                        agent: agent_id.clone(),
                        recipient: recipient.clone(),
                        amount,
                        memo: memo.clone(),
                        created_ms: U64(now),
                        reason: reason.clone(),
                    },
                );

                let log_id = self.append_log(
                    &agent_id,
                    &recipient,
                    amount,
                    &memo,
                    Decision::Pending,
                    reason.clone(),
                );

                PaymentDecision {
                    decision: Decision::Pending,
                    reason,
                    pending_id: Some(U64(pending_id)),
                    log_id: Some(U64(log_id)),
                    agent_frozen: false,
                }
            }
            Eval::Reject { reason, strike } => {
                let mut frozen = false;
                if strike {
                    st.strikes = st.strikes.saturating_add(1);
                    if st.strikes >= self.policy.strike_limit {
                        st.active = false;
                        frozen = true;
                    }
                }
                let strikes_now = st.strikes;
                self.agents.insert(agent_id.clone(), st);

                let log_id = self.append_log(
                    &agent_id,
                    &recipient,
                    amount,
                    &memo,
                    Decision::Rejected,
                    reason.clone(),
                );

                if frozen {
                    self.append_log(
                        &agent_id,
                        &recipient,
                        NearToken::from_yoctonear(0),
                        "",
                        Decision::AgentFrozen,
                        format!(
                            "auto-frozen: {} strikes reached strike_limit ({})",
                            strikes_now, self.policy.strike_limit
                        ),
                    );
                }

                PaymentDecision {
                    decision: Decision::Rejected,
                    reason,
                    pending_id: None,
                    log_id: Some(U64(log_id)),
                    agent_frozen: frozen,
                }
            }
        }
    }

    /// Settle the audit log once the transfer receipt resolves.
    #[private]
    pub fn on_transfer_complete(
        &mut self,
        log_id: U64,
        agent: AccountId,
        recipient: AccountId,
        amount: NearToken,
        reserved: bool,
    ) {
        // A transfer promise yields an empty result, so a 0-byte bound is enough
        // and avoids the out-of-gas footgun in the deprecated `promise_result`.
        let ok = env::promise_result_checked(0, 0).is_ok();
        if ok {
            // History counts money that actually landed, not requests made.
            let now = env::block_timestamp_ms();
            let rec = self
                .recipients
                .entry(recipient.clone())
                .or_insert_with(|| RecipientRecord::new(now));
            rec.times_paid = rec.times_paid.saturating_add(1);
            rec.total_paid = rec.total_paid.saturating_add(amount);
            rec.last_paid_ms = now;

            self.append_log(
                &agent,
                &recipient,
                amount,
                "",
                Decision::Executed,
                format!("transfer settled (approval #{})", log_id.0),
            );
        } else {
            if reserved {
                if let Some(st) = self.agents.get_mut(&agent) {
                    st.spent_in_window = st.spent_in_window.saturating_sub(amount);
                    st.tx_in_hour = st.tx_in_hour.saturating_sub(1);
                }
            }
            self.append_log(
                &agent,
                &recipient,
                amount,
                "",
                Decision::Failed,
                format!(
                    "transfer failed (approval #{}); recipient may not exist, reserved spend refunded",
                    log_id.0
                ),
            );
        }
    }

    // ---------------------------------------------------------------------
    // Owner methods. Sensitive ones require 1 yoctoNEAR, which a function-call
    // access key physically cannot attach.
    // ---------------------------------------------------------------------

    #[payable]
    pub fn set_policy(&mut self, policy: Policy) {
        assert_one_yocto();
        self.assert_owner();
        policy.assert_valid();
        self.policy = policy;
        events::emit_policy_updated(&self.owner);
    }

    #[payable]
    pub fn add_agent(&mut self, account_id: AccountId, label: String) {
        assert_one_yocto();
        self.assert_owner();
        assert!(label.len() <= 64, "label must be at most 64 bytes");
        assert!(
            !self.agents.contains_key(&account_id),
            "agent is already registered"
        );
        self.agents.insert(
            account_id.clone(),
            AgentState::new(label.clone(), env::block_timestamp_ms()),
        );
        events::emit_agent_registered(&account_id, &label);
    }

    #[payable]
    pub fn remove_agent(&mut self, account_id: AccountId) {
        assert_one_yocto();
        self.assert_owner();
        assert!(
            self.agents.remove(&account_id).is_some(),
            "no such agent"
        );
        events::emit_agent_removed(&account_id);
    }

    #[payable]
    pub fn freeze_agent(&mut self, account_id: AccountId) {
        assert_one_yocto();
        self.assert_owner();
        let st = self
            .agents
            .get_mut(&account_id)
            .unwrap_or_else(|| env::panic_str("no such agent"));
        st.active = false;
        self.append_log(
            &account_id,
            &account_id.clone(),
            NearToken::from_yoctonear(0),
            "",
            Decision::AgentFrozen,
            "frozen by owner".to_string(),
        );
    }

    /// Unfreeze and clear strikes, so one stale strike does not re-freeze it.
    #[payable]
    pub fn unfreeze_agent(&mut self, account_id: AccountId) {
        assert_one_yocto();
        self.assert_owner();
        let now = env::block_timestamp_ms();
        let st = self
            .agents
            .get_mut(&account_id)
            .unwrap_or_else(|| env::panic_str("no such agent"));
        st.active = true;
        st.strikes = 0;
        st.strike_window_start_ms = now;
        self.append_log(
            &account_id,
            &account_id.clone(),
            NearToken::from_yoctonear(0),
            "",
            Decision::AgentUnfrozen,
            "unfrozen by owner, strikes reset".to_string(),
        );
    }

    #[payable]
    pub fn add_to_allowlist(&mut self, account_id: AccountId) {
        assert_one_yocto();
        self.assert_owner();
        self.allowlist.insert(account_id.clone());
        events::emit_list_changed("allowlist", &account_id, true);
    }

    #[payable]
    pub fn remove_from_allowlist(&mut self, account_id: AccountId) {
        assert_one_yocto();
        self.assert_owner();
        self.allowlist.remove(&account_id);
        events::emit_list_changed("allowlist", &account_id, false);
    }

    #[payable]
    pub fn add_to_blocklist(&mut self, account_id: AccountId) {
        assert_one_yocto();
        self.assert_owner();
        self.blocklist.insert(account_id.clone());
        events::emit_list_changed("blocklist", &account_id, true);
    }

    #[payable]
    pub fn remove_from_blocklist(&mut self, account_id: AccountId) {
        assert_one_yocto();
        self.assert_owner();
        self.blocklist.remove(&account_id);
        events::emit_list_changed("blocklist", &account_id, false);
    }

    /// Release a queued payment. Counts against the agent's daily budget now.
    #[payable]
    pub fn approve_pending(&mut self, id: U64) -> PaymentDecision {
        assert_one_yocto();
        self.assert_owner();
        assert!(!self.paused, "vault is paused");

        let p = self
            .pending
            .remove(&id.0)
            .unwrap_or_else(|| env::panic_str("no such pending payment"));
        assert!(
            p.amount <= self.available_balance(),
            "insufficient available balance to release this payment"
        );

        if let Some(st) = self.agents.get_mut(&p.agent) {
            st.spent_in_window = st.spent_in_window.saturating_add(p.amount);
            st.tx_in_hour = st.tx_in_hour.saturating_add(1);
        }

        // An owner release is a deliberate blessing of this account for this
        // memo, including when rule 8c is what queued it. Bind it, so the
        // vendor's new account becomes the remembered one.
        self.bind_memo(&p.memo, &p.recipient, true);

        let reason = "released by owner".to_string();
        let log_id = self.append_log(
            &p.agent,
            &p.recipient,
            p.amount,
            &p.memo,
            Decision::OwnerApproved,
            reason.clone(),
        );
        self.schedule_transfer(log_id, p.agent.clone(), p.recipient.clone(), p.amount, true);

        PaymentDecision {
            decision: Decision::OwnerApproved,
            reason,
            pending_id: Some(id),
            log_id: Some(U64(log_id)),
            agent_frozen: false,
        }
    }

    #[payable]
    pub fn reject_pending(&mut self, id: U64) {
        assert_one_yocto();
        self.assert_owner();
        let p = self
            .pending
            .remove(&id.0)
            .unwrap_or_else(|| env::panic_str("no such pending payment"));
        self.append_log(
            &p.agent,
            &p.recipient,
            p.amount,
            &p.memo,
            Decision::OwnerRejected,
            "rejected by owner".to_string(),
        );
    }

    #[payable]
    pub fn pause(&mut self) {
        assert_one_yocto();
        self.assert_owner();
        self.paused = true;
        events::emit_paused(&self.owner, true);
    }

    #[payable]
    pub fn unpause(&mut self) {
        assert_one_yocto();
        self.assert_owner();
        self.paused = false;
        events::emit_paused(&self.owner, false);
    }

    #[payable]
    pub fn withdraw(&mut self, amount: NearToken) -> Promise {
        assert_one_yocto();
        self.assert_owner();
        assert!(
            amount <= self.available_balance(),
            "amount exceeds available balance"
        );
        events::emit_withdraw(&self.owner, amount);
        Promise::new(self.owner.clone()).transfer(amount)
    }

    /// Drop pending payments past their TTL. Callable by anyone — it only ever
    /// removes requests, so it cannot be abused.
    pub fn expire_pending(&mut self) -> u32 {
        let now = env::block_timestamp_ms();
        let ttl = self.policy.pending_ttl_ms;
        let stale: Vec<u64> = self
            .pending
            .iter()
            .filter(|(_, p)| now.saturating_sub(p.created_ms.0) >= ttl)
            .map(|(k, _)| *k)
            .collect();

        let count = stale.len() as u32;
        for id in stale {
            if let Some(p) = self.pending.remove(&id) {
                self.append_log(
                    &p.agent,
                    &p.recipient,
                    p.amount,
                    &p.memo,
                    Decision::Expired,
                    format!("expired after pending_ttl_ms ({} ms)", ttl),
                );
            }
        }
        count
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    pub fn get_policy(&self) -> Policy {
        self.policy.clone()
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    pub fn get_agents(&self) -> Vec<AgentView> {
        let now = env::block_timestamp_ms();
        self.agents
            .iter()
            .map(|(id, st)| self.agent_view(id, st, now))
            .collect()
    }

    pub fn get_agent(&self, account_id: AccountId) -> Option<AgentView> {
        let now = env::block_timestamp_ms();
        self.agents
            .get(&account_id)
            .map(|st| self.agent_view(&account_id, st, now))
    }

    pub fn get_allowlist(&self) -> Vec<AccountId> {
        self.allowlist.iter().cloned().collect()
    }

    pub fn get_blocklist(&self) -> Vec<AccountId> {
        self.blocklist.iter().cloned().collect()
    }

    pub fn get_pending(&self) -> Vec<PendingPayment> {
        self.pending.iter().map(|(_, p)| p.clone()).collect()
    }

    /// Total audit entries ever written (ids are absolute and never reused).
    pub fn get_log_len(&self) -> U64 {
        U64(self.next_log_id)
    }

    /// `[oldest_retained_id, next_id)` — the window still on chain.
    pub fn get_log_window(&self) -> (U64, U64) {
        (U64(self.log_start), U64(self.next_log_id))
    }

    pub fn get_log(&self, from_index: U64, limit: u32) -> Vec<LogEntry> {
        let start = from_index.0.max(self.log_start);
        let end = (start + limit as u64).min(self.next_log_id);
        (start..end)
            .filter_map(|i| self.log.get(&i).cloned())
            .collect()
    }

    /// Newest entries first — what the dashboard actually renders.
    pub fn get_recent_log(&self, limit: u32) -> Vec<LogEntry> {
        let end = self.next_log_id;
        let start = end.saturating_sub(limit as u64).max(self.log_start);
        (start..end)
            .rev()
            .filter_map(|i| self.log.get(&i).cloned())
            .collect()
    }

    /// One-shot read of the whole vault, for dashboards.
    ///
    /// Prefer this over nine separate view calls: it is one RPC round trip and
    /// one consistent block snapshot.
    pub fn get_dashboard(&self, log_limit: u32) -> DashboardView {
        DashboardView {
            owner: self.owner.clone(),
            paused: self.paused,
            policy: self.policy.clone(),
            agents: self.get_agents(),
            pending: self.get_pending(),
            log: self.get_recent_log(log_limit),
            balance: self.get_balance(),
            allowlist: self.get_allowlist(),
            blocklist: self.get_blocklist(),
            flagged: self.get_flagged(),
            as_of_ms: U64(env::block_timestamp_ms()),
        }
    }

    pub fn get_balance(&self) -> BalanceView {
        let total = env::account_balance();
        let storage_reserve = self.storage_reserve();
        BalanceView {
            total,
            storage_reserve,
            safety_buffer: SAFETY_BUFFER,
            available: self.available_balance(),
        }
    }

    /// Dry-run a payment without touching state.
    ///
    /// Shares [`evaluate`] with `request_payment`, so the answer here is the
    /// answer the agent would get.
    pub fn simulate_payment(
        &self,
        agent: AccountId,
        recipient: AccountId,
        amount: NearToken,
        memo: Option<String>,
    ) -> PaymentDecision {
        let flat = |reason: String| PaymentDecision {
            decision: Decision::Rejected,
            reason,
            pending_id: None,
            log_id: None,
            agent_frozen: false,
        };

        if amount.is_zero() {
            return flat("amount must be greater than zero".to_string());
        }
        let Some(stored) = self.agents.get(&agent) else {
            return flat(format!("{} is not a registered agent on this vault", agent));
        };

        let mut st = stored.clone();
        roll_windows(&mut st, env::block_timestamp_ms(), &self.policy);

        let memo_payee = memo
            .as_deref()
            .and_then(Self::memo_key)
            .and_then(|k| self.memo_payees.get(&k).cloned());

        let vault_id = env::current_account_id();
        let ctx = Context {
            policy: &self.policy,
            paused: self.paused,
            counterparty: self.counterparty(&recipient),
            vault_id: &vault_id,
            owner_id: &self.owner,
            agent_id: &agent,
            recipient: &recipient,
            amount,
            available_balance: self.available_balance(),
            now_ms: env::block_timestamp_ms(),
            memo_bound_to: memo_payee.as_ref(),
        };

        match evaluate(&ctx, &st) {
            Eval::Approve => PaymentDecision {
                decision: Decision::Approved,
                reason: "within policy".to_string(),
                pending_id: None,
                log_id: None,
                agent_frozen: false,
            },
            Eval::Pending { reason } => PaymentDecision {
                decision: Decision::Pending,
                reason,
                pending_id: None,
                log_id: None,
                agent_frozen: false,
            },
            Eval::Reject { reason, strike } => PaymentDecision {
                decision: Decision::Rejected,
                reason,
                pending_id: None,
                log_id: None,
                agent_frozen: strike
                    && st.strikes.saturating_add(1) >= self.policy.strike_limit,
            },
        }
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    // ---------------------------------------------------------------------
    // Counterparty intelligence. Reporting is open to anyone on purpose: a
    // blocklist only the owner can write is no help against a scammer the
    // owner has never heard of. The bond and the distinct-reporter threshold
    // are what stop that openness becoming a weapon.
    // ---------------------------------------------------------------------

    /// File an abuse report against a recipient. Callable by anyone.
    ///
    /// Requires `REPORT_BOND` attached, which is kept: it pays for the storage
    /// and makes mass-reporting expensive. One account reporting repeatedly
    /// still counts once towards the block threshold.
    #[payable]
    pub fn report_recipient(&mut self, account_id: AccountId, category: String, evidence: String) {
        assert!(
            env::attached_deposit() >= REPORT_BOND,
            "a report requires a bond of {} attached",
            REPORT_BOND
        );
        assert!(
            !category.is_empty() && category.len() <= MAX_CATEGORY_LEN,
            "category must be 1..={MAX_CATEGORY_LEN} bytes"
        );
        assert!(
            evidence.len() <= MAX_EVIDENCE_LEN,
            "evidence must be at most {MAX_EVIDENCE_LEN} bytes"
        );

        let reporter = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        let mut list = self.reports.get(&account_id).cloned().unwrap_or_default();
        assert!(
            list.len() < MAX_REPORTS_PER_RECIPIENT,
            "this recipient already has the maximum of {MAX_REPORTS_PER_RECIPIENT} reports"
        );
        assert!(
            !list.iter().any(|r| r.reporter == reporter),
            "{} has already reported {}",
            reporter,
            account_id
        );

        list.push(Report {
            reporter: reporter.clone(),
            category: category.clone(),
            evidence,
            ts_ms: U64(now),
        });
        let distinct = list.len() as u32;
        self.reports.insert(account_id.clone(), list);

        events::emit_recipient_reported(&account_id, &reporter, &category, distinct);
    }

    /// Owner can clear reports against an account, e.g. after review.
    #[payable]
    pub fn clear_reports(&mut self, account_id: AccountId) {
        assert_one_yocto();
        self.assert_owner();
        self.reports.remove(&account_id);
        events::emit_reports_cleared(&account_id);
    }

    /// The counterparty verdict for one account: allow, warn or block.
    ///
    /// Produced by the same `classify` the payment path uses, so what a human
    /// reads here is what the chain will do.
    pub fn get_recipient(&self, account_id: AccountId) -> RecipientView {
        self.recipient_view(&account_id, env::block_timestamp_ms())
    }

    /// Every report filed against an account, with its evidence.
    pub fn get_reports(&self, account_id: AccountId) -> Vec<Report> {
        self.reports.get(&account_id).cloned().unwrap_or_default()
    }

    /// Accounts with at least one report, worst first.
    pub fn get_flagged(&self) -> Vec<RecipientView> {
        let now = env::block_timestamp_ms();
        let mut out: Vec<RecipientView> = self
            .reports
            .keys()
            .map(|a| self.recipient_view(a, now))
            .collect();
        out.sort_by(|a, b| b.distinct_reporters.cmp(&a.distinct_reporters));
        out
    }

    /// The key a memo is indexed under: lowercased, whitespace collapsed,
    /// truncated. Crude on purpose — this is a tripwire, not a parser, and a
    /// vendor-switch attack keeps the description intact precisely so the
    /// invoice still looks routine.
    fn memo_key(memo: &str) -> Option<String> {
        let norm: String = memo.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
        if norm.is_empty() {
            return None;
        }
        Some(norm.chars().take(MEMO_KEY_LEN).collect())
    }

    /// Which account this memo has settled to before, if any.
    pub fn get_memo_payee(&self, memo: String) -> Option<AccountId> {
        Self::memo_key(&memo).and_then(|k| self.memo_payees.get(&k).cloned())
    }

    /// Bind a memo to the account it was paid to.
    ///
    /// `force` is the difference between the vault noticing a payment and the
    /// owner deciding one. An automatic approval only ever fills an empty
    /// binding, so an agent cannot quietly move a vendor by paying twice. An
    /// owner release overwrites it, because the owner has just looked at the
    /// switch and accepted it — without that, every later payment to the
    /// supplier's new account would queue again.
    fn bind_memo(&mut self, memo: &str, recipient: &AccountId, force: bool) {
        if let Some(k) = Self::memo_key(memo) {
            if force || !self.memo_payees.contains_key(&k) {
                self.memo_payees.insert(k, recipient.clone());
            }
        }
    }

    /// Gather what the policy engine needs to know about an account.
    fn counterparty(&self, recipient: &AccountId) -> Counterparty {
        let rec = self.recipients.get(recipient);
        Counterparty {
            blocklisted: self.blocklist.contains(recipient),
            allowlisted: self.allowlist.contains(recipient),
            // One report per account is enforced at filing time, so the list
            // length is already the distinct-reporter count.
            distinct_reporters: self.reports.get(recipient).map_or(0, |r| r.len() as u32),
            times_paid: rec.map_or(0, |r| r.times_paid),
            first_seen_ms: rec.map_or(0, |r| r.first_seen_ms),
        }
    }

    fn recipient_view(&self, account_id: &AccountId, now_ms: u64) -> RecipientView {
        let cp = self.counterparty(account_id);
        let (risk, reasons) = classify(&cp, &self.policy, now_ms);
        let rec = self.recipients.get(account_id);
        RecipientView {
            account_id: account_id.clone(),
            risk,
            reasons,
            first_seen_ms: U64(rec.map_or(0, |r| r.first_seen_ms)),
            times_paid: cp.times_paid,
            total_paid: rec.map_or(NearToken::from_yoctonear(0), |r| r.total_paid),
            last_paid_ms: U64(rec.map_or(0, |r| r.last_paid_ms)),
            reports: self.reports.get(account_id).map_or(0, |r| r.len() as u32),
            distinct_reporters: cp.distinct_reporters,
            allowlisted: cp.allowlisted,
            blocklisted: cp.blocklisted,
        }
    }

    fn assert_owner(&self) {
        assert_eq!(
            env::predecessor_account_id(),
            self.owner,
            "only the vault owner may call this method"
        );
    }

    fn storage_reserve(&self) -> NearToken {
        NearToken::from_yoctonear(
            env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128,
        )
    }

    fn available_balance(&self) -> NearToken {
        env::account_balance()
            .saturating_sub(self.storage_reserve())
            .saturating_sub(SAFETY_BUFFER)
    }

    fn agent_view(&self, id: &AccountId, st: &AgentState, now_ms: u64) -> AgentView {
        let mut rolled = st.clone();
        roll_windows(&mut rolled, now_ms, &self.policy);
        AgentView {
            account_id: id.clone(),
            label: rolled.label.clone(),
            active: rolled.active,
            spent_in_window: rolled.spent_in_window,
            daily_limit: self.policy.daily_limit,
            remaining_today: self
                .policy
                .daily_limit
                .saturating_sub(rolled.spent_in_window),
            tx_in_hour: rolled.tx_in_hour,
            max_tx_per_hour: self.policy.max_tx_per_hour,
            strikes: rolled.strikes,
            strike_limit: self.policy.strike_limit,
            window_start_ms: U64(rolled.window_start_ms),
        }
    }

    fn append_log(
        &mut self,
        agent: &AccountId,
        recipient: &AccountId,
        amount: NearToken,
        memo: &str,
        decision: Decision,
        reason: String,
    ) -> u64 {
        let id = self.next_log_id;
        self.next_log_id += 1;

        let entry = LogEntry {
            id: U64(id),
            ts_ms: U64(env::block_timestamp_ms()),
            agent: agent.clone(),
            recipient: recipient.clone(),
            amount,
            memo: memo.to_string(),
            decision,
            reason,
        };
        events::emit_for_entry(&entry);
        self.log.insert(id, entry);

        // Bound storage: drop the oldest entries past LOG_CAPACITY.
        while self.next_log_id.saturating_sub(self.log_start) > LOG_CAPACITY {
            self.log.remove(&self.log_start);
            self.log_start += 1;
        }
        id
    }

    /// Schedule the transfer plus its settlement callback.
    ///
    /// The promise is intentionally **not** returned: the agent gets its
    /// verdict in the same call, and the transfer settles in a later receipt
    /// which updates the audit log. A `Promise` is scheduled when dropped.
    fn schedule_transfer(
        &self,
        log_id: u64,
        agent: AccountId,
        recipient: AccountId,
        amount: NearToken,
        reserved: bool,
    ) {
        let _scheduled = Promise::new(recipient.clone()).transfer(amount).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_TRANSFER_CALLBACK)
                .on_transfer_complete(U64(log_id), agent, recipient, amount, reserved),
        );
    }
}

#[cfg(test)]
mod tests;
