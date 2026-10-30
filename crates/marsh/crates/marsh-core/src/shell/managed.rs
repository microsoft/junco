//! Protocol-neutral, fallible transactions over a retained, parked native process tree.

use std::collections::BTreeSet;
use std::ffi::{OsStr, OsString};
use std::fs::{Metadata, OpenOptions};
use std::io::{self, Read as _, Write as _};
use std::os::fd::OwnedFd;
use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
use std::os::unix::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::{Command, ExitStatus};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::task::{Context, Poll};

use brush_core::ExternalPipeline;
use futures_util::FutureExt as _;
use marsh_instrument::{ChildEvent, ParkedRun, TracedChild};
use marsh_lib::RecoverPoison as _;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::{OwnedMutexGuard, watch};

use super::access::Effects;
use super::execution::{
    BuiltinContext, ExecutedTransaction, PublicationMode, PublicationSeal, Run,
};
use super::snapshot::{self, CommandEvidence, PreparedCommand};
use super::{
    Action, MarshTool, PipelineOptions, SandboxPolicy, Shell, ShellBuilder, ShellError,
    ShellErrorKind,
};

/// The committed value and the common evidence classifier's workspace mutation bit.
#[derive(Debug)]
pub struct ManagedOutcome<T> {
    /// Callback value, released only after the transaction's durable receipt.
    pub value: T,
    /// Observed workspace mutation, including write intent and reverted writes.
    pub workspace_mutated: bool,
}

/// No callback data escapes before its capability history has committed.
#[derive(Debug, thiserror::Error)]
pub enum ManagedError<E> {
    /// The retained view differed from the frozen source; the callback was not invoked.
    #[error("retained workspace was invalidated before callback entry")]
    Invalidated,
    /// An authorized callback error whose filesystem prefix was discarded.
    #[error("managed operation failed: {0}")]
    Operation(E),
    /// Observation, authorization, publication or infrastructure failed.
    #[error(transparent)]
    Execution(#[from] ShellError),
    /// This call was cancelled before its receipt committed.
    #[error("managed call cancelled")]
    Cancelled,
    /// The session no longer admits calls.
    #[error("managed session is closed")]
    Closed,
}

/// One call's irreversible cancellation signal. Construct a fresh value for every call.
#[derive(Clone, Debug)]
pub struct ManagedCancellation {
    state: watch::Sender<bool>,
    run: Arc<Mutex<Option<Weak<Run>>>>,
}
impl Default for ManagedCancellation {
    fn default() -> Self {
        Self {
            state: watch::Sender::new(false),
            run: Arc::new(Mutex::new(None)),
        }
    }
}
impl ManagedCancellation {
    /// Irreversibly cancels this call, including queued admission or its bound run.
    pub fn cancel(&self) {
        self.state.send_replace(true);
        if let Some(run) = self.run.lock().recover().as_ref().and_then(Weak::upgrade) {
            run.cancel();
        }
    }
    /// Whether cancellation has been requested for this call.
    pub fn is_cancelled(&self) -> bool {
        *self.state.borrow()
    }
    /// Waits until cancellation is requested; the signal is never reset.
    pub async fn cancelled(&self) {
        let mut receiver = self.state.subscribe();
        let _ = receiver.wait_for(|cancelled| *cancelled).await;
    }
    fn bind(&self, run: &Arc<Run>) -> CancellationBinding {
        *self.run.lock().recover() = Some(Arc::downgrade(run));
        if self.is_cancelled() {
            run.cancel();
        }
        CancellationBinding {
            cancel: self.clone(),
        }
    }
}

struct CancellationBinding {
    cancel: ManagedCancellation,
}
impl Drop for CancellationBinding {
    fn drop(&mut self) {
        self.cancel.run.lock().recover().take();
    }
}

#[derive(Clone, Copy)]
enum Phase {
    Fresh,
    Active(u64),
    Closing(u64),
    Parked(u64),
    Retiring,
    Closed,
}

#[derive(Default)]
struct CachedReads {
    reads: BTreeSet<PathBuf>,
    dependencies: BTreeSet<PathBuf>,
    recursive_reads: BTreeSet<PathBuf>,
}
impl CachedReads {
    fn include(&mut self, evidence: &mut CommandEvidence) {
        for (_, effect) in &evidence.effects {
            self.reads.extend(effect.reads.iter().cloned());
            self.dependencies
                .extend(effect.dependencies.iter().cloned());
            self.recursive_reads
                .extend(effect.recursive_reads.iter().cloned());
        }
        evidence.effects.insert(
            0,
            (
                0,
                Effects {
                    reads: self.reads.iter().cloned().collect(),
                    dependencies: self.dependencies.iter().cloned().collect(),
                    recursive_reads: self.recursive_reads.iter().cloned().collect(),
                    ..Effects::default()
                },
            ),
        );
    }
}

struct State {
    phase: Phase,
    generation: u64,
    run: Option<Arc<Run>>,
    parked: Option<ParkedRun>,
    cleanup: Option<tokio::task::JoinHandle<Result<(), ShellError>>>,
    children: Mutex<Vec<Arc<ChildState>>>,
    infrastructure: Mutex<Vec<ExternalPipeline>>,
    startup: Option<(super::ProfileLoadBehavior, super::RcLoadBehavior)>,
    initial_interpreter: Option<brush_core::Shell<super::execution::ManagedExtensions>>,
    cached: CachedReads,
    failure: Option<Arc<ShellError>>,
}
pub(crate) struct Inner {
    shell: Arc<Shell>,
    state: tokio::sync::Mutex<State>,
    active: AtomicU64,
    environment: Vec<(OsString, OsString)>,
    pipeline: PipelineOptions,
    closing: ManagedCancellation,
}

/// Owns configured shell resources and a native tree retained only across validated epochs.
pub struct ManagedSession {
    inner: Arc<Inner>,
}
impl std::fmt::Debug for ManagedSession {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ManagedSession")
            .finish_non_exhaustive()
    }
}
impl ShellBuilder {
    /// Constructs through the normal shell builder, preserving its authorization and resources.
    pub async fn build_managed_session(self) -> Result<ManagedSession, ShellError> {
        self.build_managed_session_with_cancel(ManagedCancellation::default())
            .await
    }

