//! In-process tracing of spawned commands and host records, against real processes.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use super::*;
use std::future::poll_fn;
use std::panic::AssertUnwindSafe;
use std::pin::pin;
use std::process::Command;
use std::sync::mpsc;
use std::task::{Context, Poll, Waker};

/// Whether evidence names a file ending in `name` by path, descriptor, returned FD or cwd.
fn mentions(evidence: &[Syscall], name: &[u8]) -> bool {
    evidence.iter().any(|info| {
        info.paths.iter().any(|(_, bytes)| bytes.ends_with(name))
            || info
                .descriptors
                .iter()
                .filter_map(|(_, target)| target.as_ref())
                .chain(info.return_fd.as_ref())
                .chain(info.cwd.as_ref())
                .any(|target| target.path.ends_with(name))
    })
}

/// One registered root collecting everything classified against it.
struct Fixture {
    service: Arc<Tracing>,
    directory: tempfile::TempDir,
    root: RootId,
    seen: Arc<Mutex<Vec<Syscall>>>,
}

impl Fixture {
    fn new() -> Self {
        let service = Tracing::shared().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let root = service
            .register_root(
                &directory.path().canonicalize().unwrap(),
                Arc::new(move |_, info: Syscall| {
                    lock(&sink).push(info);
                    Ok(())
                }),
            )
            .unwrap();
        Self {
            service,
            directory,
            root,
            seen,
        }
    }

    fn path(&self, name: &str) -> PathBuf {
        self.directory.path().canonicalize().unwrap().join(name)
    }

    /// Spawns `sh -c script` inside `scope`, returning the child and its event stream.
    fn spawn(
        &self,
        scope: &TraceScope,
        script: &str,
    ) -> io::Result<(TracedChild, mpsc::Receiver<ChildEvent>)> {
        let (sender, events) = mpsc::channel();
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(script);
        let _guard = scope.enter();
        let child = self.service.spawn(
            command,
            Box::new(move |event| {
                let _ = sender.send(event);
            }),
        )?;
        Ok((child, events))
    }

    fn finish(self, run: TraceRun) {
        self.service.end_run(run).unwrap();
        self.service.unregister_root(self.root).unwrap();
    }
}

fn exited(events: &mpsc::Receiver<ChildEvent>) -> std::process::ExitStatus {
    loop {
        match events.recv().expect("the tracer reports its command's end") {
            ChildEvent::Exited(status) => return status,
            ChildEvent::Stopped => {}
        }
    }
}

#[test]
fn spawned_commands_are_traced_attributed_and_reaped_in_process() {
    let fixture = Fixture::new();
    let run = fixture.service.begin_run(fixture.root).unwrap();
    let scope = fixture.service.scope(run).unwrap();
    let file = fixture.path("traced.txt");
    let (child, events) = fixture
        .spawn(
            &scope,
            &format!("printf traced > '{}'; /bin/true", file.display()),
        )
        .unwrap();
    assert!(exited(&events).success());
    fixture.service.quiesce(run).unwrap();
    assert_eq!(std::fs::read(&file).unwrap(), b"traced");
    let seen = std::mem::take(&mut *lock(&fixture.seen));
    // The command's own write, and its child's exec, are evidence of the run.
    assert!(mentions(&seen, b"traced.txt"));
    assert!(seen.iter().any(|call| call.info.syscall == Sysno::execve
        && call.path(0).is_some_and(|path| path.ends_with(b"/true"))));
    // Its creation is stated first, so its descriptors are inherited from the host.
    let first = seen.first().expect("records");
    assert_eq!(first.info.syscall, Sysno::fork);
    assert!(matches!(first.info.result, RetCode::Ok(pid) if pid.cast_unsigned() == child.pid));

    // From a changed cwd a forked descendant writes, and the caller writes after it.
    let probe = tempfile::tempdir().unwrap();
    let sub = probe.path().canonicalize().unwrap();
    let (_, events) = fixture
        .spawn(
            &scope,
            &format!(
                "cd {}; /bin/sh -c \"printf y > child\"; printf after > after",
                sub.display()
            ),
        )
        .unwrap();
    assert!(exited(&events).success());
    // A non-leader thread execs; a descriptor-only execveat runs a vforking child.
    let vfork = fixture.path("vfork.py");
    std::fs::write(
        &vfork,
        "import subprocess\nsubprocess.run(['/bin/sh', '-c', 'printf v > vchild'], check=True)\n",
    )
    .unwrap();
    let threaded = fixture.path("threaded.py");
    std::fs::write(
        &threaded,
        format!(
            "import os, threading\nos.chdir({sub:?})\nthreading.Thread(target=lambda: \
             os.execv('/bin/sh', ['sh', '-c', 'printf n > nonleader'])).start()\n\
             threading.Event().wait()\n",
            sub = sub.display().to_string(),
        ),
    )
    .unwrap();
    let fexecve = fixture.path("fexecve.py");
    std::fs::write(
        &fexecve,
        format!(
            "import os\nfd = os.open('/bin/sh', os.O_RDONLY)\nos.chdir({sub:?})\n\
             os.execve(fd, ['sh', '-c', 'exec python3 {vfork}'], {{'PATH': '/usr/bin:/bin'}})\n",
            sub = sub.display().to_string(),
            vfork = vfork.display()
        ),
    )
    .unwrap();
    for script in [&threaded, &fexecve] {
        let (_, events) = fixture
            .spawn(&scope, &format!("exec python3 {}", script.display()))
            .unwrap();
        assert!(exited(&events).success());
    }
    // Quiescence means every descendant's record was already delivered to the run.
    fixture.service.quiesce(run).unwrap();
    let seen = std::mem::take(&mut *lock(&fixture.seen));
    for name in [&b"child"[..], b"after", b"nonleader", b"vchild"] {
        assert!(mentions(&seen, name), "{}", String::from_utf8_lossy(name));
    }
    assert!(seen.iter().any(|call| call.info.syscall == Sysno::execveat));
    let order = |name: &[u8]| {
        seen.iter()
            .find(|call| call.paths.iter().any(|(_, path)| path.ends_with(name)))
            .expect("a record")
            .entry_order
    };
    assert!(order(b"child") < order(b"after"));
    // The host itself is never traced.
    assert_eq!(
        proc_field::<i32>("/proc/self/status", "TracerPid:").unwrap(),
        Some(0)
    );
    fixture.finish(run);
}

#[test]
fn quiescence_waits_for_last_exit_delivery() {
    let fixture = Fixture::new();
    let run = fixture.service.begin_run(fixture.root).unwrap();
    let scope = fixture.service.scope(run).unwrap();
    let (at_exit, exiting) = mpsc::channel();
    let (release, released) = mpsc::sync_channel(0);
    let child = {
        let _entered = scope.enter();
        fixture
            .service
            .spawn(
                Command::new("/bin/true"),
                Box::new(move |event| {
                    if let ChildEvent::Exited(status) = event {
                        at_exit.send(status).unwrap();
                        released.recv().unwrap();
                    }
                }),
            )
            .unwrap()
    };
    assert!(
        exiting
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .success()
    );
    let (finished, completion) = mpsc::channel();
    let service = Arc::clone(&fixture.service);
    let waiter = std::thread::spawn(move || finished.send(service.quiesce(run)).unwrap());
    let early = completion.recv_timeout(Duration::from_millis(100));
    let completed_early = early.is_ok();
    release.send(()).unwrap();
    let result = early.unwrap_or_else(|_| completion.recv_timeout(Duration::from_secs(5)).unwrap());
    waiter.join().unwrap();
    child.wait_observed().unwrap();
    result.unwrap();
    fixture.finish(run);
    assert!(
        !completed_early,
        "quiescence returned before its observer's last delivery ended"
    );
}

fn probe(path: &Path) -> HostCall<'_> {
    HostCall::Metadata {
        path,
        follow: true,
        errno: None,
    }
}

