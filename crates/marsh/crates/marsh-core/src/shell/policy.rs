//! Stage 3: complete baseline diff, freshness, and an atomic ordered capability batch.

use std::collections::HashMap;
use std::fmt;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

use super::completion::{Completion, Finalize};
use super::execution::ExecutedCommand;
use super::session::{Authority, Session};
use super::{ShellError, ShellErrorKind};
pub use junco_policy::{Action, Bump, PolicyDecision};
use marsh_lib::RecoverPoison as _;
use marsh_wal::CommitOp;

/// Identity of the actor requesting a capability.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Principal(String);

impl Principal {
    /// Creates a principal from an owned or borrowed string.
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Returns the principal's exact string value.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<&str> for Principal {
    fn from(value: &str) -> Self {
        Self::new(value)
    }
}

impl From<String> for Principal {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl fmt::Display for Principal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Ordered path segments naming a protected resource.
///
/// Equality is structural: segment count, order, and exact segment text all matter. Display joins
/// segments with `/` for diagnostics only; it is not the equality representation.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Resource(Vec<String>);

impl Resource {
    /// Creates a resource by collecting ordered path segments.
    pub fn new(segments: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self(segments.into_iter().map(Into::into).collect())
    }

    /// Returns the resource's ordered path segments.
    pub fn segments(&self) -> &[String] {
        &self.0
    }
}

impl<const N: usize> From<[&str; N]> for Resource {
    fn from(segments: [&str; N]) -> Self {
        Self::new(segments)
    }
}

impl From<Vec<&str>> for Resource {
    fn from(segments: Vec<&str>) -> Self {
        Self::new(segments)
    }
}

impl From<Vec<String>> for Resource {
    fn from(segments: Vec<String>) -> Self {
        Self(segments)
    }
}

impl fmt::Display for Resource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut segments = self.0.iter();
        if let Some(first) = segments.next() {
            formatter.write_str(first)?;
            for segment in segments {
                formatter.write_str("/")?;
                formatter.write_str(segment)?;
            }
        }
        Ok(())
    }
}

/// Owned capability-product event: what Marsh records, logs, and reports.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Event {
    /// Actor requesting the capability.
    pub principal: Principal,
    /// Requested operation.
    pub action: Action,
    /// Protected resource.
    pub resource: Resource,
}

impl Event {
    /// Creates an event from values convertible to the owned component types.
    pub fn new(
        principal: impl Into<Principal>,
        action: Action,
        resource: impl Into<Resource>,
    ) -> Self {
        Self {
            principal: principal.into(),
            action,
            resource: resource.into(),
        }
    }

    /// This event as the compact borrowed value a policy evaluates.
    pub fn as_policy_event(&self) -> PolicyEvent<'_> {
        junco_policy::LockEvent::new(&self.principal, self.action, &self.resource)
    }
}

/// One owned [`Event`] borrowed for a single policy evaluation.
pub type PolicyEvent<'a> = junco_policy::LockEvent<&'a Principal, &'a Resource>;
/// Committed and tentative events of one evaluation, borrowed from owned history.
pub type PolicyHistory<'a> = junco_policy::History<PolicyEvent<'a>>;

/// Receives every capability decision `Authority::check` makes, in order, before its effect.
/// A grant is tentative: a later denial in the same batch or a failed publication rolls it back.
/// Called under the authority's write lock, so it must only enqueue, never block.
pub struct PolicyObserver(Box<dyn Fn(&Event, &PolicyDecision) + Send + Sync>);
impl PolicyObserver {
    /// Wraps the callback each decision is passed to.
    pub fn new(observe: impl Fn(&Event, &PolicyDecision) + Send + Sync + 'static) -> Self {
        Self(Box::new(observe))
    }
    fn notify(&self, event: &Event, decision: &PolicyDecision) {
        (self.0)(event, decision);
    }
}

/// One refused capability, with the policy's explanation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Denial {
    /// The rejected request.
    pub event: Event,
    /// The precondition that failed.
    pub failed_precondition: String,
    /// Policy-provided ways to make the request legal.
    pub allowed_fixes: Vec<String>,
}
impl std::fmt::Display for Denial {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} {} {}: {}",
            self.event.principal, self.event.action, self.event.resource, self.failed_precondition
        )?;
        if !self.allowed_fixes.is_empty() {
            write!(f, "\n    fix: {}", self.allowed_fixes.join("; "))?;
        }
        Ok(())
    }
}

