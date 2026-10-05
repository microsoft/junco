//! A persistent audited process: one long-lived external program run by Marsh's managed `exec`
//! in a forced-sandbox pipe shell of the session's mux. Its standard input stays open for ordered
//! writes until `finish`, which ends that input and bounds the rest of its execution through
//! Marsh's own termination controller. The program and every descendant are one managed command:
//! its effects publish, or are denied, once, when it ends.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use marsh_core::shellmux::{CommandHandle, CommandOptions, JobIo, Shell, ShellId, SpawnOptions};
use tokio::runtime::Handle;
use tokio::sync::{mpsc, oneshot, watch};

use crate::frontend::OutputRoute;
use crate::mux::{
    Backend, RoutedError, RunResult, RunState, StopCause, completion_result, published_result,
    shell_environment, stop_and_settle, working_directory,
};

/// How long a program gets to exit on its own after its input ends, before `SIGTERM`, when the
/// termination window is longer than this.
const STDIN_CLOSE_GRACE: Duration = Duration::from_millis(500);

/// The termination window a `finish` without one uses.
const DEFAULT_CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

/// One external program and its arguments as the managed `exec` line that runs it.
///
/// Every word is a single-quoted literal, so nothing is expanded, split, or resolved to a
/// function or builtin: `exec` resolves the program itself through `PATH` and runs it through
/// the audited spawner with its own name as `argv[0]`.
pub(crate) struct ExecLine(String);

impl ExecLine {
    pub(crate) fn new(command: &str, args: &[String]) -> Result<Self, String> {
        let mut line = String::from("exec --");
        for word in std::iter::once(command).chain(args.iter().map(String::as_str)) {
            if word.contains('\0') {
                return Err("A ShellMux process command or argument must not contain NUL".into());
            }
            line.push_str(" '");
            let mut pieces = word.split('\'');
            if let Some(first) = pieces.next() {
                line.push_str(first);
            }
            for piece in pieces {
                line.push_str("'\\''");
                line.push_str(piece);
            }
            line.push('\'');
        }
        Ok(Self(line))
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

/// A termination window: the time a program gets after `SIGTERM`, validated from JavaScript.
#[derive(Clone, Copy)]
pub(crate) struct CloseTimeout(Duration);

impl CloseTimeout {
    pub(crate) fn from_millis(milliseconds: Option<f64>) -> Result<Self, String> {
        let Some(milliseconds) = milliseconds else {
            return Ok(Self(DEFAULT_CLOSE_TIMEOUT));
        };
        if !milliseconds.is_finite() || milliseconds < 0.0 {
            return Err(
                "Invalid closeTimeoutMs: must be a finite non-negative number of milliseconds"
                    .into(),
            );
        }
        Duration::try_from_secs_f64(milliseconds / 1000.0)
            .map(Self)
            .map_err(|_| "Invalid closeTimeoutMs: duration is out of range".into())
    }

    /// The window after end of input, then the window after `SIGTERM`.
    fn graces(self) -> (Duration, Duration) {
        (self.0.min(STDIN_CLOSE_GRACE), self.0)
    }
}

struct WriteRequest {
    bytes: Vec<u8>,
    reply: oneshot::Sender<Result<(), String>>,
}

/// What a retained JavaScript process owns: its input queue, its one termination request, and
/// the shared run state. It never owns the shell, the mux, or a callback.
pub(crate) struct ProcessState {
    run: Arc<RunState>,
    writes: Mutex<Option<mpsc::UnboundedSender<WriteRequest>>>,
    finish: watch::Sender<Option<CloseTimeout>>,
}

impl ProcessState {
    pub(crate) fn run(&self) -> &Arc<RunState> {
        &self.run
    }

    /// Queues `bytes` behind every earlier write. The receipt settles once they are written, or
    /// with the reason they never will be.
    pub(crate) fn write(&self, bytes: Vec<u8>) -> oneshot::Receiver<Result<(), String>> {
        let (reply, receipt) = oneshot::channel();
        let writes = self.writes.lock().unwrap_or_else(PoisonError::into_inner);
        let request = WriteRequest { bytes, reply };
        let refused = match writes.as_ref() {
            Some(sender) => sender.send(request).err().map(|error| error.0),
            None => Some(request),
        };
        if let Some(request) = refused {
            let _ = request
                .reply
                .send(Err("ShellMux process input is closed".into()));
        }
        receipt
    }

    /// Fences further writes and records the first termination request; later ones join it.
    pub(crate) fn finish(&self, timeout: CloseTimeout) {
        self.writes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        self.finish.send_if_modified(|requested| {
            if requested.is_some() {
                return false;
            }
            *requested = Some(timeout);
            true
        });
    }

    pub(crate) fn abort(&self) {
        self.writes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        self.run.abort();
    }
}

/// The admission answer `spawn` resolves with: once, on acceptance or on the final failure.
pub(crate) struct Admission(Option<oneshot::Sender<Result<(), RoutedError>>>);

impl Admission {
    pub(crate) fn new() -> (Self, Admitted) {
        let (sender, receiver) = oneshot::channel();
        (Self(Some(sender)), Admitted(receiver))
    }

    fn settle(&mut self, outcome: Result<(), RoutedError>) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(outcome);
        }
    }
}