#[test]
fn host_records_count_only_inside_workload_scopes() {
    let fixture = Fixture::new();
    let run = fixture.service.begin_run(fixture.root).unwrap();
    let scope = fixture.service.scope(run).unwrap();
    let internal = fixture.service.internal_scope().unwrap();
    let file = fixture.path("probed.txt");
    std::fs::write(&file, b"x").unwrap();
    let outside = fixture.path("outside.txt");
    let hidden = fixture.path("internal.txt");
    fixture.service.host(probe(&outside)).unwrap();
    {
        let _workload = scope.enter();
        {
            let _internal = internal.enter();
            fixture.service.host(probe(&hidden)).unwrap();
        }
        fixture.service.host(probe(&file)).unwrap();
        let opened = std::fs::File::open(&file).unwrap();
        fixture
            .service
            .host(HostCall::Open {
                path: &file,
                result: Ok(opened.as_raw_fd()),
            })
            .unwrap();
    }
    let seen = std::mem::take(&mut *lock(&fixture.seen));
    assert!(!mentions(&seen, b"outside.txt"));
    assert!(!mentions(&seen, b"internal.txt"));
    assert!(seen.iter().any(|call| {
        call.info.syscall == Sysno::newfstatat
            && call
                .path(1)
                .is_some_and(|path| path.ends_with(b"probed.txt"))
    }));
    // A read-only open also stands for the reads made through it.
    assert!(seen.iter().any(|call| {
        call.info.syscall == Sysno::read
            && call
                .fd(0)
                .unwrap()
                .is_some_and(|target| target.path.ends_with(b"probed.txt"))
    }));
    fixture.finish(run);
}

#[test]
fn failed_launches_and_unscoped_spawns_leave_nothing_running() {
    let fixture = Fixture::new();
    let run = fixture.service.begin_run(fixture.root).unwrap();
    let scope = fixture.service.scope(run).unwrap();
    let missing = {
        let _guard = scope.enter();
        fixture
            .service
            .spawn(Command::new("/nonexistent/program"), Box::new(|_| {}))
    };
    assert_eq!(
        missing.err().map(|error| error.kind()),
        Some(io::ErrorKind::NotFound)
    );
    let unscoped = fixture
        .service
        .spawn(Command::new("/bin/true"), Box::new(|_| {}));
    assert!(unscoped.is_err());
    let unresolved = {
        let _guard = scope.enter();
        fixture
            .service
            .spawn(Command::new("true"), Box::new(|_| {}))
    };
    assert_eq!(
        unresolved.err().map(|error| error.kind()),
        Some(io::ErrorKind::InvalidInput)
    );
    // Nothing is left attributed to the run, and it still spawns.
    fixture.service.quiesce(run).unwrap();
    let (_, events) = fixture.spawn(&scope, "exit 3").unwrap();
    assert_eq!(exited(&events).code(), Some(3));
    fixture.finish(run);
}

#[test]
fn cancellation_kills_traced_commands() {
    let fixture = Fixture::new();
    let run = fixture.service.begin_run(fixture.root).unwrap();
    let scope = fixture.service.scope(run).unwrap();
    let (_, events) = fixture.spawn(&scope, "exec /bin/sleep 60").unwrap();
    assert!(fixture.service.cancel(run).unwrap() >= 1);
    assert_eq!(exited(&events).signal(), Some(libc::SIGKILL));
    fixture.service.quiesce(run).unwrap();
    fixture.finish(run);

    // Cancelling from the observation callback of an exec kills the new image before it runs.
    let service = Tracing::shared().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let (killed, cancelled) = mpsc::channel();
    let weak = Arc::downgrade(&service);
    let root = service
        .register_root(
            &directory.path().canonicalize().unwrap(),
            Arc::new(move |run, info: Syscall| {
                if info.info.syscall == Sysno::execve
                    && info.path(0).is_some_and(|path| path.ends_with(b"/sleep"))
                {
                    let service = weak.upgrade().expect("live service");
                    let _ = killed.send(service.cancel(run)?);
                }
                Ok(())
            }),
        )
        .unwrap();
    let fixture = Fixture {
        service,
        directory,
        root,
        seen: Arc::default(),
    };
    let run = fixture.service.begin_run(fixture.root).unwrap();
    let scope = fixture.service.scope(run).unwrap();
    let (_, events) = fixture.spawn(&scope, "exec /bin/sleep 60").unwrap();
    assert!(cancelled.recv().unwrap() >= 1);
    assert_eq!(exited(&events).signal(), Some(libc::SIGKILL));
    fixture.service.quiesce(run).unwrap();
    fixture.finish(run);
}

#[test]
fn newborn_exit_before_adoption_drains_without_discarding_effects() {
    const TEST: &str =
        "tracing::tests::newborn_exit_before_adoption_drains_without_discarding_effects";
    const SCENARIO: &str = "MARSH_NEWBORN_EXIT_FIXTURE";
    if std::env::var_os(SCENARIO).is_none() {
        crate::observation::tests::isolated(
            TEST,
            SCENARIO,
            "newborn-exit",
            Duration::from_secs(15),
            "newborn exit fully drained",
        );
        return;
    }
    group_exit_during_creation(CreationStop::Withhold);
    println!("newborn exit fully drained");
}

#[test]
fn creator_exit_before_return_preserves_child_inherited_effects() {
    const TEST: &str =
        "tracing::tests::creator_exit_before_return_preserves_child_inherited_effects";
    const SCENARIO: &str = "MARSH_KNOWN_CHILD_EXIT_FIXTURE";
    if std::env::var_os(SCENARIO).is_none() {
        crate::observation::tests::isolated(
            TEST,
            SCENARIO,
            "creator-exit",
            Duration::from_secs(15),
            "creator exit retains child effects",
        );
        return;
    }
    group_exit_during_creation(CreationStop::Adopt);
    println!("creator exit retains child effects");
}

#[test]
fn replaced_creation_stop_with_zero_exit_status_is_not_an_identity() {
    const TEST: &str =
        "tracing::tests::replaced_creation_stop_with_zero_exit_status_is_not_an_identity";
    const SCENARIO: &str = "MARSH_REPLACED_CREATION_FIXTURE";
    if std::env::var_os(SCENARIO).is_none() {
        crate::observation::tests::isolated(
            TEST,
            SCENARIO,
            "zero",
            Duration::from_secs(15),
            "replaced creation stop drained",
        );
        return;
    }
    group_exit_during_creation(CreationStop::ReplacedByExit(0));
    println!("replaced creation stop drained");
}

#[test]
fn replaced_creation_stop_with_nonzero_exit_status_is_not_an_identity() {
    const TEST: &str =
        "tracing::tests::replaced_creation_stop_with_nonzero_exit_status_is_not_an_identity";
    const SCENARIO: &str = "MARSH_REPLACED_CREATION_FIXTURE";
    if std::env::var_os(SCENARIO).is_none() {
        crate::observation::tests::isolated(
            TEST,
            SCENARIO,
            "nonzero",
            Duration::from_secs(15),
            "replaced creation stop drained",
        );
        return;
    }
    group_exit_during_creation(CreationStop::ReplacedByExit(7));
    println!("replaced creation stop drained");
}

/// How the fixture treats the creator's real, non-root creation stop.
#[derive(Clone, Copy)]
enum CreationStop {
    /// Dispatch it and hold the creator there.
    Adopt,
    /// Never dispatch it; the newborn stays terminal-only.
    Withhold,
    /// Withhold it, then replay its saved wait status once the group exit with this status
    /// has replaced the kernel stop with the creator's EXIT stop.
    ReplacedByExit(u8),
}

