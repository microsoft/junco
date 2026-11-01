//! Seized-only observation of spawned descendants around lurk's native types, argument table and
//! filter. It runs on the in-process tracer thread that seized them: the host itself is never
//! traced, which Linux refuses within one thread group anyway. No CLI, renderer, tracee launcher,
//! or dependency source patch participates here.
//!
//! A newborn killed before its adoption event may first report EXIT. Such terminal holds
//! drain only after every creator is exiting; their lifecycle tombstones survive until the
//! whole tree is reaped. This never completes a pending syscall or seals a parked epoch.

use std::collections::HashMap;
use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use lurk_cli::args::Args;
use lurk_cli::syscall_info::RetCode;
use nix::errno::Errno;
use nix::sys::ptrace::{self, Event, Options};
use nix::sys::signal::Signal;
use nix::sys::wait::WaitStatus;
use nix::unistd::Pid;
use syscalls::{Sysno, SysnoSet};

use crate::Syscall;
use crate::capture::{Captured, native_usize, proc_field};
use crate::ring::Rings;

#[cfg(target_arch = "x86_64")]
const NATIVE_ARCH: u32 = 0xC000_003E;
#[cfg(target_arch = "aarch64")]
const NATIVE_ARCH: u32 = 0xC000_00B7;
#[cfg(target_arch = "riscv64")]
const NATIVE_ARCH: u32 = 0xC000_00F3;

const OPTIONS: Options = Options::PTRACE_O_TRACESYSGOOD
    .union(Options::PTRACE_O_TRACEFORK)
    .union(Options::PTRACE_O_TRACEVFORK)
    .union(Options::PTRACE_O_TRACECLONE)
    .union(Options::PTRACE_O_TRACEEXEC)
    .union(Options::PTRACE_O_TRACEEXIT);

/// What a delivered stop asks of the observer, after the consumer has seen it.
#[derive(Debug, Default)]
pub(crate) struct Resume {
    /// Keep the delivered task stopped until a later delivery releases it.
    pub hold_current: bool,
    /// The hold is an intentional closed-evidence barrier, not unclassified adoption.
    pub policy_hold: bool,
    /// Drain an unsafe pending call without reinjecting a job-control signal.
    pub drain_current: bool,
    /// Held tasks to resume now, each from the stop it was held at.
    pub release: Vec<Pid>,
    /// Adoption stops whose ownership is now known and whose hold is now policy-owned.
    pub policy: Vec<Pid>,
}

/// Control decisions are executed only by the thread owning these ptrace relationships.
pub(crate) enum Control {
    Release,
    Hold,
    Interrupt,
}

/// Borrowed entry-time capture; unknown and unselected calls are explicit too.
pub(crate) struct EntryInfo<'a> {
    pub syscall: Option<Sysno>,
    pub capture: Option<&'a Captured>,
    /// Unselected exits still close their pending call, including kernel restart results.
    pub result: Option<RetCode>,
}

/// A stop, completed evidence, and (only at entry) borrowed capture information.
pub(crate) type Observe<'a> = dyn FnMut(u64, Pid, i32, Option<u64>, Option<Syscall>, Option<EntryInfo<'_>>) -> io::Result<Resume>
    + 'a;

/// Why held tasks cannot be classified once every other task has begun exiting.
pub(crate) const UNCLASSIFIED: &str = "native creator exited with unclassified child effects";

struct Entry {
    syscall: Sysno,
    capture: Captured,
    order: u64,
    started: Instant,
    creation_observed: bool,
}

/// A pending exec's thread group and entry, read while its caller was still stopped.
#[derive(Clone, Copy)]
struct PendingExec {
    group: Pid,
    entry: u64,
}

/// A former exec caller identity a real EXEC wait proved extinct, with its unfinished entry.
pub(crate) struct ReplacedExec {
    pub(crate) tid: Pid,
    pub(crate) group: Pid,
    pub(crate) entry: u64,
}

