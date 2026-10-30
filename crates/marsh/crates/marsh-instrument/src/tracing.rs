//! Shell attribution over in-process native observation. No syscall decoder lives here.
//!
//! Linux lets a process trace its own descendants but never its own threads. Every command a
//! managed run spawns is therefore seized, before it can run anything of its own, by a tracer
//! thread of this process that owns exactly that command's process tree; the interpreter's own
//! filesystem accesses arrive instead as host records it reports right after making them. Both
//! are attributed through the scopes the host enters on its threads.
//!
//! `park` holds a live tree behind a generation-bound token after closing its evidence. Only
//! proven effectless pending calls may cross that boundary; possible kernel writes to shared
//! mappings are drained too. Dropping the token cancels and drains rather than resuming it.
//! `quiesce` and `end_run` still require termination, not merely a parked tree.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::io::{self, Read, Write};
use std::marker::PhantomData;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak};
use std::time::Duration;

use crate::Syscall;
use crate::capture::{Captured, proc_field};
use crate::host::{HostCall, records};
use crate::observation::{
    Control, EntryInfo, Observer, Resume, Sequence, UNCLASSIFIED, alive, creation, rekey,
};
use lurk_cli::syscall_info::{RetCode, SyscallArgs, SyscallInfo};
use marsh_lib::{CheckedAdvance, RecoverPoison as _};
use nix::errno::Errno;
use nix::sys::ptrace::Event;
use nix::sys::signal::Signal;
use nix::sys::wait::WaitStatus;
use nix::unistd::Pid;
use syscalls::{Sysno, SysnoSet};

/// The published generation; a weak that no longer upgrades admits a new one.
static SHARED: Mutex<Option<Weak<Tracing>>> = Mutex::new(None);

thread_local! {
    /// Scopes entered on this host thread, innermost last: service, scope and attribution.
    static ENTERED: RefCell<Vec<(usize, ScopeId, Option<TraceRun>)>> =
        const { RefCell::new(Vec::new()) };
}

/// Opaque registration identity. Never reused within a service.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct RootId(u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct ScopeId(u64);

/// One evaluation's attribution identity, separate from native syscall evidence.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct TraceRun {
    /// Registered root owning the evaluation.
    root: RootId,
    /// Monotonic evaluation identifier.
    sequence: u64,
}

struct Root {
    path: PathBuf,
    observe: Arc<dyn Fn(TraceRun, Syscall) -> io::Result<()> + Send + Sync>,
}

/// A traced process's identity, pinned while one of its tasks was stopped.
struct ProcessLease {
    descriptor: OwnedFd,
    group: Pid,
}

/// A stop buffered until its thread's creator is known: sequence, status, event and record.
type Early = (u64, i32, Option<u64>, Option<Syscall>);

#[derive(Clone, Copy)]
struct Pending {
    entry: u64,
    run: Option<TraceRun>,
    safe: bool,
    /// Kernel completion may copy results into a shared file mapping.
    writes_memory: bool,
}

#[derive(Default)]
struct Thread {
    inherited: Option<TraceRun>,
    known_parent: bool,
    process: Option<ProcessLease>,
    pending: Option<Pending>,
    classify_after: Option<u64>,
    early: Vec<Early>,
    /// Whether the task's last stop was a job-control (group) stop.
    job_stopped: bool,
    /// A stop the observer must not release without this run's current token.
    policy_held: bool,
    /// An internal restart result is not a completed effectful call.
    restart: Option<Option<Sysno>>,
    /// Output-buffer safety of a proven effectless ERESTART_RESTARTBLOCK wait.
    safe_restart: Option<bool>,
    /// A signal handler obscured completion of an effectful interrupted call.
    restart_uncertain: bool,
}

impl Thread {
    /// Kills the task's process through its pinned identity.
    fn kill(&self) -> io::Result<()> {
        if let Some(process) = &self.process {
            signal_process(&process.descriptor, libc::SIGKILL)?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum RunPhase {
    #[default]
    Running,
    Parking(u64),
    Parked(u64),
    Cancelled,
}

#[derive(Default)]
struct RunState {
    phase: RunPhase,
    /// Accepted spawns whose tracer has not finished delivering and retiring its tree.
    observers: usize,
    starting: usize,
    /// Deliveries and classifier calls outside the bookkeeping mutex.
    deliveries: usize,
    waker: Option<std::task::Waker>,
}

#[derive(Default)]
struct State {
    ids: u64,
    roots: HashMap<RootId, Root>,
    runs: HashMap<TraceRun, RunState>,
    threads: HashMap<Pid, Thread>,
    /// Records waiting for their creator's call, by its entry: attribution and record.
    deferred: HashMap<u64, Vec<(TraceRun, Syscall)>>,
    failure: Option<String>,
}

impl CheckedAdvance for &mut State {
    type Output = u64;
    type Error = io::Error;
    fn value(&self) -> u64 {
        self.ids
    }
    fn advance(self, value: u64) -> u64 {
        self.ids = value;
        value
    }
    fn exhausted() -> io::Error {
        io::Error::other("trace ID exhaustion")
    }
}

impl State {
    fn check(&self) -> io::Result<()> {
        self.failure
            .as_ref()
            .map_or(Ok(()), |cause| Err(io::Error::other(cause.clone())))
    }

    fn run(&self, run: TraceRun) -> io::Result<()> {
        self.check()?;
        if self.runs.contains_key(&run) {
            Ok(())
        } else {
            Err(io::Error::other("closed trace run"))
        }
    }

    /// Notes that `tid` began exiting.
    ///
    /// # Errors
    /// A creator that exits inside a creating call whose child is already observed leaves that
    /// child's records unclassifiable; outside a cancelled run that fails observation.
    fn retire(&mut self, tid: Pid) -> io::Result<()> {
        let Some(thread) = self.threads.get(&tid) else {
            return Ok(());
        };
        let cancelled = self.cancelled(thread.inherited);
        let Some(Pending { entry, .. }) = thread.pending else {
            return Ok(());
        };
        let orphaned = self.deferred.contains_key(&entry)
            || self
                .threads
                .values()
                .any(|thread| thread.classify_after == Some(entry));
        if orphaned {
            if !cancelled {
                return Err(io::Error::other(UNCLASSIFIED));
            }
            // Cancelled work publishes nothing: drop what can never be ordered.
            self.deferred.remove(&entry);
            for thread in self.threads.values_mut() {
                if thread.classify_after == Some(entry) {
                    thread.classify_after = None;
                }
            }
        }
        Ok(())
    }

    /// Whether an attributed run has been cancelled.
    fn cancelled(&self, run: Option<TraceRun>) -> bool {
        run.is_some_and(|run| {
            self.runs
                .get(&run)
                .is_some_and(|run| run.phase == RunPhase::Cancelled)
        })
    }
}

/// A closed-evidence, nonterminal stop of one trace run's native process tree.
/// Dropping an armed token kills and drains the tree; it never resumes application work.
#[must_use]
pub struct ParkedRun {
    tracing: Arc<Tracing>,
    run: TraceRun,
    generation: u64,
    armed: bool,
}

impl std::fmt::Debug for ParkedRun {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ParkedRun")
            .field("run", &self.run)
            .field("generation", &self.generation)
            .finish_non_exhaustive()
    }
}

impl ParkedRun {
    /// The lifetime attribution identity retained by this checkpoint.
    pub const fn run(&self) -> TraceRun {
        self.run
    }

    /// Validates that this proof still parks the requested run of this tracing service.
    ///
    /// # Errors
    /// Rejects foreign, stale, cancelled, or unhealthy checkpoints.
    pub fn validate(&self, tracing: &Arc<Tracing>, run: TraceRun) -> io::Result<()> {
        if !self.armed || !Arc::ptr_eq(&self.tracing, tracing) || self.run != run {
            return Err(io::Error::other("foreign or consumed parked trace proof"));
        }
        let state = lock(&tracing.state);
        state.run(run)?;
        if !state
            .runs
            .get(&run)
            .is_some_and(|run| run.phase == RunPhase::Parked(self.generation))
        {
            return Err(io::Error::other("stale parked trace generation"));
        }
        Ok(())
    }

    /// Consumes the current checkpoint and permits its stopped tree to run again.
    ///
    /// # Errors
    /// Rejects a stale/cancelled token, lost observation, or a failed pinned signal.
    pub fn resume(mut self) -> io::Result<()> {
        let mut state = lock(&self.tracing.state);
        state.run(self.run)?;
        let run = state
            .runs
            .get_mut(&self.run)
            .ok_or_else(|| io::Error::other("closed trace run"))?;
        if run.phase != RunPhase::Parked(self.generation) {
            return Err(io::Error::other("stale parked trace generation"));
        }
        run.phase = RunPhase::Running;
        let result = Tracing::signal_locked(&state, self.run, libc::SIGCONT, false);
        drop(state);
        self.tracing.progress.notify_all();
        result?;
        self.armed = false;
        Ok(())
    }

    /// Kills and drains this checkpoint's tree without ending its lifetime TraceRun.
    pub fn cancel(mut self) -> io::Result<usize> {
        let result = self.tracing.cancel(self.run);
        // Even a failed signal must finish the observer lifecycle before this proof is dropped.
        self.tracing.drain(self.run);
        self.armed = false;
        let count = result?;
        self.tracing.health(self.run)?;
        Ok(count)
    }
}

impl Drop for ParkedRun {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.tracing.cancel(self.run);
            self.tracing.drain(self.run);
        }
    }
}