/// Immutable authorization configuration selected per shell. Marsh calls [`Policy::evaluator`]
/// once per command batch and owns everything around it: observer notification, append-on-grant,
/// denial collection, rollback, freshness, and publication. The evaluator only decides.
pub trait Policy: Send + Sync + 'static {
    /// Fresh decision state for one batch; `arena` outlives it.
    fn evaluator<'batch>(
        &'batch self,
        arena: &'batch Bump,
    ) -> Box<dyn FnMut(&PolicyHistory<'batch>, &PolicyEvent<'batch>) -> PolicyDecision + 'batch>;
}

/// The ownership-lock capability policy: a shell's default.
#[derive(Debug, Default)]
pub struct LockPolicy;
impl Policy for LockPolicy {
    fn evaluator<'batch>(
        &'batch self,
        arena: &'batch Bump,
    ) -> Box<dyn FnMut(&PolicyHistory<'batch>, &PolicyEvent<'batch>) -> PolicyDecision + 'batch>
    {
        let mut evaluator = junco_policy::LockPolicy::new(arena);
        Box::new(move |history, event| evaluator.decide(history, event))
    }
}

/// Grants every capability. Snapshots, freshness, history, and publication still apply.
#[derive(Debug, Default)]
pub struct EmptyPolicy;
impl Policy for EmptyPolicy {
    fn evaluator<'batch>(
        &'batch self,
        _arena: &'batch Bump,
    ) -> Box<dyn FnMut(&PolicyHistory<'batch>, &PolicyEvent<'batch>) -> PolicyDecision + 'batch>
    {
        Box::new(|_, _| PolicyDecision::Grant)
    }
}

/// One source's policy authority: its committed capability history and ledger ordering, shared by
/// every shell on that source and by routing predicates that query it.
pub struct PolicyValidator {
    authority: RwLock<Authority>,
    revision: AtomicU64,
}
impl PolicyValidator {
    /// An empty authority at the start of both orderings.
    pub(super) fn new() -> Self {
        Self {
            authority: RwLock::new(Authority::default()),
            revision: AtomicU64::new(0),
        }
    }
    /// What the lock policy would decide for `event` against the shared committed history,
    /// without adopting it. Resources name seed-relative paths, exactly as managed authorization
    /// does. This is a lock-policy query, not the selected shell's publication policy.
    pub fn decide(&self, event: &Event) -> Result<PolicyDecision, ShellError> {
        let authority = self.read();
        if authority.recovery_required {
            return Err(ShellError::infrastructure(
                "source requires recovery before new commands",
            ));
        }
        let arena = Bump::new();
        let history =
            PolicyHistory::from_events(authority.history.iter().map(Event::as_policy_event));
        let candidate = event.as_policy_event();
        let mut policy = junco_policy::LockPolicy::new(&arena);
        Ok(policy.decide(&history, &candidate))
    }
    pub(super) fn read(&self) -> RwLockReadGuard<'_, Authority> {
        self.authority.read().recover()
    }
    /// Exclusive authority for one mutation. The revision advances before the guard is returned,
    /// so a concurrent routing decision either sees the change or waits for its final history.
    pub(super) fn write(&self) -> Result<RwLockWriteGuard<'_, Authority>, ShellError> {
        let guard = self.authority.write().recover();
        self.revision
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |revision| {
                revision.checked_add(1)
            })
            .map_err(|_| ShellError::infrastructure("policy revision exhaustion"))?;
        Ok(guard)
    }
    pub(super) fn revision(&self) -> u64 {
        self.revision.load(Ordering::Acquire)
    }
}
impl Authority {
    fn check(
        &mut self,
        shell_policy: &dyn Policy,
        events: &[Event],
        observer: Option<&PolicyObserver>,
    ) -> Result<(), Vec<Denial>> {
        let denials = {
            let arena = Bump::new();
            let mut history =
                PolicyHistory::from_events(self.history.iter().map(Event::as_policy_event));
            let mut decide = shell_policy.evaluator(&arena);
            let mut denials = Vec::new();
            for event in events {
                let candidate = event.as_policy_event();
                let decision = decide(&history, &candidate);
                if let Some(observer) = observer {
                    observer.notify(event, &decision);
                }
                match decision {
                    PolicyDecision::Grant => history.push(candidate),
                    PolicyDecision::Deny {
                        failed_precondition,
                        allowed_fixes,
                    } => denials.push(Denial {
                        event: event.clone(),
                        failed_precondition,
                        allowed_fixes,
                    }),
                }
            }
            denials
        };
        if denials.is_empty() {
            self.history.extend_from_slice(events);
            Ok(())
        } else {
            Err(denials)
        }
    }
}

