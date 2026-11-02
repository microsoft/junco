//! CaMeL-style information-flow policy (Debenedetti et al. 2025, workspace `send_email` rule):
//! a value may be sent to a recipient when it is public, the recipient may read it, or the
//! recipient was named by trusted data. Readers/sources closure is the caller's (interpreter's)
//! job; this table decides over the flattened facts.

use std::fmt::{Debug, Display};
use std::hash::Hash;
use std::sync::Arc;

use history_semantics::policy::{CompiledPolicy, PolicyRule, action_is, principal_is, resource_is};
use history_semantics::{PolicyDecision, PolicyError};
use history_store::{History, Store};
use history_syntax::{
    Comparison, ComponentPattern, Event, Head, RegexExpr, Rule, RuleMode, TestExpr,
};
use junco_core::{CompileError, HistoryError};

use crate::{Flow, FlowEvent};

/// Some event of the history satisfies `test`.
fn seen<E: Event>(test: TestExpr<E>) -> RegexExpr<E> {
    RegexExpr::concat([RegexExpr::all(), RegexExpr::test(test), RegexExpr::all()])
}

/// Histories admitting `Send` of head resource `r` to head principal `p`.
fn admitted<E: Event<Action = Flow>>() -> RegexExpr<E> {
    RegexExpr::union([
        seen(TestExpr::and([
            action_is(Flow::Public, Comparison::Eq),
            resource_is(Comparison::Eq),
        ])),
        seen(TestExpr::and([
            principal_is(Comparison::Eq),
            action_is(Flow::Reader, Comparison::Eq),
            resource_is(Comparison::Eq),
        ])),
        seen(TestExpr::and([
            principal_is(Comparison::Eq),
            action_is(Flow::Trusted, Comparison::Eq),
        ])),
    ])
}

/// Head variables `p`/`r` are the names resolved by `principal_is`/`resource_is`.
fn flow_rules<E>() -> Vec<PolicyRule<E, E>>
where
    E: Event<Action = Flow>,
    E::Principal: Display,
    E::Resource: Display,
{
    vec![PolicyRule {
        rule: Rule::new(
            RuleMode::Require,
            Head::new(
                ComponentPattern::variable("p"),
                ComponentPattern::constant(Flow::Send),
                ComponentPattern::variable("r"),
            ),
            admitted(),
        ),
        diagnostic: Box::new(|candidate: &E| {
            let (p, r) = (candidate.principal(), candidate.resource());
            (
                format!("{r} is not public or shared with {p}"),
                vec![format!("{p} reader {r}")],
            )
        }),
    }]
}

/// Compiled information-flow policy reusable across candidate decisions; never appends.
pub struct FlowPolicy<P, R>
where
    P: Copy + Debug + Eq + Hash,
    R: Copy + Debug + Eq + Hash,
{
    compiled: CompiledPolicy<FlowEvent<P, R>, FlowEvent<P, R>>,
}

impl<P, R> FlowPolicy<P, R>
where
    P: Copy + Debug + Eq + Hash + Display,
    R: Copy + Debug + Eq + Hash + Display,
{
    /// Builds and compiles the flow table in `store`.
    pub fn new(store: Arc<Store<FlowEvent<P, R>>>) -> Result<Self, CompileError> {
        Ok(Self {
            compiled: CompiledPolicy::new(store, flow_rules())?,
        })
    }

    /// Decides one candidate against `history`; non-`Send` candidates always grant.
    pub fn decide(
        &mut self,
        history: &History<FlowEvent<P, R>>,
        candidate: &FlowEvent<P, R>,
    ) -> Result<PolicyDecision, HistoryError> {
        self.compiled.decide(history, candidate, || *candidate)
    }
}

/// Decides one candidate with a one-shot flow policy (compiles per call; mirrors `lock_decision`).
pub fn flow_decision<P, R>(
    history: &History<FlowEvent<P, R>>,
    candidate: &FlowEvent<P, R>,
) -> Result<PolicyDecision, PolicyError>
where
    P: Copy + Debug + Eq + Hash + Display,
    R: Copy + Debug + Eq + Hash + Display,
{
    let mut policy = FlowPolicy::new(history.store().clone())?;
    Ok(policy.decide(history, candidate)?)
}

#[cfg(test)]
mod tests;