/// A pending kernel output buffer must not change shared file contents after sealing.
fn shared_writable_mapping(tid: Pid) -> io::Result<bool> {
    // ponytail: reject all file-backed shared-writable mappings for pending output buffers;
    // inspect exact buffer ranges only if this conservative drainage prevents useful parking.
    let maps = std::fs::read_to_string(format!("/proc/{tid}/maps"))?;
    Ok(maps.lines().any(|line| {
        let mut fields = line.split_whitespace();
        let Some(permissions) = fields.nth(1) else {
            return false;
        };
        let bytes = permissions.as_bytes();
        // Anonymous kernel rings have no filesystem payload. Effectful/unknown asynchronous
        // submissions are still refused by the common syscall classifier.
        bytes.get(1) == Some(&b'w')
            && bytes.get(3) == Some(&b's')
            && fields.nth(3).is_some_and(|path| path.starts_with('/'))
    }))
}

/// Locks trace bookkeeping, recovering the guard from a panicked holder.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().recover()
}

/// What a traced command's own process does, as its spawner needs to know it.
#[derive(Clone, Copy, Debug)]
pub enum ChildEvent {
    /// The process entered a job-control stop.
    Stopped,
    /// The process ended; its status was reaped by the tracer.
    Exited(std::process::ExitStatus),
}

/// A command spawned under observation. Its tracer reaps it: never wait on its pid elsewhere.
pub struct TracedChild {
    /// The process id.
    pub pid: u32,
    /// A pidfd pinning the process, for signalling it.
    pub process: OwnedFd,
    /// Piped standard input, if requested by the caller.
    pub stdin: Option<std::process::ChildStdin>,
    /// Piped standard output, if requested by the caller.
    pub stdout: Option<std::process::ChildStdout>,
    /// Piped standard error, if requested by the caller.
    pub stderr: Option<std::process::ChildStderr>,
    /// The tracer thread observing the command's tree.
    observer: std::thread::JoinHandle<io::Result<()>>,
}

impl TracedChild {
    /// Waits until the command's whole tree has ended and every record of it was delivered.
    ///
    /// # Errors
    /// Returns the observation failure that ended its tracer.
    pub fn wait_observed(self) -> io::Result<()> {
        self.observer
            .join()
            .map_err(|_| io::Error::other("native tracer panicked"))?
    }
}

/// The host's shared native observation service; Shell owns every registration and run.
pub struct Tracing {
    state: Mutex<State>,
    progress: Condvar,
    sequence: Arc<Sequence>,
    selected: SysnoSet,
}

/// Keeps cancellation and attribution alive until this command's observer has retired.
struct ObserverRun {
    tracing: Arc<Tracing>,
    run: TraceRun,
    starting: bool,
}

impl Drop for ObserverRun {
    fn drop(&mut self) {
        if std::thread::panicking() {
            self.tracing.fail("native tracer panicked");
        }
        if let Some(run) = lock(&self.tracing.state).runs.get_mut(&self.run) {
            if self.starting {
                run.starting -= 1;
            }
            run.observers -= 1;
        }
        self.tracing.progress.notify_all();
    }
}

/// Counts callbacks even while they run outside the bookkeeping lock.
struct Delivery<'a> {
    tracing: &'a Tracing,
    run: TraceRun,
}

impl Drop for Delivery<'_> {
    fn drop(&mut self) {
        if let Some(run) = lock(&self.tracing.state).runs.get_mut(&self.run) {
            run.deliveries -= 1;
        }
        self.tracing.progress.notify_all();
    }
}

impl Tracing {
    /// Shares the live service, or starts a new generation once the previous one is gone.
    ///
    /// # Errors
    /// Returns a live generation's recorded failure.
    pub fn shared() -> io::Result<Arc<Self>> {
        let mut shared = lock(&SHARED);
        if let Some(tracing) = shared.as_ref().and_then(Weak::upgrade) {
            // Never drop a possibly-final owner while holding the cache.
            drop(shared);
            let health = lock(&tracing.state).check();
            return health.map(|()| tracing);
        }
        let tracing = Arc::new(Self {
            state: Mutex::new(State::default()),
            progress: Condvar::new(),
            sequence: Arc::new(Sequence::default()),
            selected: Observer::selection()?,
        });
        *shared = Some(Arc::downgrade(&tracing));
        drop(shared);
        Ok(tracing)
    }

