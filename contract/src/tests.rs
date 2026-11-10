//! Unit tests for the policy engine and the vault's state transitions.
//!
//! These run against near-sdk's mocked blockchain. Anything that needs real
//! receipts, real access keys or a real transfer lives in `tests/integration.rs`.

use near_sdk::json_types::U64;
use near_sdk::test_utils::{accounts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId, NearToken, PromiseResult};

use super::*;
use crate::types::{Decision, Policy};

const T0: u64 = 1_700_000_000_000; // ms
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const ZERO: NearToken = NearToken::from_yoctonear(0);

fn owner() -> AccountId {
    accounts(0)
}
fn agent() -> AccountId {
    accounts(1)
}
fn merchant() -> AccountId {
    accounts(2)
}
fn attacker() -> AccountId {
    accounts(3)
}
fn stranger() -> AccountId {
    accounts(4)
}
fn vault_id() -> AccountId {
    accounts(5)
}

fn near(n: u128) -> NearToken {
    NearToken::from_near(n)
}
fn milli(n: u128) -> NearToken {
    NearToken::from_millinear(n)
}

fn default_policy() -> Policy {
    Policy {
        max_per_tx: near(2),
        daily_limit: near(5),
        approval_threshold: near(1),
        new_recipient_limit: milli(500),
        allowlist_only: false,
        max_tx_per_hour: 10,
        strike_limit: 3,
        strike_window_ms: 3_600_000,
        pending_ttl_ms: 86_400_000,
    }
}

fn builder(predecessor: AccountId, ts_ms: u64, deposit: NearToken) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(vault_id())
        .signer_account_id(predecessor.clone())
        .predecessor_account_id(predecessor)
        .block_timestamp(ts_ms * 1_000_000)
        .account_balance(near(100))
        .attached_deposit(deposit);
    b
}

fn as_owner(ts_ms: u64) {
    testing_env!(builder(owner(), ts_ms, ONE_YOCTO).build());
}
fn as_owner_no_deposit(ts_ms: u64) {
    testing_env!(builder(owner(), ts_ms, ZERO).build());
}
fn as_agent(ts_ms: u64) {
    testing_env!(builder(agent(), ts_ms, ZERO).build());
}
fn as_account(who: AccountId, ts_ms: u64, deposit: NearToken) {
    testing_env!(builder(who, ts_ms, deposit).build());
}

