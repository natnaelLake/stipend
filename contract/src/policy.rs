//! The policy engine.
//!
//! Deliberately pure: no `env::*`, no state writes. `request_payment` and the
//! `simulate_payment` view both call [`evaluate`], which is the only reason the
//! dry-run in the dashboard is guaranteed to agree with what actually happens
//! on chain.

use near_sdk::{AccountId, NearToken};

use crate::types::{AgentState, Policy};

pub const DAY_MS: u64 = 86_400_000;
pub const HOUR_MS: u64 = 3_600_000;

/// The verdict for one request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Eval {
    /// Passes every rule; execute it.
    Approve,
    /// Hold for the owner.
    Pending { reason: String },
    /// Blocked. `strike` marks the rejections that count towards auto-freeze.
    Reject { reason: String, strike: bool },
}

/// Everything about the vault the engine needs, gathered by the caller.
pub struct Context<'a> {
    pub policy: &'a Policy,
    pub paused: bool,
    pub blocklisted: bool,
    pub allowlisted: bool,
    pub vault_id: &'a AccountId,
    pub owner_id: &'a AccountId,
    pub agent_id: &'a AccountId,
    pub recipient: &'a AccountId,
    pub amount: NearToken,
    pub available_balance: NearToken,
}

/// Roll the per-agent windows forward to `now_ms`.
///
/// Called before every evaluation so limits are rolling rather than fixed
/// calendar buckets, and so a frozen-out agent is not punished forever.
pub fn roll_windows(st: &mut AgentState, now_ms: u64, policy: &Policy) {
    if now_ms.saturating_sub(st.window_start_ms) >= DAY_MS {
        st.window_start_ms = now_ms;
        st.spent_in_window = NearToken::from_yoctonear(0);
    }
    if now_ms.saturating_sub(st.hour_start_ms) >= HOUR_MS {
        st.hour_start_ms = now_ms;
        st.tx_in_hour = 0;
    }
    if now_ms.saturating_sub(st.strike_window_start_ms) >= policy.strike_window_ms {
        st.strike_window_start_ms = now_ms;
        st.strikes = 0;
    }
}

fn reject(reason: String, strike: bool) -> Eval {
    Eval::Reject { reason, strike }
}

/// Evaluate one payment request. `st` must already be rolled forward.
///
/// Rules are checked in a fixed order and the first one that fires wins, so the
/// `reason` string always names a single rule. This order is part of the public
/// contract: it is documented in the README and asserted in the tests.
pub fn evaluate(ctx: &Context, st: &AgentState) -> Eval {
    let p = ctx.policy;

    // 1. Global kill switch.
    if ctx.paused {
        return reject("vault is paused by the owner".to_string(), false);
    }

    // 2. Frozen agent. (Registration is an auth check done by the caller.)
    if !st.active {
        return reject(
            format!(
                "agent frozen after {} rejected attempts (strike_limit {})",
                st.strikes, p.strike_limit
            ),
            false,
        );
    }

    // 3. Explicit blocklist.
    if ctx.blocklisted {
        return reject(
            format!("recipient {} is blocklisted", ctx.recipient),
            true,
        );
    }

    // 4. Self-dealing: paying the vault or the agent itself moves nothing and
    //    is a common exfiltration shape, so it is a strike, not a no-op.
    if ctx.recipient == ctx.vault_id {
        return reject("recipient is the vault itself".to_string(), true);
    }
    if ctx.recipient == ctx.agent_id {
        return reject("recipient is the agent itself".to_string(), true);
    }

    // 5. Per-transaction cap.
    if ctx.amount > p.max_per_tx {
        return reject(
            format!(
                "exceeds max_per_tx (requested {}, cap {})",
                ctx.amount, p.max_per_tx
            ),
            true,
        );
    }

    // 6. Rolling 24h budget.
    let would_spend = st
        .spent_in_window
        .checked_add(ctx.amount)
        .unwrap_or(NearToken::from_yoctonear(u128::MAX));
    if would_spend > p.daily_limit {
        return reject(
            format!(
                "exceeds daily_limit (spent {} of {} in the last 24h, requested {})",
                st.spent_in_window, p.daily_limit, ctx.amount
            ),
            true,
        );
    }

    // 7. Rolling hourly rate limit.
    if st.tx_in_hour.saturating_add(1) > p.max_tx_per_hour {
        return reject(
            format!(
                "exceeds max_tx_per_hour ({} already this hour, cap {})",
                st.tx_in_hour, p.max_tx_per_hour
            ),
            true,
        );
    }

    // 8. Unknown recipient.
    if !ctx.allowlisted {
        if p.allowlist_only {
            return reject(
                format!(
                    "recipient {} is not on the allowlist and allowlist_only is on",
                    ctx.recipient
                ),
                true,
            );
        }
        if ctx.amount > p.new_recipient_limit {
            return Eval::Pending {
                reason: format!(
                    "new recipient {} above new_recipient_limit ({}), needs owner approval",
                    ctx.recipient, p.new_recipient_limit
                ),
            };
        }
    }

    // 9. Large payment to a known recipient.
    if ctx.amount > p.approval_threshold {
        return Eval::Pending {
            reason: format!(
                "above approval_threshold ({}), needs owner approval",
                p.approval_threshold
            ),
        };
    }

    // 10. Funds. Not the agent's fault, so no strike.
    if ctx.amount > ctx.available_balance {
        return reject(
            format!(
                "insufficient available balance (requested {}, available {})",
                ctx.amount, ctx.available_balance
            ),
            false,
        );
    }

    let _ = ctx.owner_id;
    Eval::Approve
}