#[allow(
    clippy::too_many_lines,
    clippy::zombie_processes,
    reason = "one isolated ordering fixture; Observer is the child's sole reaper"
)]
fn group_exit_during_creation(mode: CreationStop) {
    let adopt_child = matches!(mode, CreationStop::Adopt);
    let exit_code = match mode {
        CreationStop::ReplacedByExit(code) => code,
        CreationStop::Adopt | CreationStop::Withhold => 0,
    };
    let fixture = Fixture::new();
    let run = fixture.service.begin_run(fixture.root).unwrap();
    let file = fixture.path("creator-write");
    let mut child = Command::new("/usr/bin/python3")
        .args([
            "-c",
            r#"
import ctypes, os, sys, threading
os.read(0, 1)
file_fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(file_fd, b'creator\n')
ready_read, ready_write = os.pipe()
libc = ctypes.CDLL(None)
callback_type = ctypes.CFUNCTYPE(ctypes.c_void_p, ctypes.c_void_p)
@callback_type
def newborn(_):
    os.write(file_fd, b'child\n')
    os.close(file_fd)
    with open(sys.argv[2], 'w') as f:
        f.write('must not run')
    os.write(ready_write, b'r')
    return None
libc.pthread_create.argtypes = [ctypes.POINTER(ctypes.c_ulong), ctypes.c_void_p,
                               callback_type, ctypes.c_void_p]
def creator():
    thread_id = ctypes.c_ulong()
    assert libc.pthread_create(ctypes.byref(thread_id), None, newborn, None) == 0
threading.Thread(target=creator).start()
os.read(ready_read if sys.argv[3] == 'known' else 0, 1)
os._exit(int(sys.argv[4]))
"#,
        ])
        .arg(&file)
        .arg(fixture.path("child-write"))
        .arg(if adopt_child { "known" } else { "unknown" })
        .arg(exit_code.to_string())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let root = Pid::from_raw(i32::try_from(child.id()).unwrap());
    let process = open_process(root.as_raw()).unwrap();
    let mut observer = Observer::new(
        fixture.service.selected.clone(),
        Arc::clone(&fixture.service.sequence),
        root,
    );
    let stopped = observer.seize(root).unwrap().unwrap();
    fixture
        .service
        .adopt_root(
            root,
            run,
            nix::unistd::gettid(),
            process.try_clone().unwrap(),
        )
        .unwrap();
    let mut root_status = None;
    let created_child = std::cell::Cell::new(None);
    let deliveries = std::cell::Cell::new(0_usize);
    let mut observe = |sequence, tid, status, event, info, entry: Option<EntryInfo<'_>>| {
        deliveries.set(deliveries.get() + 1);
        let _delivery = fixture.service.delivery(run)?;
        let mut decision = fixture
            .service
            .deliver(sequence, tid, status, event, info, entry)?;
        if adopt_child
            && tid != root
            && matches!(WaitStatus::from_raw(tid, status)?,
                WaitStatus::PtraceEvent(_, _, code) if creation(code))
        {
            let child = Pid::from_raw(i32::try_from(event.unwrap()).unwrap());
            let state = lock(&fixture.service.state);
            let pending = state.threads.get(&tid).unwrap().pending.unwrap();
            assert!(
                !pending.safe,
                "creation proof must not close the pending syscall"
            );
            assert_eq!(state.threads.get(&child).unwrap().classify_after, None);
            created_child.set(Some((child, pending.entry)));
            decision.hold_current = true;
            decision.policy_hold = true;
        }
        if tid == root && ended(status) {
            root_status = Some(std::process::ExitStatus::from_raw(status));
        }
        Ok(decision)
    };
    observer.stop(root, stopped, &mut observe).unwrap();
    let mut input = child.stdin.take().unwrap();
    input.write_all(b"g").unwrap();
    let mut stopped_creator = None;
    loop {
        let mut status = 0;
        // SAFETY: this test thread spawned/seized the tree and remains its sole wait owner.
        let tid = unsafe { libc::waitpid(-1, &raw mut status, libc::__WALL | libc::__WNOTHREAD) };
        if tid < 0 && Errno::last() == Errno::EINTR {
            continue;
        }
        assert!(tid > 0);
        let tid = Pid::from_raw(tid);
        let creating = matches!(WaitStatus::from_raw(tid, status).unwrap(),
            WaitStatus::PtraceEvent(_, _, code) if creation(code));
        if creating && tid != root {
            assert!(stopped_creator.replace((tid, status)).is_none());
            // CDLL's pthread_create releases the GIL. Hold this creator at its real
            // event while the newborn uses an inherited fd and main exits the group.
            if adopt_child {
                observer.stop(tid, status, &mut observe).unwrap();
            } else {
                // The terminal-only regression deliberately withholds adoption.
                input.write_all(b"e").unwrap();
            }
            continue;
        }
        let exit_stop = matches!(WaitStatus::from_raw(tid, status).unwrap(),
            WaitStatus::PtraceEvent(_, _, code) if code == Event::PTRACE_EVENT_EXIT as i32);
        if let (CreationStop::ReplacedByExit(_), Some((creator, saved))) = (mode, stopped_creator)
            && tid == creator
            && exit_stop
        {
            // Group exit woke the withheld creator into this EXIT stop, which replaced the
            // kernel's creation message while the saved wait status still names the creation.
            assert!(matches!(WaitStatus::from_raw(creator, saved).unwrap(),
                WaitStatus::PtraceEvent(_, _, code) if creation(code)));
            let message = i64::from(exit_code) << 8;
            assert_eq!(nix::sys::ptrace::getevent(creator).unwrap(), message);
            assert_eq!(
                nix::sys::ptrace::getsiginfo(creator).unwrap().si_code,
                libc::SIGTRAP | ((Event::PTRACE_EVENT_EXIT as i32) << 8)
            );
            println!("staged replacement: exit={exit_code} message={message}");
            let delivered = deliveries.get();
            observer.stop(creator, saved, &mut observe).unwrap();
            assert_eq!(
                deliveries.get(),
                delivered,
                "a replaced creation stop must not reach the consumer"
            );
            assert_eq!(
                nix::sys::ptrace::getevent(creator).unwrap(),
                message,
                "replaying the creation stop must not resume the real EXIT stop"
            );
            observer.stop(creator, status, &mut observe).unwrap();
            assert_eq!(deliveries.get(), delivered + 1);
            break;
        }
        observer.stop(tid, status, &mut observe).unwrap();
        // Replacement modes never resume the creator: group exit itself wakes it to EXIT.
        if tid == root && exit_stop && !matches!(mode, CreationStop::ReplacedByExit(_)) {
            let (creator, _) =
                stopped_creator.expect("main exits only after the newborn creation gate");
            // The leader's real EXIT proves group exit was entered before acknowledging
            // the withheld creator stop. No userspace work can resume in the dying tree.
            alive(nix::sys::ptrace::syscall(creator, None)).unwrap();
            break;
        }
    }
    let result = observer.run(&mut observe);
    if result.is_err() {
        observer.abandon(|tid, _| {
            lock(&fixture.service.state).threads.remove(&tid);
        });
    }
    result.unwrap();
    assert_eq!(observer.unexecuted_exits().len(), usize::from(!adopt_child));
    fixture
        .service
        .retire_unexecuted(observer.unexecuted_exits())
        .unwrap();
    assert_eq!(root_status.unwrap().code(), Some(i32::from(exit_code)));
    fixture.service.quiesce(run).unwrap();
    assert_eq!(
        std::fs::read(&file).unwrap(),
        if adopt_child {
            b"creator\nchild\n".as_slice()
        } else {
            b"creator\n".as_slice()
        }
    );
    assert_eq!(fixture.path("child-write").exists(), adopt_child);
    let seen = lock(&fixture.seen);
    assert!(mentions(&seen, b"creator-write"));
    if adopt_child {
        let (child, entry) = created_child.get().unwrap();
        assert!(
            seen.iter()
                .any(|call| call.info.typ == "CREATION" && call.entry_order == entry)
        );
        assert!(
            seen.iter()
                .all(|call| call.entry_order != entry || call.info.typ != "SYSCALL"),
            "creator never returned from its pending creation syscall"
        );
        assert!(seen.iter().any(|call| {
            call.info.pid == child
                && call.info.syscall == Sysno::write
                && call
                    .fd(0)
                    .ok()
                    .flatten()
                    .is_some_and(|target| target.path.ends_with(b"creator-write"))
        }));
    }
    assert!(
        seen.iter()
            .all(|call| !observer.unexecuted_exits().contains(&call.info.pid))
    );
    drop(seen);
    assert!(lock(&fixture.service.state).threads.is_empty());
    fixture.finish(run);
}

const REPLACED_EXEC: &str = "MARSH_REPLACED_EXEC_FIXTURE";

/// Reruns `name` isolated, or runs its fixture inside that fresh process.
fn replaced_exec_case(name: &str, scenario: &str, mode: ExecStop, selected_exec: bool) {
    if std::env::var_os(REPLACED_EXEC).is_none() {
        crate::observation::tests::isolated(
            &format!("tracing::tests::{name}"),
            REPLACED_EXEC,
            scenario,
            Duration::from_secs(15),
            "replaced exec stop drained",
        );
    } else {
        replaced_exec_stop(mode, selected_exec);
    }
}