/// The JavaScript side of an [`Admission`].
pub(crate) struct Admitted(oneshot::Receiver<Result<(), RoutedError>>);

impl Admitted {
    pub(crate) async fn wait(self) -> Result<(), RoutedError> {
        self.0.await.unwrap_or_else(|_| {
            Err(RoutedError::Other(
                "ShellMux process task ended without an admission answer".into(),
            ))
        })
    }
}

/// The JavaScript-facing state and the worker-facing ends of one process.
pub(crate) fn process_channels(run: Arc<RunState>) -> (Arc<ProcessState>, ProcessIo) {
    let (writes, requests) = mpsc::unbounded_channel();
    let (finish, requested) = watch::channel(None);
    (
        Arc::new(ProcessState {
            run,
            writes: Mutex::new(Some(writes)),
            finish,
        }),
        ProcessIo {
            requests,
            requested,
        },
    )
}

/// The worker's ends of a process's input queue and termination request.
pub(crate) struct ProcessIo {
    requests: mpsc::UnboundedReceiver<WriteRequest>,
    requested: watch::Receiver<Option<CloseTimeout>>,
}

/// Execution-only ownership of one process, like a one-shot run's.
pub(crate) struct ProcessTask {
    pub(crate) backend: Backend,
    pub(crate) runtime: Handle,
    pub(crate) seed: PathBuf,
    pub(crate) cwd: String,
    pub(crate) principal: ShellId,
    pub(crate) env: HashMap<String, String>,
    pub(crate) line: ExecLine,
    pub(crate) state: Arc<RunState>,
    pub(crate) route: Arc<OutputRoute>,
    pub(crate) io: ProcessIo,
}

impl ProcessTask {
    pub(crate) async fn run(self, mut admission: Admission) -> RunResult {
        let result = self.execute(&mut admission).await;
        // A process never admitted rejects `spawn` with its final, drained answer.
        admission.settle(match &result {
            Ok(_) => Err(RoutedError::Other(
                "ShellMux process was cancelled before admission".into(),
            )),
            Err(error) => Err(error.clone()),
        });
        result
    }

    async fn execute(self, admission: &mut Admission) -> RunResult {
        let Self {
            backend,
            runtime,
            seed,
            cwd,
            principal,
            env,
            line,
            state,
            route,
            io,
        } = self;
        if state.is_cancelled() {
            return Ok(crate::mux::cancelled_result(None, false));
        }
        let filesystem = Arc::clone(&backend.filesystem);
        let directory = runtime
            .spawn_blocking(move || working_directory(&cwd, &seed, filesystem.as_ref()))
            .await
            .map_err(|error| format!("Cannot resolve working directory: {error}"))??;
        let environment = shell_environment(env)?;
        if state.is_cancelled() {
            return Ok(crate::mux::cancelled_result(None, false));
        }
        // As for a run: never raced against cancellation, which could orphan the shell.
        let shell = backend
            .mux
            .open_shell(
                &directory,
                Some(principal),
                SpawnOptions {
                    io: JobIo::Pipes,
                    environment: Some(environment),
                    force_sandbox: true,
                    ..Default::default()
                },
            )
            .await
            .map_err(|error| error.to_string())?;
        backend
            .frontend
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .register(shell.sandbox().uid.clone(), Arc::clone(&route));
        let result = process_job(&shell, &state, &route, &line, io, admission).await;
        backend
            .frontend
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&shell.sandbox().uid);
        result
    }
}

enum ProcessEvent {
    Completed(RunResult),
    Stop(StopCause),
}

