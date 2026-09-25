use std::collections::HashMap;
use std::future::pending;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use brush_core::{ShellVariable, env::ShellEnvironment};
use marsh_btrfs::{PersistenceLayer, Subvolumes};
use marsh_core::Outcome;
use marsh_core::policy::Principal;
use marsh_core::shellmux::{
    CommandHandle, CommandOptions, JobIo, MuxError, MuxProfile, RunError, Shell, ShellFrontend,
    ShellMux, SpawnOptions,
};
use tokio::runtime::Handle;
use tokio::sync::{oneshot, watch};
use tokio::task::{Id, JoinHandle};
use tokio::time::Instant;

use crate::frontend::{Frontend, OutputCallback, OutputRoute};
use crate::{NativeRunOptions, NativeRunResult};

type RunResult = Result<NativeRunResult, String>;
type CloseResult = Result<(), String>;

/// A retained JavaScript run owns only its cancellation signal and eventual result.
/// In particular, it cannot keep the seed lease or a JavaScript callback alive.
pub(crate) struct RunState {
    cancellation: watch::Sender<bool>,
    result: watch::Receiver<Option<RunResult>>,
}

impl RunState {
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
            None => Err("ShellMux run task ended without a result".to_string()),
        }
    }

    fn is_cancelled(&self) -> bool {
        *self.cancellation.borrow()
    }

    async fn cancelled(&self) {
        let mut cancellation = self.cancellation.subscribe();
        let _ = cancellation.wait_for(|cancelled| *cancelled).await;
    }
}

#[derive(Clone)]
struct Backend {
    mux: Arc<ShellMux>,
    frontend: Arc<Mutex<Frontend>>,
    /// The one filesystem this session discovers seeds through. A second instance would
    /// know none of a CopyTree fixture's registered roots.
    filesystem: Arc<dyn Subvolumes>,
}

struct TrackedRun {
    state: Arc<RunState>,
    task: JoinHandle<()>,
}

struct SessionState {
    backend: Option<Backend>,
    closing: bool,
    runs: HashMap<Id, TrackedRun>,
    principals: HashMap<String, watch::Receiver<bool>>,
}

pub(crate) struct Session {
    seed: PathBuf,
    runtime: Handle,
    state: Mutex<SessionState>,
    closed: watch::Sender<Option<CloseResult>>,
}