#[derive(Default)]
struct Task {
    /// Whether an entry, or the one return allowed before any, has kept this task in step.
    synchronized: bool,
    in_syscall: bool,
    syscall: Option<Sysno>,
    /// An exit event was observed; no later creation event can come from this task.
    exiting: bool,
    entry: Option<Entry>,
    interrupt_requested: bool,
    pending_exec: Option<PendingExec>,
}

struct Held {
    status: i32,
    policy: bool,
}

/// The service-wide delivery order shared by every tracer thread and host record.
#[derive(Default)]
pub(crate) struct Sequence(AtomicU64);

impl Sequence {
    pub(crate) fn next(&self) -> io::Result<u64> {
        self.0
            .try_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                value.checked_add(1)
            })
            .map(|previous| previous + 1)
            .map_err(|_| io::Error::other("native delivery sequence exhausted"))
    }
}

pub(crate) struct Observer {
    selected: SysnoSet,
    tasks: HashMap<Pid, Task>,
    sequence: Arc<Sequence>,
    /// The spawned command this thread seized.
    root: Pid,
    /// Whether `root` has replaced its launcher image.
    root_executed: bool,
    /// Whether `root` was released untraced after its exec failed.
    detached: bool,
    /// The `io_uring` rings this tree set up.
    rings: Rings,
    /// Stops left unresumed at the consumer's request, by task: their raw status.
    held: HashMap<Pid, Held>,
    /// Newborn tasks drained only after every possible creator began exiting.
    unexecuted_exits: Vec<Pid>,
    /// Extinct former exec identities the consumer has not yet released.
    replaced_execs: Vec<ReplacedExec>,
}

impl Observer {
    /// The observed syscalls: lurk's categories plus the interfaces its 0.3.14 lists predate.
    pub(crate) fn selection() -> io::Result<SysnoSet> {
        let args = Args {
            follow_forks: true,
            expr: vec!["trace=%file,%desc,%process,%memory,%fstat,%fstatfs".into()],
            ..Args::default()
        };
        let mut selected = args
            .create_filter()
            .map_err(io::Error::other)?
            .all_enabled();
        for syscall in [
            Sysno::openat2,
            Sysno::clone3,
            Sysno::close_range,
            Sysno::faccessat2,
            Sysno::fchmodat2,
            Sysno::io_uring_setup,
            Sysno::io_uring_enter,
            Sysno::io_uring_register,
            Sysno::io_submit,
            Sysno::io_getevents,
            Sysno::futex,
            Sysno::sendto,
            Sysno::recvfrom,
        ] {
            selected.insert(syscall);
        }
        Ok(selected)
    }

    pub(crate) fn new(selected: SysnoSet, sequence: Arc<Sequence>, root: Pid) -> Self {
        Self {
            selected,
            tasks: HashMap::new(),
            sequence,
            root,
            root_executed: false,
            detached: false,
            rings: Rings::default(),
            held: HashMap::new(),
            unexecuted_exits: Vec::new(),
            replaced_execs: Vec::new(),
        }
    }

    /// Whether the command was handed back untraced because its exec failed: the launcher then
    /// reports that failure and reaps the process itself.
    pub(crate) const fn detached(&self) -> bool {
        self.detached
    }

    /// Terminal-only tasks whose adoption event was lost when their creator died.
    pub(crate) fn unexecuted_exits(&self) -> &[Pid] {
        &self.unexecuted_exits
    }

