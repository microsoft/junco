//! One-shot junco-policy information-flow decisions over caller-rendered capability facts.

use std::sync::Arc;

use history_semantics::PolicyDecision;
use history_store::{History, Store};
use junco_policy::{Flow, FlowEvent};
use napi::bindgen_prelude::*;
use napi_derive::napi;

/// One capability fact or candidate; labels are the caller's (addresses, variable names).
#[napi(object)]
pub struct NativeFlowEvent {
    pub principal: String,
    #[napi(ts_type = "\"Reader\" | \"Public\" | \"Trusted\" | \"Send\"")]
    pub action: String,
    pub resource: String,
}

/// A flow decision; denial details are present only when denied.
#[napi(object)]
pub struct NativeFlowDecision {
    pub granted: bool,
    pub failed_precondition: Option<String>,
    pub allowed_fixes: Option<Vec<String>>,
}

fn event(event: &NativeFlowEvent) -> Result<FlowEvent<&str, &str>> {
    let action = match event.action.as_str() {
        "Reader" => Flow::Reader,
        "Public" => Flow::Public,
        "Trusted" => Flow::Trusted,
        "Send" => Flow::Send,
        other => return Err(Error::from_reason(format!("unknown flow action {other:?}"))),
    };
    Ok(FlowEvent::new(
        event.principal.as_str(),
        action,
        event.resource.as_str(),
    ))
}

/// Decides `candidate` against `history` with junco-policy's flow table; appends nothing.
#[napi]
pub fn flow_decision(
    history: Vec<NativeFlowEvent>,
    candidate: NativeFlowEvent,
) -> Result<NativeFlowDecision> {
    let reason = |error: &dyn std::fmt::Display| Error::from_reason(error.to_string());
    let store = Arc::new(Store::new().map_err(|e| reason(&e))?);
    let mut facts = History::new(store).map_err(|e| reason(&e))?;
    for fact in &history {
        facts.push(event(fact)?).map_err(|e| reason(&e))?;
    }
    let history = facts;
    let candidate = event(&candidate)?;
    Ok(
        match junco_policy::flow_decision(&history, &candidate).map_err(|e| reason(&e))? {
            PolicyDecision::Grant => NativeFlowDecision {
                granted: true,
                failed_precondition: None,
                allowed_fixes: None,
            },
            PolicyDecision::Deny {
                failed_precondition,
                allowed_fixes,
            } => NativeFlowDecision {
                granted: false,
                failed_precondition: Some(failed_precondition),
                allowed_fixes: Some(allowed_fixes),
            },
        },
    )
}