/// Only this payload can reach publication, holding the authority through intent and application;
/// its finalizer rolls back tentative policy history unless the command completed.
pub(super) struct AuthorizedCommand<'a> {
    pub guard: Option<RwLockWriteGuard<'a, Authority>>,
    pub executed: Option<ExecutedCommand>,
    pub operations: Vec<CommitOp>,
    pub events: Vec<Event>,
    checkpoint: usize,
}
impl Completion<AuthorizedCommand<'_>> {
    /// Finalizes now and releases the authority; the later drop finds no guard to roll back.
    pub fn release_authority(&mut self) {
        self.payload.finalize(self.completed);
        drop(self.payload.guard.take());
    }
}
impl Finalize for AuthorizedCommand<'_> {
    fn finalize(&mut self, completed: bool) {
        if !completed && let Some(guard) = &mut self.guard {
            guard.history.truncate(self.checkpoint);
        }
    }
}

pub(super) fn authorize<'session>(
    session: &'session Session,
    mut executed: ExecutedCommand,
    shell_policy: &dyn Policy,
    observer: Option<&PolicyObserver>,
) -> Result<Completion<AuthorizedCommand<'session>>, ShellError> {
    // Every refusal carries the native status the command already produced.
    let admitted = (|| -> Result<_, ShellError> {
        if let Some(failure) = executed.failure.take() {
            return Err(failure);
        }
        if executed.prepared.run.is_cancelled() {
            return Err(ShellError::new(ShellErrorKind::Interrupted));
        }
        if let Some(failure) = executed.evidence.failure.take() {
            return Err(ShellError::unsupported(failure));
        }
        let scope = session.tracing.internal_scope()?;
        let _scope = scope.enter();
        // The diff never depends on observed writes. Missing write evidence must fail coverage, not
        // disappear from the candidate transaction.
        let operations = marsh_wal::diff_trees(
            &executed.prepared.baseline,
            executed.prepared.snapshot.path(),
        )?;
        preflight(&executed, &operations)?;
        let mut guard = session.validator.write()?;
        if guard.recovery_required {
            return Err(ShellError::infrastructure("source requires recovery"));
        }
        let stale = stale_paths(&executed, &guard);
        if !stale.is_empty() {
            return Err(ShellError::new(ShellErrorKind::Stale {
                paths: stale
                    .into_iter()
                    .map(|path| session.persistence.seed.join(path))
                    .collect(),
            }));
        }
        let events = translate(&executed)?;
        let checkpoint = guard.history.len();
        guard
            .check(shell_policy, &events, observer)
            .map_err(|denials| ShellError::new(ShellErrorKind::Denied { denials }))?;
        Ok((guard, operations, events, checkpoint))
    })();
    match admitted {
        Ok((guard, operations, events, checkpoint)) => Ok(Completion::new(AuthorizedCommand {
            guard: Some(guard),
            executed: Some(executed),
            operations,
            events,
            checkpoint,
        })),
        Err(error) => Err(error.with_result(executed.result.take())),
    }
}

fn preflight(executed: &ExecutedCommand, operations: &[CommitOp]) -> Result<(), ShellError> {
    use std::os::unix::fs::MetadataExt;
    for operation in operations {
        let covered = executed.evidence.effects.iter().any(|(_, effect)| {
            effect.writes.iter().any(|path| path == operation.path())
                || effect
                    .recursive_writes
                    .iter()
                    .any(|path| operation.path().starts_with(path))
        });
        if !covered {
            return Err(ShellError::unsupported(format!(
                "unobserved filesystem change: {}",
                operation.path().display()
            )));
        }
        if let CommitOp::Write(path) = operation {
            let metadata = std::fs::symlink_metadata(executed.prepared.snapshot.path().join(path))?;
            if !metadata.is_file() && !metadata.is_symlink() {
                return Err(ShellError::unsupported(
                    "special-file publication is unsupported",
                ));
            }
            if metadata.is_file() && metadata.nlink() > 1 {
                return Err(ShellError::unsupported(
                    "changed hard-link payload is unsupported",
                ));
            }
        }
    }
    Ok(())
}