    pub(crate) async fn build_managed_session_with_cancel(
        mut self,
        closing: ManagedCancellation,
    ) -> Result<ManagedSession, ShellError> {
        let profile = self.options.profile;
        let rc = self.options.rc;
        let startup = (!profile.skip() || !rc.skip()).then_some((profile, rc));
        self.options.profile = super::ProfileLoadBehavior::Skip;
        self.options.rc = super::RcLoadBehavior::Skip;
        let shell = Arc::new(self.sandbox_policy(SandboxPolicy::allow()).build().await?);
        let session = ManagedSession::from_shell(shell, closing).await?;
        {
            let mut state = session.inner.state.lock().await;
            if startup.is_some() {
                let live = session.inner.shell.shared.live.lock().await;
                state.initial_interpreter = live.as_ref().map(|live| live.interpreter.clone());
            }
            state.startup = startup;
        }
        Ok(session)
    }
}
impl ManagedSession {
    pub(crate) async fn from_shell(
        shell: Arc<Shell>,
        closing: ManagedCancellation,
    ) -> Result<Self, ShellError> {
        let (environment, pipeline) = {
            let live = shell.shared.live.lock().await;
            let live = live
                .as_ref()
                .ok_or_else(|| ShellError::new(ShellErrorKind::Closed))?;
            let environment = live
                .interpreter
                .env()
                .iter_exported()
                .filter(|(_, variable)| variable.value().is_set())
                .map(|(name, variable)| {
                    (
                        OsString::from(name),
                        OsString::from(variable.value().to_cow_str(&live.interpreter).as_ref()),
                    )
                })
                .collect();
            (
                environment,
                live.interpreter.default_exec_params().pipeline_options,
            )
        };
        Ok(Self {
            inner: Arc::new(Inner {
                shell,
                state: tokio::sync::Mutex::new(State {
                    phase: Phase::Fresh,
                    generation: 0,
                    run: None,
                    parked: None,
                    cleanup: None,
                    children: Mutex::new(Vec::new()),
                    infrastructure: Mutex::new(Vec::new()),
                    startup: None,
                    initial_interpreter: None,
                    cached: CachedReads::default(),
                    failure: None,
                }),
                active: AtomicU64::new(0),
                environment,
                pipeline,
                closing,
            }),
        })
    }

    pub(crate) fn registration(&self) -> ManagedRegistration {
        ManagedRegistration::Ready(Arc::downgrade(&self.inner))
    }