    /// Seizes a spawned child and returns its first ptrace stop, still unresumed, or `None`
    /// once the child vanished first. An interrupt may be acknowledged by another stop kind;
    /// the normal dispatcher must consume that stop rather than waiting for a second trap.
    pub(crate) fn seize(&mut self, pid: Pid) -> io::Result<Option<i32>> {
        ptrace::seize(pid, OPTIONS)
            .map_err(|error| io::Error::other(format!("seizing child {pid}: {error}")))?;
        self.tasks.insert(pid, Task::default());
        // A child that died meanwhile is still reported, and reaped, by the wait below.
        alive(ptrace::interrupt(pid))?;
        loop {
            let mut status = 0;
            // SAFETY: status points to one writable integer; the pid is this thread's tracee.
            let waited = unsafe {
                libc::waitpid(
                    pid.as_raw(),
                    &raw mut status,
                    libc::__WALL | libc::__WNOTHREAD,
                )
            };
            if waited < 0 {
                match Errno::last() {
                    Errno::EINTR => continue,
                    error => return Err(error.into()),
                }
            }
            match WaitStatus::from_raw(pid, status)? {
                WaitStatus::Stopped(..)
                | WaitStatus::PtraceEvent(..)
                | WaitStatus::PtraceSyscall(..) => {
                    return Ok(Some(status));
                }
                WaitStatus::Exited(..) | WaitStatus::Signaled(..) => {
                    self.tasks.remove(&pid);
                    return Ok(None);
                }
                _ => {}
            }
        }
    }

    #[cfg(test)]
    /// Observes an ordinary exit-only tree without policy-held stops.
    pub(crate) fn run(&mut self, observe: &mut Observe<'_>) -> io::Result<()> {
        self.run_controlled(observe, &mut |_, _| Ok(Control::Hold), &mut |_| Ok(()))
    }