fn stale_paths(executed: &ExecutedCommand, authority: &Authority) -> Vec<PathBuf> {
    let mut stale = std::collections::BTreeSet::new();
    for (_, effects) in &executed.evidence.effects {
        for (changed, sequence) in &authority.versions {
            if *sequence <= executed.prepared.tree_seq {
                continue;
            }
            let exact = effects
                .dependencies
                .iter()
                .chain(&effects.reads)
                .chain(&effects.writes)
                .any(|path| path == changed || path.starts_with(changed));
            let recursive = effects
                .recursive_reads
                .iter()
                .chain(&effects.recursive_writes)
                .any(|path| changed.starts_with(path) || path.starts_with(changed));
            if exact || recursive {
                stale.insert(changed.clone());
            }
        }
    }
    stale.into_iter().collect()
}

/// The run's effects as one ordered capability batch for the shell's policy principal: a read
/// claims, a write edits, a successful removal removes and an explicit release releases, each at
/// its own entry order. A repeated action on a resource collapses into its first.
fn translate(executed: &ExecutedCommand) -> Result<Vec<Event>, ShellError> {
    let principal = &executed.prepared.snapshot.owner;
    let mut ordered = Vec::new();
    for (order, effects) in &executed.evidence.effects {
        for path in &effects.reads {
            ordered.push((*order, Action::Read, path.as_path()));
        }
        let write = if effects.removed {
            Action::Remove
        } else {
            Action::Edit
        };
        for path in &effects.writes {
            ordered.push((*order, write, path.as_path()));
        }
        if let Some(path) = &effects.release {
            ordered.push((*order, Action::Release, path.as_path()));
        }
    }
    ordered.sort_by_key(|(order, _, _)| *order);
    let mut last = HashMap::new();
    let mut events = Vec::new();
    for (_, action, path) in ordered {
        let Some(resource) = resource_of(path)? else {
            continue;
        };
        if last.get(&resource) == Some(&action) {
            continue;
        }
        last.insert(resource.clone(), action);
        events.push(Event::new(principal.clone(), action, resource));
    }
    Ok(events)
}

pub(super) fn resource_of(path: &Path) -> Result<Option<Resource>, ShellError> {
    if path.as_os_str().is_empty() {
        return Ok(None);
    }
    let mut segments = Vec::new();
    for component in path.components() {
        let Component::Normal(component) = component else {
            return Err(ShellError::unsupported("non-relative policy resource"));
        };
        let component = component
            .to_str()
            .ok_or_else(|| ShellError::unsupported("non-UTF-8 policy resource"))?;
        segments.push(component.to_owned());
    }
    Ok(Some(Resource::from(segments)))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    #[test]
    fn borrowed_policy_batch_preserves_atomic_history() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let observer = PolicyObserver::new({
            let seen = Arc::clone(&seen);
            move |event, decision| {
                let granted = matches!(decision, PolicyDecision::Grant);
                seen.lock().unwrap().push((event.clone(), granted));
            }
        });
        let initial = Event::new("alice", Action::Edit, Resource::from(["a/b"]));
        let mut authority = Authority::default();
        authority.history.push(initial.clone());

        let batch = [
            Event::new("bob", Action::Read, Resource::from(["a", "b"])),
            Event::new("mallory", Action::Edit, Resource::from(["a/b"])),
            Event::new("alice", Action::Release, Resource::from(["a/b"])),
            Event::new("eve", Action::Edit, Resource::from(["a", "b"])),
        ];
        let denials = authority
            .check(&LockPolicy, &batch, Some(&observer))
            .expect_err("the batch has two refused capabilities");
        let denied: Vec<_> = denials.iter().map(|denial| &denial.event).collect();
        assert_eq!(denied, [&batch[1], &batch[3]]);
        let markers: Vec<_> = seen.lock().unwrap().iter().cloned().collect();
        assert_eq!(
            markers,
            [
                (batch[0].clone(), true),
                (batch[1].clone(), false),
                (batch[2].clone(), true),
                (batch[3].clone(), false),
            ]
        );
        assert_eq!(authority.history, [initial.clone()]);

        let retry = batch[3].clone();
        authority
            .check(&LockPolicy, std::slice::from_ref(&retry), Some(&observer))
            .expect("the rejected batch left no read claim behind");
        assert_eq!(authority.history, [initial, retry.clone()]);
        assert_eq!(seen.lock().unwrap().last(), Some(&(retry, true)));
    }
}