    /// Executes one fallible operation. Only an unissued callback may return `Invalidated`.
    pub async fn epoch<T, R, E, F>(
        &mut self,
        tool: T,
        cancel: &ManagedCancellation,
        operation: F,
    ) -> Result<ManagedOutcome<R>, ManagedError<E>>
    where
        T: MarshTool,
        for<'a> &'a T: Into<Action>,
        // Independent lifetimes let Rust generalize Send for higher-ranked async callbacks.
        F: for<'epoch, 'view> std::ops::AsyncFnOnce(&'epoch ManagedEpoch<'view>) -> Result<R, E>
            + Send,
        R: Send + 'static,
        E: std::error::Error + Send + 'static,
    {
        if cancel.is_cancelled() {
            return Err(ManagedError::Cancelled);
        }
        if self.inner.closing.is_cancelled() {
            return Err(ManagedError::Closed);
        }
        let mut state = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(ManagedError::Cancelled),
            () = self.inner.closing.cancelled() => return Err(ManagedError::Closed),
            state = self.inner.state.lock() => state,
        };
        if let Some(error) = &state.failure {
            return Err(ManagedError::Execution(shared_error(error)));
        }
        if matches!(state.phase, Phase::Closed) {
            return Err(ManagedError::Closed);
        }
        let generation = state
            .generation
            .checked_add(1)
            .ok_or_else(|| ShellError::infrastructure("managed epoch generation exhausted"))?;
        let action: Action = (&tool).into();
        let description = tool.description().into_owned();
        let mut live_guard = self.inner.shell.shared.live.lock().await;
        let live = live_guard.as_mut().ok_or(ManagedError::Closed)?;
        match state.phase {
            Phase::Active(generation) | Phase::Closing(generation) => {
                if generation > state.generation {
                    return Err(ManagedError::Execution(ShellError::infrastructure(
                        "invalid managed epoch generation",
                    )));
                }
                self.inner.retire_locked(&mut state, live).await?;
            }
            Phase::Retiring => {
                self.inner.retire_locked(&mut state, live).await?;
            }
            Phase::Parked(generation) if generation != state.generation => {
                return Err(ManagedError::Execution(ShellError::infrastructure(
                    "invalid managed park generation",
                )));
            }
            Phase::Fresh | Phase::Parked(_) | Phase::Closed => {}
        }
        let notify = tokio::sync::Notify::new();
        let force = std::sync::atomic::AtomicBool::new(false);
        let parent = super::execution::current_context().map(|context| context.parent());
        let (admission, _) = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(ManagedError::Cancelled),
            () = self.inner.closing.cancelled() => return Err(ManagedError::Closed),
            admitted = live.resources.admit(&tool, &action, &notify, &force, parent.as_ref()) => admitted?,
        };
        if cancel.is_cancelled() {
            return Err(ManagedError::Cancelled);
        }
        let prepared = tokio::select! {
            biased;
            () = cancel.cancelled() => return Err(ManagedError::Cancelled),
            () = self.inner.closing.cancelled() => return Err(ManagedError::Closed),
            prepared = self.inner.prepare(&mut state, live) => prepared,
        };
        let prepared = match prepared {
            Ok(Some(prepared)) => prepared,
            Ok(None) => {
                self.inner.retire_locked(&mut state, live).await?;
                return Err(ManagedError::Invalidated);
            }
            Err(error) => {
                let cleanup = self.inner.retire_locked(&mut state, live).await;
                return Err(ManagedError::Execution(cleanup.err().unwrap_or(error)));
            }
        };
        let run = Arc::clone(&prepared.run);
        let mut abort = AbortEpoch::new(Arc::clone(&self.inner), Arc::clone(&run));
        let _call_cancellation = cancel.bind(&run);
        let _close_cancellation = self.inner.closing.bind(&run);
        self.inner.shell.shared.executor.install(&run);
        if matches!(state.phase, Phase::Fresh)
            && let Some((profile, rc)) = &state.startup
        {
            let profile = if profile.skip() {
                super::ProfileLoadBehavior::Skip
            } else {
                super::ProfileLoadBehavior::LoadDefault
            };
            let rc = match rc {
                super::RcLoadBehavior::LoadDefault => super::RcLoadBehavior::LoadDefault,
                super::RcLoadBehavior::LoadCustom(path) => {
                    super::RcLoadBehavior::LoadCustom(path.clone())
                }
                super::RcLoadBehavior::Skip => super::RcLoadBehavior::Skip,
            };
            let startup = super::execution::evaluate(
                &mut live.interpreter,
                &run,
                super::Command::Startup(profile, rc),
            );
            let startup = tokio::select! {
                biased;
                () = cancel.cancelled() => Err(ManagedError::Cancelled),
                () = self.inner.closing.cancelled() => Err(ManagedError::Closed),
                (_, failure) = startup => failure.map_or(Ok(()), |_| Err(ManagedError::Execution(ShellError::infrastructure("managed startup failed")))),
            };
            if let Err(error) = startup {
                drop(prepared);
                let cleanup = self.inner.retire_locked(&mut state, live).await;
                return Err(cleanup.err().map_or(error, ManagedError::Execution));
            }
        }
        state.generation = generation;
        state.phase = Phase::Active(generation);
        self.inner.active.store(generation, Ordering::Release);
        let context = BuiltinContext::from_run(Arc::clone(&run));
        let epoch = ManagedEpoch {
            inner: &self.inner,
            context,
            run: &run,
            generation,
            children: &state.children,
            infrastructure: &state.infrastructure,
        };
        let evaluated = match epoch.context.wrap_managed(operation(&epoch)) {
            Ok(evaluation) => tokio::select! {
                biased;
                () = cancel.cancelled() => Err(ManagedError::Cancelled),
                () = self.inner.closing.cancelled() => Err(ManagedError::Closed),
                error = run.failure() => Err(ManagedError::Execution(error)),
                result = std::panic::AssertUnwindSafe(evaluation).catch_unwind() => match result {
                    Ok(result) => Ok(result),
                    Err(_) => Err(ManagedError::Execution(ShellError::infrastructure("managed callback panicked"))),
                },
            },
            Err(error) => Err(if cancel.is_cancelled() {
                ManagedError::Cancelled
            } else if self.inner.closing.is_cancelled() {
                ManagedError::Closed
            } else {
                ManagedError::Execution(error)
            }),
        };
        self.inner.active.store(0, Ordering::Release);
        state.phase = Phase::Closing(generation);
        run.begin_closing();
        let result = match evaluated {
            Ok(result) => result,
            Err(error) => {
                drop(prepared);
                let cleanup = self.inner.retire_locked(&mut state, live).await;
                return Err(cleanup.err().map_or(error, ManagedError::Execution));
            }
        };
        let closed = tokio::select! {
            biased;
            () = cancel.cancelled() => Err(ManagedError::Cancelled),
            () = self.inner.closing.cancelled() => Err(ManagedError::Closed),
            error = run.failure() => Err(ManagedError::Execution(error)),
            outcome = run.drain_application() => outcome.map_err(ManagedError::Execution),
        };
        if let Err(error) = closed {
            drop(prepared);
            let cleanup = self.inner.retire_locked(&mut state, live).await;
            return Err(cleanup.err().map_or(error, ManagedError::Execution));
        }
        let (tracing, trace) = run.trace()?;
        let tracing = Arc::clone(tracing);
        abort.parking = Some(
            self.inner
                .shell
                .shared
                .runtime
                .spawn_blocking(move || tracing.park(trace)),
        );
        let parking = abort.parking.as_mut().expect("managed park task installed");
        let parked = tokio::select! {
            biased;
            () = cancel.cancelled() => { run.cancel(); parking.await },
            () = self.inner.closing.cancelled() => { run.cancel(); parking.await },
            error = run.failure() => {
                run.cancel();
                let _ = parking.await;
                abort.parking = None;
                drop(prepared);
                let cleanup = self.inner.retire_locked(&mut state, live).await;
                return Err(ManagedError::Execution(cleanup.err().unwrap_or(error)));
            },
            parked = &mut *parking => parked,
        };
        abort.parking = None;
        let parked = match parked {
            Ok(Ok(parked)) if !cancel.is_cancelled() && !self.inner.closing.is_cancelled() => {
                parked
            }
            other => {
                let error = match other {
                    Ok(Ok(parked)) => {
                        drop(parked);
                        ManagedError::Cancelled
                    }
                    Ok(Err(_)) if cancel.is_cancelled() => ManagedError::Cancelled,
                    Ok(Err(error)) => ManagedError::Execution(error.into()),
                    Err(error) => ManagedError::Execution(ShellError::infrastructure(format!(
                        "managed park task failed: {error}"
                    ))),
                };
                drop(prepared);
                let cleanup = self.inner.retire_locked(&mut state, live).await;
                return Err(cleanup.err().map_or(error, ManagedError::Execution));
            }
        };
        state.parked = Some(parked);
        let evidence = prepared.snapshot.checkpoint(trace);
        let committed = match evidence {
            Ok(mut evidence) => {
                state.cached.include(&mut evidence);
                let session = Arc::clone(&prepared.snapshot.session);
                let transaction = ExecutedTransaction {
                    prepared,
                    failure: None,
                    evidence,
                    command: description,
                    uncertain: false,
                    mode: if result.is_ok() {
                        PublicationMode::Apply
                    } else {
                        PublicationMode::DiscardWrites
                    },
                    seal: PublicationSeal::Parked(
                        state.parked.as_ref().expect("parked proof installed"),
                    ),
                };
                super::policy::authorize(
                    &session,
                    transaction,
                    live.resources.shell_policy.as_ref(),
                    live.resources.policy_observer.as_deref(),
                )
                .and_then(super::publication::commit)
            }
            Err(error) => Err(error),
        };
        drop(admission);
        // Synchronize with any cancellation already delivering to this generation. Once the
        // receipt exists, an old call must never acquire a later generation's cancellation right.
        drop(_call_cancellation);
        drop(_close_cancellation);
        match committed {
            Ok(workspace_mutated) => match result {
                Ok(value) => {
                    if run.is_cancelled() {
                        self.inner.retire_locked(&mut state, live).await?;
                    } else {
                        state.phase = Phase::Parked(generation);
                    }
                    abort.armed = false;
                    Ok(ManagedOutcome {
                        value,
                        workspace_mutated,
                    })
                }
                Err(error) => {
                    self.inner.retire_locked(&mut state, live).await?;
                    Err(ManagedError::Operation(error))
                }
            },
            Err(error) => {
                let error = if cancel.is_cancelled() {
                    ManagedError::Cancelled
                } else if self.inner.closing.is_cancelled() {
                    ManagedError::Closed
                } else {
                    ManagedError::Execution(error)
                };
                let cleanup = self.inner.retire_locked(&mut state, live).await;
                Err(cleanup.err().map_or(error, ManagedError::Execution))
            }
        }
    }

    /// Kills and drains the current tree and drops its view; configuration remains reusable.
    pub async fn retire(&mut self) -> Result<(), ShellError> {
        let mut state = self.inner.state.lock().await;
        let mut live = self.inner.shell.shared.live.lock().await;
        match live.as_mut() {
            Some(live) => self.inner.retire_locked(&mut state, live).await,
            None => Ok(()),
        }
    }

    /// Fences admission and joins every native child and resource monitor. Idempotent.
    pub async fn close(&mut self) -> Result<(), ShellError> {
        self.inner.close().await
    }
}
impl Drop for ManagedSession {
    fn drop(&mut self) {
        self.inner.closing.cancel();
        let inner = Arc::clone(&self.inner);
        self.inner.shell.shared.runtime.spawn(async move {
            let _ = inner.close_owned().await;
        });
    }
}