#[test]
fn replaced_nonleader_exec_stop_drains() {
    replaced_exec_case(
        "replaced_nonleader_exec_stop_drains",
        "exit",
        ExecStop::Exit,
        true,
    );
}

#[test]
fn vanished_nonleader_exec_stop_drains() {
    replaced_exec_case(
        "vanished_nonleader_exec_stop_drains",
        "gone",
        ExecStop::Gone,
        true,
    );
}

#[test]
fn unselected_replaced_nonleader_exec_stop_drains() {
    replaced_exec_case(
        "unselected_replaced_nonleader_exec_stop_drains",
        "unselected",
        ExecStop::Exit,
        false,
    );
}

/// When the fixture replays a withheld nonleader EXEC stop after killing its new image.
#[derive(Clone, Copy)]
enum ExecStop {
    /// While the root's real SIGKILL EXIT stop has replaced its message and siginfo.
    Exit,
    /// After the root's final status was reaped without dispatching its EXIT.
    Gone,
}

#[allow(
    clippy::too_many_lines,
    clippy::zombie_processes,
    reason = "one isolated ordering fixture; Observer is the child's sole reaper"
)]
fn replaced_exec_stop(mode: ExecStop, selected_exec: bool) {
    let fixture = Fixture::new();
    let run = fixture.service.begin_run(fixture.root).unwrap();
    let before = fixture.path("before-exec");
    let after = fixture.path("after-exec");
    let mut child = Command::new("/usr/bin/python3")
        .args([
            "-c",
            r#"
import os, sys, threading
sys.stdout.write('R')
sys.stdout.flush()
os.read(0, 1)
go = threading.Event()
def worker():
    go.wait()
    fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.write(fd, b'before\n')
    os.close(fd)
    os.execv('/bin/sh', ['sh', '-c', 'printf after > "$1"', 'sh', sys.argv[2]])
threading.Thread(target=worker).start()
# The leader's creating call has returned before the worker may exec.
go.set()
threading.Event().wait()
"#,
        ])
        .arg(&before)
        .arg(&after)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .unwrap();
    let mut output = child.stdout.take().unwrap();
    let mut ready = [0; 1];
    output.read_exact(&mut ready).unwrap();
    assert_eq!(&ready, b"R");
    let root = Pid::from_raw(i32::try_from(child.id()).unwrap());
    let process = open_process(root.as_raw()).unwrap();
    let mut selected = fixture.service.selected.clone();
    if !selected_exec {
        selected.remove(Sysno::execve);
        selected.remove(Sysno::execveat);
    }
    assert!(selected.contains(Sysno::write));
    let mut observer = Observer::new(selected, Arc::clone(&fixture.service.sequence), root);
    let stopped = observer.seize(root).unwrap().unwrap();
    fixture
        .service
        .adopt_root(
            root,
            run,
            nix::unistd::gettid(),
            process.try_clone().unwrap(),
        )
        .unwrap();
    let delivered = RefCell::new(Vec::new());
    let exec_entry = std::cell::Cell::new(None);
    let mut root_status = None;
    let mut observe = |sequence, tid: Pid, status, event, info, entry: Option<EntryInfo<'_>>| {
        delivered.borrow_mut().push((tid, status));
        let exec = tid != root
            && entry.as_ref().is_some_and(|entry| {
                entry.result.is_none()
                    && matches!(entry.syscall, Some(Sysno::execve | Sysno::execveat))
            });
        let _delivery = fixture.service.delivery(run)?;
        let decision = fixture
            .service
            .deliver(sequence, tid, status, event, info, entry)?;
        if exec {
            assert!(exec_entry.replace(Some((tid, sequence))).is_none());
            let state = lock(&fixture.service.state);
            let thread = state.threads.get(&tid).unwrap();
            assert_eq!(thread.pending.unwrap().entry, sequence);
            assert_eq!(thread.process.as_ref().unwrap().group, root);
            drop(state);
        }
        if tid == root && ended(status) {
            root_status = Some(std::process::ExitStatus::from_raw(status));
        }
        Ok(decision)
    };
    let wait = || {
        loop {
            let mut status = 0;
            // SAFETY: this test thread spawned/seized the tree and remains its sole wait owner.
            let tid =
                unsafe { libc::waitpid(-1, &raw mut status, libc::__WALL | libc::__WNOTHREAD) };
            if tid < 0 && Errno::last() == Errno::EINTR {
                continue;
            }
            assert!(tid > 0);
            return (Pid::from_raw(tid), status);
        }
    };
    let event_stop = |tid, status, event: Event| {
        matches!(WaitStatus::from_raw(tid, status).unwrap(),
            WaitStatus::PtraceEvent(_, _, code) if code == event as i32)
    };
    observer.stop(root, stopped, &mut observe).unwrap();
    let mut input = child.stdin.take().unwrap();
    input.write_all(b"g").unwrap();
    // The old leader's EXIT must be dispatched: de_thread waits for it before EXEC.
    let (worker, exec_status) = loop {
        let (tid, status) = wait();
        if tid == root && event_stop(tid, status, Event::PTRACE_EVENT_EXEC) {
            let (worker, _) = exec_entry
                .get()
                .expect("the nonleader exec entry precedes EXEC");
            assert_ne!(worker, root);
            // Fixture evidence only: the repair never learns this former identity.
            assert_eq!(
                nix::sys::ptrace::getevent(root).unwrap(),
                i64::from(worker.as_raw())
            );
            assert_eq!(
                nix::sys::ptrace::getsiginfo(root).unwrap().si_code,
                libc::SIGTRAP | ((Event::PTRACE_EVENT_EXEC as i32) << 8)
            );
            break (worker, status);
        }
        observer.stop(tid, status, &mut observe).unwrap();
    };
    assert!(signal_process(&process, libc::SIGKILL).unwrap());
    let exit_status = loop {
        let (tid, status) = wait();
        if tid == root && event_stop(tid, status, Event::PTRACE_EVENT_EXIT) {
            break status;
        }
        observer.stop(tid, status, &mut observe).unwrap();
    };
    let exit_message = i64::from(libc::SIGKILL);
    let exit_info = libc::SIGTRAP | ((Event::PTRACE_EVENT_EXIT as i32) << 8);
    assert_eq!(nix::sys::ptrace::getevent(root).unwrap(), exit_message);
    assert_eq!(
        nix::sys::ptrace::getsiginfo(root).unwrap().si_code,
        exit_info
    );
    let count = delivered.borrow().len();
    match mode {
        ExecStop::Exit => {
            println!("staged replaced exec: exit message={exit_message}");
            observer.stop(root, exec_status, &mut observe).unwrap();
            assert_eq!(
                delivered.borrow().len(),
                count,
                "a replaced EXEC stop must not reach the consumer"
            );
            assert_eq!(
                nix::sys::ptrace::getevent(root).unwrap(),
                exit_message,
                "replaying EXEC must not resume the real EXIT stop"
            );
            assert_eq!(
                nix::sys::ptrace::getsiginfo(root).unwrap().si_code,
                exit_info
            );
            observer.stop(root, exit_status, &mut observe).unwrap();
            assert_eq!(delivered.borrow().len(), count + 1);
        }
        ExecStop::Gone => {
            nix::sys::ptrace::syscall(root, None).unwrap();
            let (tid, final_status) = wait();
            assert_eq!(tid, root);
            assert!(ended(final_status));
            assert_eq!(nix::sys::ptrace::getevent(root), Err(Errno::ESRCH));
            println!("staged replaced exec: gone");
            observer.stop(root, exec_status, &mut observe).unwrap();
            observer.stop(root, exit_status, &mut observe).unwrap();
            assert_eq!(delivered.borrow().len(), count);
            observer.stop(root, final_status, &mut observe).unwrap();
            assert_eq!(delivered.borrow().len(), count + 1);
        }
    }
    observer
        .run_controlled(
            &mut observe,
            &mut |_, _| Ok(Control::Hold),
            &mut |replaced| fixture.service.retire_replaced_execs(replaced),
        )
        .unwrap();
    fixture
        .service
        .retire_unexecuted(observer.unexecuted_exits())
        .unwrap();
    assert_eq!(root_status.unwrap().signal(), Some(libc::SIGKILL));
    assert!(
        delivered.borrow().iter().all(|&(tid, status)| tid != worker
            || !(ended(status) || event_stop(tid, status, Event::PTRACE_EVENT_EXIT))),
        "the former exec identity never reports its own end"
    );
    fixture.service.quiesce(run).unwrap();
    assert_eq!(std::fs::read(&before).unwrap(), b"before\n");
    assert!(!after.exists());
    let (_, exec_order) = exec_entry.get().unwrap();
    let seen = lock(&fixture.seen);
    assert!(
        seen.iter().all(|call| call.entry_order != exec_order),
        "the replaced exec never completed"
    );
    assert!(seen.iter().any(|call| {
        call.info.pid == worker
            && call.info.syscall == Sysno::write
            && call
                .fd(0)
                .ok()
                .flatten()
                .is_some_and(|target| target.path.ends_with(b"before-exec"))
    }));
    drop(seen);
    assert!(lock(&fixture.service.state).threads.is_empty());
    fixture.finish(run);
    drop(output);
    println!("replaced exec stop drained");
}

