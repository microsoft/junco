use std::collections::HashMap;
use std::future::{Future, pending};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use brush_core::{ShellVariable, env::ShellEnvironment};
use marsh_btrfs::{PersistenceLayer, Subvolumes};
use marsh_core::builtins::BuiltinContext;
use marsh_core::shellmux::{
    CommandCompletion, CommandHandle, CommandOptions, JobIo, MuxError, MuxProfile, RunError, Shell,
    ShellFrontend, ShellId, ShellMux, SpawnOptions, WaitError,
};
use marsh_core::{PolicyObserver, Principal, SandboxPolicy, ShellError, ShellErrorKind};
use tokio::runtime::Handle;
use tokio::sync::{oneshot, watch};
use tokio::task::{Id, JoinHandle};
use tokio::time::Instant;

use crate::frontend::{Frontend, OutputCallback, OutputRoute, PolicyLog};
use crate::process::{Admission, Admitted, ExecLine, ProcessState, ProcessTask, process_channels};
use crate::tool::JuncoTool;
use crate::{NativeProcessOptions, NativeRunOptions, NativeRunResult};

pub(crate) type RunResult = Result<NativeRunResult, RoutedError>;
type CloseResult = Result<(), String>;

/// A routed call's or run's failure. `Denied` is exactly a Marsh policy denial of publication;
/// every other failure is `Other`. Both carry the diagnostic JavaScript reports unchanged.
#[derive(Clone)]
pub(crate) enum RoutedError {
    Denied(String),
    Other(String),
}

impl From<String> for RoutedError {
    fn from(message: String) -> Self {
        Self::Other(message)
    }
}

impl RoutedError {
    /// Appends a cleanup diagnostic, keeping the primary failure's classification.
    fn with_cleanup(self, cleanup: String) -> Self {
        let append = |message: String| {
            if cleanup == message {
                message
            } else {
                format!("{message}\nShellMux cleanup: {cleanup}")
            }
        };
        match self {
            Self::Denied(message) => Self::Denied(append(message)),
            Self::Other(message) => Self::Other(append(message)),
        }
    }
}

/// A retained JavaScript run owns only its cancellation signal and eventual result.
/// In particular, it cannot keep the seed lease or a JavaScript callback alive.
pub(crate) struct RunState {
    cancellation: watch::Sender<bool>,
    result: watch::Receiver<Option<RunResult>>,
}

impl RunState {
    /// A pending state and the sender its worker publishes the one final result through.
    fn pending() -> (Arc<Self>, watch::Sender<Option<RunResult>>) {
        let (cancellation, _) = watch::channel(false);
        let (result_sender, result) = watch::channel(None);
        (
            Arc::new(Self {
                cancellation,
                result,
            }),
            result_sender,
        )
    }

    pub(crate) fn abort(&self) {
        self.cancellation.send_replace(true);
    }

    pub(crate) async fn wait(&self) -> RunResult {
        let published = self
            .result
            .clone()
            .wait_for(Option::is_some)
            .await
            .map_err(|_| "ShellMux run task ended without a result".to_string())?
            .clone();
        match published {
            Some(value) => value,
            None => Err(RoutedError::Other(
                "ShellMux run task ended without a result".to_string(),
            )),
        }
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        *self.cancellation.borrow()
    }

    pub(crate) async fn cancelled(&self) {
        let mut cancellation = self.cancellation.subscribe();
        let _ = cancellation.wait_for(|cancelled| *cancelled).await;
    }
}

#[derive(Clone)]
pub(crate) struct Backend {
    pub(crate) mux: Arc<ShellMux>,
    pub(crate) frontend: Arc<Mutex<Frontend>>,
    /// The one filesystem this session discovers seeds through. A second instance would
    /// know none of a CopyTree fixture's registered roots.
    pub(crate) filesystem: Arc<dyn Subvolumes>,
}

/// A task close joins before the mux shuts down: a run, which close also cancels through its
/// state, or a routed tool call, which finishes on its own within its cancel token's bounds.
struct TrackedTask {
    run: Option<Arc<RunState>>,
    task: JoinHandle<()>,
}