    /// Registers a physical work root and its native observation consumer.
    pub fn register_root(
        &self,
        root: &Path,
        observe: Arc<dyn Fn(TraceRun, Syscall) -> io::Result<()> + Send + Sync>,
    ) -> io::Result<RootId> {
        let mut state = lock(&self.state);
        state.check()?;
        if state.roots.values().any(|entry| entry.path == root) {
            return Err(io::Error::other("root already registered"));
        }
        let id = RootId(state.next()?);
        state.roots.insert(
            id,
            Root {
                path: root.to_path_buf(),
                observe,
            },
        );
        drop(state);
        Ok(id)
    }

    /// Admits one evaluation on a registered root.
    pub fn begin_run(&self, root: RootId) -> io::Result<TraceRun> {
        let mut state = lock(&self.state);
        state.check()?;
        if !state.roots.contains_key(&root) || state.runs.keys().any(|run| run.root == root) {
            return Err(io::Error::other("missing or busy trace root"));
        }
        let run = TraceRun {
            root,
            sequence: state.next()?,
        };
        state.runs.insert(run, RunState::default());
        drop(state);
        Ok(run)
    }

    /// Allocates a workload scope: what the host does inside it, and what it spawns, is the run's.
    pub fn scope(self: &Arc<Self>, run: TraceRun) -> io::Result<TraceScope> {
        let mut state = lock(&self.state);
        state.run(run)?;
        let id = ScopeId(state.next()?);
        drop(state);
        Ok(TraceScope {
            tracing: Arc::clone(self),
            id,
            target: Some(run),
        })
    }

    /// Marks implementation work so it cannot become a command's evidence or producer.
    pub fn internal_scope(self: &Arc<Self>) -> io::Result<TraceScope> {
        let mut state = lock(&self.state);
        state.check()?;
        let id = ScopeId(state.next()?);
        drop(state);
        Ok(TraceScope {
            tracing: Arc::clone(self),
            id,
            target: None,
        })
    }

    /// Allocates the run's next entry order from the sequence its syscall records use.
    pub fn next_order(&self, run: TraceRun) -> io::Result<u64> {
        lock(&self.state).run(run)?;
        self.sequence.next()
    }

    /// Waits for every inherited producer, pending call and observer to finish.
    pub fn quiesce(&self, run: TraceRun) -> io::Result<()> {
        let mut state = lock(&self.state);
        loop {
            state.check()?;
            let current = state
                .runs
                .get(&run)
                .ok_or_else(|| io::Error::other("closed trace run"))?;
            let busy = current.observers != 0
                || current.deliveries != 0
                || state.threads.values().any(|thread| {
                    thread.inherited == Some(run)
                        || thread
                            .pending
                            .is_some_and(|pending| pending.run == Some(run))
                })
                || state
                    .deferred
                    .values()
                    .flatten()
                    .any(|(owner, _)| *owner == run);
            if !busy {
                break;
            }
            state = self.progress.wait(state).recover();
        }
        drop(state);
        Ok(())
    }

    /// Signals the run's live traced processes, never historical PIDs or the host itself.
    ///
    /// `SIGCONT` goes only to processes in a job-control stop. Every tracer stop notifies this
    /// process with `SIGCHLD`, and an embedder that answers `SIGCHLD` by continuing its jobs
    /// would otherwise keep interrupting running commands with continue notifications.
    pub fn signal(&self, run: TraceRun, signal: i32) -> io::Result<usize> {
        let state = lock(&self.state);
        let phase = state
            .runs
            .get(&run)
            .ok_or_else(|| io::Error::other("closed trace run"))?
            .phase;
        // Job-control callbacks and external continue requests never release a policy hold.
        if signal == libc::SIGCONT && phase != RunPhase::Running {
            return Ok(0);
        }
        Self::signal_locked(&state, run, signal, true)
    }

    fn signal_locked(
        state: &State,
        run: TraceRun,
        signal: i32,
        job_only: bool,
    ) -> io::Result<usize> {
        let mut signalled = HashSet::new();
        for thread in state.threads.values().filter(|thread| {
            thread.inherited == Some(run)
                && (signal != libc::SIGCONT || !job_only || thread.job_stopped)
        }) {
            if let Some(process) = &thread.process
                && !signalled.contains(&process.group)
                && signal_process(&process.descriptor, signal)?
            {
                signalled.insert(process.group);
            }
        }
        Ok(signalled.len())
    }

    /// Stops a live run only once its complete evidence prefix is classified.
    /// Effectful/unknown pending calls are drained before their tasks are held.
    /// The caller supplies its deadline by cancelling the run from another thread.
    ///
    /// # Errors
    /// Observation loss, cancellation, uncertain interrupted calls, and signalling failures
    /// cancel and drain the tree rather than return an incomplete evidence prefix.
    pub fn park(self: &Arc<Self>, run: TraceRun) -> io::Result<ParkedRun> {
        let mut state = lock(&self.state);
        if let Err(error) = state.run(run) {
            drop(state);
            let _ = self.cancel(run);
            self.drain(run);
            return Err(error);
        }
        if state
            .runs
            .get(&run)
            .is_none_or(|run| run.phase != RunPhase::Running)
        {
            return Err(io::Error::other("trace run is not running"));
        }
        let generation = match state.next() {
            Ok(generation) => generation,
            Err(error) => {
                drop(state);
                let _ = self.cancel(run);
                self.drain(run);
                return Err(error);
            }
        };
        state.runs.get_mut(&run).expect("checked run").phase = RunPhase::Parking(generation);
        let result = self.wait_park(run, generation, state);
        if let Err(error) = result {
            let _ = self.cancel(run);
            self.drain(run);
            return Err(error);
        }
        Ok(ParkedRun {
            tracing: Arc::clone(self),
            run,
            generation,
            armed: true,
        })
    }