    /// Policy holds are released only after the owner consumes its current token. Former exec
    /// identities proven extinct reach `retire_execs` before any further control or wait.
    pub(crate) fn run_controlled(
        &mut self,
        observe: &mut Observe<'_>,
        control: &mut dyn FnMut(Pid, bool) -> io::Result<Control>,
        retire_execs: &mut dyn FnMut(&[ReplacedExec]) -> io::Result<()>,
    ) -> io::Result<()> {
        let mut release = Vec::new();
        loop {
            if !self.replaced_execs.is_empty() {
                retire_execs(&self.replaced_execs)?;
                self.replaced_execs.clear();
            }
            for (&tid, task) in &mut self.tasks {
                let held = self.held.get(&tid);
                if task.exiting || held.is_some_and(|held| !held.policy) {
                    continue;
                }
                match control(tid, held.is_some())? {
                    Control::Release if held.is_some() => release.push(tid),
                    Control::Interrupt if held.is_none() && !task.interrupt_requested => {
                        // Holding SIGSTOP's delivery in one thread can prevent the group's stop
                        // from completing. Interrupt every safe task through its owning tracer.
                        match ptrace::interrupt(tid) {
                            Ok(()) | Err(Errno::EIO) => task.interrupt_requested = true,
                            Err(Errno::ESRCH) => {}
                            Err(error) => return Err(error.into()),
                        }
                    }
                    _ => {}
                }
            }
            for tid in release.drain(..) {
                self.held.remove(&tid);
                // SIGCONT has already cleared any group-stop. Never reinject SIGSTOP.
                resume(tid, None)?;
            }
            if self.held.values().any(|held| !held.policy)
                && self
                    .tasks
                    .iter()
                    .all(|(tid, task)| task.exiting || self.held.contains_key(tid))
            {
                // exit_group/SIGKILL can replace a newborn's attachment stop with EXIT before
                // its creator's event message can be read. An exit stop must reach its final
                // wait, but only after every possible creator is exiting: otherwise its late
                // adoption still needs the held task and its buffered lifecycle records.
                let terminal_only = self.tasks.values().all(|task| task.exiting)
                    && self.held.iter().all(|(tid, held)| {
                        held.policy
                            || self.tasks.get(tid).is_some_and(|task| {
                                !task.synchronized
                                    && !task.in_syscall
                                    && task.entry.is_none()
                                    && matches!(
                                        WaitStatus::from_raw(*tid, held.status),
                                        Ok(WaitStatus::PtraceEvent(_, _, code))
                                            if code == Event::PTRACE_EVENT_EXIT as i32
                                    )
                            })
                    });
                if terminal_only {
                    for (&tid, held) in &self.held {
                        if !held.policy {
                            release.push(tid);
                        }
                    }
                    for tid in release.drain(..) {
                        self.held.remove(&tid);
                        self.unexecuted_exits.push(tid);
                        resume(tid, None)?;
                    }
                    continue;
                }
                return Err(io::Error::other(UNCLASSIFIED));
            }
            match wait_ready(!self.held.is_empty())? {
                Waited::Stop(tid, status) => self.stop(tid, status, observe)?,
                Waited::End => break,
                Waited::Pending => {
                    // ponytail: poll only while ptrace-held; use a tracer wake fd if measured.
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
            }
        }
        if self.tasks.is_empty() {
            Ok(())
        } else {
            Err(io::Error::other(
                "native wait ended before every task's final exit",
            ))
        }
    }

    /// After a failure: kills every tracee and resumes whatever still stops, observing nothing,
    /// until none is left. `retired` sees each final status, or `None` for a former exec identity
    /// already proven extinct; no tracee is left stopped or unreaped.
    pub(crate) fn abandon(&mut self, mut retired: impl FnMut(Pid, Option<i32>)) {
        // Never signaled or waited for: their numeric TIDs no longer name these tasks.
        for replaced in std::mem::take(&mut self.replaced_execs) {
            retired(replaced.tid, None);
        }
        for tid in self.tasks.keys() {
            let _ = nix::sys::signal::kill(*tid, Signal::SIGKILL);
        }
        // A held task stays stopped until resumed; the kill above ends it there.
        for tid in std::mem::take(&mut self.held).into_keys() {
            let _ = ptrace::cont(tid, None);
        }
        while let Ok(Some((tid, status))) = wait_any() {
            if let Ok(WaitStatus::Exited(..) | WaitStatus::Signaled(..)) =
                WaitStatus::from_raw(tid, status)
            {
                self.tasks.remove(&tid);
                retired(tid, Some(status));
            } else {
                // A task created after the kill above is killed on its first stop.
                if self.tasks.insert(tid, Task::default()).is_none() {
                    let _ = nix::sys::signal::kill(tid, Signal::SIGKILL);
                }
                let _ = ptrace::cont(tid, None);
            }
        }
    }

    /// Applies a lifecycle stop and its stop-bound message to the task table, returning it.
    fn lifecycle(&mut self, tid: Pid, code: i32, message: Option<u64>) -> io::Result<Option<u64>> {
        let exec = code == Event::PTRACE_EVENT_EXEC as i32;
        if exec && tid == self.root {
            self.root_executed = true;
        }
        let other = if creation(code) || exec {
            Some(event_pid(message)?)
        } else {
            None
        };
        match other {
            Some(former) if exec => rekey(&mut self.tasks, tid, former),
            Some(child) => {
                self.tasks.entry(child).or_default();
            }
            None => {}
        }
        let task = self.tasks.entry(tid).or_default();
        if code == Event::PTRACE_EVENT_EXIT as i32 {
            // exit/exit_group never return. A killed or exec-displaced call is also
            // retired here, without manufacturing a successful kernel result.
            task.entry = None;
            task.in_syscall = false;
            task.pending_exec = None;
            task.exiting = true;
        }
        Ok(message)
    }

    /// A real EXEC wait for `group` proves `de_thread` released every other task of that group,
    /// including its caller's former TID: those exec entries can never complete. Nothing is
    /// resumed, signaled, rekeyed or completed here; the consumer releases their bookkeeping.
    fn retire_replaced_exec(&mut self, group: Pid) {
        let replaced = self.tasks.extract_if(|tid, task| {
            *tid != group
                && task
                    .pending_exec
                    .is_some_and(|pending| pending.group == group)
        });
        for (tid, task) in replaced {
            if let Some(PendingExec { group, entry }) = task.pending_exec {
                self.held.remove(&tid);
                self.replaced_execs.push(ReplacedExec { tid, group, entry });
            }
        }
    }

    /// Delivers one stop, then resumes its task unless the consumer holds it.
    pub(crate) fn stop(
        &mut self,
        tid: Pid,
        status: i32,
        observe: &mut Observe<'_>,
    ) -> io::Result<()> {
        let wait = WaitStatus::from_raw(tid, status)?;
        let message = match wait {
            WaitStatus::PtraceEvent(_, signal, code) if carries_message(code) => {
                // A woken task's successor stop replaces both message and siginfo. Reading the
                // siginfo after the message proves the message still belongs to this wait status.
                let message = event_message(tid, code)?;
                let current = match message {
                    Some(_) => alive(ptrace::getsiginfo(tid))?,
                    None => None,
                };
                if let (Some(message), Some(info)) = (message, current)
                    && info.si_code == (code << 8) | signal as i32
                {
                    Some(message)
                } else {
                    // Vanished or already at its successor stop, whose own wait drains it. A
                    // real EXEC wait still proves de_thread released its group's other tasks.
                    if code == Event::PTRACE_EVENT_EXEC as i32 {
                        self.retire_replaced_exec(tid);
                    }
                    return Ok(());
                }
            }
            _ => None,
        };
        if let Some(task) = self.tasks.get_mut(&tid) {
            task.interrupt_requested = false;
        }
        let event = match wait {
            WaitStatus::PtraceSyscall(_) => return self.syscall_stop(tid, status, observe),
            WaitStatus::Exited(..) | WaitStatus::Signaled(..) => {
                self.tasks.remove(&tid);
                self.held.remove(&tid);
                None
            }
            WaitStatus::PtraceEvent(_, _, code) => self.lifecycle(tid, code, message)?,
            WaitStatus::Stopped(..) => {
                self.tasks.entry(tid).or_default();
                None
            }
            WaitStatus::Continued(_) | WaitStatus::StillAlive => return Ok(()),
        };
        let info = if matches!(wait, WaitStatus::PtraceEvent(_, _, code) if creation(code))
            && let Some(message) = event
        {
            let child = event_pid(Some(message))?;
            let entry = self
                .tasks
                .get_mut(&tid)
                .and_then(|task| task.entry.as_mut())
                .ok_or_else(|| io::Error::other("creation event lacks captured entry"))?;
            if entry.creation_observed
                || !matches!(
                    entry.syscall,
                    Sysno::clone | Sysno::clone3 | Sysno::fork | Sysno::vfork
                )
            {
                return Err(io::Error::other(
                    "creation event does not match pending call",
                ));
            }
            let info = entry.capture.created(
                tid,
                entry.syscall,
                child,
                entry.order,
                entry.started.elapsed(),
            )?;
            entry.creation_observed = true;
            Some(info)
        } else {
            None
        };
        let resume = observe(self.sequence.next()?, tid, status, event, info, None)?;
        self.apply(tid, status, resume)
    }

    /// Resumes the delivered task — or holds it — and every held task the consumer released.
    /// A released task resumes from its own saved stop; nothing about that stop is delivered
    /// again.
    fn apply(&mut self, tid: Pid, status: i32, decision: Resume) -> io::Result<()> {
        let wait = WaitStatus::from_raw(tid, status)?;
        self.held.remove(&tid);
        if decision.hold_current
            && !matches!(wait, WaitStatus::Exited(..) | WaitStatus::Signaled(..))
        {
            self.held.insert(
                tid,
                Held {
                    status,
                    policy: decision.policy_hold,
                },
            );
        } else if decision.drain_current {
            resume(tid, None)?;
        } else {
            resume_stop(tid, wait)?;
        }
        for released in decision.release {
            if let Some(held) = self.held.remove(&released) {
                if held.policy {
                    resume(released, None)?;
                } else {
                    resume_stop(released, WaitStatus::from_raw(released, held.status)?)?;
                }
            }
        }
        for held in decision.policy {
            if let Some(held) = self.held.get_mut(&held) {
                held.policy = true;
            }
        }
        Ok(())
    }

    fn syscall_stop(&mut self, tid: Pid, status: i32, observe: &mut Observe<'_>) -> io::Result<()> {
        let Some(info) = syscall_info(tid)? else {
            return Ok(());
        };
        if info.arch != NATIVE_ARCH {
            return Err(io::Error::other(format!(
                "task {tid} uses unsupported syscall ABI {:#x}",
                info.arch
            )));
        }
        match info.op {
            libc::PTRACE_SYSCALL_INFO_ENTRY => {
                // SAFETY: the kernel tagged this as the entry union member.
                let number = unsafe { info.u.entry.nr };
                #[cfg(target_arch = "x86_64")]
                if number & 0x4000_0000 != 0 {
                    return Err(io::Error::other("x32 syscalls cannot be observed natively"));
                }
                self.entry(tid, status, number, observe)
            }
            libc::PTRACE_SYSCALL_INFO_EXIT => {
                // SAFETY: the kernel tagged this as the exit union member.
                let exit = unsafe { info.u.exit };
                let result = if exit.is_error != 0 {
                    RetCode::Err(i32::try_from(exit.sval).map_err(io::Error::other)?)
                } else if let Ok(value) = i32::try_from(exit.sval)
                    && (0..=0x8000).contains(&value)
                {
                    RetCode::Ok(value)
                } else {
                    // Upstream Address is also a success: preserve all large values, not
                    // only addresses, and never infer errno from a signed-looking bit pattern.
                    RetCode::Address(native_usize(exit.sval.cast_unsigned()))
                };
                self.exit(tid, status, result, observe)
            }
            // The kernel no longer holds this task at a syscall stop (it was killed or woken
            // between the wait and this query): nothing is left to record, only to release.
            libc::PTRACE_SYSCALL_INFO_NONE => resume(tid, None),
            operation => Err(io::Error::other(format!(
                "unexpected syscall stop kind {operation} for {tid}"
            ))),
        }
    }

    fn entry(
        &mut self,
        tid: Pid,
        status: i32,
        number: u64,
        observe: &mut Observe<'_>,
    ) -> io::Result<()> {
        let syscall = usize::try_from(number).ok().and_then(Sysno::new);
        // Read while the caller's original TID still names it: only a real EXEC wait for this
        // thread group may later retire the entry once that former TID has vanished.
        let group = if matches!(syscall, Some(Sysno::execve | Sysno::execveat)) {
            match proc_field::<i32>(format!("/proc/{tid}/status"), "Tgid:") {
                Ok(group) => Some(
                    group
                        .filter(|group| *group > 0)
                        .map(Pid::from_raw)
                        .ok_or_else(|| io::Error::other("missing or invalid exec thread group"))?,
                ),
                // This stopped entry vanished; its real terminal wait owns cleanup.
                Err(error) if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ESRCH)) => {
                    return Ok(());
                }
                Err(error) => return Err(error),
            }
        } else {
            None
        };
        let pending_exec = |entry| group.map(|group| PendingExec { group, entry });
        let task = self.tasks.entry(tid).or_default();
        if task.in_syscall {
            return Err(io::Error::other(format!(
                "task {tid} replaced an incomplete syscall"
            )));
        }
        task.in_syscall = true;
        task.synchronized = true;
        task.syscall = syscall;
        let selected = syscall.filter(|syscall| self.selected.contains(*syscall));
        if let Some(syscall) = selected {
            let Some(registers) = alive(ptrace::getregs(tid))? else {
                return Ok(());
            };
            let mut capture = Captured::at_entry(tid, syscall, registers)?;
            if syscall == Sysno::io_uring_enter {
                capture.submit(self.rings.pending(tid, capture.descriptor(0)));
            }
            let order = self.sequence.next()?;
            let task = self
                .tasks
                .get_mut(&tid)
                .ok_or_else(|| io::Error::other("missing entry task"))?;
            task.entry = Some(Entry {
                syscall,
                capture,
                order,
                started: Instant::now(),
                creation_observed: false,
            });
            task.pending_exec = pending_exec(order);
            let entry = self
                .tasks
                .get(&tid)
                .and_then(|task| task.entry.as_ref())
                .ok_or_else(|| io::Error::other("missing entry capture"))?;
            let resume = observe(
                order,
                tid,
                status,
                None,
                None,
                Some(EntryInfo {
                    syscall: Some(syscall),
                    capture: Some(&entry.capture),
                    result: None,
                }),
            )?;
            return self.apply(tid, status, resume);
        }
        let order = self.sequence.next()?;
        self.tasks
            .get_mut(&tid)
            .ok_or_else(|| io::Error::other("missing entry task"))?
            .pending_exec = pending_exec(order);
        let resume = observe(
            order,
            tid,
            status,
            None,
            None,
            Some(EntryInfo {
                syscall,
                capture: None,
                result: None,
            }),
        )?;
        self.apply(tid, status, resume)
    }

    fn exit(
        &mut self,
        tid: Pid,
        status: i32,
        result: RetCode,
        observe: &mut Observe<'_>,
    ) -> io::Result<()> {
        let task = self.tasks.entry(tid).or_default();
        if !task.in_syscall {
            if task.synchronized {
                return Err(io::Error::other(format!(
                    "task {tid} returned without an observed entry"
                )));
            }
            // One syscall may predate attachment (or be the child's inherited clone return).
            task.synchronized = true;
            return resume(tid, None);
        }
        task.in_syscall = false;
        task.pending_exec = None;
        let syscall = task.syscall.take();
        if let Some(entry) = task.entry.take() {
            let mut call = entry.capture.complete(
                tid,
                entry.syscall,
                result,
                entry.order,
                entry.started.elapsed(),
            )?;
            call.creation_observed = entry.creation_observed;
            if call.info.syscall == Sysno::io_uring_setup
                && !matches!(call.info.result, RetCode::Err(_))
            {
                self.rings.created(tid, &mut call);
            }
            let failed_launch = tid == self.root
                && !self.root_executed
                && matches!(call.info.syscall, Sysno::execve | Sysno::execveat)
                && matches!(call.info.result, RetCode::Err(_));
            let resume = observe(self.sequence.next()?, tid, status, None, Some(call), None)?;
            if failed_launch {
                // The launcher now reports the errno and waits for this process itself. Only
                // the launcher's own code runs from here, which ran untraced before the
                // handshake too; its wait must not race this thread for the remaining stops.
                alive(ptrace::detach(tid, None))?;
                self.tasks.remove(&tid);
                self.detached = true;
                return Ok(());
            }
            return self.apply(tid, status, resume);
        }
        let resume = observe(
            self.sequence.next()?,
            tid,
            status,
            None,
            None,
            Some(EntryInfo {
                syscall,
                capture: None,
                result: Some(result),
            }),
        )?;
        self.apply(tid, status, resume)
    }
}

