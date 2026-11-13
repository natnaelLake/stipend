//! The policy engine.
//!
//! Deliberately pure: no `env::*`, no state writes. `request_payment` and the
//! `simulate_payment` view both call [`evaluate`], which is the only reason the
//! dry-run in the dashboard is guaranteed to agree with what actually happens
//! on chain.

use near_sdk::{AccountId, NearToken};

use crate::types::{AgentState, Policy, RiskLevel};

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

/// What is known about the account being paid.
///
/// Split out from `Context` so the dashboard's counterparty verdict and the
/// enforcement path can be fed the identical input and call the identical
/// [`classify`]. A risk badge that disagreed with what the chain actually does
/// would be worse than no badge at all.
pub struct Counterparty {
    pub blocklisted: bool,
    pub allowlisted: bool,
    /// Reports from distinct accounts, not total reports.
    pub distinct_reporters: u32,
    /// Payments that actually settled.
    pub times_paid: u32,
    /// When this vault first saw the account; 0 means never.
    pub first_seen_ms: u64,
}

/// Everything about the vault the engine needs, gathered by the caller.
pub struct Context<'a> {
    pub policy: &'a Policy,
    pub paused: bool,
    pub counterparty: Counterparty,
    pub vault_id: &'a AccountId,
    pub owner_id: &'a AccountId,
    pub agent_id: &'a AccountId,
    pub recipient: &'a AccountId,
    pub amount: NearToken,
    pub available_balance: NearToken,
    pub now_ms: u64,
    /// The account this memo has been paid to before, if any.
    ///
    /// Invoice fraud rarely looks like a new payee. It looks like the supplier
    /// you already pay, with the account number changed. The vault remembers
    /// which account a given memo settled to, so the change is visible.
    pub memo_bound_to: Option<&'a AccountId>,
}

/// Has this vault paid the account before, long enough ago to count?
///
/// The delay is the point. Without it an attacker who controls the agent can
/// push one small payment through to a fresh account, have it counted as
/// "known", and immediately send a large one. Trust has to age.
pub fn is_trusted(cp: &Counterparty, policy: &Policy, now_ms: u64) -> bool {
    if cp.allowlisted {
        return true;
    }
    cp.times_paid > 0
        && cp.first_seen_ms > 0
        && now_ms.saturating_sub(cp.first_seen_ms) >= policy.trust_delay_ms
}

/// The counterparty verdict: allow, warn or block, with the reasons.
///
/// Used both by `get_recipient` and by [`evaluate`], so the badge a human sees
/// is produced by the code that decides.
pub fn classify(cp: &Counterparty, policy: &Policy, now_ms: u64) -> (RiskLevel, Vec<String>) {
    let mut reasons = Vec::new();

    if cp.blocklisted {
        reasons.push("on the owner's blocklist".to_string());
        return (RiskLevel::Blocked, reasons);
    }
    if cp.distinct_reporters >= policy.report_block_threshold {
        reasons.push(format!(
            "{} independent abuse reports (threshold {})",
            cp.distinct_reporters, policy.report_block_threshold
        ));
        return (RiskLevel::Blocked, reasons);
    }
    if cp.distinct_reporters > 0 {
        reasons.push(format!(
            "{} abuse report(s), below the block threshold of {}",
            cp.distinct_reporters, policy.report_block_threshold
        ));
        return (RiskLevel::Warn, reasons);
    }
    if cp.allowlisted {
        reasons.push("on the owner's allowlist".to_string());
        return (RiskLevel::Known, reasons);
    }
    if cp.times_paid == 0 {
        reasons.push("never paid by this vault".to_string());
        return (RiskLevel::Warn, reasons);
    }
    if !is_trusted(cp, policy, now_ms) {
        reasons.push(format!(
            "first seen too recently (trust delay {} ms not yet elapsed)",
            policy.trust_delay_ms
        ));
        return (RiskLevel::Warn, reasons);
    }
    reasons.push(format!("paid {} time(s) by this vault", cp.times_paid));
    (RiskLevel::Known, reasons)
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
/// contract: it is documented in the README and asserted in the tests. The
/// numbers here match the table in the README; rule 8 covers two of its rows.
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
    if ctx.counterparty.blocklisted {
        return reject(
            format!("recipient {} is blocklisted", ctx.recipient),
            true,
        );
    }

    // 3b. Enough independent reporters is a block in its own right. Distinct
    //     reporters, not total reports, so one account cannot manufacture a
    //     block by filing repeatedly.
    if ctx.counterparty.distinct_reporters >= p.report_block_threshold {
        return reject(
            format!(
                "recipient {} has {} independent abuse reports (threshold {})",
                ctx.recipient, ctx.counterparty.distinct_reporters, p.report_block_threshold
            ),
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

    // 8. Unknown recipient. "Known" means allowlisted, or paid before and
    //     past the trust delay — see `is_trusted`.
    if !is_trusted(&ctx.counterparty, p, ctx.now_ms) {
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

    // 9b. Reported, but not by enough people to block. A single anonymous
    //     report must not be able to stop payments outright, so it costs the
    //     payment its automation and asks the owner instead.
    if ctx.counterparty.distinct_reporters > 0 {
        return Eval::Pending {
            reason: format!(
                "recipient {} has {} abuse report(s), needs owner approval",
                ctx.recipient, ctx.counterparty.distinct_reporters
            ),
        };
    }

    // 9c. Same memo, different account. This is the business-email-compromise
    //     shape: the invoice looks routine and the amount is unremarkable, and
    //     only the destination has moved. An allowlisted recipient is exempt,
    //     because the owner has already vouched for that account by name.
    if let Some(previous) = ctx.memo_bound_to {
        if previous != ctx.recipient && !ctx.counterparty.allowlisted {
            return Eval::Pending {
                reason: format!(
                    "this memo was previously paid to {}, now {} — needs owner approval",
                    previous, ctx.recipient
                ),
            };
        }
    }

    // 10. Large payment to a known recipient.
    if ctx.amount > p.approval_threshold {
        return Eval::Pending {
            reason: format!(
                "above approval_threshold ({}), needs owner approval",
                p.approval_threshold
            ),
        };
    }

    // 11. Funds. Not the agent's fault, so no strike.
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