fn shared_error(error: &Arc<ShellError>) -> ShellError {
    ShellError::caused(error.kind().clone(), Arc::clone(error))
}

/// If the caller drops the borrowed callback future, cancellation still owns the final drain.
struct AbortEpoch {
    inner: Arc<Inner>,
    run: Arc<Run>,
    parking: Option<tokio::task::JoinHandle<io::Result<ParkedRun>>>,
    armed: bool,
}
impl AbortEpoch {
    fn new(inner: Arc<Inner>, run: Arc<Run>) -> Self {
        Self {
            inner,
            run,
            parking: None,
            armed: true,
        }
    }
}
impl Drop for AbortEpoch {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        self.inner.active.store(0, Ordering::Release);
        if self.run.closed.load(Ordering::Acquire) && self.parking.is_none() {
            return;
        }
        self.run.cancel();
        let inner = Arc::clone(&self.inner);
        let run = Arc::clone(&self.run);
        let parking = self.parking.take();
        self.inner.shell.shared.runtime.spawn(async move {
            if let Some(parking) = parking {
                let _ = parking.await;
            }
            let mut state = inner.state.lock().await;
            if state
                .run
                .as_ref()
                .is_some_and(|active| Arc::ptr_eq(active, &run))
            {
                let mut live = inner.shell.shared.live.lock().await;
                if let Some(live) = live.as_mut() {
                    let _ = inner.retire_locked(&mut state, live).await;
                }
            }
        });
    }
}

impl Inner {
    async fn prepare(
        &self,
        state: &mut State,
        live: &mut super::Live,
    ) -> Result<Option<super::completion::Completion<PreparedCommand>>, ShellError> {
        let number = live.resources.number()?;
        if let Some(run) = &state.run {
            let snapshot = live
                .resources
                .snapshot
                .as_ref()
                .ok_or_else(|| ShellError::infrastructure("retained managed view missing"))?;
            let prepared = snapshot::prepare_retained(snapshot, run, number)?;
            if prepared.is_none() {
                return Ok(None);
            }
            run.reopen()?;
            state
                .parked
                .take()
                .ok_or_else(|| ShellError::infrastructure("retained managed park missing"))?
                .resume()?;
            return Ok(prepared);
        }
        if live.resources.snapshot.is_none() {
            let session = live.resources.domain.managed().await?;
            let snapshot = snapshot::Snapshot::new(
                session,
                live.resources.principal.clone(),
                live.resources.owner.clone(),
            )?;
            let scope = snapshot.session.tracing.internal_scope()?;
            let _guard = scope.enter();
            super::view::Transition::plan(
                &live.interpreter,
                &snapshot.session.persistence.seed,
                snapshot.path(),
            )?
            .apply(&mut live.interpreter)?;
            live.resources.snapshot = Some(snapshot);
        }
        let snapshot = live
            .resources
            .snapshot
            .as_ref()
            .expect("managed view installed");
        let prepared = snapshot::prepare(
            snapshot,
            self.shell.shared.runtime.clone(),
            number,
            Arc::new(live.logical_cwd()),
        )?;
        state.run = Some(Arc::clone(&prepared.run));
        Ok(Some(prepared))
    }

    async fn retire_locked(
        &self,
        state: &mut State,
        live: &mut super::Live,
    ) -> Result<(), ShellError> {
        self.active.store(0, Ordering::Release);
        if let Some(error) = &state.failure {
            return Err(shared_error(error));
        }
        if matches!(state.phase, Phase::Closed) {
            return Ok(());
        }
        if state.run.is_none() && state.cleanup.is_none() && live.resources.snapshot.is_none() {
            state.cached = CachedReads::default();
            state.phase = Phase::Fresh;
            return Ok(());
        }
        state.phase = Phase::Retiring;
        if state.cleanup.is_none() {
            let run = state.run.clone();
            if let Some(run) = &run {
                run.cancel();
            }
            let parked = state.parked.take();
            let children = std::mem::take(&mut *state.children.lock().recover());
            let infrastructure = std::mem::take(&mut *state.infrastructure.lock().recover());
            let runtime = self.shell.shared.runtime.clone();
            state.cleanup = Some(self.shell.shared.runtime.spawn(cleanup_native(
                runtime,
                run,
                parked,
                children,
                infrastructure,
            )));
        }
        let cleaned = state
            .cleanup
            .as_mut()
            .expect("managed cleanup task installed")
            .await;
        state.cleanup = None;
        let cleaned = cleaned
            .unwrap_or_else(|_| Err(ShellError::infrastructure("managed cleanup task failed")));
        self.shell.shared.executor.idle();
        if let Err(error) = cleaned {
            if let Some(snapshot) = &live.resources.snapshot {
                snapshot.retained.store(true, Ordering::Release);
            }
            live.resources.domain.fail(
                &live.resources.coverage,
                "managed native tree cleanup could not be proven complete",
            );
            let error = Arc::new(error);
            state.failure = Some(Arc::clone(&error));
            return Err(shared_error(&error));
        }
        state.run = None;
        if let Some(initial) = &state.initial_interpreter {
            live.interpreter = initial.clone();
        } else if let Some(snapshot) = &live.resources.snapshot {
            let transition = (|| -> Result<(), ShellError> {
                let scope = snapshot.session.tracing.internal_scope()?;
                let _guard = scope.enter();
                super::view::Transition::plan(
                    &live.interpreter,
                    snapshot.path(),
                    &snapshot.session.persistence.seed,
                )?
                .apply(&mut live.interpreter)
            })();
            if let Err(error) = transition {
                snapshot.retained.store(true, Ordering::Release);
                let error = Arc::new(error);
                state.failure = Some(Arc::clone(&error));
                return Err(shared_error(&error));
            }
        }
        if let Some(snapshot) = &live.resources.snapshot
            && let Err(error) = snapshot.close()
        {
            snapshot.retained.store(true, Ordering::Release);
            let error = Arc::new(error);
            state.failure = Some(Arc::clone(&error));
            return Err(shared_error(&error));
        }
        live.resources.snapshot = None;
        state.cached = CachedReads::default();
        state.phase = Phase::Fresh;
        Ok(())
    }