struct SessionState {
    backend: Option<Backend>,
    tasks: HashMap<Id, TrackedTask>,
    principals: HashMap<String, watch::Receiver<bool>>,
    /// Every capability decision of this mux's shells; close takes, drains and releases it.
    policy_log: Option<Arc<PolicyLog>>,
}

pub(crate) struct Session {
    seed: PathBuf,
    runtime: Handle,
    state: Mutex<SessionState>,
    closed: watch::Sender<Option<CloseResult>>,
}

impl Session {
    pub(crate) fn new(
        seed: PathBuf,
        filesystem: Arc<dyn Subvolumes>,
        sandbox_policy: SandboxPolicy,
        shell_policy: Arc<dyn marsh_core::Policy>,
        policy_log: Option<Arc<PolicyLog>>,
        create_mux: impl FnOnce(MuxProfile, Arc<Mutex<Frontend>>) -> Result<Arc<ShellMux>, MuxError>,
    ) -> Result<Arc<Self>, String> {
        let runtime = Handle::current();
        let frontend = Arc::new(Mutex::new(Frontend::new(24, 80)));
        let profile = MuxProfile {
            environment: ShellEnvironment::default(),
            builtins: HashMap::default(),
            sandbox_policy,
            shell_policy,
            policy_observer: policy_log.clone().map(|log| {
                Arc::new(PolicyObserver::new(move |event, decision| {
                    log.observe(event, decision);
                }))
            }),
        };
        // Leases nothing: the seed's exclusive lease, its log recovery and its one validator
        // are opened by the first shell whose working directory names it. That source-domain
        // state is marsh's, shared across every live shell drawing on the same backend (and,
        // in a CopyTree build, a second mux over that backend), never retained here.
        let mux = create_mux(profile, Arc::clone(&frontend)).map_err(|error| error.to_string())?;
        let (closed, _) = watch::channel(None);
        Ok(Arc::new(Self {
            seed,
            runtime,
            state: Mutex::new(SessionState {
                backend: Some(Backend {
                    mux,
                    frontend,
                    filesystem,
                }),
                tasks: HashMap::new(),
                principals: HashMap::new(),
                policy_log,
            }),
            closed,
        }))
    }

    pub(crate) fn seed(&self) -> &Path {
        &self.seed
    }

    /// Resolves `cwd` exactly as an operation at it would, against this session's own seed and
    /// filesystem: a missing or non-directory path, one outside the seed, or one inside a nested
    /// or different seed is refused.
    pub(crate) async fn validate_cwd(&self, cwd: String) -> Result<(), String> {
        let filesystem = {
            let session = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            let backend = session
                .backend
                .as_ref()
                .ok_or_else(|| "ShellMux session is closed".to_string())?;
            Arc::clone(&backend.filesystem)
        };
        let seed = self.seed.clone();
        self.runtime
            .spawn_blocking(move || working_directory(&cwd, &seed, filesystem.as_ref()))
            .await
            .map_err(|error| format!("Cannot resolve working directory: {error}"))?
            .map(|_| ())
    }

    pub(crate) fn start(
        self: &Arc<Self>,
        options: NativeRunOptions,
        owner: Option<Principal>,
        callback: OutputCallback,
    ) -> Result<Arc<RunState>, String> {
        let timeout = native_timeout(options.timeout_ms)?;
        let (state, result_sender) = RunState::pending();
        let route = OutputRoute::new(callback);
        let runtime = self.runtime.clone();
        let seed = self.seed.clone();
        let principal = options.principal.clone();
        let run_state = Arc::clone(&state);
        self.admit(principal, &state, result_sender, move |backend| {
            RunTask {
                backend,
                runtime,
                seed,
                options,
                owner,
                state: run_state,
                route,
                timeout,
            }
            .run()
        })?;
        Ok(state)
    }