    fn wait_park(
        &self,
        run: TraceRun,
        generation: u64,
        mut state: MutexGuard<'_, State>,
    ) -> io::Result<()> {
        Self::signal_locked(&state, run, libc::SIGSTOP, false)?;
        loop {
            state.run(run)?;
            let current = state
                .runs
                .get(&run)
                .ok_or_else(|| io::Error::other("closed trace run"))?;
            if current.phase != RunPhase::Parking(generation) {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "trace parking cancelled",
                ));
            }
            if state
                .threads
                .values()
                .any(|thread| thread.inherited == Some(run) && thread.restart_uncertain)
            {
                return Err(io::Error::other(
                    "cannot park an unproven effectful syscall restart",
                ));
            }
            let busy = current.starting != 0
                || current.deliveries != 0
                || state.threads.values().any(|thread| {
                    thread.inherited == Some(run)
                        && (!thread.policy_held
                            || !thread.known_parent
                            || !thread.early.is_empty()
                            || thread.classify_after.is_some()
                            || thread.pending.is_some_and(|pending| !pending.safe))
                })
                || state
                    .deferred
                    .values()
                    .flatten()
                    .any(|(owner, _)| *owner == run);
            if !busy {
                // A pipe/wait can still mutate a mapped file through its result buffer. All
                // tasks are held here, so no peer can introduce a new mapping during this check.
                let mut shared = HashMap::new();
                for (tid, thread) in &state.threads {
                    if thread.inherited == Some(run)
                        && thread.pending.is_some_and(|pending| pending.writes_memory)
                    {
                        let group = thread
                            .process
                            .as_ref()
                            .map_or(*tid, |process| process.group);
                        if let std::collections::hash_map::Entry::Vacant(slot) = shared.entry(group)
                        {
                            slot.insert(shared_writable_mapping(*tid)?);
                        }
                    }
                }
                let mut draining = false;
                for (tid, thread) in &mut state.threads {
                    let group = thread
                        .process
                        .as_ref()
                        .map_or(*tid, |process| process.group);
                    if thread.inherited == Some(run)
                        && shared.get(&group) == Some(&true)
                        && let Some(pending) = &mut thread.pending
                        && pending.writes_memory
                    {
                        pending.safe = false;
                        thread.policy_held = false;
                        draining = true;
                    }
                }
                if draining {
                    Self::signal_locked(&state, run, libc::SIGCONT, false)?;
                    self.progress.notify_all();
                    continue;
                }
                state.runs.get_mut(&run).expect("checked run").phase = RunPhase::Parked(generation);
                return Ok(());
            }
            state = self.progress.wait(state).recover();
        }
    }

    /// Waits for all producers and deliveries to drain, even when trace health has failed.
    /// Cancel or terminate the native tree first; failed evidence is never made publishable.
    pub fn drain(&self, run: TraceRun) {
        let mut state = lock(&self.state);
        while state
            .runs
            .get(&run)
            .is_some_and(|run| run.observers != 0 || run.deliveries != 0)
            || state
                .threads
                .values()
                .any(|thread| thread.inherited == Some(run))
        {
            state = self.progress.wait(state).recover();
        }
    }

    fn delivery(&self, run: TraceRun) -> io::Result<Delivery<'_>> {
        let mut state = lock(&self.state);
        state.run(run)?;
        state.runs.get_mut(&run).expect("checked run").deliveries += 1;
        Ok(Delivery { tracing: self, run })
    }

    fn application_delivery(&self, run: TraceRun) -> io::Result<Delivery<'_>> {
        let mut state = lock(&self.state);
        state.run(run)?;
        let current = state.runs.get_mut(&run).expect("checked run");
        if current.phase != RunPhase::Running {
            return Err(io::Error::other("trace run is not running"));
        }
        current.deliveries += 1;
        Ok(Delivery { tracing: self, run })
    }

    /// Reports loss of the native service even while a consumer callback is blocked.
    pub fn health(&self, run: TraceRun) -> io::Result<()> {
        lock(&self.state).run(run)
    }

    /// Cancels existing descendants and descendants whose creation is still being delivered.
    pub fn cancel(&self, run: TraceRun) -> io::Result<usize> {
        let mut state = lock(&self.state);
        state
            .runs
            .get_mut(&run)
            .ok_or_else(|| io::Error::other("closed trace run"))?
            .phase = RunPhase::Cancelled;
        let result = Self::signal_locked(&state, run, libc::SIGKILL, false);
        drop(state);
        self.progress.notify_all();
        result
    }

    /// Registers the owning evaluation for immediate failure notification.
    pub fn poll_failure(
        &self,
        run: TraceRun,
        context: &std::task::Context<'_>,
    ) -> std::task::Poll<io::Error> {
        let mut state = lock(&self.state);
        if let Err(error) = state.run(run) {
            return std::task::Poll::Ready(error);
        }
        if let Some(run) = state.runs.get_mut(&run)
            && run
                .waker
                .as_ref()
                .is_none_or(|waker| !waker.will_wake(context.waker()))
        {
            run.waker = Some(context.waker().clone());
        }
        drop(state);
        std::task::Poll::Pending
    }

    /// Ends a fully quiescent evaluation and retires its attribution bookkeeping.
    pub fn end_run(&self, run: TraceRun) -> io::Result<()> {
        self.quiesce(run)?;
        lock(&self.state).runs.remove(&run);
        Ok(())
    }

    /// Releases a root only after its runs have finished.
    pub fn unregister_root(&self, root: RootId) -> io::Result<()> {
        let mut state = lock(&self.state);
        if state.runs.keys().any(|run| run.root == root) && state.failure.is_none() {
            return Err(io::Error::other("trace root still owns a run"));
        }
        // A failed service cannot prove reclamation. Its owner retains the private tree, but
        // must still be able to close all roots and release the failed generation.
        state.runs.retain(|run, _| run.root != root);
        state
            .roots
            .remove(&root)
            .ok_or_else(|| io::Error::other("missing trace root"))?;
        drop(state);
        Ok(())
    }

    /// Reports one filesystem access the host interpreter performed on this thread. Outside a
    /// workload scope it is implementation work and records nothing.
    ///
    /// # Errors
    /// Fails when the access cannot be restated as evidence; the caller must refuse the run.
    pub fn host(&self, call: HostCall<'_>) -> io::Result<()> {
        let Some(run) = self.current() else {
            return Ok(());
        };
        let _delivery = self.application_delivery(run)?;
        for record in records(call, nix::unistd::gettid(), &self.sequence)? {
            self.classify(run, record)?;
        }
        Ok(())
    }

    /// Spawns `command` for the workload scope entered on this thread, traced from before it
    /// runs anything of its own until its whole process tree has ended.
    ///
    /// The child parks in a handshake between its launch setup and `exec`; a dedicated tracer
    /// thread seizes it there, and every task of its tree stays that thread's. The tracer reaps
    /// the command, reporting it through `events`, so nothing else may wait on its pid: in one
    /// thread group any such wait would also consume the tracer's stops.
    ///
    /// # Errors
    /// Refuses outside a workload scope, a program named without a path, and launch failures.
    pub fn spawn(
        self: &Arc<Self>,
        mut command: std::process::Command,
        events: Box<dyn FnMut(ChildEvent) + Send>,
    ) -> io::Result<TracedChild> {
        let run = self
            .current()
            .ok_or_else(|| io::Error::other("a managed command spawned outside its run's scope"))?;
        let mut observation = {
            let mut state = lock(&self.state);
            state.run(run)?;
            let current = state.runs.get_mut(&run).expect("checked run");
            if current.phase != RunPhase::Running {
                return Err(io::Error::other("trace run is not running"));
            }
            current.observers += 1;
            current.starting += 1;
            drop(state);
            ObserverRun {
                tracing: Arc::clone(self),
                run,
                starting: true,
            }
        };
        // A PATH search would exec several candidates, and only the first failure is detached.
        if !command.get_program().as_encoded_bytes().contains(&b'/') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "a managed command needs its resolved program path",
            ));
        }
        let host = nix::unistd::gettid();
        let (request_read, request_write) = pipe()?;
        let (release_read, release_write) = pipe()?;
        let (pinned, identity) = std::sync::mpsc::sync_channel(1);
        let tracer = std::thread::Builder::new()
            .name("marsh-tracer".into())
            .spawn(move || {
                let tracing = Arc::clone(&observation.tracing);
                let result = tracing.trace(
                    request_read,
                    release_write,
                    &pinned,
                    observation.run,
                    host,
                    events,
                    &mut observation.starting,
                );
                drop(observation);
                result
            })?;
        let (request, release) = (request_write.as_raw_fd(), release_read.as_raw_fd());
        // SAFETY: the hook runs in the forked child and only calls async-signal-safe getpid, write
        // and read on two descriptors the child inherited; it allocates nothing.
        unsafe {
            command.pre_exec(move || handshake(request, release));
        }
        let spawned = command.spawn();
        drop(command);
        drop((request_write, release_read));
        match spawned {
            Ok(mut child) => {
                let pid = child.id();
                let stdin = child.stdin.take();
                let stdout = child.stdout.take();
                let stderr = child.stderr.take();
                // Pipe ownership has moved out; dropping the std handle never waits.
                drop(child);
                let process = identity
                    .recv()
                    .map_err(|_| io::Error::other("tracer ended before pinning its command"))?;
                Ok(TracedChild {
                    pid,
                    process,
                    stdin,
                    stdout,
                    stderr,
                    observer: tracer,
                })
            }
            Err(error) => {
                // No command runs; the tracer ends once it has nothing left to trace.
                let _ = tracer.join();
                Err(error)
            }
        }
    }

    /// The attribution of the innermost scope this thread entered on this service.
    fn current(&self) -> Option<TraceRun> {
        let service = std::ptr::from_ref(self) as usize;
        ENTERED.with_borrow(|entered| {
            entered
                .iter()
                .rev()
                .find(|(owner, ..)| *owner == service)
                .and_then(|(_, _, target)| *target)
        })
    }

    /// One command tree's tracer thread: seize the command in its handshake, release it, then
    /// deliver every stop of its tree until none is left.
    fn trace(
        self: &Arc<Self>,
        request: OwnedFd,
        release: OwnedFd,
        pinned: &std::sync::mpsc::SyncSender<OwnedFd>,
        run: TraceRun,
        host: Pid,
        mut events: Box<dyn FnMut(ChildEvent) + Send>,
        starting: &mut bool,
    ) -> io::Result<()> {
        let mut pid = [0; 4];
        // End of file: the launch failed before its handshake.
        if std::fs::File::from(request).read_exact(&mut pid).is_err() {
            return Ok(());
        }
        let root = Pid::from_raw(i32::from_ne_bytes(pid));
        let mut observer = Observer::new(self.selected.clone(), Arc::clone(&self.sequence), root);
        let result = (|| -> io::Result<()> {
            let mut observe =
                |sequence, tid: Pid, status, event, info, entry: Option<EntryInfo<'_>>| {
                    let _delivery = self.delivery(run)?;
                    let resume = self.deliver(sequence, tid, status, event, info, entry)?;
                    if tid == root {
                        report(&mut *events, status)?;
                    }
                    Ok(resume)
                };
            let Some(status) = observer.seize(root)? else {
                return Ok(());
            };
            let process = open_process(root.as_raw())?;
            pinned
                .send(process.try_clone()?)
                .map_err(|_| io::Error::other("spawner abandoned its command"))?;
            self.adopt_root(root, run, host, process)?;
            {
                let mut state = lock(&self.state);
                state
                    .runs
                    .get_mut(&run)
                    .ok_or_else(|| io::Error::other("closed trace run"))?
                    .starting -= 1;
                *starting = false;
            }
            self.progress.notify_all();
            observer.stop(root, status, &mut observe)?;
            std::fs::File::from(release).write_all(&[1])?;
            observer.run_controlled(&mut observe, &mut |tid, held| {
                let mut state = lock(&self.state);
                state.check()?;
                let decision = match state.threads.get(&tid) {
                    None => Control::Release,
                    Some(thread) => match thread.inherited.and_then(|run| state.runs.get(&run)) {
                        None => Control::Release,
                        Some(run)
                            if matches!(run.phase, RunPhase::Running | RunPhase::Cancelled) =>
                        {
                            Control::Release
                        }
                        Some(_) if !thread.policy_held && held => Control::Release,
                        Some(_)
                            if !thread.policy_held
                                && thread.pending.is_none_or(|pending| pending.safe)
                                && thread.restart.is_none()
                                && !thread.restart_uncertain =>
                        {
                            Control::Interrupt
                        }
                        Some(_) => Control::Hold,
                    },
                };
                if matches!(decision, Control::Release)
                    && let Some(thread) = state.threads.get_mut(&tid)
                {
                    thread.policy_held = false;
                }
                Ok(decision)
            })?;
            self.retire_unexecuted(observer.unexecuted_exits())
        })();
        if observer.detached() {
            lock(&self.state).threads.remove(&root);
            self.progress.notify_all();
        }
        if let Err(error) = &result {
            let mut state = lock(&self.state);
            if state.cancelled(Some(run)) && error.to_string() == UNCLASSIFIED {
                // A cancelled run publishes nothing: what it left unordered is only dropped.
                for records in state.deferred.values_mut() {
                    records.retain(|(owner, _)| *owner != run);
                }
                state.deferred.retain(|_, records| !records.is_empty());
                drop(state);
            } else {
                drop(state);
                self.fail(format!("native observation: {error}"));
            }
            observer.abandon(|tid, status| {
                lock(&self.state).threads.remove(&tid);
                if tid == root {
                    events(ChildEvent::Exited(std::process::ExitStatus::from_raw(
                        status,
                    )));
                }
            });
            self.progress.notify_all();
        }
        result
    }

    /// Removes only terminal lifecycle tombstones after their entire native tree drained.
    /// Creator-side pending calls retain their ordinary completion/exit handling; this is not
    /// a syscall-completion proof and cannot release an intermediate publication barrier.
    fn retire_unexecuted(&self, tids: &[Pid]) -> io::Result<()> {
        if tids.is_empty() {
            return Ok(());
        }
        let mut state = lock(&self.state);
        for tid in tids {
            let Some(thread) = state.threads.get(tid) else {
                return Err(io::Error::other(UNCLASSIFIED));
            };
            let terminal = thread.early.iter().any(|(_, status, _, _)| ended(*status));
            let lifecycle_only = thread.early.iter().all(|(_, status, _, info)| {
                if info.is_some() {
                    return false;
                }
                match WaitStatus::from_raw(*tid, *status) {
                    Ok(
                        WaitStatus::Stopped(..) | WaitStatus::Exited(..) | WaitStatus::Signaled(..),
                    ) => true,
                    Ok(WaitStatus::PtraceEvent(_, _, code)) => {
                        code == Event::PTRACE_EVENT_STOP as i32
                            || code == Event::PTRACE_EVENT_EXIT as i32
                    }
                    _ => false,
                }
            });
            if thread.known_parent
                || thread.pending.is_some()
                || thread.classify_after.is_some()
                || !terminal
                || !lifecycle_only
                || state
                    .deferred
                    .values()
                    .flatten()
                    .any(|(_, info)| info.info.pid == *tid)
            {
                return Err(io::Error::other(UNCLASSIFIED));
            }
        }
        for tid in tids {
            state.threads.remove(tid);
        }
        drop(state);
        self.progress.notify_all();
        Ok(())
    }

    /// Registers a seized command under the scope that spawned it, and hands its classifier
    /// the fork that created it, so its inherited descriptors are the host's.
    fn adopt_root(&self, root: Pid, run: TraceRun, host: Pid, process: OwnedFd) -> io::Result<()> {
        let mut state = lock(&self.state);
        state.run(run)?;
        let cancelled = state.cancelled(Some(run));
        let thread = state.threads.entry(root).or_default();
        thread.inherited = Some(run);
        thread.known_parent = true;
        thread.process = Some(ProcessLease {
            descriptor: process,
            group: root,
        });
        if cancelled {
            thread.kill()?;
        }
        drop(state);
        let fork = Syscall {
            info: SyscallInfo {
                typ: "SYSCALL",
                pid: host,
                syscall: Sysno::fork,
                args: SyscallArgs(Vec::new()),
                result: RetCode::Ok(root.as_raw()),
                duration: Duration::ZERO,
            },
            creation_observed: false,
            entry_order: self.sequence.next()?,
            cwd: None,
            return_fd: None,
            paths: Vec::new(),
            descriptors: Vec::new(),
            flags: None,
            submissions: None,
        };
        self.classify(run, fork)
    }

    fn fail(&self, cause: impl Into<String>) {
        let mut state = lock(&self.state);
        state.failure.get_or_insert_with(|| cause.into());
        for thread in state.threads.values() {
            let _ = thread.kill();
        }
        let waiters: Vec<_> = state
            .runs
            .values_mut()
            .filter_map(|run| run.waker.take())
            .collect();
        drop(state);
        self.progress.notify_all();
        for waker in waiters {
            waker.wake();
        }
    }

    fn deliver(
        &self,
        sequence: u64,
        tid: Pid,
        status: i32,
        event: Option<u64>,
        info: Option<Syscall>,
        entry: Option<EntryInfo<'_>>,
    ) -> io::Result<Resume> {
        let wait = WaitStatus::from_raw(tid, status).map_err(io::Error::other)?;
        let mut resume = Resume::default();
        let mut state = lock(&self.state);
        state.check()?;
        if state.runs.is_empty()
            && matches!(wait, WaitStatus::Exited(..) | WaitStatus::Signaled(..))
        {
            state.threads.remove(&tid);
            return Ok(resume);
        }
        // A missing message means the task was killed at this stop; nothing is left to rekey or
        // adopt through it.
        if matches!(wait, WaitStatus::PtraceEvent(_, _, code) if code == Event::PTRACE_EVENT_EXEC as i32)
            && event.is_some()
        {
            let former = Self::event_thread(event, "missing exec identity")?;
            rekey(&mut state.threads, tid, former);
        }
        if let Some(thread) = state.threads.get_mut(&tid) {
            thread.job_stopped = matches!(
                wait,
                WaitStatus::PtraceEvent(_, signal, code)
                    if code == Event::PTRACE_EVENT_STOP as i32
                        && matches!(
                            signal,
                            Signal::SIGSTOP | Signal::SIGTSTP | Signal::SIGTTIN | Signal::SIGTTOU
                        )
            );
            if matches!(wait, WaitStatus::Stopped(_, signal)
                if !matches!(signal, Signal::SIGSTOP | Signal::SIGCONT
                    | Signal::SIGTSTP | Signal::SIGTTIN | Signal::SIGTTOU))
            {
                // Ordinary exit-only observation is valid, but reuse cannot prove completion.
                if thread.restart.is_some() {
                    thread.restart_uncertain = true;
                }
                thread.safe_restart = None;
            }
        }
        if matches!(wait, WaitStatus::PtraceEvent(..) | WaitStatus::Stopped(..)) {
            Self::lease(&mut state, tid)?;
        }
        if let WaitStatus::PtraceEvent(_, _, code) = wait
            && creation(code)
            && event.is_some()
        {
            let child = Self::event_thread(event, "missing child identity")?;
            let early = Self::adopt(&mut state, tid, child)?;
            let proof =
                info.ok_or_else(|| io::Error::other("creation event lacks inheritance proof"))?;
            let pending = state
                .threads
                .get(&tid)
                .and_then(|thread| thread.pending)
                .ok_or_else(|| io::Error::other("creation proof lacks pending attribution"))?;
            if proof.info.typ != "CREATION"
                || proof.entry_order != pending.entry
                || !matches!(proof.info.result, RetCode::Ok(pid) if pid == child.as_raw())
            {
                return Err(io::Error::other(
                    "creation proof does not match pending attribution",
                ));
            }
            drop(state);
            // Inheritance is now kernel-confirmed. This does not consume the creator's
            // pending call or make its still-running kernel work safe for parking.
            if let Some(run) = pending.run {
                self.classify(run, proof)?;
            }
            let mut held = false;
            for (sequence, status, event, info) in early {
                let replay = self.deliver(sequence, child, status, event, info, None)?;
                // The child was held at its first stop; it goes on unless its replay holds it.
                held = !ended(status) && !replay.hold_current;
                resume.release.extend(replay.release);
                resume.policy.extend(replay.policy);
                if replay.policy_hold {
                    resume.policy.push(child);
                }
            }
            if held {
                resume.release.push(child);
            }
            let mut state = lock(&self.state);
            Self::policy_stop(&mut state, tid, wait, &mut resume)?;
            drop(state);
            self.progress.notify_all();
            return Ok(resume);
        }
        if let Some(thread) = state.threads.get_mut(&tid)
            && !thread.known_parent
        {
            // Nothing it does may run before its owner is known: its records could not be
            // attributed.
            if entry.is_some() {
                return Err(io::Error::other(
                    "unclassified task reached a syscall entry",
                ));
            }
            resume.hold_current = !ended(status);
            thread.early.push((sequence, status, event, info));
            return Ok(resume);
        }
        if matches!(wait, WaitStatus::Exited(..) | WaitStatus::Signaled(..)) {
            state.retire(tid)?;
            state.threads.remove(&tid);
            drop(state);
            self.progress.notify_all();
            return Ok(resume);
        }
        if matches!(wait, WaitStatus::PtraceEvent(_, _, code) if code == Event::PTRACE_EVENT_EXIT as i32)
        {
            state.retire(tid)?;
        }
        let Some(info) = info else {
            Self::note_stop(&mut state, tid, wait, sequence, entry)?;
            Self::policy_stop(&mut state, tid, wait, &mut resume)?;
            drop(state);
            self.progress.notify_all();
            return Ok(resume);
        };
        let Pending {
            entry,
            run,
            safe,
            writes_memory,
        } = state
            .threads
            .get_mut(&tid)
            .and_then(|thread| thread.pending.take())
            .ok_or_else(|| io::Error::other("native completion lacks attribution entry"))?;
        if entry != info.entry_order {
            return Err(io::Error::other("native completion entry mismatch"));
        }
        if safe && matches!(info.info.result, RetCode::Err(-516)) {
            if let Some(thread) = state.threads.get_mut(&tid) {
                thread.safe_restart = Some(writes_memory);
            }
        }
        if !safe && matches!(info.info.result, RetCode::Err(-512 | -513 | -514 | -516)) {
            if let Some(thread) = state.threads.get_mut(&tid) {
                thread.restart = Some(Some(info.info.syscall));
            }
        }
        drop(state);
        if let Some(run) = run {
            self.classify(run, info)?;
        }
        let mut state = lock(&self.state);
        Self::policy_stop(&mut state, tid, wait, &mut resume)?;
        drop(state);
        self.progress.notify_all();
        Ok(resume)
    }

    fn policy_stop(
        state: &mut State,
        tid: Pid,
        wait: WaitStatus,
        resume: &mut Resume,
    ) -> io::Result<()> {
        let Some(run) = state.threads.get(&tid).and_then(|thread| thread.inherited) else {
            return Ok(());
        };
        let stopping = state
            .runs
            .get(&run)
            .is_some_and(|run| matches!(run.phase, RunPhase::Parking(_) | RunPhase::Parked(_)));
        let thread = state.threads.get_mut(&tid).expect("checked thread");
        // Exiting tasks must reach their final wait; they cannot perform more application work.
        let exiting = matches!(wait, WaitStatus::PtraceEvent(_, _, code)
            if code == Event::PTRACE_EVENT_EXIT as i32);
        if stopping && !exiting {
            if thread.pending.is_none_or(|pending| pending.safe)
                && thread.restart.is_none()
                && !thread.restart_uncertain
            {
                thread.policy_held = true;
                resume.hold_current = true;
                resume.policy_hold = true;
            } else {
                // Drain through the call's completion, then hold at its exit stop. Continuing
                // a group-stop here must not re-inject SIGSTOP or release already-held peers.
                resume.drain_current = true;
                if matches!(wait, WaitStatus::Stopped(_, Signal::SIGSTOP)) || thread.job_stopped {
                    if let Some(process) = &thread.process {
                        signal_process(&process.descriptor, libc::SIGCONT)?;
                    }
                }
            }
        }
        Ok(())
    }

    /// Pins a stopped task's process identity once, killing it when its run was cancelled.
    fn lease(state: &mut State, tid: Pid) -> io::Result<()> {
        let cancelled =
            state.cancelled(state.threads.get(&tid).and_then(|thread| thread.inherited));
        let thread = state.threads.entry(tid).or_default();
        if thread.process.is_none()
            && let Some(group) = proc_field::<i32>(format!("/proc/{tid}/status"), "Tgid:")
                .ok()
                .flatten()
                .filter(|group| *group > 0)
            && let Some(descriptor) = alive_process(group)?
        {
            thread.process = Some(ProcessLease {
                descriptor,
                group: Pid::from_raw(group),
            });
        }
        if cancelled {
            thread.kill()?;
        }
        Ok(())
    }

    /// Decodes a ptrace event message that carries a thread identity.
    fn event_thread(event: Option<u64>, missing: &'static str) -> io::Result<Pid> {
        Ok(Pid::from_raw(
            i32::try_from(event.ok_or_else(|| io::Error::other(missing))?)
                .map_err(io::Error::other)?,
        ))
    }

    /// Registers a created thread under its creator's attribution, returning its early stops.
    fn adopt(state: &mut State, tid: Pid, child: Pid) -> io::Result<Vec<Early>> {
        let parent = state.threads.get(&tid);
        let parent_entry = parent.and_then(|thread| thread.pending);
        let inherited = parent_entry
            .and_then(|pending| pending.run)
            .or_else(|| parent.and_then(|thread| thread.inherited));
        let cancelled = state.cancelled(inherited);
        let thread = state.threads.entry(child).or_default();
        thread.known_parent = true;
        thread.inherited = inherited;
        if cancelled {
            thread.kill()?;
        }
        if inherited.is_some() {
            thread.classify_after = parent_entry.map(|pending| pending.entry);
        }
        Ok(std::mem::take(&mut thread.early))
    }

    /// Records a record-less stop: a syscall entry's attribution, or an exit's cleared entry.
    fn note_stop(
        state: &mut State,
        tid: Pid,
        wait: WaitStatus,
        sequence: u64,
        entry: Option<EntryInfo<'_>>,
    ) -> io::Result<()> {
        let thread = state.threads.entry(tid).or_default();
        if entry.as_ref().is_some_and(|entry| entry.result.is_none()) {
            let entry = entry.expect("checked entry");
            if let Some(restarted) = thread.restart.take() {
                if restarted != entry.syscall {
                    thread.restart_uncertain = true;
                }
            }
            let restarted = thread
                .safe_restart
                .take()
                .filter(|_| entry.syscall == Some(Sysno::restart_syscall));
            let writes_memory = restarted.unwrap_or_else(|| match entry.syscall {
                Some(
                    Sysno::write
                    | Sysno::writev
                    | Sysno::sendto
                    | Sysno::splice
                    | Sysno::tee
                    | Sysno::futex
                    | Sysno::rt_sigsuspend,
                ) => false,
                #[cfg(target_arch = "x86_64")]
                Some(Sysno::pause) => false,
                _ => true,
            });
            let safe = (restarted.is_some() || Captured::park_safe(entry.syscall, entry.capture))
                && (!writes_memory || !shared_writable_mapping(tid)?);
            let pending = Pending {
                entry: sequence,
                run: thread.inherited,
                safe,
                writes_memory,
            };
            if thread.pending.replace(pending).is_some() {
                return Err(io::Error::other(
                    "native entry replaced pending attribution",
                ));
            }
        } else if matches!(wait, WaitStatus::PtraceSyscall(_)) {
            // Unselected calls carry no completed record, but still close their entry.
            let pending = thread
                .pending
                .take()
                .ok_or_else(|| io::Error::other("native unselected completion lacks entry"))?;
            if let Some(entry) = entry {
                if pending.safe && matches!(entry.result, Some(RetCode::Err(-516))) {
                    thread.safe_restart = Some(pending.writes_memory);
                }
                if !pending.safe
                    && matches!(entry.result, Some(RetCode::Err(-512 | -513 | -514 | -516)))
                {
                    thread.restart = Some(entry.syscall);
                }
            }
        } else if matches!(wait, WaitStatus::PtraceEvent(_, _, code) if code == Event::PTRACE_EVENT_EXIT as i32)
        {
            thread.pending = None;
            thread.restart = None;
            thread.safe_restart = None;
            thread.restart_uncertain = false;
        }
        Ok(())
    }

    fn classify(&self, run: TraceRun, info: Syscall) -> io::Result<()> {
        let _delivery = self.delivery(run)?;
        let mut state = lock(&self.state);
        if let Some(entry) = state
            .threads
            .get(&info.info.pid)
            .and_then(|thread| thread.classify_after)
        {
            state.deferred.entry(entry).or_default().push((run, info));
            return Ok(());
        }
        let created = (matches!(
            info.info.syscall,
            Sysno::clone | Sysno::clone3 | Sysno::fork | Sysno::vfork
        ) && !info.creation_observed)
            .then_some(info.entry_order);
        let observe = state
            .roots
            .get(&run.root)
            .map(|root| Arc::clone(&root.observe));
        drop(state);
        if let Some(observe) = observe {
            observe(run, info)?;
        }
        if let Some(entry) = created {
            let mut state = lock(&self.state);
            for thread in state.threads.values_mut() {
                if thread.classify_after == Some(entry) {
                    thread.classify_after = None;
                }
            }
            let deferred = state.deferred.remove(&entry).unwrap_or_default();
            drop(state);
            for (run, info) in deferred {
                self.classify(run, info)?;
            }
        }
        Ok(())
    }
}