    async fn close(self: &Arc<Self>) -> Result<(), ShellError> {
        self.closing.cancel();
        let inner = Arc::clone(self);
        self.shell
            .shared
            .runtime
            .spawn(async move { inner.close_owned().await })
            .await
            .map_err(|_| ShellError::infrastructure("managed close task failed"))?
    }

    async fn close_owned(&self) -> Result<(), ShellError> {
        self.closing.cancel();
        let mut state = self.state.lock().await;
        if matches!(state.phase, Phase::Closed) {
            return state
                .failure
                .as_ref()
                .map_or(Ok(()), |error| Err(shared_error(error)));
        }
        let result = {
            let mut live = self.shell.shared.live.lock().await;
            match live.as_mut() {
                Some(live) => self.retire_locked(&mut state, live).await,
                None => Ok(()),
            }
        };
        state.phase = Phase::Closed;
        if let Err(error) = result {
            let error = Arc::new(error);
            state.failure = Some(Arc::clone(&error));
            return Err(shared_error(&error));
        }
        if let Err(error) = self.shell.close(true).await {
            let error = Arc::new(error);
            state.failure = Some(Arc::clone(&error));
            return Err(shared_error(&error));
        }
        Ok(())
    }
}

/// This task owns every producer before its first await; dropping a caller cannot orphan a join.
async fn cleanup_native(
    runtime: tokio::runtime::Handle,
    run: Option<Arc<Run>>,
    parked: Option<ParkedRun>,
    children: Vec<Arc<ChildState>>,
    infrastructure: Vec<ExternalPipeline>,
) -> Result<(), ShellError> {
    let mut failure = None;
    if let Some(parked) = parked {
        match runtime.spawn_blocking(move || parked.cancel()).await {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => {
                failure.get_or_insert_with(|| error.into());
            }
            Err(_) => {
                failure.get_or_insert_with(|| {
                    ShellError::infrastructure("managed cancellation task failed")
                });
            }
        }
    }
    if let Some(run) = &run {
        let (tracing, trace) = run.trace()?;
        let tracing = Arc::clone(tracing);
        match runtime
            .spawn_blocking(move || {
                tracing.drain(trace);
                tracing.health(trace)
            })
            .await
        {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                failure.get_or_insert_with(|| error.into());
            }
            Err(_) => {
                failure
                    .get_or_insert_with(|| ShellError::infrastructure("managed drain task failed"));
            }
        }
    }
    for child in children {
        let traced = child.traced.lock().recover().take();
        if let Some(traced) = traced {
            match runtime.spawn_blocking(move || traced.wait_observed()).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    failure.get_or_insert_with(|| error.into());
                }
                Err(_) => {
                    failure.get_or_insert_with(|| {
                        ShellError::infrastructure("managed observer join failed")
                    });
                }
            }
        }
        let resources = child.resources.lock().recover().take();
        if let Some(resources) = resources {
            resources.finish().await;
        }
    }
    for resources in infrastructure {
        resources.finish().await;
    }
    if let Some(run) = &run {
        if let Err((error, _)) = run.finish().await {
            failure.get_or_insert(error);
        }
        let (tracing, trace) = run.trace()?;
        if let Err(error) = tracing.end_run(trace) {
            failure.get_or_insert_with(|| error.into());
        }
    }
    failure.map_or(Ok(()), Err)
}

#[derive(Clone)]
pub(crate) enum ManagedRegistration {
    Opening,
    Ready(Weak<Inner>),
    Failed,
}
/// A mux registration fences construction as well as parked sessions.
pub(crate) struct ManagedClose {
    pub(crate) cancel: ManagedCancellation,
    pub(crate) ready: watch::Receiver<ManagedRegistration>,
}
impl ManagedClose {
    pub(crate) fn live(&self) -> bool {
        match &*self.ready.borrow() {
            ManagedRegistration::Opening => true,
            ManagedRegistration::Ready(inner) => inner.strong_count() != 0,
            ManagedRegistration::Failed => false,
        }
    }
    pub(crate) async fn close(mut self) -> Result<(), ShellError> {
        self.cancel.cancel();
        loop {
            let registration = self.ready.borrow_and_update().clone();
            match registration {
                ManagedRegistration::Opening => {
                    if self.ready.changed().await.is_err() {
                        return Ok(());
                    }
                }
                ManagedRegistration::Ready(inner) => {
                    return match inner.upgrade() {
                        Some(inner) => inner.close().await,
                        None => Ok(()),
                    };
                }
                ManagedRegistration::Failed => return Ok(()),
            }
        }
    }
}