    /// Launches one persistent process: `options.command` with its arguments through the managed
    /// `exec` builtin, in a pipe shell that always takes the managed route. The receiver answers
    /// once the command is admitted, or with its final, drained failure.
    pub(crate) fn spawn(
        self: &Arc<Self>,
        options: NativeProcessOptions,
        owner: Option<Principal>,
        stdout: OutputCallback,
        stderr: OutputCallback,
    ) -> Result<(Arc<ProcessState>, Admitted), String> {
        let NativeProcessOptions {
            command,
            args,
            cwd,
            principal,
            env,
        } = options;
        let line = ExecLine::new(&command, args.as_deref().unwrap_or_default())?;
        let (run, result_sender) = RunState::pending();
        let (process, io) = process_channels(Arc::clone(&run));
        let (admission, admitted) = Admission::new();
        let route = OutputRoute::separate(stdout, stderr);
        let runtime = self.runtime.clone();
        let seed = self.seed.clone();
        let shell = ShellId::from(principal.clone());
        let task_state = Arc::clone(&run);
        self.admit(principal, &run, result_sender, move |backend| {
            ProcessTask {
                backend,
                runtime,
                seed,
                cwd,
                principal: shell,
                owner,
                env,
                line,
                state: task_state,
                route,
                io,
            }
            .run(admission)
        })?;
        Ok((process, admitted))
    }

    /// Registers one run's worker in the task table and its principal's queue. Admission and
    /// registration share this lock with begin_close: the worker may finish immediately, but
    /// cannot remove itself before insertion, and close always joins it.
    fn admit<Work>(
        self: &Arc<Self>,
        principal: String,
        state: &Arc<RunState>,
        result_sender: watch::Sender<Option<RunResult>>,
        work: impl FnOnce(Backend) -> Work,
    ) -> Result<(), String>
    where
        Work: Future<Output = RunResult> + Send + 'static,
    {
        let mut session = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let backend = session
            .backend
            .as_ref()
            .ok_or_else(|| "ShellMux session is closed".to_string())?
            .clone();
        let (release, released) = watch::channel(false);
        let predecessor = session.principals.insert(principal, released);
        let run = work(backend);
        let owner = Arc::downgrade(self);
        let task = self.runtime.spawn(async move {
            // Linkage happened synchronously in admit(), not when this worker
            // happened to be polled. Even an aborted queued run must join its
            // predecessor before releasing the next run in that principal's queue.
            let result = match predecessor_released(predecessor).await {
                Ok(()) => {
                    // The worker drops every mux/callback reference before releasing
                    // this fence or publishing the result.
                    let result = run.await;
                    release.send_replace(true);
                    result
                }
                Err(error) => {
                    drop(run);
                    // Dropping an unreleased sender poisons the remaining queue:
                    // a lost task is not proof that its job was reclaimed.
                    Err(error.into())
                }
            };
            result_sender.send_replace(Some(result));
            if let Some(owner) = owner.upgrade() {
                owner
                    .state
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .tasks
                    .remove(&tokio::task::id());
            }
        });
        session.tasks.insert(
            task.id(),
            TrackedTask {
                run: Some(Arc::clone(state)),
                task,
            },
        );
        Ok(())
    }

