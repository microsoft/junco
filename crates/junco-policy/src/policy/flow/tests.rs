use super::*;

type E = FlowEvent<&'static str, &'static str>;

fn store() -> Arc<Store<E>> {
    Arc::new(Store::new().unwrap())
}

fn denied(principal: &str, resource: &str) -> PolicyDecision {
    PolicyDecision::Deny {
        failed_precondition: format!("{resource} is not public or shared with {principal}"),
        allowed_fixes: vec![format!("{principal} reader {resource}")],
    }
}

#[test]
fn denies_a_value_nobody_vouched_for() {
    let store = store();
    let history = History::from_events(Arc::clone(&store), []).unwrap();
    let mut policy = FlowPolicy::new(store).unwrap();
    assert_eq!(
        policy
            .decide(&history, &E::new("bob", Flow::Send, "body"))
            .unwrap(),
        denied("bob", "body"),
    );
}

#[test]
fn grants_public_values_per_resource() {
    let store = store();
    let history = History::from_events(
        Arc::clone(&store),
        [E::new("interpreter", Flow::Public, "body")],
    )
    .unwrap();
    let mut policy = FlowPolicy::new(store).unwrap();
    assert_eq!(
        policy
            .decide(&history, &E::new("bob", Flow::Send, "body"))
            .unwrap(),
        PolicyDecision::Grant
    );
    assert_eq!(
        policy
            .decide(&history, &E::new("bob", Flow::Send, "subject"))
            .unwrap(),
        denied("bob", "subject")
    );
}

#[test]
fn grants_only_named_readers() {
    let store = store();
    let history =
        History::from_events(Arc::clone(&store), [E::new("alice", Flow::Reader, "body")]).unwrap();
    let mut policy = FlowPolicy::new(store).unwrap();
    assert_eq!(
        policy
            .decide(&history, &E::new("alice", Flow::Send, "body"))
            .unwrap(),
        PolicyDecision::Grant
    );
    assert_eq!(
        policy
            .decide(&history, &E::new("bob", Flow::Send, "body"))
            .unwrap(),
        denied("bob", "body")
    );
}

#[test]
fn grants_trusted_recipients_any_value() {
    let store = store();
    let history = History::from_events(
        Arc::clone(&store),
        [E::new("bob", Flow::Trusted, "recipients")],
    )
    .unwrap();
    let mut policy = FlowPolicy::new(store).unwrap();
    assert_eq!(
        policy
            .decide(&history, &E::new("bob", Flow::Send, "body"))
            .unwrap(),
        PolicyDecision::Grant
    );
    assert_eq!(
        policy
            .decide(&history, &E::new("eve", Flow::Send, "body"))
            .unwrap(),
        denied("eve", "body")
    );
}

#[test]
fn ignores_other_candidates_and_never_appends() {
    let store = store();
    let history = History::from_events(Arc::clone(&store), []).unwrap();
    let mut policy = FlowPolicy::new(store).unwrap();
    assert_eq!(
        policy
            .decide(&history, &E::new("bob", Flow::Reader, "body"))
            .unwrap(),
        PolicyDecision::Grant
    );
    let candidate = E::new("bob", Flow::Send, "body");
    let length = history.len();
    let decision = policy.decide(&history, &candidate).unwrap();
    assert_eq!(decision, denied("bob", "body"));
    assert_eq!(history.len(), length);
    assert_eq!(flow_decision(&history, &candidate).unwrap(), decision);
}