/// A non-cloneable borrowed generation. Paths may escape; contexts and I/O cannot.
pub struct ManagedEpoch<'session> {
    inner: &'session Inner,
    context: BuiltinContext,
    run: &'session Arc<Run>,
    generation: u64,
    children: &'session Mutex<Vec<Arc<ChildState>>>,
    infrastructure: &'session Mutex<Vec<ExternalPipeline>>,
}
impl ManagedEpoch<'_> {
    fn check(&self) -> Result<(), ShellError> {
        if self.inner.active.load(Ordering::Acquire) != self.generation {
            return Err(ShellError::new(ShellErrorKind::Closed));
        }
        self.run.check()
    }
    fn io_step<T>(&self, operation: impl FnOnce() -> io::Result<T>) -> io::Result<T> {
        self.check().map_err(io::Error::other)?;
        let lease = self.run.application_lease().map_err(io::Error::other)?;
        let result = operation();
        lease.complete();
        result
    }
    /// Canonical logical working directory of this session.
    pub fn cwd(&self) -> &Path {
        self.context.working_dir()
    }
    /// Exported environment frozen when the session was constructed.
    pub fn environment(&self) -> impl Iterator<Item = (&OsStr, &OsStr)> {
        self.inner
            .environment
            .iter()
            .map(|(name, value)| (name.as_os_str(), value.as_os_str()))
    }
    /// Reads a regular file through the active epoch's tracked context.
    /// Special files are rejected; a raced FIFO replacement cannot block its open.
    pub fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        self.io_step(|| {
            let regular = |metadata: Metadata| {
                if metadata.is_file() {
                    Ok(())
                } else {
                    Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "expected a regular file",
                    ))
                }
            };
            regular(self.context.metadata(path)?)?;
            let mut file = self.context.open(
                path,
                OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK),
            )?;
            // Check the opened object too: the pathname may have changed since metadata.
            regular(file.metadata()?)?;
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)?;
            Ok(bytes)
        })
    }
    /// Reads tracked UTF-8 content, returning invalid-data errors without replacement.
    pub fn read_to_string(&self, path: &Path) -> io::Result<String> {
        String::from_utf8(self.read(path)?)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }
    /// Reads tracked metadata, following the final symlink.
    pub fn metadata(&self, path: &Path) -> io::Result<Metadata> {
        self.io_step(|| self.context.metadata(path))
    }
    /// Reads tracked metadata without following the final symlink.
    pub fn symlink_metadata(&self, path: &Path) -> io::Result<Metadata> {
        self.io_step(|| self.context.symlink_metadata(path))
    }
    /// Reads a symlink target through the tracked context.
    pub fn read_link(&self, path: &Path) -> io::Result<PathBuf> {
        self.io_step(|| self.context.read_link(path))
    }
    /// Iterates tracked logical paths while borrowing this active epoch.
    pub fn read_dir(&self, path: &Path) -> io::Result<ManagedReadDir<'_>> {
        let inner = self.io_step(|| self.context.read_dir(path))?;
        Ok(ManagedReadDir { epoch: self, inner })
    }
    /// Expands a tracked glob into epoch-borrowed logical paths.
    pub fn glob(&self, pattern: &str) -> Result<ManagedGlobPaths<'_>, ShellError> {
        self.check()?;
        let lease = self.run.application_lease()?;
        let inner = self.context.glob(pattern, None);
        lease.complete();
        Ok(ManagedGlobPaths {
            epoch: self,
            inner: inner?,
        })
    }
    /// Creates or truncates a file and writes every byte through the tracked context.
    pub fn write(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        self.io_step(|| {
            self.context
                .open(
                    path,
                    OpenOptions::new().write(true).create(true).truncate(true),
                )?
                .write_all(bytes)
        })
    }
    /// Exclusively creates a file and writes every byte, refusing an existing entry.
    pub fn create_new(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        self.io_step(|| {
            self.context
                .open(path, OpenOptions::new().write(true).create_new(true))?
                .write_all(bytes)
        })
    }
    /// Creates missing parents through tracked directory operations.
    pub fn create_dir_all(&self, path: &Path) -> io::Result<()> {
        self.io_step(|| self.context.create_dir_all(path))
    }
    /// Removes a tracked file or symlink.
    pub fn remove_file(&self, path: &Path) -> io::Result<()> {
        self.io_step(|| self.context.remove_file(path))
    }
    /// Removes a tracked empty directory.
    pub fn remove_dir(&self, path: &Path) -> io::Result<()> {
        self.io_step(|| self.context.remove_dir(path))
    }
    /// Renames an entry while recording both source and destination effects.
    pub fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        self.io_step(|| self.context.rename(from, to))
    }
    /// Identity translation only, not permission to perform untracked filesystem accesses.
    pub fn physical_path(&self, path: &Path) -> Result<PathBuf, ShellError> {
        self.check()?;
        self.context.physical_path(path)
    }
    /// Converts view identity to a logical path; it does not authorize untracked I/O.
    pub fn logical_path(&self, path: &Path) -> Result<PathBuf, ShellError> {
        self.check()?;
        self.context.logical_path(path)
    }
    /// Resolves an executable using tracked metadata probes and this session's frozen PATH.
    pub fn resolve_executable(&self, program: &OsStr, path: Option<&OsStr>) -> io::Result<PathBuf> {
        let executable = |candidate: &Path| -> io::Result<bool> {
            match self.metadata(candidate) {
                Ok(metadata) => {
                    Ok(metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
                }
                Err(error)
                    if error.kind() == io::ErrorKind::NotFound
                        || error.kind() == io::ErrorKind::NotADirectory =>
                {
                    Ok(false)
                }
                Err(error) => Err(error),
            }
        };
        if program.as_encoded_bytes().contains(&b'/') {
            let candidate = self.cwd().join(program);
            return if executable(&candidate)? {
                self.physical_path(&candidate).map_err(io::Error::other)
            } else {
                Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "executable not found",
                ))
            };
        }
        let path = path
            .or_else(|| {
                self.environment()
                    .find(|(name, _)| *name == OsStr::new("PATH"))
                    .map(|(_, value)| value)
            })
            .unwrap_or(OsStr::new(""));
        for directory in std::env::split_paths(path) {
            let candidate = self.cwd().join(directory).join(program);
            if executable(&candidate)? {
                return self.physical_path(&candidate).map_err(io::Error::other);
            }
        }
        Err(io::Error::new(
            io::ErrorKind::NotFound,
            "executable not found",
        ))
    }
    /// Launches direct argv with the shell's exact resource owner and the shared native tracer.
    pub fn spawn(
        &self,
        description: impl Into<String>,
        mut command: Command,
    ) -> Result<ManagedChild, ShellError> {
        self.check()?;
        let resources = self.inner.pipeline.begin_external(description)?;
        let lease = self.run.application_lease()?;
        command.process_group(0);
        let environment: Vec<_> = command
            .get_envs()
            .map(|(name, value)| (name.to_owned(), value.map(OsStr::to_owned)))
            .collect();
        command.env_clear().envs(self.environment());
        for (name, value) in environment {
            match value {
                Some(value) => {
                    command.env(name, value);
                }
                None => {
                    command.env_remove(name);
                }
            }
        }
        if command.get_current_dir().is_none() {
            match self.physical_path(self.cwd()) {
                Ok(cwd) => {
                    command.current_dir(cwd);
                }
                Err(error) => {
                    lease.complete();
                    self.infrastructure.lock().recover().push(resources);
                    return Err(error);
                }
            }
        }
        if let Err(error) = resources.attach(&mut command, &self.run.infrastructure_observer()) {
            lease.complete();
            self.infrastructure.lock().recover().push(resources);
            return Err(error.into());
        }
        let (status, _) = watch::channel(None);
        let events = status.clone();
        let mut traced = match self.context.spawn_traced(
            command,
            Box::new(move |event| {
                if let ChildEvent::Exited(status) = event {
                    events.send_replace(Some(status));
                }
            }),
        ) {
            Ok(traced) => traced,
            Err(error) => {
                self.infrastructure.lock().recover().push(resources);
                lease.complete();
                return Err(error.into());
            }
        };
        let converted = (|| -> Result<_, ShellError> {
            Ok((
                Arc::new(traced.process.try_clone()?),
                traced
                    .stdin
                    .take()
                    .map(tokio::process::ChildStdin::from_std)
                    .transpose()?,
                traced
                    .stdout
                    .take()
                    .map(tokio::process::ChildStdout::from_std)
                    .transpose()?,
                traced
                    .stderr
                    .take()
                    .map(tokio::process::ChildStderr::from_std)
                    .transpose()?,
            ))
        })();
        let (process, stdin, stdout, stderr) = match converted {
            Ok(pipes) => pipes,
            Err(error) => {
                let _ = marsh_instrument::signal_process(&traced.process, libc::SIGKILL);
                self.children.lock().recover().push(Arc::new(ChildState {
                    owner: Arc::downgrade(&self.inner.shell),
                    pid: traced.pid,
                    process: None,
                    traced: Mutex::new(Some(traced)),
                    status,
                    stdin: Arc::new(tokio::sync::Mutex::new(None)),
                    stdout: Arc::new(tokio::sync::Mutex::new(None)),
                    stderr: Arc::new(tokio::sync::Mutex::new(None)),
                    resources: Mutex::new(Some(resources)),
                }));
                self.run.cancel();
                lease.complete();
                return Err(error);
            }
        };
        let inner = Arc::new(ChildState {
            owner: Arc::downgrade(&self.inner.shell),
            pid: traced.pid,
            process: Some(process),
            traced: Mutex::new(Some(traced)),
            status,
            stdin: Arc::new(tokio::sync::Mutex::new(stdin)),
            stdout: Arc::new(tokio::sync::Mutex::new(stdout)),
            stderr: Arc::new(tokio::sync::Mutex::new(stderr)),
            resources: Mutex::new(Some(resources)),
        });
        self.children.lock().recover().push(Arc::clone(&inner));
        lease.complete();
        Ok(ManagedChild { inner })
    }
}