impl Drop for Tracing {
    fn drop(&mut self) {
        // Only the published generation clears its entry.
        let mut shared = lock(&SHARED);
        if shared
            .as_ref()
            .is_some_and(|weak| std::ptr::eq(weak.as_ptr(), self))
        {
            *shared = None;
        }
        drop(shared);
    }
}

/// The child's side of the launch handshake: announce its pid, then wait to be released.
fn handshake(request: RawFd, release: RawFd) -> io::Result<()> {
    // SAFETY: getpid has no preconditions.
    let pid = unsafe { libc::getpid() }.to_ne_bytes();
    let mut written = 0;
    while written < pid.len() {
        // SAFETY: the buffer is live for the stated length; the descriptor was inherited open.
        let count =
            unsafe { libc::write(request, pid[written..].as_ptr().cast(), pid.len() - written) };
        match usize::try_from(count) {
            Ok(count) => written += count,
            Err(_) if Errno::last() == Errno::EINTR => {}
            Err(_) => return Err(io::Error::last_os_error()),
        }
    }
    let mut byte = 0_u8;
    loop {
        // SAFETY: one writable byte; the descriptor was inherited open.
        let count = unsafe { libc::read(release, (&raw mut byte).cast(), 1) };
        if count == 1 && byte == 1 {
            return Ok(());
        }
        if count < 0 && Errno::last() == Errno::EINTR {
            continue;
        }
        // The tracer refused or vanished: never run unobserved.
        return Err(io::Error::from_raw_os_error(libc::EPERM));
    }
}