    /// Runs `operation` as one call of `tool`, acting as `owner`, in a transient shell at `cwd`,
    /// routed by the mux's policy. A call already accepted when the session begins closing still
    /// completes: close joins it before the mux shuts down.
    pub(crate) async fn run_tool<R: Send + 'static>(
        self: &Arc<Self>,
        cwd: String,
        owner: Option<Principal>,
        tool: JuncoTool,
        operation: impl FnOnce(&BuiltinContext) -> R + Send + 'static,
    ) -> Result<R, RoutedError> {
        let receipt = {
            // Admission and task registration share this lock with begin_close, as runs do.
            let mut session = self.state.lock().unwrap_or_else(PoisonError::into_inner);
            let backend = session
                .backend
                .as_ref()
                .ok_or_else(|| "ShellMux session is closed".to_string())?
                .clone();
            let runtime = self.runtime.clone();
            let seed = self.seed.clone();
            let this = Arc::downgrade(self);
            let (sender, receipt) = oneshot::channel();
            let task = self.runtime.spawn(async move {
                let filesystem = Arc::clone(&backend.filesystem);
                let result = match runtime
                    .spawn_blocking(move || working_directory(&cwd, &seed, filesystem.as_ref()))
                    .await
                {
                    Ok(Ok(directory)) => backend
                        .mux
                        .run_tool(&directory, owner, tool, operation)
                        .await
                        .map_err(tool_error),
                    Ok(Err(error)) => Err(error.into()),
                    Err(error) => Err(format!("Cannot resolve working directory: {error}").into()),
                };
                drop(backend);
                let _ = sender.send(result);
                if let Some(this) = this.upgrade() {
                    this
                        .state
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .tasks
                        .remove(&tokio::task::id());
                }
            });
            session
                .tasks
                .insert(task.id(), TrackedTask { run: None, task });
            receipt
        };
        receipt
            .await
            .map_err(|_| "ShellMux tool task ended without a result".to_string())?
    }

    pub(crate) fn begin_close(self: &Arc<Self>) -> watch::Receiver<Option<CloseResult>> {
        let mut session = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let completion = self.closed.subscribe();
        let Some(backend) = session.backend.take() else {
            return completion;
        };
        let tasks = std::mem::take(&mut session.tasks);
        session.principals.clear();
        for run in tasks.values().filter_map(|tracked| tracked.run.as_ref()) {
            run.abort();
        }
        let closed = self.closed.clone();
        let policy_log = session.policy_log.take();
        // No caller owns this cleanup future, so cancelling a close promise cannot
        // cancel teardown or let another close return ahead of it.
        self.runtime.spawn(async move {
            let mut failure = None;
            for tracked in tasks.into_values() {
                let kind = if tracked.run.is_some() { "run" } else { "tool" };
                if let Err(error) = tracked.task.await {
                    remember_error(
                        &mut failure,
                        format!("ShellMux {kind} task failed: {error}"),
                    );
                }
            }
            if let Err(error) = backend.mux.shutdown().await {
                remember_error(&mut failure, error.to_string());
            }
            // shutdown detaches the frontend; dropping both remaining strong
            // references releases its callbacks. The source-domain state shells opened
            // through is marsh's, shared with any other live shell or mux over the same
            // backend, and was never an exclusive resource this idle session retained.
            drop(backend);
            // Every producer is joined; the last decision is enqueued. Drain it before release.
            if let Some(log) = policy_log {
                let drained = log.drained().await;
                if let Err(error) = drained {
                    failure = Some(match failure {
                        Some(shutdown) => format!("{shutdown}\n{error}"),
                        None => error,
                    });
                }
            }
            closed.send_replace(Some(failure.map_or(Ok(()), Err)));
        });
        completion
    }
}

/// Execution-only ownership, deliberately separate from the public RunState.
struct RunTask {
    backend: Backend,
    runtime: Handle,
    seed: PathBuf,
    options: NativeRunOptions,
    owner: Option<Principal>,
    state: Arc<RunState>,
    route: Arc<OutputRoute>,
    timeout: Option<Duration>,
}

