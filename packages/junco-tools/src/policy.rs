//! Native authorization policies, closed under the Boolean combinators. Each policy is an open
//! `marsh_core::Policy` implementation; a new one needs only its own factory here.

use std::sync::Arc;

use marsh_core::{Bump, Policy, PolicyDecision, PolicyEvent, PolicyHistory};
use napi::bindgen_prelude::{FromNapiValue, TypeName, ValidateNapiValue};
use napi::{ValueType, sys};
use napi_derive::napi;

type Evaluator<'batch> =
    Box<dyn FnMut(&PolicyHistory<'batch>, &PolicyEvent<'batch>) -> PolicyDecision + 'batch>;

/// One immutable marsh authorization policy, shareable across muxes of this addon.
#[napi]
pub struct NativePolicy(pub(crate) Arc<dyn Policy>);

/// A [`NativePolicy`] option, taken by value: its policy is shared while the JavaScript call
/// converts its arguments, so nothing borrows the instance afterwards.
pub struct PolicyArg(pub(crate) Arc<dyn Policy>);

impl TypeName for PolicyArg {
    fn type_name() -> &'static str {
        "NativePolicy"
    }
    fn value_type() -> ValueType {
        ValueType::Object
    }
}

impl ValidateNapiValue for PolicyArg {}

impl FromNapiValue for PolicyArg {
    unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> napi::Result<Self> {
        // SAFETY: forwarded from napi's own conversion of this argument.
        let policy = unsafe { <&NativePolicy>::from_napi_value(env, value) }?;
        Ok(Self(Arc::clone(&policy.0)))
    }
}

#[napi]
impl NativePolicy {
    /// The ownership-lock policy.
    #[napi(factory)]
    pub fn lock() -> Self {
        Self(Arc::new(marsh_core::LockPolicy))
    }

    /// Grants every capability.
    #[napi(factory)]
    pub fn empty() -> Self {
        Self(Arc::new(marsh_core::EmptyPolicy))
    }

    /// Grants exactly what both grant; a denial is the left one's, else the right one's.
    #[napi(factory)]
    pub fn and(left: &NativePolicy, right: &NativePolicy) -> Self {
        Self(Arc::new(And(Arc::clone(&left.0), Arc::clone(&right.0))))
    }

    /// Grants what either grants; a denial joins both preconditions and both fix lists.
    #[napi(factory)]
    pub fn or(left: &NativePolicy, right: &NativePolicy) -> Self {
        Self(Arc::new(Or(Arc::clone(&left.0), Arc::clone(&right.0))))
    }

    /// Grants exactly what `policy` denies.
    #[napi(factory)]
    pub fn not(policy: &NativePolicy) -> Self {
        Self(Arc::new(Not(Arc::clone(&policy.0))))
    }
}

struct And(Arc<dyn Policy>, Arc<dyn Policy>);
impl Policy for And {
    fn evaluator<'batch>(&'batch self, arena: &'batch Bump) -> Evaluator<'batch> {
        let (mut left, mut right) = (self.0.evaluator(arena), self.1.evaluator(arena));
        Box::new(move |history, event| match left(history, event) {
            PolicyDecision::Grant => right(history, event),
            denied => denied,
        })
    }
}

struct Or(Arc<dyn Policy>, Arc<dyn Policy>);
impl Policy for Or {
    fn evaluator<'batch>(&'batch self, arena: &'batch Bump) -> Evaluator<'batch> {
        let (mut left, mut right) = (self.0.evaluator(arena), self.1.evaluator(arena));
        Box::new(move |history, event| {
            let PolicyDecision::Deny {
                failed_precondition: left_failed,
                allowed_fixes: mut fixes,
            } = left(history, event)
            else {
                return PolicyDecision::Grant;
            };
            let PolicyDecision::Deny {
                failed_precondition: right_failed,
                allowed_fixes: right_fixes,
            } = right(history, event)
            else {
                return PolicyDecision::Grant;
            };
            fixes.extend(right_fixes);
            PolicyDecision::Deny {
                failed_precondition: format!("{left_failed}, and {right_failed}"),
                allowed_fixes: fixes,
            }
        })
    }
}

struct Not(Arc<dyn Policy>);
impl Policy for Not {
    fn evaluator<'batch>(&'batch self, arena: &'batch Bump) -> Evaluator<'batch> {
        let mut inner = self.0.evaluator(arena);
        Box::new(move |history, event| match inner(history, event) {
            PolicyDecision::Grant => PolicyDecision::Deny {
                failed_precondition: "the negated policy grants this request".to_owned(),
                allowed_fixes: Vec::new(),
            },
            PolicyDecision::Deny { .. } => PolicyDecision::Grant,
        })
    }
}