/// Synthetic bookkeeping above any kernel `pid_max`: never signaled or waited for.
fn synthetic(offset: i32) -> Pid {
    Pid::from_raw((1 << 30) + offset)
}

/// A known task pending at `entry`, leased to this test process, which is never signaled.
fn leased(run: TraceRun, entry: u64, group: Pid) -> Thread {
    Thread {
        inherited: Some(run),
        known_parent: true,
        process: Some(ProcessLease {
            descriptor: open_process(std::process::id().cast_signed()).unwrap(),
            group,
        }),
        pending: Some(Pending {
            entry,
            run: Some(run),
            safe: false,
            writes_memory: true,
        }),
        ..Thread::default()
    }
}

/// One test run's synthetic threads and their pending entries, in TID order. The service is
/// shared by concurrent tests, so each test also uses its own synthetic TID range.
fn synthetic_threads(service: &Tracing, run: TraceRun) -> Vec<(Pid, Option<u64>)> {
    let mut threads: Vec<_> = lock(&service.state)
        .threads
        .iter()
        .filter(|(_, thread)| thread.inherited == Some(run))
        .map(|(tid, thread)| (*tid, thread.pending.map(|pending| pending.entry)))
        .collect();
    threads.sort();
    threads
}

fn remove_synthetic(service: &Tracing, run: TraceRun) {
    lock(&service.state)
        .threads
        .retain(|_, thread| thread.inherited != Some(run));
}

/// A completed record built directly as bookkeeping input, not a mocked ptrace event.
fn completed(pid: Pid, syscall: Sysno, entry_order: u64, result: RetCode) -> Syscall {
    Syscall {
        info: SyscallInfo {
            typ: "SYSCALL",
            pid,
            syscall,
            args: SyscallArgs(Vec::new()),
            result,
            duration: Duration::ZERO,
        },
        creation_observed: false,
        entry_order,
        cwd: None,
        return_fd: None,
        paths: Vec::new(),
        descriptors: Vec::new(),
        flags: None,
        submissions: None,
    }
}

#[test]
fn replaced_exec_retirement_validates_identity() {
    let fixture = Fixture::new();
    let run = fixture.service.begin_run(fixture.root).unwrap();
    let service = &fixture.service;
    let (group, other) = (synthetic(0), synthetic(100));
    let entry: Vec<_> = (0..10).map(|_| service.next_order(run).unwrap()).collect();
    {
        let mut state = lock(&service.state);
        for (tid, thread) in [
            (group, leased(run, entry[0], group)),
            (synthetic(1), leased(run, entry[1], group)),
            (synthetic(2), leased(run, entry[2], group)),
            // Sentinels: an unlisted task of the same group, and one of another group.
            (synthetic(3), leased(run, entry[3], group)),
            (synthetic(101), leased(run, entry[4], other)),
            (
                synthetic(4),
                Thread {
                    known_parent: false,
                    ..leased(run, entry[5], group)
                },
            ),
            (
                synthetic(5),
                Thread {
                    pending: None,
                    ..leased(run, entry[6], group)
                },
            ),
            (
                synthetic(6),
                Thread {
                    process: None,
                    ..leased(run, entry[7], group)
                },
            ),
            (
                synthetic(7),
                Thread {
                    early: vec![(entry[8], 0, None, None)],
                    ..leased(run, entry[8], group)
                },
            ),
        ] {
            state.threads.insert(tid, thread);
        }
    }
    let proof = |tid, entry| ReplacedExec { tid, group, entry };
    let before = synthetic_threads(service, run);
    for (case, invalid) in [
        ("missing task", proof(synthetic(50), entry[9])),
        ("leader", proof(group, entry[0])),
        ("unknown parent", proof(synthetic(4), entry[5])),
        ("missing pending entry", proof(synthetic(5), entry[6])),
        ("wrong pending entry", proof(synthetic(3), entry[9])),
        ("missing process lease", proof(synthetic(6), entry[7])),
        ("wrong process group", proof(synthetic(101), entry[4])),
        ("early stops", proof(synthetic(7), entry[8])),
    ] {
        let error = service
            .retire_replaced_execs(&[proof(synthetic(1), entry[1]), invalid])
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "invalid replaced exec retirement",
            "{case}"
        );
        assert_eq!(synthetic_threads(service, run), before, "{case}");
    }
    service
        .retire_replaced_execs(&[proof(synthetic(1), entry[1]), proof(synthetic(2), entry[2])])
        .unwrap();
    let mut after = before;
    after.retain(|(tid, _)| ![synthetic(1), synthetic(2)].contains(tid));
    assert_eq!(synthetic_threads(service, run), after);
    remove_synthetic(service, run);
    fixture.finish(run);
}

#[test]
fn replaced_exec_retirement_preserves_creator_order() {
    let fixture = Fixture::new();
    let run = fixture.service.begin_run(fixture.root).unwrap();
    let service = &fixture.service;
    let (group, creator, retiring) = (synthetic(1000), synthetic(1001), synthetic(1002));
    let [created, written, executed] = [(); 3].map(|()| service.next_order(run).unwrap());
    {
        let mut state = lock(&service.state);
        state.threads.insert(creator, leased(run, created, group));
        // The exec caller's earlier write still waits for its creator's completion.
        state.threads.insert(
            retiring,
            Thread {
                classify_after: Some(created),
                ..leased(run, executed, group)
            },
        );
        state.deferred.insert(
            created,
            vec![(
                run,
                completed(retiring, Sysno::write, written, RetCode::Ok(7)),
            )],
        );
    }
    service
        .retire_replaced_execs(&[ReplacedExec {
            tid: retiring,
            group,
            entry: executed,
        }])
        .unwrap();
    {
        let state = lock(&service.state);
        assert!(!state.threads.contains_key(&retiring));
        assert_eq!(
            state.threads[&creator].pending.map(|pending| pending.entry),
            Some(created)
        );
        let [(owner, info)] = state.deferred[&created].as_slice() else {
            panic!("one deferred record");
        };
        assert_eq!(
            (*owner, info.info.pid, info.entry_order),
            (run, retiring, written)
        );
        assert!(matches!(info.info.result, RetCode::Ok(7)));
        drop(state);
    }
    service
        .classify(
            run,
            completed(
                creator,
                Sysno::clone,
                created,
                RetCode::Ok(retiring.as_raw()),
            ),
        )
        .unwrap();
    let seen: Vec<_> = lock(&fixture.seen)
        .iter()
        .map(|call| (call.info.pid, call.info.syscall, call.entry_order))
        .collect();
    assert_eq!(
        seen,
        [
            (creator, Sysno::clone, created),
            (retiring, Sysno::write, written)
        ]
    );
    assert!(!lock(&service.state).deferred.contains_key(&created));

    // A live run cannot retire an entry its own unclassified dependent still waits for.
    let (blocked, dependent) = (synthetic(1003), synthetic(1004));
    let pending = service.next_order(run).unwrap();
    {
        let mut state = lock(&service.state);
        state.threads.insert(blocked, leased(run, pending, group));
        state.threads.insert(
            dependent,
            Thread {
                inherited: Some(run),
                known_parent: true,
                classify_after: Some(pending),
                ..Thread::default()
            },
        );
    }
    let error = service
        .retire_replaced_execs(&[ReplacedExec {
            tid: blocked,
            group,
            entry: pending,
        }])
        .unwrap_err();
    assert_eq!(error.to_string(), UNCLASSIFIED);
    assert!(lock(&service.state).threads.contains_key(&blocked));
    remove_synthetic(service, run);
    fixture.finish(run);
}