/// Directory names only; obtaining metadata requires another tracked epoch operation.
pub struct ManagedReadDir<'epoch> {
    epoch: &'epoch ManagedEpoch<'epoch>,
    inner: super::execution::ReadDir,
}
impl Iterator for ManagedReadDir<'_> {
    type Item = io::Result<PathBuf>;
    fn next(&mut self) -> Option<Self::Item> {
        if let Err(error) = self.epoch.check() {
            return Some(Err(io::Error::other(error)));
        }
        self.inner
            .next()
            .map(|entry| entry.map(|entry| entry.path()))
    }
}
/// Glob names only, borrowing and checking the active generation at every advancement.
pub struct ManagedGlobPaths<'epoch> {
    epoch: &'epoch ManagedEpoch<'epoch>,
    inner: super::execution::GlobPaths,
}
impl Iterator for ManagedGlobPaths<'_> {
    type Item = Result<PathBuf, ShellError>;
    fn next(&mut self) -> Option<Self::Item> {
        if let Err(error) = self.epoch.check() {
            return Some(Err(error));
        }
        self.inner.next().map(|path| path.map_err(ShellError::from))
    }
}

struct ChildState {
    owner: Weak<Shell>,
    pid: u32,
    process: Option<Arc<OwnedFd>>,
    traced: Mutex<Option<TracedChild>>,
    status: watch::Sender<Option<ExitStatus>>,
    stdin: Arc<tokio::sync::Mutex<Option<tokio::process::ChildStdin>>>,
    stdout: Arc<tokio::sync::Mutex<Option<tokio::process::ChildStdout>>>,
    stderr: Arc<tokio::sync::Mutex<Option<tokio::process::ChildStderr>>>,
    resources: Mutex<Option<ExternalPipeline>>,
}
/// An inert session-bound native identity; I/O always requires an active epoch borrow.
pub struct ManagedChild {
    inner: Arc<ChildState>,
}
impl std::fmt::Debug for ManagedChild {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ManagedChild")
            .field("pid", &self.inner.pid)
            .finish_non_exhaustive()
    }
}
impl ManagedChild {
    /// Native process identity reported by the sole tracer reaper.
    pub fn id(&self) -> u32 {
        self.inner.pid
    }
    fn check(&self, epoch: &ManagedEpoch<'_>) -> Result<(), ShellError> {
        epoch.check()?;
        if !self.inner.owner.ptr_eq(&Arc::downgrade(&epoch.inner.shell)) {
            return Err(ShellError::unsupported(
                "child belongs to another managed session",
            ));
        }
        if !epoch
            .children
            .lock()
            .recover()
            .iter()
            .any(|child| Arc::ptr_eq(child, &self.inner))
        {
            return Err(ShellError::new(ShellErrorKind::Closed));
        }
        Ok(())
    }
    /// Borrows independently synchronized streams for this child's owning active epoch.
    pub fn io<'epoch>(
        &'epoch self,
        epoch: &'epoch ManagedEpoch<'_>,
    ) -> Result<ManagedChildIo<'epoch>, ShellError> {
        self.check(epoch)?;
        Ok(ManagedChildIo {
            stdin: ManagedChildStdin(Stream::new(epoch, Arc::clone(&self.inner.stdin))),
            stdout: ManagedChildStdout(Stream::new(epoch, Arc::clone(&self.inner.stdout))),
            stderr: ManagedChildStderr(Stream::new(epoch, Arc::clone(&self.inner.stderr))),
        })
    }
    /// Waits for the tracer's exit receipt without a competing OS wait.
    pub async fn wait(&self, epoch: &ManagedEpoch<'_>) -> Result<ExitStatus, ShellError> {
        self.check(epoch)?;
        let mut status = self.inner.status.subscribe();
        let waited = status.wait_for(Option::is_some);
        tokio::pin!(waited);
        std::future::poll_fn(|context| {
            if let Err(error) = self.check(epoch) {
                return Poll::Ready(Err(error));
            }
            let lease = match epoch.run.application_lease() {
                Ok(lease) => lease,
                Err(error) => return Poll::Ready(Err(error)),
            };
            let result = match waited.as_mut().poll(context) {
                Poll::Ready(Ok(status)) => Poll::Ready(
                    status
                        .as_ref()
                        .copied()
                        .ok_or_else(|| ShellError::infrastructure("missing native exit status")),
                ),
                Poll::Ready(Err(_)) => Poll::Ready(Err(ShellError::infrastructure(
                    "native exit observation ended without status",
                ))),
                Poll::Pending => Poll::Pending,
            };
            lease.complete();
            result
        })
        .await
    }
    /// Signals the pinned child identity; final drainage remains the session's responsibility.
    pub fn kill(&self) -> Result<(), ShellError> {
        let process = self
            .inner
            .process
            .as_ref()
            .ok_or_else(|| ShellError::new(ShellErrorKind::Closed))?;
        marsh_instrument::signal_process(process, libc::SIGKILL)?;
        Ok(())
    }
}