/// Whether a raw wait status is a task's final exit rather than a stop.
const fn ended(status: i32) -> bool {
    libc::WIFEXITED(status) || libc::WIFSIGNALED(status)
}

/// Tells the spawner what a delivered stop means for its command's own process.
fn report(events: &mut dyn FnMut(ChildEvent), status: i32) -> io::Result<()> {
    match WaitStatus::from_raw(Pid::from_raw(0), status)? {
        WaitStatus::Exited(..) | WaitStatus::Signaled(..) => {
            events(ChildEvent::Exited(std::process::ExitStatus::from_raw(
                status,
            )));
        }
        WaitStatus::PtraceEvent(_, signal, code)
            if code == Event::PTRACE_EVENT_STOP as i32
                && matches!(
                    signal,
                    Signal::SIGSTOP | Signal::SIGTSTP | Signal::SIGTTIN | Signal::SIGTTOU
                ) =>
        {
            events(ChildEvent::Stopped);
        }
        _ => {}
    }
    Ok(())
}

/// A close-on-exec pipe: read end, write end.
fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let (read, write) = io::pipe()?;
    Ok((read.into(), write.into()))
}

/// An issued attribution bracket; its identifier is valid only in its owning service.
pub struct TraceScope {
    tracing: Arc<Tracing>,
    id: ScopeId,
    target: Option<TraceRun>,
}