thread_local! { static LABEL: RefCell<Option<&'static str>> = const { RefCell::new(None) }; }

fn label() -> Option<&'static str> {
    LABEL.with(|label| *label.borrow())
}

/// A caller-defined per-poll context: installs one thread-local label.
struct Label(&'static str);

/// Restores the label that was current when its scope was entered.
struct Restore(Option<&'static str>);

impl Drop for Restore {
    fn drop(&mut self) {
        LABEL.with(|label| {
            label.replace(self.0.take());
        });
    }
}

impl PollScope for Label {
    type Guard = Restore;
    fn enter(&self) -> Restore {
        Restore(LABEL.with(|label| label.replace(Some(self.0))))
    }
}

#[test]
fn poll_scope_restores_context_between_polls() {
    let observed = RefCell::new(Vec::new());
    let mut context = Context::from_waker(Waker::noop());
    let outer = Label("outer").enter();
    {
        let mut polls = 0_u8;
        let mut inner = pin!(Scoped::new(
            poll_fn(|_| {
                observed.borrow_mut().push(("inner", label()));
                polls += 1;
                if polls == 1 {
                    Poll::Pending
                } else {
                    Poll::Ready(polls)
                }
            }),
            Label("inner")
        ));
        let mut future = pin!(Scoped::new(
            poll_fn(|cx| {
                let poll = inner.as_mut().poll(cx);
                observed.borrow_mut().push(("middle", label()));
                poll
            }),
            Label("middle")
        ));
        assert!(future.as_mut().poll(&mut context).is_pending());
        assert_eq!(label(), Some("outer"));
        assert_eq!(future.as_mut().poll(&mut context), Poll::Ready(2));
        assert_eq!(label(), Some("outer"));
    }
    drop(outer);
    assert_eq!(label(), None);
    assert_eq!(
        *observed.borrow(),
        [
            ("inner", Some("inner")),
            ("middle", Some("middle")),
            ("inner", Some("inner")),
            ("middle", Some("middle"))
        ]
    );
}

#[test]
fn poll_scope_restores_context_after_unwind() {
    let outer = Label("outer").enter();
    let payload = std::panic::catch_unwind(AssertUnwindSafe(|| {
        let mut context = Context::from_waker(Waker::noop());
        let mut inner = pin!(Scoped::new(
            poll_fn(|_| -> Poll<()> {
                assert_eq!(label(), Some("inner"));
                panic!("scoped poll unwinds");
            }),
            Label("inner")
        ));
        let mut future = pin!(Scoped::new(
            poll_fn(|cx| -> Poll<()> {
                let payload =
                    std::panic::catch_unwind(AssertUnwindSafe(|| inner.as_mut().poll(cx)))
                        .unwrap_err();
                assert_eq!(label(), Some("middle"));
                std::panic::resume_unwind(payload)
            }),
            Label("middle")
        ));
        let _ = future.as_mut().poll(&mut context);
    }))
    .unwrap_err();
    assert_eq!(payload.downcast_ref::<&str>(), Some(&"scoped poll unwinds"));
    assert_eq!(label(), Some("outer"));
    drop(outer);
    assert_eq!(label(), None);
}

/// A real multithreaded process with a socket-controlled writer and process-local counter.
fn parking_child(
    fixture: &Fixture,
    scope: &TraceScope,
) -> (
    TracedChild,
    mpsc::Receiver<ChildEvent>,
    std::os::unix::net::UnixStream,
) {
    use std::os::fd::AsRawFd;
    use std::process::Stdio;
    let (mut host, peer) = std::os::unix::net::UnixStream::pair().unwrap();
    host.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    // SAFETY: this test owns the descriptor and keeps it alive until spawn completes.
    assert_eq!(
        unsafe { libc::fcntl(peer.as_raw_fd(), libc::F_SETFD, 0) },
        0
    );
    let mut command = Command::new("/usr/bin/python3");
    command.args([
        "-c",
        r#"
import ctypes, mmap, os, socket, sys, threading
libc = ctypes.CDLL(None)
s = socket.socket(fileno=int(sys.argv[1]))
def worker():
    count = 0
    s.sendall(b'R')
    while True:
        command = s.recv(1)
        if not command:
            return
        if command == b't':
            def timed_wait():
                class Timespec(ctypes.Structure):
                    _fields_ = [('sec', ctypes.c_long), ('nsec', ctypes.c_long)]
                word = ctypes.c_int()
                timeout = Timespec(600, 0)
                s.sendall(b'T' + threading.get_native_id().to_bytes(4, 'little') + ctypes.addressof(word).to_bytes(8, 'little'))
                libc.syscall(int(sys.argv[3]), ctypes.byref(word), 128, 0, ctypes.byref(timeout), 0, 0)
            threading.Thread(target=timed_wait, daemon=True).start()
            continue
        if command == b'o':
            s.sendall(b'B' + threading.get_native_id().to_bytes(4, 'little'))
            fd = os.open(sys.argv[2] + '-fifo', os.O_WRONLY)
            os.close(fd)
            s.sendall(b'O')
            continue
        if command == b'm':
            file = open(sys.argv[2], 'r+b')
            mapping = mmap.mmap(file.fileno(), 4096)
            address = ctypes.addressof(ctypes.c_char.from_buffer(mapping))
            s.sendall(b'M' + threading.get_native_id().to_bytes(4, 'little'))
            libc.read(s.fileno(), ctypes.c_void_p(address), 1)
            mapping.close()
            file.close()
            continue
        count += 1
        pid = os.fork() if command == b'f' else 0
        if pid:
            os.waitpid(pid, 0)
            continue
        with open(sys.argv[2], 'w') as f:
            f.write(str(count))
        s.sendall(bytes([count]))
        if command == b'f':
            os._exit(0)
threading.Thread(target=worker).start()
threading.Event().wait()
"#,
    ]);
    command
        .arg(peer.as_raw_fd().to_string())
        .arg(fixture.path("counter"))
        .arg((Sysno::futex as usize).to_string());
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let (sender, events) = mpsc::channel();
    let _guard = scope.enter();
    let child = fixture
        .service
        .spawn(
            command,
            Box::new(move |event| {
                let _ = sender.send(event);
            }),
        )
        .unwrap();
    drop(peer);
    let mut ready = [0];
    host.read_exact(&mut ready).unwrap();
    assert_eq!(ready, [b'R']);
    (child, events, host)
}

#[test]
fn parking_preserves_multithreaded_process_state_and_blocks_external_continue() {
    let fixture = Fixture::new();
    let run = fixture.service.begin_run(fixture.root).unwrap();
    let scope = fixture.service.scope(run).unwrap();
    let (child, events, mut socket) = parking_child(&fixture, &scope);
    let mut reply = [0];
    socket.write_all(b"w").unwrap();
    socket.read_exact(&mut reply).unwrap();
    assert_eq!(reply, [1]);
    let parked = fixture.service.park(run).unwrap();
    assert_eq!(parked.run(), run);
    socket.write_all(b"w").unwrap();
    // An embedder's SIGCONT must not release a policy-held tree.
    signal_process(&child.process, libc::SIGCONT).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_millis(100)))
        .unwrap();
    assert!(matches!(
        socket.read_exact(&mut reply).unwrap_err().kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
    ));
    assert_eq!(
        std::fs::read_to_string(fixture.path("counter")).unwrap(),
        "1"
    );
    parked.resume().unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    socket.read_exact(&mut reply).unwrap();
    assert_eq!(reply, [2], "same process-local counter survives resume");
    assert_eq!(
        std::fs::read_to_string(fixture.path("counter")).unwrap(),
        "2"
    );
    let parked = fixture.service.park(run).unwrap();
    drop(parked);
    assert_eq!(exited(&events).signal(), Some(libc::SIGKILL));
    child.wait_observed().unwrap();
    fixture.finish(run);
}