impl Session {
    pub(crate) fn new(seed: PathBuf, filesystem: Arc<dyn Subvolumes>) -> Result<Arc<Self>, String> {
        let runtime = Handle::current();
        let frontend = Arc::new(Mutex::new(Frontend::new(24, 80)));
        // Leases nothing: the seed's exclusive lease, its log recovery and its one validator
        // are opened by the first shell whose working directory names it.
        let mux = ShellMux::new_with(
            MuxProfile::default(),
            Arc::clone(&frontend),
            Arc::clone(&filesystem),
        )
        .map_err(|error| error.to_string())?;
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
                closing: false,
                runs: HashMap::new(),
                principals: HashMap::new(),
            }),
            closed,
        }))
    }

    pub(crate) fn seed(&self) -> &Path {
        &self.seed
    }

    pub(crate) fn start(
        self: &Arc<Self>,
        options: NativeRunOptions,
        callback: OutputCallback,
    ) -> Result<Arc<RunState>, String> {
        // Admission and task registration share this lock with begin_close. The
        // worker may finish immediately, but cannot remove itself before insertion.
        let mut session = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if session.closing {
            return Err("ShellMux session is closed".to_string());
        }
        let backend = session
            .backend
            .as_ref()
            .ok_or_else(|| "ShellMux session is closed".to_string())?
            .clone();
        let timeout = native_timeout(options.timeout_ms)?;
        let (release, released) = watch::channel(false);
        let predecessor = session
            .principals
            .insert(options.principal.clone(), released);
        let (cancellation, _) = watch::channel(false);
        let (result_sender, result) = watch::channel(None);
        let state = Arc::new(RunState {
            cancellation,
            result,
        });
        let route = OutputRoute::new(callback);
        let run = RunTask {
            backend,
            runtime: self.runtime.clone(),
            seed: self.seed.clone(),
            options,
            state: Arc::clone(&state),
            route,
            timeout,
        };
        let owner = Arc::downgrade(self);
        let task = self.runtime.spawn(async move {
            // Linkage happened synchronously in start(), not when this worker
            // happened to be polled. Even an aborted queued run must join its
            // predecessor before releasing the next run in that principal's queue.
            let result = match predecessor_released(predecessor).await {
                Ok(()) => {
                    // run() drops every mux/callback reference before releasing
                    // this fence or publishing the result.
                    let result = run.run().await;
                    release.send_replace(true);
                    result
                }
                Err(error) => {
                    drop(run);
                    // Dropping an unreleased sender poisons the remaining queue:
                    // a lost task is not proof that its job was reclaimed.
                    Err(error)
                }
            };
            result_sender.send_replace(Some(result));
            if let Some(owner) = owner.upgrade() {
                owner
                    .state
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .runs
                    .remove(&tokio::task::id());
            }
        });
        session.runs.insert(
            task.id(),
            TrackedRun {
                state: Arc::clone(&state),
                task,
            },
        );
        Ok(state)
    }

    pub(crate) fn begin_close(self: &Arc<Self>) -> watch::Receiver<Option<CloseResult>> {
        let mut session = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let completion = self.closed.subscribe();
        if session.closing {
            return completion;
        }
        session.closing = true;
        let runs = std::mem::take(&mut session.runs);
        let backend = session.backend.take();
        session.principals.clear();
        for run in runs.values() {
            run.state.abort();
        }
        let closed = self.closed.clone();
        // No caller owns this cleanup future, so cancelling a close promise cannot
        // cancel teardown or let another close return ahead of it.
        self.runtime.spawn(async move {
            let mut failure = None;
            for run in runs.into_values() {
                if let Err(error) = run.task.await {
                    remember_error(&mut failure, format!("ShellMux run task failed: {error}"));
                }
            }
            if let Some(backend) = backend {
                if let Err(error) = backend.mux.shutdown().await {
                    remember_error(&mut failure, error.to_string());
                }
                // shutdown detaches the frontend; dropping both remaining strong
                // references releases its callbacks and the executor's seed lease.
                drop(backend);
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
        let mut environment = ShellEnvironment::new();
        for (name, value) in env {
            let mut variable = ShellVariable::new(value);
            variable.export();
            environment
                .set_global(name, variable)
                .map_err(|error| error.to_string())?;
        }
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
                Some(Principal::from(principal_name)),
                SpawnOptions {
                    io: JobIo::Pipes,
                    environment: Some(environment),
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

enum StopCause {
    Cancelled,
    TimedOut,
    Failed(String),
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
        return stop_and_settle(shell, None, route, StopCause::Failed(error.to_string())).await;
    }
    if let Some(error) = route.failure() {
        return stop_and_settle(shell, None, route, StopCause::Failed(error)).await;
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
                        "Invalid native timeoutMs: duration is out of range".to_string(),
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
        error = route.failed() => RunEvent::Stop(StopCause::Failed(error)),
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
    // Ok means Outcome::Published and nothing else; a nonzero exit code is a process status,
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
    let end = shell
        .wait_closed()
        .await
        .map_err(|error| error.to_string())?;
    // wait_closed sends the closure watch before the lifecycle task emits FrontendEvent::Closed,
    // so neither it nor shutdown acknowledges a pending JavaScript callback. Only the route does.
    route.drained().await?;
    if let Some(error) = &end.error {
        return Err(error.to_string());
    }
    let exit_code = completion
        .exit_code
        .ok_or_else(|| "Marsh published a command without a process exit status".to_string())?;
    Ok(NativeRunResult {
        exit_code: Some(exit_code),
        cancelled: false,
        timed_out: false,
    })
}

async fn stop_and_settle(
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
            Some(cleanup) if cleanup != error => format!("{error}\nShellMux cleanup: {cleanup}"),
            _ => error,
        }),
        StopCause::Cancelled | StopCause::TimedOut => {
            if let Some(error) = failure {
                return Err(error);
            }
            // The receipt's own code: JobEnd.completion can miss it when a concurrent stop
            // reclaimed the shell during finalization.
            let exit_code = completion
                .as_ref()
                .and_then(|completion| completion.exit_code);
            Ok(cancelled_result(
                exit_code,
                matches!(cause, StopCause::TimedOut),
            ))
        }
    }
}

/// Upstream already decided publication; this only keeps a denial's diagnostics actionable.
fn run_error(error: RunError) -> String {
    let RunError::Policy(denied) = &error else {
        // Display preserves the infrastructure cause for admission, unpublished and lost answers.
        return error.to_string();
    };
    let mut message = format!("Marsh policy denied publication: {denied}");
    if let Ok(Outcome::Denied { denials, .. }) = denied.completion().outcome.as_ref() {
        for denial in denials {
            message.push('\n');
            message.push_str(&denial.to_string());
        }
    }
    message
}

fn cancelled_result(exit_code: Option<i32>, timed_out: bool) -> NativeRunResult {
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

fn working_directory(
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