fn event_pid(event: Option<u64>) -> io::Result<Pid> {
    let raw = event
        .and_then(|value| i32::try_from(value).ok())
        .filter(|raw| *raw > 0)
        .ok_or_else(|| io::Error::other("missing or invalid ptrace lifecycle identity"))?;
    Ok(Pid::from_raw(raw))
}

pub(crate) const fn creation(event: i32) -> bool {
    event == Event::PTRACE_EVENT_CLONE as i32
        || event == Event::PTRACE_EVENT_FORK as i32
        || event == Event::PTRACE_EVENT_VFORK as i32
}

const fn carries_message(event: i32) -> bool {
    creation(event)
        || event == Event::PTRACE_EVENT_EXEC as i32
        || event == Event::PTRACE_EVENT_EXIT as i32
}

fn event_message(tid: Pid, event: i32) -> io::Result<Option<u64>> {
    if carries_message(event) {
        // A killed task leaves its stop at once; ESRCH is its vanishing, not a failure.
        alive(ptrace::getevent(tid)).map(|message| message.map(i64::cast_unsigned))
    } else {
        Ok(None)
    }
}

fn resume(tid: Pid, signal: Option<Signal>) -> io::Result<()> {
    alive(ptrace::syscall(tid, signal)).map(|_| ())
}