#[test]
fn empty_runs_park_resume_and_cancel_without_ending_the_run() {
    let fixture = Fixture::new();
    let run = fixture.service.begin_run(fixture.root).unwrap();
    fixture.service.park(run).unwrap().resume().unwrap();
    assert_eq!(fixture.service.park(run).unwrap().cancel().unwrap(), 0);
    fixture.finish(run);
}

#[test]
fn parking_drains_a_pending_filesystem_open_before_closing_evidence() {
    use std::os::unix::fs::OpenOptionsExt;
    let fixture = Fixture::new();
    let run = fixture.service.begin_run(fixture.root).unwrap();
    let scope = fixture.service.scope(run).unwrap();
    let fifo = fixture.path("counter-fifo");
    assert!(
        Command::new("/usr/bin/mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    let (child, events, mut socket) = parking_child(&fixture, &scope);
    pending_fifo_open(&mut socket, child.pid);
    let service = Arc::clone(&fixture.service);
    let (sender, completed) = mpsc::channel();
    let waiter = std::thread::spawn(move || {
        let result = service.park(run);
        let _ = sender.send(result);
    });
    assert!(
        matches!(
            completed.recv_timeout(Duration::from_millis(100)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ),
        "an effectful pending call cannot span epochs"
    );
    let reader = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(&fifo)
        .unwrap();
    let parked = completed
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap();
    waiter.join().unwrap();
    assert!(
        lock(&fixture.seen).iter().any(|call| {
            matches!(call.info.syscall, Sysno::open | Sysno::openat)
                && call
                    .paths
                    .iter()
                    .any(|(_, path)| path.ends_with(b"counter-fifo"))
                && !matches!(call.info.result, RetCode::Err(_))
        }),
        "the completed open must be classified before parking succeeds"
    );
    parked.cancel().unwrap();
    assert_eq!(exited(&events).signal(), Some(libc::SIGKILL));
    child.wait_observed().unwrap();
    drop(reader);
    fixture.finish(run);
}

#[test]
fn descendants_adopted_while_parking_cannot_write_until_resumed() {
    let fixture = Fixture::new();
    let run = fixture.service.begin_run(fixture.root).unwrap();
    let scope = fixture.service.scope(run).unwrap();
    let (child, events, mut socket) = parking_child(&fixture, &scope);
    for expected in 1..=32 {
        socket.write_all(b"f").unwrap();
        let parked = bounded_park(&fixture.service, run);
        let before = std::fs::read(fixture.path("counter")).ok();
        // A socket command issued across a closed barrier cannot make progress.
        socket
            .set_read_timeout(Some(Duration::from_millis(20)))
            .unwrap();
        let mut reply = [0];
        let pending_reply = socket.read_exact(&mut reply);
        assert_eq!(std::fs::read(fixture.path("counter")).ok(), before);
        parked.resume().unwrap();
        if pending_reply.is_err() {
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            socket.read_exact(&mut reply).unwrap();
        }
        assert_eq!(reply, [expected]);
        assert_eq!(
            std::fs::read_to_string(fixture.path("counter")).unwrap(),
            expected.to_string()
        );
    }
    bounded_park(&fixture.service, run).cancel().unwrap();
    assert_eq!(exited(&events).signal(), Some(libc::SIGKILL));
    child.wait_observed().unwrap();
    fixture.finish(run);
}

#[test]
fn parking_waits_for_in_progress_classification_delivery() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let service = Tracing::shared().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);
    let armed = Arc::new(AtomicBool::new(false));
    let trigger = Arc::clone(&armed);
    let (at_callback, callback) = mpsc::channel();
    let (release, released) = mpsc::sync_channel(0);
    let released = Mutex::new(released);
    let root = service
        .register_root(
            &directory.path().canonicalize().unwrap(),
            Arc::new(move |_, info| {
                if info
                    .paths
                    .iter()
                    .any(|(_, path)| path.ends_with(b"counter"))
                    && trigger.swap(false, Ordering::AcqRel)
                {
                    at_callback.send(()).unwrap();
                    released.lock().unwrap().recv().unwrap();
                }
                lock(&sink).push(info);
                Ok(())
            }),
        )
        .unwrap();
    let fixture = Fixture {
        service,
        directory,
        root,
        seen,
    };
    let run = fixture.service.begin_run(root).unwrap();
    let scope = fixture.service.scope(run).unwrap();
    let (child, events, mut socket) = parking_child(&fixture, &scope);
    armed.store(true, Ordering::Release);
    socket.write_all(b"w").unwrap();
    callback.recv_timeout(Duration::from_secs(5)).unwrap();
    let service = Arc::clone(&fixture.service);
    let (sender, completed) = mpsc::channel();
    let waiter = std::thread::spawn(move || {
        let _ = sender.send(service.park(run));
    });
    let early = completed.recv_timeout(Duration::from_millis(100));
    release.send(()).unwrap();
    let parked = match early {
        Ok(_) => panic!("park returned with an unclassified delivery"),
        Err(mpsc::RecvTimeoutError::Disconnected) => panic!("park waiter disconnected"),
        Err(mpsc::RecvTimeoutError::Timeout) => completed
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap(),
    };
    waiter.join().unwrap();
    parked.cancel().unwrap();
    assert_eq!(exited(&events).signal(), Some(libc::SIGKILL));
    child.wait_observed().unwrap();
    fixture.finish(run);
}

#[test]
fn cancellation_wakes_a_barrier_draining_an_effectful_call() {
    let fixture = Fixture::new();
    let run = fixture.service.begin_run(fixture.root).unwrap();
    let scope = fixture.service.scope(run).unwrap();
    let fifo = fixture.path("counter-fifo");
    assert!(
        Command::new("/usr/bin/mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    let (child, events, mut socket) = parking_child(&fixture, &scope);
    pending_fifo_open(&mut socket, child.pid);
    let service = Arc::clone(&fixture.service);
    let (sender, completed) = mpsc::channel();
    let waiter = std::thread::spawn(move || {
        let _ = sender.send(service.park(run));
    });
    assert!(matches!(
        completed.recv_timeout(Duration::from_millis(100)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    fixture.service.cancel(run).unwrap();
    assert!(
        completed
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .is_err()
    );
    waiter.join().unwrap();
    assert_eq!(exited(&events).signal(), Some(libc::SIGKILL));
    child.wait_observed().unwrap();
    fixture.finish(run);
}

fn pending_fifo_open(socket: &mut std::os::unix::net::UnixStream, pid: u32) {
    socket.write_all(b"o").unwrap();
    let mut ready = [0; 5];
    socket.read_exact(&mut ready).unwrap();
    assert_eq!(ready[0], b'B');
    let tid = u32::from_le_bytes(ready[1..].try_into().unwrap());
    wait_in_syscall(pid, tid, Sysno::openat);
}

fn wait_in_syscall(pid: u32, tid: u32, expected: Sysno) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let syscall = std::fs::read_to_string(format!("/proc/{pid}/task/{tid}/syscall")).unwrap();
        if syscall
            .split_whitespace()
            .next()
            .and_then(|n| n.parse::<usize>().ok())
            == Some(expected as usize)
        {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "worker never entered {expected}"
        );
        std::thread::yield_now();
    }
}

/// Waits until `tid` sleeps in the announced private futex wait on `word`, or, with
/// `allow_restart`, in its kernel continuation, whose restart block has no argument ABI.
fn wait_for_timed_futex(pid: u32, tid: u32, word: u64, allow_restart: bool) -> io::Result<()> {
    let status = format!("/proc/{pid}/task/{tid}/status");
    let registers = format!("/proc/{pid}/task/{tid}/syscall");
    let operation = u64::from((libc::FUTEX_WAIT | libc::FUTEX_PRIVATE_FLAG).cast_unsigned());
    let invalid = |what: &str, text: &str| {
        io::Error::new(io::ErrorKind::InvalidData, format!("{what}: {text:?}"))
    };
    let state = || -> io::Result<String> {
        let text = std::fs::read_to_string(&status)?;
        text.lines()
            .find_map(|line| line.strip_prefix("State:"))
            .and_then(|rest| rest.split_whitespace().next())
            .map(str::to_owned)
            .ok_or_else(|| invalid("status lacks State", &text))
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        // Registers alone cannot tell a ptrace entry stop from the kernel sleep; bracket them.
        let before = state()?;
        let syscall = std::fs::read_to_string(&registers)?;
        let after = state()?;
        let mut fields = syscall.split_whitespace();
        let waiting = match fields.next() {
            Some("running") => false,
            number => match number.and_then(|number| number.parse::<i64>().ok()) {
                None => return Err(invalid("malformed syscall number", &syscall)),
                Some(-1) => false,
                Some(number) if number == Sysno::futex as i64 => {
                    let mut argument = || {
                        fields
                            .next()
                            .and_then(|field| {
                                u64::from_str_radix(field.strip_prefix("0x").unwrap_or(field), 16)
                                    .ok()
                            })
                            .ok_or_else(|| invalid("malformed futex arguments", &syscall))
                    };
                    (argument()?, argument()?, argument()?) == (word, operation, 0)
                }
                Some(number) => allow_restart && number == Sysno::restart_syscall as i64,
            },
        };
        if waiting && before == "S" && after == "S" {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!(
                    "pid {pid} tid {tid} never slept in the futex wait on {word:#x} \
                     (allow_restart: {allow_restart}); last states {before}/{after}, \
                     syscall {syscall:?}"
                ),
            ));
        }
        std::thread::yield_now();
    }
}

fn bounded_park(service: &Arc<Tracing>, run: TraceRun) -> ParkedRun {
    let tracing = Arc::clone(service);
    let (sender, completed) = mpsc::channel();
    let waiter = std::thread::spawn(move || {
        let _ = sender.send(tracing.park(run));
    });
    match completed.recv_timeout(Duration::from_secs(5)) {
        Ok(result) => {
            waiter.join().unwrap();
            result.unwrap()
        }
        Err(error) => {
            let state = lock(&service.state);
            let tasks: Vec<_> = state
                .threads
                .iter()
                .filter(|(_, t)| t.inherited == Some(run))
                .map(|(tid, t)| {
                    (
                        *tid,
                        t.policy_held,
                        t.pending.map(|p| (p.entry, p.safe)),
                        t.classify_after,
                        t.early.len(),
                        t.restart,
                        t.restart_uncertain,
                    )
                })
                .collect();
            drop(state);
            eprintln!("park deadline before cancel: {error}; tasks={tasks:?}");
            service.cancel(run).unwrap();
            waiter.join().unwrap();
            panic!("park deadline: {error}; tasks={tasks:?}");
        }
    }
}

#[test]
fn a_socket_read_into_a_shared_mapping_must_complete_before_parking() {
    let fixture = Fixture::new();
    std::fs::write(fixture.path("counter"), [0; 4096]).unwrap();
    let run = fixture.service.begin_run(fixture.root).unwrap();
    let scope = fixture.service.scope(run).unwrap();
    let (child, events, mut socket) = parking_child(&fixture, &scope);
    socket.write_all(b"m").unwrap();
    let mut ready = [0; 5];
    socket.read_exact(&mut ready).unwrap();
    assert_eq!(ready[0], b'M');
    wait_in_syscall(
        child.pid,
        u32::from_le_bytes(ready[1..].try_into().unwrap()),
        Sysno::read,
    );
    let tracing = Arc::clone(&fixture.service);
    let (sender, completed) = mpsc::channel();
    let waiter = std::thread::spawn(move || {
        let _ = sender.send(tracing.park(run));
    });
    let early = completed.recv_timeout(Duration::from_millis(100));
    socket.write_all(b"x").unwrap();
    let parked = match early {
        Ok(_) => panic!("a kernel writer retained a shared file buffer across the barrier"),
        Err(mpsc::RecvTimeoutError::Disconnected) => panic!("park waiter disconnected"),
        Err(mpsc::RecvTimeoutError::Timeout) => completed
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap(),
    };
    waiter.join().unwrap();
    assert_eq!(std::fs::read(fixture.path("counter")).unwrap()[0], b'x');
    parked.cancel().unwrap();
    assert_eq!(exited(&events).signal(), Some(libc::SIGKILL));
    child.wait_observed().unwrap();
    fixture.finish(run);
}

#[test]
fn effectless_timed_waits_remain_parkable_across_resumes() {
    let fixture = Fixture::new();
    let run = fixture.service.begin_run(fixture.root).unwrap();
    let scope = fixture.service.scope(run).unwrap();
    let (child, events, mut socket) = parking_child(&fixture, &scope);
    socket.write_all(b"t").unwrap();
    let mut ready = [0; 13];
    socket.read_exact(&mut ready).unwrap();
    assert_eq!(ready[0], b'T');
    let tid = u32::from_le_bytes(ready[1..5].try_into().unwrap());
    let word = u64::from_le_bytes(ready[5..].try_into().unwrap());
    // A resumed wait may continue as `restart_syscall` or still sleep in its original entry.
    let cycles = || -> io::Result<()> {
        wait_for_timed_futex(child.pid, tid, word, false)?;
        for _ in 0..3 {
            bounded_park(&fixture.service, run).resume()?;
            wait_for_timed_futex(child.pid, tid, word, true)?;
        }
        Ok(())
    };
    let result = cycles();
    if result.is_ok() {
        bounded_park(&fixture.service, run).cancel().unwrap();
    } else {
        fixture.service.cancel(run).unwrap();
    }
    let signal = exited(&events).signal();
    child.wait_observed().unwrap();
    fixture.finish(run);
    result.unwrap();
    assert_eq!(signal, Some(libc::SIGKILL));
}

/// Feeds `tid`'s record-less stop, as the observer reports calls outside the selected set.
fn note_syscall(
    state: &mut State,
    tid: Pid,
    sequence: u64,
    syscall: Sysno,
    result: Option<RetCode>,
) {
    let entry = EntryInfo {
        syscall: Some(syscall),
        capture: None,
        result,
    };
    Tracing::note_stop(
        state,
        tid,
        WaitStatus::PtraceSyscall(tid),
        sequence,
        Some(entry),
    )
    .unwrap();
}

/// Pending (safe, writes memory), safe restart provenance, and no effectful interrupted call.
fn restart_view(state: &State, tid: Pid) -> (Option<(bool, bool)>, Option<bool>, bool) {
    let thread = state.threads.get(&tid).unwrap();
    (
        thread
            .pending
            .map(|pending| (pending.safe, pending.writes_memory)),
        thread.safe_restart,
        thread.restart.is_none() && !thread.restart_uncertain,
    )
}

#[test]
fn effectless_restartblock_preserves_park_safety_across_restarts() {
    let tid = Pid::from_raw(1);
    let mut state = State::default();
    // Provenance of an interrupted wait that cannot write into a shared mapping.
    state.threads.entry(tid).or_default().safe_restart = Some(false);
    note_syscall(&mut state, tid, 1, Sysno::restart_syscall, None);
    assert_eq!(restart_view(&state, tid), (Some((true, false)), None, true));
    note_syscall(
        &mut state,
        tid,
        2,
        Sysno::restart_syscall,
        Some(RetCode::Err(-516)),
    );
    assert_eq!(restart_view(&state, tid), (None, Some(false), true));
    note_syscall(&mut state, tid, 3, Sysno::restart_syscall, None);
    assert_eq!(restart_view(&state, tid), (Some((true, false)), None, true));
}

#[test]
fn restart_syscall_requires_immediate_safe_predecessor() {
    let tid = Pid::from_raw(1);
    let mut state = State::default();
    note_syscall(&mut state, tid, 1, Sysno::restart_syscall, None);
    assert_eq!(restart_view(&state, tid), (Some((false, true)), None, true));

    let mut state = State::default();
    state.threads.entry(tid).or_default().safe_restart = Some(false);
    note_syscall(&mut state, tid, 1, Sysno::openat, None);
    assert_eq!(restart_view(&state, tid), (Some((false, true)), None, true));
    note_syscall(&mut state, tid, 2, Sysno::openat, Some(RetCode::Ok(0)));
    assert_eq!(restart_view(&state, tid), (None, None, true));
    note_syscall(&mut state, tid, 3, Sysno::restart_syscall, None);
    assert_eq!(restart_view(&state, tid), (Some((false, true)), None, true));
}