impl TraceScope {
    /// Enters on this thread. The guard cannot move to another thread.
    pub fn enter(&self) -> TraceScopeGuard {
        let service = Arc::as_ptr(&self.tracing) as usize;
        ENTERED.with_borrow_mut(|entered| entered.push((service, self.id, self.target)));
        TraceScopeGuard {
            tracing: Arc::clone(&self.tracing),
            id: self.id,
            thread: PhantomData,
        }
    }
}

/// A thread-bound scope exit guard. Never hold across an await.
pub struct TraceScopeGuard {
    tracing: Arc<Tracing>,
    id: ScopeId,
    thread: PhantomData<Rc<()>>,
}

impl Drop for TraceScopeGuard {
    fn drop(&mut self) {
        let popped = ENTERED.with_borrow_mut(Vec::pop);
        if popped.map(|(_, id, _)| id) != Some(self.id) {
            self.tracing.fail("non-LIFO trace scope");
        }
    }
}

/// A per-poll context whose guard is entered for one poll and dropped before it returns.
pub trait PollScope {
    /// The thread-bound exit guard; it is never held across a suspension.
    type Guard;
    /// Enters this scope on the polling thread.
    fn enter(&self) -> Self::Guard;
}

impl PollScope for TraceScope {
    type Guard = TraceScopeGuard;
    fn enter(&self) -> TraceScopeGuard {
        Self::enter(self)
    }
}