/// Treats a vanished task (`ESRCH`) as absent rather than as an observation failure.
pub(crate) fn alive<T>(result: nix::Result<T>) -> io::Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(Errno::ESRCH) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// Moves an exec-displaced thread's bookkeeping to the thread that now owns its identity.
pub(crate) fn rekey<V>(map: &mut HashMap<Pid, V>, tid: Pid, former: Pid) {
    if former != tid
        && let Some(value) = map.remove(&former)
    {
        map.insert(tid, value);
    }
}

fn resume_stop(tid: Pid, wait: WaitStatus) -> io::Result<()> {
    match wait {
        WaitStatus::PtraceEvent(_, signal, code)
            if code == Event::PTRACE_EVENT_STOP as i32
                && matches!(
                    signal,
                    Signal::SIGSTOP | Signal::SIGTSTP | Signal::SIGTTIN | Signal::SIGTTOU
                ) =>
        {
            // SAFETY: PTRACE_LISTEN takes no address or data. Only seized group-stops reach it.
            alive(Errno::result(unsafe {
                libc::ptrace(
                    libc::PTRACE_LISTEN,
                    tid.as_raw(),
                    std::ptr::null_mut::<libc::c_void>(),
                    std::ptr::null_mut::<libc::c_void>(),
                )
            }))
            .map(|_| ())
        }
        WaitStatus::Stopped(_, signal) => resume(tid, Some(signal)),
        WaitStatus::PtraceEvent(..) | WaitStatus::PtraceSyscall(_) => resume(tid, None),
        _ => Ok(()),
    }
}