impl RunTask {
    async fn run(self) -> RunResult {
        let Self {
            backend,
            runtime,
            seed,
            options,
            owner,
            state,
            route,
            timeout,
        } = self;
        let NativeRunOptions {
            command,
            cwd,
            principal: principal_name,
            env,
            timeout_ms: _,
        } = options;

        if state.is_cancelled() {
            return Ok(cancelled_result(None, false));
        }
        let filesystem = Arc::clone(&backend.filesystem);
        let directory = runtime
            .spawn_blocking(move || working_directory(&cwd, &seed, filesystem.as_ref()))
            .await
            .map_err(|error| format!("Cannot resolve working directory: {error}"))??;
        if state.is_cancelled() {
            return Ok(cancelled_result(None, false));
        }
        let environment = shell_environment(env)?;
        if state.is_cancelled() {
            return Ok(cancelled_result(None, false));
        }
        // Never race this future against cancellation: open_shell leases the seed and builds
        // resources, and dropping it could orphan both. A fresh pipe shell every call, so a
        // durable principal's variables never leak from one command into the next.
        let shell = backend
            .mux
            .open_shell(
                &directory,
                Some(ShellId::from(principal_name)),
                SpawnOptions {
                    io: JobIo::Pipes,
                    environment: Some(environment),
                    policy_owner: owner,
                    ..Default::default()
                },
            )
            .await
            .map_err(|error| error.to_string())?;
        // Register before the route's drain fence can be awaited: only a registered route ever
        // observes FrontendEvent::Closed, and run_job's first act is the cancellation check.
        backend
            .frontend
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .register(shell.sandbox().uid.clone(), Arc::clone(&route));
        let result = run_job(&shell, &state, &route, &command, timeout).await;
        backend
            .frontend
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&shell.sandbox().uid);
        result
    }
}

async fn predecessor_released(predecessor: Option<watch::Receiver<bool>>) -> Result<(), String> {
    if let Some(mut predecessor) = predecessor {
        predecessor
            .wait_for(|released| *released)
            .await
            .map_err(|_| "ShellMux preceding run ended before releasing its job".to_string())?;
    }
    Ok(())
}

pub(crate) enum StopCause {
    Cancelled,
    TimedOut,
    Failed(RoutedError),
}

enum RunEvent {
    Completed(RunResult),
    Stop(StopCause),
}

async fn run_job(
    shell: &Shell,
    state: &RunState,
    route: &OutputRoute,
    text: &str,
    timeout: Option<Duration>,
) -> RunResult {
    if state.is_cancelled() {
        return stop_and_settle(shell, None, route, StopCause::Cancelled).await;
    }
    if let Err(error) = shell.close_input().await {
        return stop_and_settle(
            shell,
            None,
            route,
            StopCause::Failed(error.to_string().into()),
        )
        .await;
    }
    if let Some(error) = route.failure() {
        return stop_and_settle(shell, None, route, StopCause::Failed(error.into())).await;
    }
    // Admission is the deadline boundary. Neither discovering the seed, waiting for this
    // principal, canonicalization nor shell construction consumes it.
    let deadline = match timeout {
        Some(duration) => match Instant::now().checked_add(duration) {
            Some(deadline) => Some(deadline),
            None => {
                return stop_and_settle(
                    shell,
                    None,
                    route,
                    StopCause::Failed(
                        "Invalid native timeoutMs: duration is out of range"
                            .to_string()
                            .into(),
                    ),
                )
                .await;
            }
        },
        None => None,
    };
    if state.is_cancelled() {
        return stop_and_settle(shell, None, route, StopCause::Cancelled).await;
    }
    // The sender goes into the completion branch and the receiver stays here. A branch that is
    // never polled drops the sender and closes the channel; a polled one has already handed the
    // sender to marsh's owned command task, so dropping the answer stops nothing.
    let (accepted, receipt) = oneshot::channel();
    let event = tokio::select! {
        biased;
        error = route.failed() => RunEvent::Stop(StopCause::Failed(error.into())),
        _ = state.cancelled() => RunEvent::Stop(StopCause::Cancelled),
        result = completed_job(shell, route, text, accepted) => RunEvent::Completed(result),
        _ = deadline_elapsed(deadline) => RunEvent::Stop(StopCause::TimedOut),
    };
    // The unselected completion future is already dropped here, so its receipt channel is
    // settled one way or the other before cleanup consults it.
    match event {
        RunEvent::Completed(Ok(result)) => Ok(result),
        // A policy, admission or IO failure still owes an idle shell and pending callbacks.
        RunEvent::Completed(Err(error)) => {
            stop_and_settle(shell, Some(receipt), route, StopCause::Failed(error)).await
        }
        RunEvent::Stop(cause) => stop_and_settle(shell, Some(receipt), route, cause).await,
    }
}

