//! Sandbox integration tests.
//!
//! These run a real NEAR node, so unlike the unit tests they prove the things
//! that only the protocol can prove: that funds actually move, that a failed
//! transfer refunds the reserved budget, and — the important one — that a
//! function-call access key restricted to `request_payment` genuinely cannot
//! be used to drain the vault.

use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, Contract, Worker};
use serde_json::json;

const VAULT_FUNDING: NearToken = NearToken::from_near(20);

fn yocto(t: NearToken) -> String {
    t.as_yoctonear().to_string()
}

/// max_per_tx 2, daily 5, approval threshold 1, new-recipient limit 0.5.
fn demo_policy() -> serde_json::Value {
    json!({
        "max_per_tx": yocto(NearToken::from_near(2)),
        "daily_limit": yocto(NearToken::from_near(5)),
        "approval_threshold": yocto(NearToken::from_near(1)),
        "new_recipient_limit": yocto(NearToken::from_millinear(500)),
        "allowlist_only": false,
        "max_tx_per_hour": 10,
        "strike_limit": 3,
        "strike_window_ms": 3_600_000u64,
        "pending_ttl_ms": 86_400_000u64,
        "report_block_threshold": 2,
        "trust_delay_ms": 3_600_000u64,
    })
}

struct World {
    worker: Worker<Sandbox>,
    vault: Contract,
    owner: Account,
    agent: Account,
    merchant: Account,
    attacker: Account,
}