/// Reads the current syscall stop, or `None` once its task has vanished.
fn syscall_info(tid: Pid) -> io::Result<Option<libc::ptrace_syscall_info>> {
    let mut info = std::mem::MaybeUninit::<libc::ptrace_syscall_info>::zeroed();
    // SAFETY: unlike nix 0.30.1's syscall_info wrapper, this supplies the actual writable
    // buffer size. Kernel versions without this operation are errors, never a fallback.
    let Some(copied) = alive(Errno::result(unsafe {
        libc::ptrace(
            libc::PTRACE_GET_SYSCALL_INFO,
            tid.as_raw(),
            std::mem::size_of::<libc::ptrace_syscall_info>(),
            info.as_mut_ptr(),
        )
    }))?
    else {
        return Ok(None);
    };
    // SAFETY: the zero-initialized structure and union contain only integer fields.
    let info = unsafe { info.assume_init() };
    let required = match info.op {
        libc::PTRACE_SYSCALL_INFO_ENTRY => 80,
        libc::PTRACE_SYSCALL_INFO_EXIT => 33,
        _ => 24,
    };
    if copied < required {
        return Err(io::Error::other(
            "truncated PTRACE_GET_SYSCALL_INFO response",
        ));
    }
    Ok(Some(info))
}

enum Waited {
    Stop(Pid, i32),
    Pending,
    End,
}

fn wait_ready(nonblocking: bool) -> io::Result<Waited> {
    loop {
        let mut status = 0;
        let options =
            libc::__WALL | libc::__WNOTHREAD | if nonblocking { libc::WNOHANG } else { 0 };
        // SAFETY: status is writable; __WNOTHREAD confines waits to this tracer's tracees.
        let tid = unsafe { libc::waitpid(-1, &raw mut status, options) };
        if tid > 0 {
            return Ok(Waited::Stop(Pid::from_raw(tid), status));
        }
        if tid == 0 {
            return Ok(Waited::Pending);
        }
        match Errno::last() {
            Errno::EINTR => {}
            Errno::ECHILD => return Ok(Waited::End),
            error => return Err(error.into()),
        }
    }
}

fn wait_any() -> io::Result<Option<(Pid, i32)>> {
    match wait_ready(false)? {
        Waited::Stop(tid, status) => Ok(Some((tid, status))),
        Waited::End => Ok(None),
        Waited::Pending => unreachable!("blocking wait cannot report pending"),
    }
}

#[cfg(test)]
pub(crate) mod tests;