/// A future whose individual polls, not its suspended intervals, belong to a scope.
pub struct Scoped<F, S> {
    inner: F,
    scope: S,
}

impl<F: Future, S: PollScope> Scoped<F, S> {
    /// Wraps one future in an already-issued scope.
    pub const fn new(inner: F, scope: S) -> Self {
        Self { inner, scope }
    }
}

impl<F: Future, S: PollScope> Future for Scoped<F, S> {
    type Output = F::Output;
    fn poll(
        self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Self::Output> {
        // SAFETY: `inner` is structurally pinned and never moved by this implementation;
        // `scope` is only borrowed.
        let this = unsafe { self.get_unchecked_mut() };
        let _scope = this.scope.enter();
        // SAFETY: projection preserves the pin on `inner` for the lifetime of `Self`.
        unsafe { std::pin::Pin::new_unchecked(&mut this.inner) }.poll(context)
    }
}

/// Opens a pidfd pinning the identity of live process `pid`, so a later signal cannot reach a
/// recycled PID.
///
/// # Errors
/// Fails when the process no longer exists or the kernel refuses a pidfd.
pub fn open_process(pid: i32) -> io::Result<OwnedFd> {
    // SAFETY: pidfd_open accepts two integer arguments and accesses no pointer.
    let fd = i32::try_from(Errno::result(unsafe {
        libc::syscall(libc::SYS_pidfd_open, pid, 0)
    })?)
    .map_err(io::Error::other)?;
    // SAFETY: the syscall returned a fresh descriptor owned by this function.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

/// A pidfd for `pid`, or `None` once it has vanished.
fn alive_process(pid: i32) -> io::Result<Option<OwnedFd>> {
    match open_process(pid) {
        Ok(descriptor) => Ok(Some(descriptor)),
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Ok(None),
        Err(error) => Err(error),
    }
}

/// Sends `signal` through a pidfd; answers whether the process was still alive to receive it.
///
/// # Errors
/// Fails for any refusal other than the process having already exited.
pub fn signal_process(process: &OwnedFd, signal: i32) -> io::Result<bool> {
    // SAFETY: the descriptor pins process identity; a null siginfo requests the standard signal.
    Ok(alive(Errno::result(unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            process.as_raw_fd(),
            signal,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        )
    }))?
    .is_some())
}

#[cfg(test)]
mod tests;
