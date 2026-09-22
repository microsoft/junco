use std::collections::HashMap;
use std::future::pending;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use brush_core::{ShellVariable, env::ShellEnvironment};
use marsh_core::shellmux::{
    CommandCompletion, CommandHandle, CommandOptions, JobIo, MuxError, MuxProfile, ShellFrontend,
    ShellId, ShellMux, SpawnOptions, Spawned,
};
use marsh_core::{MarshExecutor, Outcome, PolicyValidator};
use tokio::runtime::Handle;
use tokio::sync::watch;
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
        let mut result = self.result.clone();
        loop {
            if let Some(value) = result.borrow_and_update().clone() {
                return value;
            }
            result
                .changed()
                .await
                .map_err(|_| "ShellMux run task ended without a result".to_string())?;
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
    pub(crate) fn new(executor: MarshExecutor) -> Result<Arc<Self>, String> {
        let seed = executor
            .seed()
            .ok_or_else(|| "ShellMux requires an executor with an open seed".to_string())?
            .to_path_buf();
        let runtime = Handle::current();
        let frontend = Arc::new(Mutex::new(Frontend::new(24, 80)));
        let validator = Arc::new(Mutex::new(PolicyValidator::new()));
        let mux = ShellMux::new(
            executor,
            validator,
            MuxProfile::default(),
            Arc::clone(&frontend),
        )
        .map_err(|error| error.to_string())?;
        let (closed, _) = watch::channel(None);
        Ok(Arc::new(Self {
            seed,
            runtime,
            state: Mutex::new(SessionState {
                backend: Some(Backend { mux, frontend }),
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
        let directory = runtime
            .spawn_blocking(move || working_directory(&cwd, &seed))
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
        // Never race this future against cancellation: spawn admits its job
        // before building resources, and dropping it could orphan that job.
        let job = backend
            .mux
            .spawn(
                &directory,
                Some(ShellId::durable(principal_name)),
                None,
                SpawnOptions {
                    io: JobIo::Pipes,
                    environment: Some(environment),
                },
            )
            .await
            .map_err(|error| error.to_string())?;
        backend
            .frontend
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .register(job.sandbox().uid.clone(), Arc::clone(&route));
        let result = run_job(&backend.mux, &job, &state, &route, &command, timeout).await;
        backend
            .frontend
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&job.sandbox().uid);
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
    Completed(Result<Arc<CommandCompletion>, String>),
    Stop(StopCause),
}

async fn run_job(
    mux: &Arc<ShellMux>,
    job: &Spawned,
    state: &RunState,
    route: &OutputRoute,
    text: &str,
    timeout: Option<Duration>,
) -> RunResult {
    if state.is_cancelled() {
        return stop_and_settle(mux, job, None, route, StopCause::Cancelled).await;
    }
    if let Err(error) = mux.close_input(job).await {
        return stop_and_settle(mux, job, None, route, StopCause::Failed(error.to_string())).await;
    }
    if let Some(error) = route.failure() {
        return stop_and_settle(mux, job, None, route, StopCause::Failed(error)).await;
    }
    // Admission is the deadline boundary. Neither opening the mux, waiting for
    // this principal, canonicalization nor snapshot construction consumes it.
    let deadline = match timeout {
        Some(duration) => match Instant::now().checked_add(duration) {
            Some(deadline) => Some(deadline),
            None => {
                return stop_and_settle(
                    mux,
                    job,
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
        return stop_and_settle(mux, job, None, route, StopCause::Cancelled).await;
    }
    // start_in is also allowed to finish once entered. A cancellation recorded
    // during admission is observed immediately afterwards by the watch below.
    let command = match mux.start_in(job, text, CommandOptions::default()).await {
        Ok(command) => command,
        Err(error) => {
            return stop_and_settle(mux, job, None, route, StopCause::Failed(error.to_string()))
                .await;
        }
    };
    let event = tokio::select! {
        biased;
        error = route.failed() => RunEvent::Stop(StopCause::Failed(error)),
        _ = state.cancelled() => RunEvent::Stop(StopCause::Cancelled),
        result = completed_job(&command, job, route) => RunEvent::Completed(result),
        _ = deadline_elapsed(deadline) => RunEvent::Stop(StopCause::TimedOut),
    };
    match event {
        RunEvent::Completed(Ok(completion)) => published_result(&completion),
        RunEvent::Completed(Err(error)) => {
            stop_and_settle(mux, job, Some(&command), route, StopCause::Failed(error)).await
        }
        RunEvent::Stop(cause) => stop_and_settle(mux, job, Some(&command), route, cause).await,
    }
}

async fn completed_job(
    command: &CommandHandle,
    job: &Spawned,
    route: &OutputRoute,
) -> Result<Arc<CommandCompletion>, String> {
    let completion = command.wait().await.map_err(|error| error.to_string())?;
    let end = job.wait_closed().await.map_err(|error| error.to_string())?;
    // wait_closed can precede the frontend's final output/Closed observation at
    // this marsh revision. Only the route provides the JavaScript output fence.
    route.drained().await?;
    if let Some(error) = &end.error {
        return Err(error.to_string());
    }
    Ok(completion)
}

async fn stop_and_settle(
    mux: &Arc<ShellMux>,
    job: &Spawned,
    command: Option<&CommandHandle>,
    route: &OutputRoute,
    cause: StopCause,
) -> RunResult {
    let mut failure = None;
    if !job.is_closed() {
        match mux.stop(job, true).await {
            Ok(()) | Err(MuxError::StaleJob(_)) => {}
            Err(error) => remember_error(&mut failure, error.to_string()),
        }
    }
    // Once cleanup starts it is never selected away. All callbacks are joined
    // even when one failed, and every admitted command keeps its own verdict.
    let completion = match command {
        Some(command) => match command.wait().await {
            Ok(completion) => Some(completion),
            Err(error) => {
                remember_error(&mut failure, error.to_string());
                None
            }
        },
        None => None,
    };
    match job.wait_closed().await {
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

fn published_result(completion: &CommandCompletion) -> RunResult {
    match completion.outcome.as_ref() {
        Ok(Outcome::Published { .. }) => {
            let exit_code = completion.exit_code.ok_or_else(|| {
                "Marsh published a command without a process exit status".to_string()
            })?;
            Ok(NativeRunResult {
                exit_code: Some(exit_code),
                cancelled: false,
                timed_out: false,
            })
        }
        Ok(Outcome::Denied { denials, .. }) => Err(format!(
            "Marsh policy denied publication: {}",
            denials
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join("\n")
        )),
        Ok(Outcome::Stale { stale, .. }) => Err(format!("Marsh snapshot is stale: {stale:?}")),
        Ok(Outcome::Discarded) => Err("Marsh discarded a command without cancellation".to_string()),
        Ok(Outcome::Detached) => {
            Err("Marsh command unexpectedly ran without an attached seed".to_string())
        }
        Err(error) => Err(error.to_string()),
    }
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

fn working_directory(cwd: &str, seed: &Path) -> Result<String, String> {
    let directory = std::fs::canonicalize(cwd)
        .map_err(|error| format!("Cannot resolve working directory {cwd}: {error}"))?;
    let metadata = std::fs::metadata(&directory)
        .map_err(|error| format!("Cannot inspect working directory {cwd}: {error}"))?;
    if !metadata.is_dir() {
        return Err(format!("Working directory is not a directory: {cwd}"));
    }
    let relative = directory.strip_prefix(seed).map_err(|_| {
        format!(
            "Working directory {} is outside ShellMux seed {}",
            directory.display(),
            seed.display()
        )
    })?;
    relative.to_str().map(str::to_owned).ok_or_else(|| {
        format!(
            "Working directory is not valid UTF-8: {}",
            directory.display()
        )
    })
}