async fn process_job(
    shell: &Shell,
    state: &RunState,
    route: &OutputRoute,
    line: &ExecLine,
    io: ProcessIo,
    admission: &mut Admission,
) -> RunResult {
    if state.is_cancelled() {
        return stop_and_settle(shell, None, route, StopCause::Cancelled).await;
    }
    if let Some(error) = route.failure() {
        return stop_and_settle(shell, None, route, StopCause::Failed(error.into())).await;
    }
    // As run_job: the receipt the cleanup consults is settled once the driving future is gone.
    let (accepted, receipt) = oneshot::channel();
    let event = tokio::select! {
        biased;
        error = route.failed() => ProcessEvent::Stop(StopCause::Failed(error.into())),
        _ = state.cancelled() => ProcessEvent::Stop(StopCause::Cancelled),
        result = drive(shell, route, line, accepted, io, admission) => {
            ProcessEvent::Completed(result)
        }
    };
    match event {
        ProcessEvent::Completed(Ok(result)) => Ok(result),
        ProcessEvent::Completed(Err(error)) => {
            stop_and_settle(shell, Some(receipt), route, StopCause::Failed(error)).await
        }
        ProcessEvent::Stop(cause) => stop_and_settle(shell, Some(receipt), route, cause).await,
    }
}

/// Admits the program, feeds its input, and awaits its own verdict, its shell's end and every
/// queued output callback.
async fn drive(
    shell: &Shell,
    route: &OutputRoute,
    line: &ExecLine,
    accepted: oneshot::Sender<CommandHandle>,
    io: ProcessIo,
    admission: &mut Admission,
) -> RunResult {
    let ProcessIo {
        requests,
        requested,
    } = io;
    let (on_accept, receipt) = oneshot::channel();
    let command = shell.run_command(
        line.as_str(),
        CommandOptions {
            on_accept: Some(on_accept),
            ..Default::default()
        },
    );
    tokio::pin!(command);
    let handle = tokio::select! {
        biased;
        handle = receipt => handle.ok(),
        // Admission failed and run_command answered first; its error is the reason.
        result = &mut command => {
            return Err(match result {
                Ok(_) => "ShellMux process finished without an admission receipt".to_string().into(),
                Err(error) => crate::mux::run_error(error),
            });
        }
    };
    let Some(handle) = handle else {
        // No line was admitted: the submission's own answer says why.
        return Err(match command.await {
            Ok(_) => "ShellMux process finished without an admission receipt"
                .to_string()
                .into(),
            Err(error) => crate::mux::run_error(error),
        });
    };
    // The command is the collection's now; its receipt answers for it from here on.
    let _ = accepted.send(handle.clone());
    admission.settle(Ok(()));

    let (ended, ended_watch) = watch::channel(false);
    let mut termination = requested.clone();
    let verdict = async {
        let verdict = tokio::select! {
            biased;
            verdict = handle.wait() => verdict,
            verdict = async {
                let timeout = termination_requested(&mut termination).await;
                let (stdin_grace, terminate_grace) = timeout.graces();
                handle.finish_with_grace(stdin_grace, terminate_grace).await
            } => verdict,
        };
        ended.send_replace(true);
        verdict
    };
    let ((), verdict) = tokio::join!(feed_input(shell, requests, requested, ended_watch), verdict);
    let completion = completion_result(verdict)?;
    published_result(shell, route, &completion).await
}

/// The first termination request; never, once nobody can make one.
async fn termination_requested(
    requested: &mut watch::Receiver<Option<CloseTimeout>>,
) -> CloseTimeout {
    let requested = requested
        .wait_for(Option::is_some)
        .await
        .ok()
        .and_then(|timeout| *timeout);
    match requested {
        Some(timeout) => timeout,
        None => std::future::pending().await,
    }
}

/// Writes queued input in order until termination is requested, the command ends, or nobody can
/// write any more; then rejects whatever was never sent and ends the program's input.
async fn feed_input(
    shell: &Shell,
    mut requests: mpsc::UnboundedReceiver<WriteRequest>,
    mut requested: watch::Receiver<Option<CloseTimeout>>,
    mut ended: watch::Receiver<bool>,
) {
    loop {
        let request = tokio::select! {
            biased;
            _ = requested.wait_for(Option::is_some) => None,
            _ = ended.wait_for(|ended| *ended) => None,
            request = requests.recv() => request,
        };
        let Some(WriteRequest { bytes, reply }) = request else {
            break;
        };
        // A write blocked on a program that stopped reading is not raced away: the termination
        // controller runs beside it and ends the program, which fails the write.
        let _ = reply.send(
            shell
                .write_input(&bytes)
                .await
                .map_err(|error| format!("ShellMux process write failed: {error}")),
        );
    }
    requests.close();
    while let Ok(WriteRequest { reply, .. }) = requests.try_recv() {
        let _ = reply.send(Err(
            "ShellMux process input closed before this write was sent".into(),
        ));
    }
    if !*ended.borrow() {
        // End of file; an already reclaimed shell has no input left to end.
        let _ = shell.close_input().await;
    }
}