/// Re-enter the contract as itself, with a settled promise result, so the
/// `on_transfer_complete` callback can be exercised.
fn as_callback(ts_ms: u64, result: PromiseResult) {
    testing_env!(
        builder(vault_id(), ts_ms, ZERO).build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

fn setup_with(policy: Policy) -> Vault {
    as_owner(T0);
    let mut v = Vault::new(owner(), policy);
    v.add_agent(agent(), "Shopping agent".to_string());
    v.add_to_allowlist(merchant());
    v.add_to_blocklist(attacker());
    v
}

fn setup() -> Vault {
    setup_with(default_policy())
}

// ---------------------------------------------------------------------------
// Approve
// ---------------------------------------------------------------------------

#[test]
fn approves_a_payment_within_every_limit() {
    let mut v = setup();
    as_agent(T0);

    let d = v.request_payment(merchant(), milli(300), "api credits".to_string());

    assert_eq!(d.decision, Decision::Approved, "reason: {}", d.reason);
    assert!(!d.agent_frozen);

    let a = v.get_agent(agent()).unwrap();
    assert_eq!(a.spent_in_window, milli(300), "spend is reserved up front");
    assert_eq!(a.tx_in_hour, 1);
    assert_eq!(a.remaining_today, near(5).saturating_sub(milli(300)));
    assert_eq!(a.strikes, 0);
}

#[test]
fn approval_emits_a_nep297_event() {
    let mut v = setup();
    as_agent(T0);
    v.request_payment(merchant(), milli(300), "api credits".to_string());

    let logs = get_logs();
    assert!(
        logs.iter().any(|l| l.starts_with("EVENT_JSON:")
            && l.contains("\"event\":\"payment_approved\"")
            && l.contains("\"standard\":\"warden\"")),
        "expected a payment_approved event, got: {logs:?}"
    );
}

// ---------------------------------------------------------------------------
// Reject
// ---------------------------------------------------------------------------

#[test]
fn rejects_above_max_per_tx_and_records_a_strike() {
    let mut v = setup();
    as_agent(T0);

    let d = v.request_payment(merchant(), near(3), "too big".to_string());

    assert_eq!(d.decision, Decision::Rejected);
    assert!(d.reason.contains("max_per_tx"), "reason: {}", d.reason);
    assert_eq!(v.get_agent(agent()).unwrap().strikes, 1);
    // A rejection must never move funds or consume budget.
    assert_eq!(v.get_agent(agent()).unwrap().spent_in_window, ZERO);
}

#[test]
fn rejects_above_daily_limit() {
    let mut v = setup();

    // Five payments of exactly 1 NEAR fill the 5 NEAR daily budget.
    for i in 0..5 {
        as_agent(T0 + i);
        let d = v.request_payment(merchant(), near(1), format!("buy {i}"));
        assert_eq!(d.decision, Decision::Approved, "payment {i}: {}", d.reason);
    }
    assert_eq!(v.get_agent(agent()).unwrap().spent_in_window, near(5));

    as_agent(T0 + 5);
    let d = v.request_payment(merchant(), near(1), "one too many".to_string());

    assert_eq!(d.decision, Decision::Rejected);
    assert!(d.reason.contains("daily_limit"), "reason: {}", d.reason);
    assert_eq!(v.get_agent(agent()).unwrap().spent_in_window, near(5));
}

#[test]
fn rejects_a_blocklisted_recipient() {
    let mut v = setup();
    as_agent(T0);

    let d = v.request_payment(attacker(), milli(100), "verification fee".to_string());

    assert_eq!(d.decision, Decision::Rejected);
    assert!(d.reason.contains("blocklisted"), "reason: {}", d.reason);
    assert_eq!(v.get_agent(agent()).unwrap().strikes, 1);
}

#[test]
fn rejects_above_the_hourly_rate_limit() {
    let mut v = setup_with(Policy {
        max_tx_per_hour: 2,
        ..default_policy()
    });

    for i in 0..2 {
        as_agent(T0 + i);
        assert_eq!(
            v.request_payment(merchant(), milli(10), format!("drip {i}")).decision,
            Decision::Approved
        );
    }

    as_agent(T0 + 2);
    let d = v.request_payment(merchant(), milli(10), "third".to_string());

    assert_eq!(d.decision, Decision::Rejected);
    assert!(d.reason.contains("max_tx_per_hour"), "reason: {}", d.reason);
}

#[test]
fn rate_limit_window_rolls_after_an_hour() {
    let mut v = setup_with(Policy {
        max_tx_per_hour: 2,
        ..default_policy()
    });
    for i in 0..2 {
        as_agent(T0 + i);
        v.request_payment(merchant(), milli(10), format!("drip {i}"));
    }

    as_agent(T0 + 3_600_001);
    let d = v.request_payment(merchant(), milli(10), "next hour".to_string());

    assert_eq!(d.decision, Decision::Approved, "reason: {}", d.reason);
}

#[test]
fn rejects_everything_while_paused() {
    let mut v = setup();
    as_owner(T0);
    v.pause();
    assert!(v.is_paused());

    as_agent(T0);
    let d = v.request_payment(merchant(), milli(10), "normal".to_string());

    assert_eq!(d.decision, Decision::Rejected);
    assert!(d.reason.contains("paused"), "reason: {}", d.reason);
    // Pausing is an owner action, not agent misbehaviour.
    assert_eq!(v.get_agent(agent()).unwrap().strikes, 0);
}

#[test]
fn rejects_a_frozen_agent() {
    let mut v = setup();
    as_owner(T0);
    v.freeze_agent(agent());

    as_agent(T0);
    let d = v.request_payment(merchant(), milli(10), "normal".to_string());

    assert_eq!(d.decision, Decision::Rejected);
    assert!(d.reason.contains("frozen"), "reason: {}", d.reason);
}

#[test]
fn rejects_paying_the_vault_or_the_agent_itself() {
    let mut v = setup();

    as_agent(T0);
    let d = v.request_payment(vault_id(), milli(10), "loop".to_string());
    assert_eq!(d.decision, Decision::Rejected);
    assert!(d.reason.contains("vault itself"), "reason: {}", d.reason);

    as_agent(T0 + 1);
    let d = v.request_payment(agent(), milli(10), "self".to_string());
    assert_eq!(d.decision, Decision::Rejected);
    assert!(d.reason.contains("agent itself"), "reason: {}", d.reason);
}

#[test]
fn allowlist_only_rejects_an_unknown_recipient() {
    let mut v = setup_with(Policy {
        allowlist_only: true,
        ..default_policy()
    });
    as_agent(T0);

    let d = v.request_payment(stranger(), milli(1), "tiny".to_string());

    assert_eq!(d.decision, Decision::Rejected);
    assert!(d.reason.contains("allowlist"), "reason: {}", d.reason);
    assert_eq!(v.get_agent(agent()).unwrap().strikes, 1);
}

// ---------------------------------------------------------------------------
// Pending
// ---------------------------------------------------------------------------

#[test]
fn holds_a_new_recipient_above_the_new_recipient_limit() {
    let mut v = setup();
    as_agent(T0);

    let d = v.request_payment(stranger(), milli(600), "unknown vendor".to_string());

    assert_eq!(d.decision, Decision::Pending, "reason: {}", d.reason);
    assert!(d.reason.contains("new_recipient_limit"), "reason: {}", d.reason);
    assert_eq!(d.pending_id, Some(U64(0)));

    // Pending must not consume budget until the owner releases it.
    assert_eq!(v.get_agent(agent()).unwrap().spent_in_window, ZERO);
    assert_eq!(v.get_pending().len(), 1);
}

#[test]
fn small_payment_to_a_new_recipient_is_allowed() {
    let mut v = setup();
    as_agent(T0);

    let d = v.request_payment(stranger(), milli(100), "small tip".to_string());

    assert_eq!(d.decision, Decision::Approved, "reason: {}", d.reason);
}

#[test]
fn holds_a_payment_above_the_approval_threshold() {
    let mut v = setup();
    as_agent(T0);

    let d = v.request_payment(merchant(), milli(1500), "bulk credits".to_string());

    assert_eq!(d.decision, Decision::Pending, "reason: {}", d.reason);
    assert!(d.reason.contains("approval_threshold"), "reason: {}", d.reason);
}

#[test]
fn owner_approval_executes_and_charges_the_daily_budget() {
    let mut v = setup();
    as_agent(T0);
    let d = v.request_payment(merchant(), milli(1500), "bulk credits".to_string());
    let pending_id = d.pending_id.unwrap();

    as_owner(T0 + 10);
    let approved = v.approve_pending(pending_id);

    assert_eq!(approved.decision, Decision::OwnerApproved);
    assert!(v.get_pending().is_empty());
    assert_eq!(v.get_agent(agent()).unwrap().spent_in_window, milli(1500));
}

#[test]
fn owner_rejection_clears_the_queue_without_spending() {
    let mut v = setup();
    as_agent(T0);
    let id = v
        .request_payment(merchant(), milli(1500), "bulk".to_string())
        .pending_id
        .unwrap();

    as_owner(T0 + 10);
    v.reject_pending(id);

    assert!(v.get_pending().is_empty());
    assert_eq!(v.get_agent(agent()).unwrap().spent_in_window, ZERO);
    assert_eq!(
        v.get_recent_log(1)[0].decision,
        Decision::OwnerRejected
    );
}

#[test]
fn pending_payments_expire_after_their_ttl() {
    let mut v = setup();
    as_agent(T0);
    v.request_payment(merchant(), milli(1500), "bulk".to_string());
    assert_eq!(v.get_pending().len(), 1);

    // Anyone may sweep; it only ever removes.
    as_account(stranger(), T0 + 86_400_001, ZERO);
    let removed = v.expire_pending();

    assert_eq!(removed, 1);
    assert!(v.get_pending().is_empty());
    assert_eq!(v.get_recent_log(1)[0].decision, Decision::Expired);
}

#[test]
fn pending_payments_survive_until_their_ttl() {
    let mut v = setup();
    as_agent(T0);
    v.request_payment(merchant(), milli(1500), "bulk".to_string());

    as_account(stranger(), T0 + 1_000, ZERO);
    assert_eq!(v.expire_pending(), 0);
    assert_eq!(v.get_pending().len(), 1);
}

// ---------------------------------------------------------------------------
// Strikes and auto-freeze — the core of the demo
// ---------------------------------------------------------------------------

#[test]
fn repeated_violations_auto_freeze_the_agent() {
    let mut v = setup();

    for i in 0..2 {
        as_agent(T0 + i);
        let d = v.request_payment(attacker(), milli(100), "drain".to_string());
        assert_eq!(d.decision, Decision::Rejected);
        assert!(!d.agent_frozen, "froze too early at attempt {i}");
    }

    as_agent(T0 + 2);
    let d = v.request_payment(attacker(), milli(100), "drain".to_string());

    assert_eq!(d.decision, Decision::Rejected);
    assert!(d.agent_frozen, "should freeze on the third strike");
    assert!(!v.get_agent(agent()).unwrap().active);

    // And the freeze is itself audited.
    assert_eq!(v.get_recent_log(1)[0].decision, Decision::AgentFrozen);

    // A frozen agent is now blocked even for a perfectly legitimate payment.
    as_agent(T0 + 3);
    let d = v.request_payment(merchant(), milli(10), "legit".to_string());
    assert_eq!(d.decision, Decision::Rejected);
    assert!(d.reason.contains("frozen"), "reason: {}", d.reason);
}

#[test]
fn unfreezing_resets_strikes_and_restores_service() {
    let mut v = setup();
    for i in 0..3 {
        as_agent(T0 + i);
        v.request_payment(attacker(), milli(100), "drain".to_string());
    }
    assert!(!v.get_agent(agent()).unwrap().active);

    as_owner(T0 + 10);
    v.unfreeze_agent(agent());

    let a = v.get_agent(agent()).unwrap();
    assert!(a.active);
    assert_eq!(a.strikes, 0, "stale strikes must not re-freeze immediately");

    as_agent(T0 + 11);
    assert_eq!(
        v.request_payment(merchant(), milli(10), "legit".to_string()).decision,
        Decision::Approved
    );
}

#[test]
fn strikes_decay_after_the_strike_window() {
    let mut v = setup();
    for i in 0..2 {
        as_agent(T0 + i);
        v.request_payment(attacker(), milli(100), "drain".to_string());
    }
    assert_eq!(v.get_agent(agent()).unwrap().strikes, 2);

    // Two strikes an hour apart must not add up to a freeze.
    as_agent(T0 + 3_600_001);
    let d = v.request_payment(attacker(), milli(100), "drain".to_string());

    assert_eq!(d.decision, Decision::Rejected);
    assert!(!d.agent_frozen);
    assert_eq!(v.get_agent(agent()).unwrap().strikes, 1);
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

#[test]
fn daily_window_resets_after_24h() {
    let mut v = setup();
    for i in 0..5 {
        as_agent(T0 + i);
        v.request_payment(merchant(), near(1), format!("buy {i}"));
    }
    as_agent(T0 + 5);
    assert_eq!(
        v.request_payment(merchant(), near(1), "blocked".to_string()).decision,
        Decision::Rejected
    );

    as_agent(T0 + 86_400_001);
    let d = v.request_payment(merchant(), near(1), "new day".to_string());

    assert_eq!(d.decision, Decision::Approved, "reason: {}", d.reason);
    assert_eq!(v.get_agent(agent()).unwrap().spent_in_window, near(1));
}

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

#[test]
#[should_panic(expected = "only the vault owner")]
fn non_owner_cannot_pause() {
    let mut v = setup();
    as_account(agent(), T0, ONE_YOCTO);
    v.pause();
}

#[test]
#[should_panic(expected = "only the vault owner")]
fn non_owner_cannot_set_policy() {
    let mut v = setup();
    as_account(attacker(), T0, ONE_YOCTO);
    v.set_policy(default_policy());
}

#[test]
#[should_panic(expected = "only the vault owner")]
fn non_owner_cannot_withdraw() {
    let mut v = setup();
    as_account(attacker(), T0, ONE_YOCTO);
    let _ = v.withdraw(near(1));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn owner_methods_require_one_yocto() {
    let mut v = setup();
    as_owner_no_deposit(T0);
    v.pause();
}

#[test]
#[should_panic(expected = "not a registered agent")]
fn unregistered_caller_cannot_request_payment() {
    let mut v = setup();
    as_account(stranger(), T0, ZERO);
    v.request_payment(merchant(), milli(10), "sneaky".to_string());
}

#[test]
#[should_panic(expected = "amount must be greater than zero")]
fn zero_amount_is_malformed() {
    let mut v = setup();
    as_agent(T0);
    v.request_payment(merchant(), ZERO, "nothing".to_string());
}

#[test]
#[should_panic(expected = "memo must be at most")]
fn oversized_memo_is_malformed() {
    let mut v = setup();
    as_agent(T0);
    v.request_payment(merchant(), milli(10), "x".repeat(257));
}

#[test]
#[should_panic(expected = "max_per_tx must be greater than zero")]
fn invalid_policy_is_rejected_at_init() {
    as_owner(T0);
    Vault::new(
        owner(),
        Policy {
            max_per_tx: ZERO,
            ..default_policy()
        },
    );
}

// ---------------------------------------------------------------------------
// simulate_payment
// ---------------------------------------------------------------------------

#[test]
fn simulate_matches_request_and_leaves_no_trace() {
    let mut v = setup();

    as_agent(T0);
    let before_log = v.get_log_len();
    let simulated = v.simulate_payment(agent(), attacker(), milli(100));

    assert_eq!(simulated.decision, Decision::Rejected);
    assert_eq!(v.get_log_len(), before_log, "simulation must not log");
    assert_eq!(v.get_agent(agent()).unwrap().strikes, 0, "simulation must not strike");

    let real = v.request_payment(attacker(), milli(100), "drain".to_string());
    assert_eq!(simulated.decision, real.decision);
    assert_eq!(simulated.reason, real.reason);
}

#[test]
fn simulate_agrees_on_approve_and_pending() {
    let v = setup();
    as_agent(T0);

    assert_eq!(
        v.simulate_payment(agent(), merchant(), milli(300)).decision,
        Decision::Approved
    );
    assert_eq!(
        v.simulate_payment(agent(), merchant(), milli(1500)).decision,
        Decision::Pending
    );
    assert_eq!(
        v.simulate_payment(agent(), merchant(), near(3)).decision,
        Decision::Rejected
    );
}

#[test]
fn simulate_warns_when_the_next_strike_would_freeze() {
    let mut v = setup();
    for i in 0..2 {
        as_agent(T0 + i);
        v.request_payment(attacker(), milli(100), "drain".to_string());
    }

    let s = v.simulate_payment(agent(), attacker(), milli(100));
    assert!(s.agent_frozen, "third strike should be flagged as freezing");
}

#[test]
fn simulate_rejects_an_unregistered_agent_without_panicking() {
    let v = setup();
    let s = v.simulate_payment(stranger(), merchant(), milli(10));
    assert_eq!(s.decision, Decision::Rejected);
    assert!(s.reason.contains("not a registered agent"), "reason: {}", s.reason);
}

// ---------------------------------------------------------------------------
// Transfer settlement
// ---------------------------------------------------------------------------

#[test]
fn successful_transfer_is_logged_as_executed() {
    let mut v = setup();
    as_agent(T0);
    let d = v.request_payment(merchant(), milli(300), "api credits".to_string());
    let log_id = d.log_id.unwrap();

    as_callback(T0 + 1, PromiseResult::Successful(vec![]));
    v.on_transfer_complete(log_id, agent(), merchant(), milli(300), true);

    let newest = &v.get_recent_log(1)[0];
    assert_eq!(newest.decision, Decision::Executed);
    assert_eq!(v.get_agent(agent()).unwrap().spent_in_window, milli(300));
}

#[test]
fn failed_transfer_refunds_the_reserved_spend() {
    let mut v = setup();
    as_agent(T0);
    let d = v.request_payment(merchant(), milli(300), "api credits".to_string());
    let log_id = d.log_id.unwrap();
    assert_eq!(v.get_agent(agent()).unwrap().spent_in_window, milli(300));

    as_callback(T0 + 1, PromiseResult::Failed);
    v.on_transfer_complete(log_id, agent(), merchant(), milli(300), true);

    let newest = &v.get_recent_log(1)[0];
    assert_eq!(newest.decision, Decision::Failed);
    let a = v.get_agent(agent()).unwrap();
    assert_eq!(a.spent_in_window, ZERO, "budget must be given back");
    assert_eq!(a.tx_in_hour, 0);
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

#[test]
fn log_is_append_only_and_newest_first() {
    let mut v = setup();
    as_agent(T0);
    v.request_payment(merchant(), milli(10), "one".to_string());
    as_agent(T0 + 1);
    v.request_payment(attacker(), milli(10), "two".to_string());

    assert_eq!(v.get_log_len(), U64(2));

    let recent = v.get_recent_log(10);
    assert_eq!(recent.len(), 2);
    assert_eq!(recent[0].decision, Decision::Rejected);
    assert_eq!(recent[0].memo, "two");
    assert_eq!(recent[1].decision, Decision::Approved);
    assert_eq!(recent[1].memo, "one");

    let page = v.get_log(U64(0), 1);
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].memo, "one");
}

#[test]
fn owner_can_edit_the_lists_and_the_policy_takes_effect() {
    let mut v = setup();

    as_owner(T0);
    v.remove_from_blocklist(attacker());
    v.add_to_allowlist(attacker());
    assert!(v.get_blocklist().is_empty());
    assert_eq!(v.get_allowlist().len(), 2);

    as_agent(T0 + 1);
    assert_eq!(
        v.request_payment(attacker(), milli(10), "now allowed".to_string()).decision,
        Decision::Approved
    );

    as_owner(T0 + 2);
    v.set_policy(Policy {
        max_per_tx: milli(5),
        ..default_policy()
    });

    as_agent(T0 + 3);
    assert_eq!(
        v.request_payment(merchant(), milli(10), "now too big".to_string()).decision,
        Decision::Rejected
    );
}
