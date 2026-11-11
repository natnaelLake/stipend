use near_sdk::serde_json::{json, Value};
use near_sdk::{env, AccountId, NearToken};

use crate::types::{Decision, LogEntry};

pub const EVENT_STANDARD: &str = "stipend";
pub const EVENT_VERSION: &str = "1.0.0";

/// Emit a NEP-297 style structured log line.
pub fn emit(event: &str, data: Value) {
    let payload = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{}", payload));
}

/// Map a log entry onto its event name and emit it.
pub fn emit_for_entry(entry: &LogEntry) {
    let event = match entry.decision {
        Decision::Approved => "payment_approved",
        Decision::Pending => "payment_pending",
        Decision::Rejected => "payment_rejected",
        Decision::Executed => "payment_executed",
        Decision::Failed => "payment_failed",
        Decision::OwnerApproved => "payment_owner_approved",
        Decision::OwnerRejected => "payment_owner_rejected",
        Decision::Expired => "payment_expired",
        Decision::AgentFrozen => "agent_frozen",
        Decision::AgentUnfrozen => "agent_unfrozen",
    };
    emit(
        event,
        json!({
            "log_id": entry.id,
            "ts_ms": entry.ts_ms,
            "agent": entry.agent,
            "recipient": entry.recipient,
            "amount": entry.amount,
            "memo": entry.memo,
            "decision": entry.decision.as_str(),
            "reason": entry.reason,
        }),
    );
}

pub fn emit_policy_updated(by: &AccountId) {
    emit("policy_updated", json!({ "by": by }));
}

pub fn emit_paused(by: &AccountId, paused: bool) {
    emit(
        if paused { "paused" } else { "unpaused" },
        json!({ "by": by }),
    );
}

pub fn emit_agent_registered(agent: &AccountId, label: &str) {
    emit(
        "agent_registered",
        json!({ "agent": agent, "label": label }),
    );
}

pub fn emit_agent_removed(agent: &AccountId) {
    emit("agent_removed", json!({ "agent": agent }));
}

pub fn emit_list_changed(list: &str, account: &AccountId, added: bool) {
    emit(
        if added { "list_added" } else { "list_removed" },
        json!({ "list": list, "account": account }),
    );
}

pub fn emit_withdraw(to: &AccountId, amount: NearToken) {
    emit("withdraw", json!({ "to": to, "amount": amount }));
}
