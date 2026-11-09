//! Real CopyTree transactions through the public typed-session API.
use super::*;
use crate::{
    Action, ManagedCancellation, ManagedError, ManagedSession, MarshTool, Policy, PolicyDecision,
    PolicyFn, PolicyObserver, PolicyStore, Principal, ShellError,
};
use std::{
    borrow::Cow,
    io,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Clone, Copy)]
struct TypedTool;
impl From<&TypedTool> for Action {
    fn from(_: &TypedTool) -> Self {
        Self::Edit
    }
}
impl From<TypedTool> for Action {
    fn from(tool: TypedTool) -> Self {
        Self::from(&tool)
    }
}
impl MarshTool for TypedTool {
    fn description(&self) -> Cow<'_, str> {
        Cow::Borrowed("typed transaction integration")
    }
}

async fn open(fixture: &Fixture) -> ManagedSession {
    let mut builder = Shell::builder().working_dir(fixture.seed.clone());
    builder.backend = Some(fixture.fs.clone());
    builder.build_managed_session().await.unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn typed_reads_reject_special_files_without_waiting_for_a_writer() {
    let fixture = Fixture::new();
    let scratch = tempfile::tempdir().unwrap();
    let fifo = scratch.path().join("blocked");
    assert!(
        std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    let (done, completed) = std::sync::mpsc::channel();
    let unblock = fifo.clone();
    // A real writer releases a regressed blocking read, so this test fails rather than hangs.
    let guard = std::thread::spawn(move || {
        if completed
            .recv_timeout(std::time::Duration::from_secs(3))
            .is_err()
        {
            let mut writer = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(unblock)
                .unwrap();
            std::io::Write::write_all(&mut writer, b"unblocked regression").unwrap();
        }
    });
    let mut managed = open(&fixture).await;
    let result = managed
        .epoch(TypedTool, &ManagedCancellation::default(), async |epoch| {
            Ok::<_, io::Error>([
                epoch
                    .read_to_string(&fifo)
                    .map(|_| ())
                    .map_err(|error| error.kind()),
                epoch
                    .read(Path::new("/dev/null"))
                    .map(|_| ())
                    .map_err(|error| error.kind()),
            ])
        })
        .await;
    let _ = done.send(());
    guard.join().unwrap();
    assert_eq!(result.unwrap().value, [Err(io::ErrorKind::InvalidInput); 2]);
    managed.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tracked_host_writes_publish_before_return_and_reverts_still_mutate() {
    let fixture = Fixture::new();
    let mut managed = open(&fixture).await;
    let outcome = managed
        .epoch(TypedTool, &ManagedCancellation::default(), async |epoch| {
            let before = epoch.read(Path::new("src/a.txt"))?;
            epoch.write(Path::new("src/a.txt"), b"new\n")?;
            Ok::<_, io::Error>(before)
        })
        .await
        .unwrap();
    assert_eq!(outcome.value, b"seed\n");
    assert!(outcome.workspace_mutated);
    assert_eq!(fixture.read("src/a.txt"), "new\n");
    let outcome = managed
        .epoch(TypedTool, &ManagedCancellation::default(), async |epoch| {
            let before = epoch.read(Path::new("src/a.txt"))?;
            epoch.write(Path::new("src/a.txt"), b"temporary\n")?;
            epoch.write(Path::new("src/a.txt"), &before)?;
            Ok::<_, io::Error>(())
        })
        .await
        .unwrap();
    assert!(
        outcome.workspace_mutated,
        "byte equality is not mutation evidence"
    );
    assert_eq!(fixture.read("src/a.txt"), "new\n");
    managed.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_edits_invalidate_before_the_callback_and_can_be_retried_fresh() {
    let fixture = Fixture::new();
    let mut managed = open(&fixture).await;
    let first = managed
        .epoch(TypedTool, &ManagedCancellation::default(), async |epoch| {
            epoch.read_to_string(Path::new("src/a.txt"))
        })
        .await
        .unwrap();
    assert!(!first.workspace_mutated);
    std::fs::write(fixture.seed.join("src/a.txt"), "host\n").unwrap();
    let entered = AtomicBool::new(false);
    let invalidated = managed
        .epoch(TypedTool, &ManagedCancellation::default(), async |_epoch| {
            entered.store(true, Ordering::Release);
            Ok::<_, io::Error>(())
        })
        .await;
    assert!(matches!(invalidated, Err(ManagedError::Invalidated)));
    assert!(!entered.load(Ordering::Acquire));
    let fresh = managed
        .epoch(TypedTool, &ManagedCancellation::default(), async |epoch| {
            epoch.read_to_string(Path::new("src/a.txt"))
        })
        .await
        .unwrap();
    assert_eq!(fresh.value, "host\n");
    managed.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn authorized_operation_errors_discard_all_filesystem_changes_and_keep_history() {
    use super::super::session::PublishMeta;
    use marsh_wal::{JsonLog, WalRecord};
    let fixture = Fixture::new();
    let mut managed = open(&fixture).await;
    let error = managed
        .epoch(TypedTool, &ManagedCancellation::default(), async |epoch| {
            let protected = epoch.read_to_string(Path::new("src/a.txt"))?;
            epoch.write(Path::new("src/a.txt"), b"must not publish\n")?;
            Err::<(), _>(io::Error::other(protected))
        })
        .await
        .err()
        .unwrap();
    assert!(matches!(error, ManagedError::Operation(ref error) if error.to_string() == "seed\n"));
    assert_eq!(fixture.read("src/a.txt"), "seed\n");
    let records = JsonLog::<WalRecord<PublishMeta>>::read(&fixture.log()).unwrap();
    assert!(records.iter().any(|record| matches!(record,
        WalRecord::Begin { op_count: 0, meta, .. }
            if meta.granted.iter().any(|grant| grant.action == Action::Read)
                && meta.granted.iter().any(|grant| grant.action == Action::Edit))));
    let fresh = managed
        .epoch(TypedTool, &ManagedCancellation::default(), async |epoch| {
            epoch.read_to_string(Path::new("src/a.txt"))
        })
        .await
        .unwrap();
    assert_eq!(fresh.value, "seed\n");
    managed.close().await.unwrap();
}

struct DenyAll;
impl Policy for DenyAll {
    fn evaluator<'batch>(
        &'batch self,
        _store: Arc<PolicyStore<'batch>>,
    ) -> Result<Box<PolicyFn<'batch>>, ShellError> {
        Ok(Box::new(|_, _| {
            Ok(PolicyDecision::Deny {
                failed_precondition: "test policy refuses capabilities".into(),
                allowed_fixes: Vec::new(),
            })
        }))
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn denied_operation_error_does_not_expose_read_content_or_partial_edits() {
    let fixture = Fixture::new();
    let mut builder = Shell::builder()
        .working_dir(fixture.seed.clone())
        .shell_policy(Arc::new(DenyAll));
    builder.backend = Some(fixture.fs.clone());
    let mut managed = builder.build_managed_session().await.unwrap();
    let error = managed
        .epoch(TypedTool, &ManagedCancellation::default(), async |epoch| {
            let secret = epoch.read_to_string(Path::new("src/a.txt"))?;
            epoch.write(Path::new("src/a.txt"), b"unapproved prefix")?;
            Err::<(), _>(io::Error::other(secret))
        })
        .await
        .err()
        .unwrap();
    assert!(matches!(error, ManagedError::Execution(ref error)
        if matches!(error.kind(), ShellErrorKind::Denied { .. })));
    assert!(!format!("{error:?}").contains("seed\n"));
    assert_eq!(fixture.read("src/a.txt"), "seed\n");
    managed.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_later_resource_failure_never_commits_an_earlier_edit() {
    let fixture = Fixture::new();
    let mut managed = open(&fixture).await;
    let result = managed
        .epoch(TypedTool, &ManagedCancellation::default(), async |epoch| {
            epoch.read(Path::new("src/a.txt"))?;
            epoch.write(Path::new("src/a.txt"), b"prefix")?;
            epoch.rename(Path::new("missing"), Path::new("destination"))?;
            Ok::<_, io::Error>(())
        })
        .await;
    assert!(matches!(result, Err(ManagedError::Operation(_))));
    assert_eq!(fixture.read("src/a.txt"), "seed\n");
    assert!(!fixture.seed.join("destination").exists());
    managed.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_pre_cancelled_call_never_enters_its_callback() {
    let fixture = Fixture::new();
    let mut managed = open(&fixture).await;
    let cancel = ManagedCancellation::default();
    cancel.cancel();
    let entered = AtomicBool::new(false);
    let result = managed
        .epoch(TypedTool, &cancel, async |_epoch| {
            entered.store(true, Ordering::Release);
            Ok::<_, io::Error>(())
        })
        .await;
    assert!(matches!(result, Err(ManagedError::Cancelled)));
    assert!(!entered.load(Ordering::Acquire));
    assert!(
        !fixture.log().exists(),
        "cancelled admission performs no workspace I/O"
    );
    managed.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn active_cancellation_discards_private_changes_and_keeps_configuration_usable() {
    let fixture = Fixture::new();
    let mut managed = open(&fixture).await;
    let cancel = ManagedCancellation::default();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (result, ()) = tokio::join!(
        managed.epoch(TypedTool, &cancel, async |epoch| {
            epoch.read(Path::new("src/a.txt"))?;
            epoch.write(Path::new("src/a.txt"), b"cancelled prefix")?;
            let _ = started.send(());
            std::future::pending::<Result<(), io::Error>>().await
        }),
        async {
            ready.await.unwrap();
            cancel.cancel();
        },
    );
    assert!(matches!(result, Err(ManagedError::Cancelled)));
    assert_eq!(fixture.read("src/a.txt"), "seed\n");
    let next = managed
        .epoch(TypedTool, &ManagedCancellation::default(), async |epoch| {
            epoch.read_to_string(Path::new("src/a.txt"))
        })
        .await
        .unwrap();
    assert_eq!(next.value, "seed\n");
    managed.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cached_content_claims_are_reauthorized_for_the_configured_owner() {
    let fixture = Fixture::new();
    let observed = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&observed);
    let owner = Principal::from("typed-owner".to_owned());
    let observer = PolicyObserver::new(move |event, decision| {
        sink.lock()
            .unwrap()
            .push((event.clone(), matches!(decision, PolicyDecision::Grant)));
    });
    let mut builder = Shell::builder()
        .working_dir(fixture.seed.clone())
        .policy_owner(Some(owner.clone()))
        .policy_observer(Some(Arc::new(observer)));
    builder.backend = Some(fixture.fs.clone());
    let mut managed = builder.build_managed_session().await.unwrap();
    let first = managed
        .epoch(TypedTool, &ManagedCancellation::default(), async |epoch| {
            epoch.read_to_string(Path::new("src/a.txt"))
        })
        .await
        .unwrap();
    assert_eq!(first.value, "seed\n");
    observed.lock().unwrap().clear();
    let cached = managed
        .epoch(TypedTool, &ManagedCancellation::default(), async |_epoch| {
            Ok::<_, io::Error>(first.value)
        })
        .await
        .unwrap();
    assert_eq!(cached.value, "seed\n");
    assert!(
        observed
            .lock()
            .unwrap()
            .iter()
            .any(|(event, granted)| *granted
                && event.principal == owner
                && event.action == Action::Read)
    );
    managed.close().await.unwrap();
}

async fn exchange(
    child: &crate::ManagedChild,
    epoch: &crate::ManagedEpoch<'_>,
    message: &[u8],
) -> io::Result<String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let mut streams = child.io(epoch).map_err(io::Error::other)?;
    streams.stdin.write_all(message).await?;
    streams.stdin.flush().await?;
    let mut line = String::new();
    BufReader::new(&mut streams.stdout)
        .read_line(&mut line)
        .await?;
    Ok(line)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn direct_argv_children_keep_pid_and_state_across_clean_epochs_and_retire_on_invalidation() {
    use std::{
        ffi::OsStr,
        process::{Command, Stdio},
    };
    let fixture = Fixture::new();
    let mut managed = open(&fixture).await;
    let first = managed.epoch(TypedTool, &ManagedCancellation::default(), async |epoch| {
        assert_eq!(epoch.read_to_string(Path::new("src/a.txt"))?, "seed\n");
        let python = epoch.resolve_executable(OsStr::new("python3"), None)?;
        let mut command = Command::new(python);
        command.args(["-u", "-c", "import os,sys\ncount=0\nfor line in sys.stdin:\n count+=1\n print(str(os.getpid())+':'+str(count)+':'+line.strip(), flush=True)"])
            .env_clear().envs(epoch.environment())
            .current_dir(epoch.physical_path(epoch.cwd()).map_err(io::Error::other)?)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let child = epoch.spawn("retained Python server", command).map_err(io::Error::other)?;
        let line = exchange(&child, epoch, b"first\n").await?;
        Ok::<_, io::Error>((child, line))
    }).await.unwrap();
    assert!(!first.workspace_mutated);
    let (child, first_line) = first.value;
    let pid = child.id();
    assert_eq!(first_line, format!("{pid}:1:first\n"));
    let peer = fixture.shell().await;
    let second = managed
        .epoch(TypedTool, &ManagedCancellation::default(), async |epoch| {
            exchange(&child, epoch, b"second\n").await
        })
        .await
        .unwrap();
    assert!(!second.workspace_mutated);
    assert_eq!(second.value, format!("{pid}:2:second\n"));
    let mut unrelated = open(&fixture).await;
    unrelated
        .epoch(TypedTool, &ManagedCancellation::default(), async |epoch| {
            assert!(
                child.io(epoch).is_err(),
                "foreign session must not obtain pipe access"
            );
            Ok::<_, io::Error>(())
        })
        .await
        .unwrap();
    unrelated.close().await.unwrap();
    accepted(&peer, "printf peer > disjoint").await;
    let entered = AtomicBool::new(false);
    let invalidated = managed
        .epoch(TypedTool, &ManagedCancellation::default(), async |epoch| {
            entered.store(true, Ordering::Release);
            exchange(&child, epoch, b"must-not-send\n").await
        })
        .await;
    assert!(matches!(invalidated, Err(ManagedError::Invalidated)));
    assert!(!entered.load(Ordering::Acquire));
    assert!(
        !Path::new(&format!("/proc/{pid}")).exists(),
        "invalidated tree was drained"
    );
    let fresh = managed
        .epoch(TypedTool, &ManagedCancellation::default(), async |epoch| {
            epoch.read_to_string(Path::new("disjoint"))
        })
        .await
        .unwrap();
    assert_eq!(fresh.value, "peer");
    managed.close().await.unwrap();
    close(peer).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tracked_resource_operations_publish_the_complete_result() {
    let fixture = Fixture::new();
    std::os::unix::fs::symlink("a.txt", fixture.seed.join("src/link")).unwrap();
    let mut managed = open(&fixture).await;
    let result = managed
        .epoch(TypedTool, &ManagedCancellation::default(), async |epoch| {
            assert!(epoch.symlink_metadata(Path::new("src/link"))?.is_symlink());
            assert_eq!(epoch.read_link(Path::new("src/link"))?, Path::new("a.txt"));
            epoch.create_dir_all(Path::new("new/nested"))?;
            epoch.create_new(Path::new("new/nested/file"), b"content")?;
            epoch.rename(Path::new("new/nested/file"), Path::new("new/moved"))?;
            epoch.remove_dir(Path::new("new/nested"))?;
            let entries = epoch
                .read_dir(Path::new("new"))?
                .collect::<io::Result<Vec<_>>>()?;
            assert_eq!(entries, [epoch.cwd().join("new/moved")]);
            let globs = epoch
                .glob("new/*")
                .map_err(io::Error::other)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(io::Error::other)?;
            assert_eq!(globs, entries);
            Ok::<_, io::Error>(epoch.read_to_string(Path::new("new/moved"))?)
        })
        .await
        .unwrap();
    assert!(result.workspace_mutated);
    assert_eq!(result.value, "content");
    assert_eq!(fixture.read("new/moved"), "content");
    assert!(!fixture.seed.join("new/nested").exists());
    managed.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_while_waiting_for_direct_admission_does_not_run_the_callback() {
    let fixture = Fixture::new();
    let mut managed = open(&fixture).await;
    let mut builder = Shell::builder()
        .working_dir(fixture.seed.clone())
        .sandbox_policy(SandboxPolicy::Base(|_| false));
    builder.backend = Some(fixture.fs.clone());
    let direct = builder.build().await.unwrap();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, released) = std::sync::mpsc::channel();
    let held = direct.run_tool(TypedTool, move |_context| {
        let _ = started.send(());
        released.recv().unwrap();
    });
    let cancel = ManagedCancellation::default();
    let entered = AtomicBool::new(false);
    let (held_result, ()) = tokio::join!(held, async {
        ready.await.unwrap();
        let (result, ()) = tokio::join!(
            managed.epoch(TypedTool, &cancel, async |_epoch| {
                entered.store(true, Ordering::Release);
                Ok::<_, io::Error>(())
            }),
            async {
                tokio::task::yield_now().await;
                cancel.cancel();
                release.send(()).unwrap();
            },
        );
        assert!(matches!(result, Err(ManagedError::Cancelled)));
    });
    held_result.unwrap();
    assert!(!entered.load(Ordering::Acquire));
    assert_eq!(fixture.read("src/a.txt"), "seed\n");
    managed.close().await.unwrap();
    close(direct).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn comparison_io_failure_is_execution_error_not_an_invalidation_retry() {
    let fixture = Fixture::new();
    let mut managed = open(&fixture).await;
    let work = managed
        .epoch(TypedTool, &ManagedCancellation::default(), async |epoch| {
            epoch
                .read(Path::new("src/a.txt"))
                .map_err(io::Error::other)?;
            epoch.physical_path(epoch.cwd()).map_err(io::Error::other)
        })
        .await
        .unwrap()
        .value;
    let moved = work.with_extension("temporarily-unavailable");
    std::fs::rename(&work, &moved).unwrap();
    let entered = AtomicBool::new(false);
    let result = managed
        .epoch(TypedTool, &ManagedCancellation::default(), async |_epoch| {
            entered.store(true, Ordering::Release);
            Ok::<_, io::Error>(())
        })
        .await;
    std::fs::rename(&moved, &work).unwrap();
    assert!(matches!(result, Err(ManagedError::Execution(_))));
    assert!(!entered.load(Ordering::Acquire));
    assert_eq!(fixture.read("src/a.txt"), "seed\n");
    // Removing the root can also make retirement uncertain; close must still be attempted.
    let _ = managed.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delegated_resources_remain_charged_across_parks_and_finish_before_close() {
    use crate::{PipelineOptions, ResourceEvent, ResourceLimits, ResourceMonitorConfig};
    use std::{
        ffi::OsStr,
        process::{Command, Stdio},
        time::Duration,
    };
    let fixture = Fixture::new();
    let monitor = ResourceMonitorConfig::new(Duration::from_secs(1));
    let mut events = monitor.events().unwrap();
    let options = PipelineOptions::default()
        .with_resource_limits(ResourceLimits {
            pids: Some(64),
            ..Default::default()
        })
        .with_resource_monitor(monitor);
    let mut builder = Shell::builder()
        .working_dir(fixture.seed.clone())
        .pipeline_options(options)
        .policy_owner(Some(Principal::from("resource-owner".to_owned())));
    builder.backend = Some(fixture.fs.clone());
    let mut managed = builder.build_managed_session().await.unwrap();
    // Without a delegated cgroup the spawn fails closed; skip as the other resource tests do (the
    // CI lanes reject the skip line, so they still require delegation).
    let cgroup_unavailable = |error: &io::Error| {
        std::iter::successors(Some(error as &(dyn std::error::Error + 'static)), |e| {
            e.source()
        })
        .any(|e| {
            e.to_string()
                .starts_with("cgroup resource control unavailable")
        })
    };
    let first = match managed
        .epoch(TypedTool, &ManagedCancellation::default(), async |epoch| {
            let cat = epoch.resolve_executable(OsStr::new("cat"), None)?;
            let mut command = Command::new(cat);
            command
                .env_clear()
                .envs(epoch.environment())
                .current_dir(epoch.physical_path(epoch.cwd()).map_err(io::Error::other)?)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let child = epoch
                .spawn("resource-owner retained child", command)
                .map_err(io::Error::other)?;
            assert_eq!(exchange(&child, epoch, b"first\n").await?, "first\n");
            Ok::<_, io::Error>(child)
        })
        .await
    {
        Err(ManagedError::Operation(error)) if cgroup_unavailable(&error) => {
            eprintln!("skipping: cgroup delegation unavailable");
            managed.close().await.unwrap();
            return;
        }
        result => result.unwrap(),
    };
    let child = first.value;
    let pid = child.id();
    let membership = std::fs::read_to_string(format!("/proc/{pid}/cgroup")).unwrap();
    let group = membership
        .lines()
        .find_map(|line| line.strip_prefix("0::"))
        .unwrap();
    let cgroup = Path::new("/sys/fs/cgroup").join(group.trim_start_matches('/'));
    assert_eq!(
        std::fs::read_to_string(cgroup.join("pids.max"))
            .unwrap()
            .trim(),
        "64"
    );
    let mut started = None;
    let charged = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match events.recv().await.unwrap() {
                ResourceEvent::Started {
                    pipeline_id,
                    command,
                } => {
                    assert_eq!(command, "resource-owner retained child");
                    started = Some(pipeline_id);
                }
                ResourceEvent::Sample {
                    pipeline_id,
                    sample,
                } if sample.pids > 0 => {
                    assert_eq!(Some(pipeline_id), started);
                    break;
                }
                ResourceEvent::Sample { .. } => {}
                ResourceEvent::Finished { .. } => panic!("a parked live child was finalized"),
                _ => panic!("unexpected resource event"),
            }
        }
    })
    .await;
    charged.expect("delegated-cgroup sampling continues while application work is parked");
    managed
        .epoch(TypedTool, &ManagedCancellation::default(), async |epoch| {
            assert_eq!(exchange(&child, epoch, b"second\n").await?, "second\n");
            Ok::<_, io::Error>(())
        })
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(format!("/proc/{pid}/cgroup")).unwrap(),
        membership
    );
    managed.close().await.unwrap();
    assert!(!Path::new(&format!("/proc/{pid}")).exists());
    let mut finished = false;
    while let Ok(event) = events.try_recv() {
        if let ResourceEvent::Finished { pipeline_id, .. } = event {
            assert_eq!(Some(pipeline_id), started);
            finished = true;
        }
    }
    assert!(
        finished,
        "the final monitor receipt is queued before close resolves"
    );
    assert!(
        !cgroup.exists(),
        "close drains and removes the pipeline cgroup"
    );
}

struct ReleaseOwnedTool;
impl From<ReleaseOwnedTool> for Action {
    fn from(_: ReleaseOwnedTool) -> Self {
        Self::Release
    }
}
impl From<&ReleaseOwnedTool> for Action {
    fn from(_: &ReleaseOwnedTool) -> Self {
        Self::Release
    }
}
impl MarshTool for ReleaseOwnedTool {
    fn description(&self) -> Cow<'_, str> {
        Cow::Borrowed("release owned resources")
    }
}

async fn release_owned(shell: &Shell) -> Result<Vec<String>, ShellError> {
    shell.run_tool(ReleaseOwnedTool, |context| context.release_owned()).await?
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bulk_release_uses_committed_owners_and_preserves_other_claims() {
    use crate::{Event, Resource};

    let fixture = Fixture::new();
    std::fs::create_dir(fixture.seed.join("out")).unwrap();
    let owner = fixture.shell().await;
    let other = fixture.shell().await;
    let stranger = fixture.shell().await;
    accepted(&owner, "printf owned > src/a.txt; printf z > out/z; printf gone > out/gone; printf prior > out/already; printf ignored > .ignored").await;
    accepted(&other, "printf foreign > out/b; cat src/a.txt >/dev/null").await;
    accepted(&owner, "cat out/b >/dev/null; release -- out/already").await;
    std::fs::remove_file(fixture.seed.join("out/gone")).unwrap();
    let validator = session(&owner).await.validator.clone();
    let released = release_owned(&owner).await.unwrap();
    assert_eq!(released, [".ignored", "out/gone", "out/z", "src/a.txt"]);
    assert_eq!(fixture.read("src/a.txt"), "owned");
    assert_eq!(fixture.read("out/b"), "foreign");
    assert!(!fixture.seed.join("out/gone").exists());

    let decide = |principal: Principal, action, path: &str| {
        validator.decide(&Event::new(principal, action, Resource::new(path.split('/')))).unwrap()
    };
    assert!(matches!(decide(owner.principal().clone(), Action::Edit, "src/a.txt"), PolicyDecision::Deny { .. }));
    assert_eq!(decide(other.principal().clone(), Action::Edit, "src/a.txt"), PolicyDecision::Grant);
    assert!(matches!(decide(stranger.principal().clone(), Action::Edit, "out/z"), PolicyDecision::Deny { .. }));
    assert!(matches!(decide(owner.principal().clone(), Action::Release, "out/b"), PolicyDecision::Deny { .. }));
    let history = validator.read().history.clone();
    assert!(release_owned(&owner).await.unwrap().is_empty());
    assert_eq!(validator.read().history, history);
    accepted(&stranger, "cat out/z >/dev/null; printf fresh > out/z").await;
    close(stranger).await;
    close(other).await;
    close(owner).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bulk_release_revalidates_the_whole_selection_even_with_permissive_policy() {
    for takeover in [false, true] {
        let fixture = Fixture::new();
        let mut builder = Shell::builder()
            .working_dir(fixture.seed.clone())
            .sandbox_policy(SandboxPolicy::allow())
            .shell_policy(Arc::new(crate::EmptyPolicy));
        builder.backend = Some(fixture.fs.clone());
        let owner = builder.build().await.unwrap();
        accepted(&owner, "printf a > a; printf z > z").await;
        let mut builder = Shell::builder()
            .working_dir(fixture.seed.clone())
            .sandbox_policy(SandboxPolicy::allow())
            .policy_owner(Some(owner.principal().clone()));
        builder.backend = Some(fixture.fs.clone());
        let handoff = builder.build().await.unwrap();
        let other = fixture.shell().await;
        let validator = session(&owner).await.validator.clone();
        let (started, ready) = tokio::sync::oneshot::channel();
        let (resume, paused) = std::sync::mpsc::channel();
        let release = owner.run_tool(ReleaseOwnedTool, move |context| {
            let paths = context.release_owned().unwrap();
            started.send(paths.clone()).unwrap();
            paused.recv_timeout(std::time::Duration::from_secs(10)).unwrap();
            paths
        });
        let (result, history) = tokio::join!(release, async {
            assert_eq!(ready.await.unwrap(), ["a", "z"]);
            accepted(&handoff, "release -- z").await;
            if takeover {
                accepted(&other, "cat z >/dev/null; printf foreign > z").await;
            }
            let history = validator.read().history.clone();
            resume.send(()).unwrap();
            history
        });
        assert!(matches!(result, Err(ref error) if matches!(error.kind(), ShellErrorKind::Denied { .. })));
        assert_eq!(validator.read().history, history);
        assert_eq!(fixture.read("a"), "a");
        assert_eq!(fixture.read("z"), if takeover { "foreign" } else { "z" });
        close(other).await;
        close(handoff).await;
        close(owner).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bulk_release_rolls_back_all_ownership_on_publication_failure() {
    let fixture = Fixture::new();
    let owner = fixture.shell().await;
    let sibling = fixture.shell().await;
    accepted(&owner, "printf a > a; printf z > z").await;
    let validator = session(&owner).await.validator.clone();
    let history = validator.read().history.clone();
    let log = fixture.log();
    let saved = log.with_extension("saved");
    std::fs::rename(&log, &saved).unwrap();
    std::fs::create_dir(&log).unwrap();
    let error = release_owned(&owner).await.unwrap_err();
    assert_eq!(error.kind(), &ShellErrorKind::Infrastructure);
    assert_eq!(validator.read().history, history);
    assert_eq!(fixture.read("a"), "a");
    assert_eq!(fixture.read("z"), "z");
    std::fs::remove_dir(&log).unwrap();
    std::fs::rename(saved, log).unwrap();
    close(owner).await;
    close(sibling).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bulk_release_honors_the_selected_policy_atomically() {
    struct RejectRelease;
    impl Policy for RejectRelease {
        fn evaluator<'batch>(
            &'batch self,
            _store: Arc<PolicyStore<'batch>>,
        ) -> Result<Box<PolicyFn<'batch>>, ShellError> {
            Ok(Box::new(|_, event| {
                Ok(if event.action == Action::Release && event.resource.segments() == ["z"] {
                    PolicyDecision::Deny {
                        failed_precondition: "test release refusal".into(),
                        allowed_fixes: Vec::new(),
                    }
                } else {
                    PolicyDecision::Grant
                })
            }))
        }
    }
    let fixture = Fixture::new();
    let mut builder = Shell::builder()
        .working_dir(fixture.seed.clone())
        .sandbox_policy(SandboxPolicy::allow())
        .shell_policy(Arc::new(RejectRelease));
    builder.backend = Some(fixture.fs.clone());
    let owner = builder.build().await.unwrap();
    accepted(&owner, "printf a > a; printf z > z").await;
    let validator = session(&owner).await.validator.clone();
    let history = validator.read().history.clone();
    let error = release_owned(&owner).await.unwrap_err();
    assert!(matches!(error.kind(), ShellErrorKind::Denied { .. }));
    assert_eq!(validator.read().history, history);
    close(owner).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bulk_release_allows_the_managed_root_but_rejects_direct_and_ended_contexts() {
    let fixture = Fixture::new();
    let owner = fixture.shell().await;
    let context = owner
        .run_tool(ReleaseOwnedTool, |context| {
            assert!(matches!(context.release(Path::new(".")).unwrap_err().kind(), ShellErrorKind::Unsupported));
            assert!(context.release_owned().unwrap().is_empty());
            context.clone()
        })
        .await
        .unwrap();
    assert_eq!(context.release_owned().unwrap_err().kind(), &ShellErrorKind::Closed);
    close(owner).await;
    assert_eq!(context.release_owned().unwrap_err().kind(), &ShellErrorKind::Closed);

    let mut builder = Shell::builder()
        .working_dir(fixture.seed.clone())
        .sandbox_policy(SandboxPolicy::forbid());
    builder.backend = Some(fixture.fs.clone());
    let direct = builder.build().await.unwrap();
    let error = direct
        .run_tool(ReleaseOwnedTool, |context| context.release_owned().unwrap_err())
        .await
        .unwrap();
    assert_eq!(error.kind(), &ShellErrorKind::Infrastructure);
    close(direct).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bulk_release_rejects_managed_mutations_before_any_publication() {
    use std::io::Write as _;
    for (owned, path, release_first) in [
        (true, "new", false),
        (true, "src/a.txt", true),
        (false, "new", true),
        (false, "src/a.txt", false),
    ] {
        let fixture = Fixture::new();
        let owner = fixture.shell().await;
        if owned {
            accepted(&owner, "printf a > a; printf z > z").await;
        }
        let validator = session(&owner).await.validator.clone();
        let history = validator.read().history.clone();
        let result = owner.run_tool(ReleaseOwnedTool, move |context| {
            let selected = release_first.then(|| context.release_owned().unwrap());
            // Writing the original bytes also exercises a reverted/no-diff protected write.
            context.open(Path::new(path), std::fs::OpenOptions::new().write(true).create(true).truncate(true))
                .unwrap().write_all(b"seed\n").unwrap();
            selected.unwrap_or_else(|| context.release_owned().unwrap())
        }).await;
        assert!(matches!(result, Err(ref error) if error.kind() == &ShellErrorKind::Unsupported));
        assert_eq!(validator.read().history, history);
        assert_eq!(fixture.read("src/a.txt"), "seed\n");
        assert!(!fixture.seed.join("new").exists());
        close(owner).await;
        let reopened = fixture.shell().await;
        if owned {
            refused(&reopened, "cat a >/dev/null; printf stolen > a").await;
            refused(&reopened, "cat z >/dev/null; printf stolen > z").await;
        }
        close(reopened).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bulk_release_reopen_never_adopts_an_unfinished_metadata_frame() {
    for tail in [0, 5] {
        let fixture = Fixture::new();
        let owner = fixture.shell().await;
        accepted(&owner, "printf a > a; printf z > z").await;
        assert_eq!(release_owned(&owner).await.unwrap(), ["a", "z"]);
        close(owner).await;
        let log = fixture.log();
        let bytes = std::fs::read(&log).unwrap();
        let end = bytes[..bytes.len() - 1].iter().rposition(|byte| *byte == b'\n').unwrap() + 1;
        std::fs::write(&log, &bytes[..end + tail]).unwrap();
        std::fs::File::open(&log).unwrap().sync_all().unwrap();
        for _ in 0..2 {
            let reopened = fixture.shell().await;
            refused(&reopened, "cat a >/dev/null; printf stolen > a").await;
            refused(&reopened, "cat z >/dev/null; printf stolen > z").await;
            assert_eq!(fixture.read("a"), "a");
            assert_eq!(fixture.read("z"), "z");
            close(reopened).await;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bulk_release_complete_metadata_receipt_survives_reopen() {
    let fixture = Fixture::new();
    let owner = fixture.shell().await;
    accepted(&owner, "printf a > a; printf z > z").await;
    assert_eq!(release_owned(&owner).await.unwrap(), ["a", "z"]);
    close(owner).await;
    let reopened = fixture.shell().await;
    accepted(&reopened, "cat a z >/dev/null; printf next > a; printf next > z").await;
    assert_eq!(fixture.read("a"), "next");
    assert_eq!(fixture.read("z"), "next");
    close(reopened).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bulk_release_in_doubt_checkpoint_blocks_reopen_until_outcome_is_resolved() {
    for committed in [false, true] {
        let fixture = Fixture::new();
        let owner = fixture.shell().await;
        accepted(&owner, "printf a > a; printf z > z").await;
        let log = fixture.log();
        let boundary = std::fs::metadata(&log).unwrap().len();
        assert_eq!(release_owned(&owner).await.unwrap(), ["a", "z"]);
        close(owner).await;
        let pending = log.with_extension("metadata-pending");
        std::fs::write(&pending, boundary.to_le_bytes()).unwrap();
        std::fs::File::open(&pending).unwrap().sync_all().unwrap();
        std::fs::File::open(log.parent().unwrap()).unwrap().sync_all().unwrap();
        let before = std::fs::read(&log).unwrap();
        for _ in 0..2 {
            let error = fixture.open().await.err().unwrap();
            assert_eq!(error.kind(), &ShellErrorKind::Infrastructure);
            assert_eq!(std::fs::read(&log).unwrap(), before);
            assert!(pending.exists());
        }
        if !committed {
            let file = std::fs::OpenOptions::new().write(true).open(&log).unwrap();
            file.set_len(boundary).unwrap();
            file.sync_all().unwrap();
        }
        std::fs::remove_file(&pending).unwrap();
        std::fs::File::open(log.parent().unwrap()).unwrap().sync_all().unwrap();
        let reopened = fixture.shell().await;
        if committed {
            accepted(&reopened, "cat a z >/dev/null; printf next > a; printf next > z").await;
        } else {
            refused(&reopened, "cat a >/dev/null; printf stolen > a").await;
            refused(&reopened, "cat z >/dev/null; printf stolen > z").await;
        }
        close(reopened).await;
    }
}