async fn completed_job(
    shell: &Shell,
    route: &OutputRoute,
    text: &str,
    accepted: oneshot::Sender<CommandHandle>,
) -> RunResult {
    // Ok means a published result and nothing else; a nonzero exit code is a process status,
    // not a refusal, and is published like any other.
    let completion = shell
        .run_command(
            text,
            CommandOptions {
                on_accept: Some(accepted),
                ..Default::default()
            },
        )
        .await
        .map_err(run_error)?;
    published_result(shell, route, &completion).await
}

/// The answer for a command Marsh published: its shell's end, every queued output callback, and
/// the program's own exit status.
pub(crate) async fn published_result(
    shell: &Shell,
    route: &OutputRoute,
    completion: &CommandCompletion,
) -> RunResult {
    let end = shell
        .wait_closed()
        .await
        .map_err(|error| error.to_string())?;
    // wait_closed sends the closure watch before the lifecycle task emits FrontendEvent::Closed,
    // so neither it nor shutdown acknowledges a pending JavaScript callback. Only the route does.
    route.drained().await?;
    if let Some(error) = &end.error {
        return Err(error.to_string().into());
    }
    let exit_code = completion
        .exit_code()
        .ok_or_else(|| "Marsh published a command without a process exit status".to_string())?;
    Ok(NativeRunResult {
        exit_code: Some(exit_code),
        cancelled: false,
        timed_out: false,
    })
}

pub(crate) async fn stop_and_settle(
    shell: &Shell,
    accepted: Option<oneshot::Receiver<CommandHandle>>,
    route: &OutputRoute,
    cause: StopCause,
) -> RunResult {
    let mut failure = None;
    if !shell.is_closed() {
        match shell.stop(true).await {
            Ok(()) | Err(MuxError::StaleJob(_)) => {}
            Err(error) => remember_error(&mut failure, error.to_string()),
        }
    }
    // Once cleanup starts it is never selected away. All callbacks are joined even when one
    // failed, and every admitted command keeps its own verdict.
    let completion = match accepted {
        Some(receipt) => match receipt.await {
            Ok(handle) => match handle.wait().await {
                Ok(completion) => Some(completion),
                Err(error) => {
                    remember_error(&mut failure, error.to_string());
                    None
                }
            },
            // A closed channel means no line was ever admitted through this submission. There
            // is no receipt to wait for, and success or an exit code must not be invented.
            Err(_) => None,
        },
        None => None,
    };
    match shell.wait_closed().await {
        Ok(end) => {
            if let Some(error) = &end.error {
                remember_error(&mut failure, error.to_string());
            }
        }
        Err(error) => remember_error(&mut failure, error.to_string()),
    }
    if let Err(error) = route.drained().await {
        remember_error(&mut failure, error);
    }
    match cause {
        StopCause::Failed(error) => Err(match failure {
            Some(cleanup) => error.with_cleanup(cleanup),
            None => error,
        }),
        StopCause::Cancelled | StopCause::TimedOut => {
            if let Some(error) = failure {
                return Err(error.into());
            }
            // The receipt's own code: JobEnd.completion can miss it when a concurrent stop
            // reclaimed the shell during finalization.
            let exit_code = completion
                .as_ref()
                .and_then(|completion| completion.exit_code());
            Ok(cancelled_result(
                exit_code,
                matches!(cause, StopCause::TimedOut),
            ))
        }
    }
}

/// Upstream already decided publication; only its `Denied` kind is classified as a denial.
pub(crate) fn run_error(error: RunError) -> RoutedError {
    if let Some(completion) = error.completion()
        && let Err(cause) = completion.result.as_ref()
        && let Some(denial) = denial(cause)
    {
        return denial;
    }
    RoutedError::Other(error.to_string())
}