/// Independent stream locks allow concurrent stdin, stdout and stderr pumping.
pub struct ManagedChildIo<'epoch> {
    /// Epoch-borrowed child input, checked on every poll.
    pub stdin: ManagedChildStdin<'epoch>,
    /// Epoch-borrowed child output, checked on every poll.
    pub stdout: ManagedChildStdout<'epoch>,
    /// Epoch-borrowed child error output, checked on every poll.
    pub stderr: ManagedChildStderr<'epoch>,
}
type LockFuture<T> = Pin<Box<dyn Future<Output = OwnedMutexGuard<Option<T>>> + Send>>;
struct Stream<'epoch, T> {
    epoch: &'epoch ManagedEpoch<'epoch>,
    lock: Option<LockFuture<T>>,
    guard: Option<OwnedMutexGuard<Option<T>>>,
}
impl<'epoch, T: Send + 'static> Stream<'epoch, T> {
    fn new(
        epoch: &'epoch ManagedEpoch<'epoch>,
        stream: Arc<tokio::sync::Mutex<Option<T>>>,
    ) -> Self {
        Self {
            epoch,
            lock: Some(Box::pin(stream.lock_owned())),
            guard: None,
        }
    }
    fn poll_stream(&mut self, context: &mut Context<'_>) -> Poll<io::Result<&mut T>> {
        if let Err(error) = self.epoch.check() {
            return Poll::Ready(Err(io::Error::other(error)));
        }
        if self.guard.is_none() {
            let Some(lock) = self.lock.as_mut() else {
                return Poll::Ready(Err(io::Error::other("managed pipe lock missing")));
            };
            self.guard = Some(std::task::ready!(lock.as_mut().poll(context)));
            self.lock = None;
        }
        Poll::Ready(
            self.guard
                .as_mut()
                .and_then(|guard| guard.as_mut())
                .ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        "native command did not pipe this stream",
                    )
                }),
        )
    }
}
/// Epoch-borrowed asynchronous native stdin.
pub struct ManagedChildStdin<'epoch>(Stream<'epoch, tokio::process::ChildStdin>);
/// Epoch-borrowed asynchronous native stdout.
pub struct ManagedChildStdout<'epoch>(Stream<'epoch, tokio::process::ChildStdout>);
/// Epoch-borrowed asynchronous native stderr.
pub struct ManagedChildStderr<'epoch>(Stream<'epoch, tokio::process::ChildStderr>);
impl AsyncWrite for ManagedChildStdin<'_> {
    fn poll_write(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let lease = match this.0.epoch.run.application_lease() {
            Ok(lease) => lease,
            Err(error) => return Poll::Ready(Err(io::Error::other(error))),
        };
        let result = match this.0.poll_stream(context) {
            Poll::Ready(Ok(stream)) => Pin::new(stream).poll_write(context, bytes),
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
            Poll::Pending => Poll::Pending,
        };
        lease.complete();
        result
    }
    fn poll_flush(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let lease = match this.0.epoch.run.application_lease() {
            Ok(lease) => lease,
            Err(error) => return Poll::Ready(Err(io::Error::other(error))),
        };
        let result = match this.0.poll_stream(context) {
            Poll::Ready(Ok(stream)) => Pin::new(stream).poll_flush(context),
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
            Poll::Pending => Poll::Pending,
        };
        lease.complete();
        result
    }
    fn poll_shutdown(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let lease = match this.0.epoch.run.application_lease() {
            Ok(lease) => lease,
            Err(error) => return Poll::Ready(Err(io::Error::other(error))),
        };
        let result = match this.0.poll_stream(context) {
            Poll::Ready(Ok(stream)) => Pin::new(stream).poll_shutdown(context),
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
            Poll::Pending => Poll::Pending,
        };
        lease.complete();
        result
    }
}
macro_rules! managed_reader {
    ($name:ident) => {
        impl AsyncRead for $name<'_> {
            fn poll_read(
                self: Pin<&mut Self>,
                context: &mut Context<'_>,
                buffer: &mut ReadBuf<'_>,
            ) -> Poll<io::Result<()>> {
                let this = self.get_mut();
                let lease = match this.0.epoch.run.application_lease() {
                    Ok(lease) => lease,
                    Err(error) => return Poll::Ready(Err(io::Error::other(error))),
                };
                let result = match this.0.poll_stream(context) {
                    Poll::Ready(Ok(stream)) => Pin::new(stream).poll_read(context, buffer),
                    Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
                    Poll::Pending => Poll::Pending,
                };
                lease.complete();
                result
            }
        }
    };
}
managed_reader!(ManagedChildStdout);
managed_reader!(ManagedChildStderr);