async fn setup() -> anyhow::Result<World> {
    let worker = near_workspaces::sandbox().await?;
    let wasm = near_workspaces::compile_project("../contract").await?;
    let vault = worker.dev_deploy(&wasm).await?;
    let root = worker.root_account()?;

    let mk = |name: &str, near: u128| {
        let root = root.clone();
        let name = name.to_string();
        async move {
            root.create_subaccount(&name)
                .initial_balance(NearToken::from_near(near))
                .transact()
                .await?
                .into_result()
                .map_err(anyhow::Error::from)
        }
    };

    let owner = mk("owner", 30).await?;
    let agent = mk("agent", 10).await?;
    let merchant = mk("merchant", 5).await?;
    let attacker = mk("attacker", 5).await?;

    vault
        .call("new")
        .args_json(json!({ "owner": owner.id(), "policy": demo_policy() }))
        .transact()
        .await?
        .into_result()?;

    // Fund the vault with real NEAR to pay out of.
    owner
        .transfer_near(vault.id(), VAULT_FUNDING)
        .await?
        .into_result()?;

    owner
        .call(vault.id(), "add_agent")
        .args_json(json!({ "account_id": agent.id(), "label": "Shopping agent" }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;

    owner
        .call(vault.id(), "add_to_allowlist")
        .args_json(json!({ "account_id": merchant.id() }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;

    owner
        .call(vault.id(), "add_to_blocklist")
        .args_json(json!({ "account_id": attacker.id() }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;

    Ok(World {
        worker,
        vault,
        owner,
        agent,
        merchant,
        attacker,
    })
}

async fn pay(
    agent: &Account,
    vault: &Contract,
    recipient: &str,
    amount: NearToken,
    memo: &str,
) -> anyhow::Result<serde_json::Value> {
    let res = agent
        .call(vault.id(), "request_payment")
        .args_json(json!({ "recipient": recipient, "amount": yocto(amount), "memo": memo }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    Ok(res.json()?)
}

async fn recent_log(vault: &Contract, limit: u32) -> anyhow::Result<Vec<serde_json::Value>> {
    Ok(vault
        .view("get_recent_log")
        .args_json(json!({ "limit": limit }))
        .await?
        .json()?)
}

async fn agent_view(vault: &Contract, agent: &Account) -> anyhow::Result<serde_json::Value> {
    Ok(vault
        .view("get_agent")
        .args_json(json!({ "account_id": agent.id() }))
        .await?
        .json()?)
}

fn decisions(log: &[serde_json::Value]) -> Vec<String> {
    log.iter()
        .map(|e| e["decision"].as_str().unwrap_or("?").to_string())
        .collect()
}

// ---------------------------------------------------------------------------

#[tokio::test]
async fn approved_payment_actually_moves_funds() -> anyhow::Result<()> {
    let w = setup().await?;
    let before = w.merchant.view_account().await?.balance;

    let d = pay(
        &w.agent,
        &w.vault,
        w.merchant.id().as_str(),
        NearToken::from_millinear(300),
        "api credits",
    )
    .await?;
    assert_eq!(d["decision"], "approved", "reason: {}", d["reason"]);

    let after = w.merchant.view_account().await?.balance;
    assert_eq!(
        after.as_yoctonear() - before.as_yoctonear(),
        NearToken::from_millinear(300).as_yoctonear(),
        "merchant should have received exactly 0.3 NEAR"
    );

    // The callback should have settled the audit log.
    let log = recent_log(&w.vault, 5).await?;
    assert!(
        decisions(&log).contains(&"executed".to_string()),
        "expected an executed entry, got {:?}",
        decisions(&log)
    );
    Ok(())
}

#[tokio::test]
async fn transfer_to_a_nonexistent_account_fails_and_refunds_the_budget() -> anyhow::Result<()> {
    let w = setup().await?;
    let ghost = format!("ghost.{}", w.worker.root_account()?.id());

    let d = pay(
        &w.agent,
        &w.vault,
        &ghost,
        NearToken::from_millinear(400),
        "pay a ghost",
    )
    .await?;
    // Policy-wise this is fine (small, under the new-recipient limit), so the
    // vault approves it and only the protocol can tell us it failed.
    assert_eq!(d["decision"], "approved", "reason: {}", d["reason"]);

    let log = recent_log(&w.vault, 5).await?;
    assert!(
        decisions(&log).contains(&"failed".to_string()),
        "expected a failed entry, got {:?}",
        decisions(&log)
    );

    let a = agent_view(&w.vault, &w.agent).await?;
    assert_eq!(
        a["spent_in_window"], "0",
        "a failed transfer must give the daily budget back"
    );
    Ok(())
}

#[tokio::test]
async fn owner_approval_releases_a_pending_payment() -> anyhow::Result<()> {
    let w = setup().await?;
    let before = w.merchant.view_account().await?.balance;

    // 1.5 NEAR is above the 1 NEAR approval threshold.
    let d = pay(
        &w.agent,
        &w.vault,
        w.merchant.id().as_str(),
        NearToken::from_millinear(1500),
        "bulk credits",
    )
    .await?;
    assert_eq!(d["decision"], "pending", "reason: {}", d["reason"]);
    let pending_id = d["pending_id"].as_str().expect("pending_id").to_string();

    let queue: Vec<serde_json::Value> = w.vault.view("get_pending").await?.json()?;
    assert_eq!(queue.len(), 1);

    w.owner
        .call(w.vault.id(), "approve_pending")
        .args_json(json!({ "id": pending_id }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let after = w.merchant.view_account().await?.balance;
    assert_eq!(
        after.as_yoctonear() - before.as_yoctonear(),
        NearToken::from_millinear(1500).as_yoctonear(),
        "merchant should have received the released payment"
    );

    let queue: Vec<serde_json::Value> = w.vault.view("get_pending").await?.json()?;
    assert!(queue.is_empty(), "queue should be empty after approval");
    Ok(())
}

#[tokio::test]
async fn a_compromised_agent_is_blocked_and_frozen() -> anyhow::Result<()> {
    let w = setup().await?;
    let attacker_before = w.attacker.view_account().await?.balance;

    // Three drain attempts of different shapes, all of which earn a strike.
    let d1 = pay(
        &w.agent,
        &w.vault,
        w.attacker.id().as_str(),
        NearToken::from_millinear(100),
        "verification fee",
    )
    .await?;
    assert_eq!(d1["decision"], "rejected");
    assert!(d1["reason"].as_str().unwrap().contains("blocklisted"));

    let d2 = pay(
        &w.agent,
        &w.vault,
        w.merchant.id().as_str(),
        NearToken::from_near(10),
        "everything",
    )
    .await?;
    assert_eq!(d2["decision"], "rejected");
    assert!(d2["reason"].as_str().unwrap().contains("max_per_tx"));

    let d3 = pay(
        &w.agent,
        &w.vault,
        w.attacker.id().as_str(),
        NearToken::from_millinear(50),
        "again",
    )
    .await?;
    assert_eq!(d3["decision"], "rejected");
    assert_eq!(d3["agent_frozen"], true, "third strike should freeze");

    // Nothing left the vault.
    assert_eq!(
        w.attacker.view_account().await?.balance.as_yoctonear(),
        attacker_before.as_yoctonear(),
        "attacker must not have received anything"
    );

    // Even a legitimate payment is now refused.
    let d4 = pay(
        &w.agent,
        &w.vault,
        w.merchant.id().as_str(),
        NearToken::from_millinear(10),
        "legit",
    )
    .await?;
    assert_eq!(d4["decision"], "rejected");
    assert!(d4["reason"].as_str().unwrap().contains("frozen"));

    // ...until the owner unfreezes.
    w.owner
        .call(w.vault.id(), "unfreeze_agent")
        .args_json(json!({ "account_id": w.agent.id() }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;

    let d5 = pay(
        &w.agent,
        &w.vault,
        w.merchant.id().as_str(),
        NearToken::from_millinear(10),
        "legit again",
    )
    .await?;
    assert_eq!(d5["decision"], "approved", "reason: {}", d5["reason"]);
    Ok(())
}

// ---------------------------------------------------------------------------
// The function-call access key proof.
//
// This is the claim the whole project rests on: the agent's key is physically
// unable to move funds, regardless of what the agent's own code decides to do.
// ---------------------------------------------------------------------------

/// Assert a call was refused by the protocol *for the expected reason*.
///
/// Checking the specific `InvalidAccessKeyError` variant matters: a test that
/// accepts any error at all would also pass if the sandbox were simply down,
/// which would make the whole security claim vacuous.
fn assert_denied(label: &str, expected: &str, res: near_workspaces::Result<ExecutionFinalResult>) {
    let detail = match res {
        Err(e) => format!("{e:?}"),
        Ok(exec) => {
            assert!(
                exec.is_failure(),
                "{label} unexpectedly SUCCEEDED — the function-call key is too permissive"
            );
            format!("{:?}", exec.failures())
        }
    };
    assert!(
        detail.contains(expected),
        "{label}: refused, but not for the expected reason.\n  expected: {expected}\n  actual:   {detail}"
    );
    println!("  {label}: refused by the protocol — {expected}");
}

#[tokio::test]
async fn function_call_key_can_only_request_payment() -> anyhow::Result<()> {
    let w = setup().await?;

    // Give the agent account a second key, restricted to exactly one method on
    // exactly one contract — this is what the agent runner is handed.
    let fc_key = SecretKey::from_random(KeyType::ED25519);
    w.agent
        .batch(w.agent.id())
        .add_key(
            fc_key.public_key(),
            AccessKey::function_call_access(w.vault.id(), &["request_payment"], None),
        )
        .transact()
        .await?
        .into_result()?;

    // An account handle that can ONLY sign with the restricted key.
    let restricted = Account::from_secret_key(w.agent.id().clone(), fc_key, &w.worker);

    // 1. It can do its job.
    let d = pay(
        &restricted,
        &w.vault,
        w.merchant.id().as_str(),
        NearToken::from_millinear(200),
        "api credits via fc key",
    )
    .await?;
    assert_eq!(d["decision"], "approved", "reason: {}", d["reason"]);

    // 2. Method restriction: any other method on the vault is not signable,
    //    even with no deposit attached.
    assert_denied(
        "set_policy (no deposit)",
        "MethodNameMismatch",
        restricted
            .call(w.vault.id(), "set_policy")
            .args_json(json!({ "policy": demo_policy() }))
            .transact()
            .await,
    );
    assert_denied(
        "withdraw (no deposit)",
        "MethodNameMismatch",
        restricted
            .call(w.vault.id(), "withdraw")
            .args_json(json!({ "amount": yocto(NearToken::from_near(5)) }))
            .transact()
            .await,
    );
    assert_denied(
        "unfreeze_agent (no deposit)",
        "MethodNameMismatch",
        restricted
            .call(w.vault.id(), "unfreeze_agent")
            .args_json(json!({ "account_id": w.agent.id() }))
            .transact()
            .await,
    );

    // 3. No deposits: this is why the owner-only methods take 1 yoctoNEAR.
    //    Even the permitted method cannot carry value.
    assert_denied(
        "request_payment with a deposit",
        "DepositWithFunctionCall",
        restricted
            .call(w.vault.id(), "request_payment")
            .args_json(json!({
                "recipient": w.merchant.id(),
                "amount": yocto(NearToken::from_millinear(1)),
                "memo": "sneaking value through"
            }))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await,
    );

    // 4. Receiver restriction: the key is bound to this one contract.
    assert_denied(
        "request_payment against another account",
        "ReceiverMismatch",
        restricted
            .call(w.merchant.id(), "request_payment")
            .args_json(json!({
                "recipient": w.attacker.id(),
                "amount": yocto(NearToken::from_near(1)),
                "memo": "wrong contract"
            }))
            .transact()
            .await,
    );

    // 5. It cannot send a plain transfer out of the agent account at all —
    //    a function-call key may not carry a Transfer action.
    let before = w.attacker.view_account().await?.balance;
    assert_denied(
        "plain transfer",
        "RequiresFullAccess",
        restricted
            .batch(w.attacker.id())
            .transfer(NearToken::from_near(1))
            .transact()
            .await,
    );
    assert_eq!(
        w.attacker.view_account().await?.balance.as_yoctonear(),
        before.as_yoctonear(),
        "a function-call key must not be able to move NEAR"
    );

    // 6. Control: the same methods DO work for the owner's full-access key, so
    //    the refusals above are about the key, not about a broken sandbox.
    w.owner
        .call(w.vault.id(), "set_policy")
        .args_json(json!({ "policy": demo_policy() }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;

    // 7. And the vault still holds its funds.
    let balance: serde_json::Value = w.vault.view("get_balance").await?.json()?;
    let available: u128 = balance["available"].as_str().unwrap().parse()?;
    assert!(
        available > NearToken::from_near(15).as_yoctonear(),
        "vault should be largely untouched, available = {available}"
    );
    Ok(())
}

#[tokio::test]
async fn simulate_payment_agrees_with_the_chain() -> anyhow::Result<()> {
    let w = setup().await?;

    for (recipient, amount, label) in [
        (w.merchant.id().as_str(), NearToken::from_millinear(300), "small to allowlisted"),
        (w.merchant.id().as_str(), NearToken::from_millinear(1500), "above threshold"),
        (w.attacker.id().as_str(), NearToken::from_millinear(100), "blocklisted"),
        (w.merchant.id().as_str(), NearToken::from_near(9), "over cap"),
    ] {
        let simulated: serde_json::Value = w
            .vault
            .view("simulate_payment")
            .args_json(json!({
                "agent": w.agent.id(),
                "recipient": recipient,
                "amount": yocto(amount),
            }))
            .await?
            .json()?;

        let real = pay(&w.agent, &w.vault, recipient, amount, label).await?;

        assert_eq!(
            simulated["decision"], real["decision"],
            "{label}: dry-run disagreed with the chain"
        );
        assert_eq!(simulated["reason"], real["reason"], "{label}: reason differs");
    }
    Ok(())
}

/// Counterparty reporting, end to end on a real sandbox chain.
///
/// The point is that the block comes from accounts the vault owner has no
/// relationship with: the owner never touches the blocklist here.
#[tokio::test]
async fn independent_reports_block_a_recipient_the_owner_never_blocklisted() -> anyhow::Result<()> {
    let w = setup().await?;
    let supplier = w
        .worker
        .root_account()?
        .create_subaccount("supplier")
        .initial_balance(NearToken::from_near(5))
        .transact()
        .await?
        .into_result()?;

    // Before any reports: a small payment to this stranger is fine.
    let before = pay(
        &w.agent,
        &w.vault,
        supplier.id().as_str(),
        NearToken::from_millinear(100),
        "first invoice",
    )
    .await?;
    assert_eq!(
        before["decision"], "approved",
        "an unreported stranger under the new-recipient limit should be payable: {}",
        before["reason"]
    );

    let report = |who: &Account, n: u32| {
        let who = who.clone();
        let vault = w.vault.clone();
        let target = supplier.id().clone();
        async move {
            who.call(vault.id(), "report_recipient")
                .args_json(json!({
                    "account_id": target,
                    "category": "fake-invoice",
                    "evidence": format!("https://example.invalid/{n}"),
                }))
                .deposit(NearToken::from_millinear(10))
                .max_gas()
                .transact()
                .await?
                .into_result()
                .map_err(anyhow::Error::from)
        }
    };

    // One report: a warning, not a block. The payment waits for a human.
    report(&w.merchant, 1).await?;
    let warned = pay(
        &w.agent,
        &w.vault,
        supplier.id().as_str(),
        NearToken::from_millinear(100),
        "second invoice",
    )
    .await?;
    assert_eq!(
        warned["decision"], "pending",
        "one report should warn, not block: {}",
        warned["reason"]
    );

    // The same account reporting again must not move the threshold.
    assert!(
        report(&w.merchant, 2).await.is_err(),
        "a second report from the same account must be refused"
    );

    // A second, independent reporter reaches the threshold.
    report(&w.attacker, 3).await?;
    let blocked = pay(
        &w.agent,
        &w.vault,
        supplier.id().as_str(),
        NearToken::from_millinear(100),
        "third invoice",
    )
    .await?;
    assert_eq!(
        blocked["decision"], "rejected",
        "two independent reporters should block: {}",
        blocked["reason"]
    );
    assert!(
        blocked["reason"]
            .as_str()
            .unwrap()
            .contains("independent abuse reports"),
        "got: {}",
        blocked["reason"]
    );

    // The view a human reads must agree with what the chain just did.
    let view: serde_json::Value = w
        .vault
        .view("get_recipient")
        .args_json(json!({ "account_id": supplier.id() }))
        .await?
        .json()?;
    assert_eq!(view["risk"], "blocked");
    assert_eq!(view["distinct_reporters"], 2);
    assert_eq!(
        view["blocklisted"], false,
        "the owner never blocklisted this account — the reports did the work"
    );

    Ok(())
}