/// A receipt's verdict as a run's: only a published completion is `Ok`. An unpublished one —
/// denied, stale, discarded by cancellation, or failed — and a lost answer are failures, with a
/// denial classified as one.
pub(crate) fn completion_result(
    verdict: Result<Arc<CommandCompletion>, WaitError>,
) -> Result<Arc<CommandCompletion>, RoutedError> {
    let completion = verdict.map_err(|error| RoutedError::Other(error.to_string()))?;
    if let Err(cause) = completion.result.as_ref() {
        return Err(denial(cause).unwrap_or_else(|| RoutedError::Other(cause.to_string())));
    }
    Ok(completion)
}

/// Exported variables replacing a shell's inherited and profile environment.
pub(crate) fn shell_environment(env: HashMap<String, String>) -> Result<ShellEnvironment, String> {
    let mut environment = ShellEnvironment::new();
    for (name, value) in env {
        let mut variable = ShellVariable::new(value);
        variable.export();
        environment
            .set_global(name, variable)
            .map_err(|error| error.to_string())?;
    }
    Ok(environment)
}

/// A routed tool call's failure, with a denial classified like a run's.
fn tool_error(error: MuxError) -> RoutedError {
    if let MuxError::Marsh(cause) = &error
        && let Some(denial) = denial(cause)
    {
        return denial;
    }
    RoutedError::Other(error.to_string())
}

/// The denial `cause` reports, or `None` for any other failure.
fn denial(cause: &ShellError) -> Option<RoutedError> {
    matches!(cause.kind(), ShellErrorKind::Denied { .. })
        .then(|| RoutedError::Denied(format!("Marsh policy denied publication: {cause}")))
}

pub(crate) fn cancelled_result(exit_code: Option<i32>, timed_out: bool) -> NativeRunResult {
    NativeRunResult {
        exit_code,
        cancelled: !timed_out,
        timed_out,
    }
}

fn remember_error(failure: &mut Option<String>, error: String) {
    if failure.is_none() {
        *failure = Some(error);
    }
}

async fn deadline_elapsed(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => pending::<()>().await,
    }
}

fn native_timeout(milliseconds: Option<f64>) -> Result<Option<Duration>, String> {
    let Some(milliseconds) = milliseconds else {
        return Ok(None);
    };
    if !milliseconds.is_finite() || milliseconds <= 0.0 {
        return Err(
            "Invalid native timeoutMs: must be a finite positive number of milliseconds"
                .to_string(),
        );
    }
    let duration = Duration::try_from_secs_f64(milliseconds / 1000.0)
        .map_err(|_| "Invalid native timeoutMs: duration is out of range".to_string())?;
    if Instant::now().checked_add(duration).is_none() {
        return Err("Invalid native timeoutMs: duration is out of range".to_string());
    }
    Ok(Some(duration))
}

pub(crate) fn working_directory(
    cwd: &str,
    seed: &Path,
    filesystem: &dyn Subvolumes,
) -> Result<PathBuf, String> {
    let directory = std::fs::canonicalize(cwd)
        .map_err(|error| format!("Cannot resolve working directory {cwd}: {error}"))?;
    let metadata = std::fs::metadata(&directory)
        .map_err(|error| format!("Cannot inspect working directory {cwd}: {error}"))?;
    if !metadata.is_dir() {
        return Err(format!("Working directory is not a directory: {cwd}"));
    }
    if directory.strip_prefix(seed).is_err() {
        return Err(format!(
            "Working directory {} is outside ShellMux seed {}",
            directory.display(),
            seed.display()
        ));
    }
    if directory.to_str().is_none() {
        return Err(format!(
            "Working directory is not valid UTF-8: {}",
            directory.display()
        ));
    }
    // Before a shell exists: a multi-seed mux would otherwise silently lease a nested seed for
    // a session that was opened over exactly one.
    let (layer, _) = PersistenceLayer::discover(&directory, filesystem)
        .map_err(|error| format!("Cannot resolve working directory {cwd}: {error}"))?;
    if layer.seed != seed {
        return Err(format!(
            "Working directory {cwd} belongs to a different ShellMux seed {} (expected {})",
            layer.seed.display(),
            seed.display()
        ));
    }
    Ok(directory)
}
