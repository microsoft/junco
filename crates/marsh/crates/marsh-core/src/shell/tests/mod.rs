//! White-box storage and semantic assertions stay below the ordinary Shell interface.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use super::session::Session;
use super::{SandboxPolicy, Shell, ShellError, ShellErrorKind};
use std::path::{Path, PathBuf};
use std::sync::Arc;

mod managed;
mod publication;
mod reconciliation;

/// A private seed holding `src/a.txt`, a subvolume of a fake filesystem backend.
struct Fixture {
    _scratch: tempfile::TempDir,
    seed: PathBuf,
    fs: Arc<marsh_btrfs::fake::CopyTree>,
}
impl Fixture {
    fn new() -> Self {
        let scratch = tempfile::tempdir().expect("scratch");
        let seed = scratch.path().canonicalize().unwrap().join("seed");
        std::fs::create_dir_all(seed.join("src")).unwrap();
        std::fs::write(seed.join("src/a.txt"), b"seed\n").unwrap();
        let fs = Arc::new(marsh_btrfs::fake::CopyTree::new());
        fs.register(&seed);
        Self {
            _scratch: scratch,
            seed,
            fs,
        }
    }
    /// A managed shell over the seed, which must start.
    async fn shell(&self) -> Shell {
        self.open().await.expect("build managed shell")
    }
    /// A managed shell over the seed with its storage opened, or the first managed operation's
    /// failure.
    async fn open(&self) -> Result<Shell, ShellError> {
        self.open_on(self.fs.clone()).await
    }
    /// A managed shell over the seed, stored through `backend`. Storage is opened lazily, so the
    /// first managed operation is run here and its failure is the verdict.
    async fn open_on(
        &self,
        backend: Arc<dyn marsh_btrfs::Subvolumes>,
    ) -> Result<Shell, ShellError> {
        managed(self.seed.clone(), backend).await
    }
    /// The seed's write-ahead log.
    fn log(&self) -> PathBuf {
        self.seed
            .parent()
            .unwrap()
            .join(marsh_btrfs::STATE_DIR)
            .join("seed/meta")
            .join(marsh_wal::LOG_FILE)
    }
    /// A seed file's contents.
    fn read(&self, path: &str) -> String {
        read(&self.seed.join(path))
    }
}

/// A file's contents.
fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}
/// An explicitly managed shell at `initial_dir` whose first managed operation has run.
async fn managed(
    initial_dir: PathBuf,
    backend: Arc<dyn marsh_btrfs::Subvolumes>,
) -> Result<Shell, ShellError> {
    let mut builder = Shell::builder()
        .working_dir(initial_dir)
        .sandbox_policy(SandboxPolicy::allow());
    builder.backend = Some(backend);
    let shell = builder.build().await?;
    if let Err(error) = shell.run(":").await {
        let _ = shell.close(true).await;
        return Err(error);
    }
    Ok(shell)
}
/// The session a live `shell` publishes through.
async fn session(shell: &Shell) -> Arc<Session> {
    Arc::clone(
        &shell
            .shared
            .live
            .lock()
            .await
            .as_ref()
            .unwrap()
            .resources
            .snapshot
            .as_ref()
            .expect("managed view")
            .session,
    )
}
/// Runs `line`, which must be accepted and exit 0.
async fn accepted(shell: &Shell, line: &str) {
    let result = shell
        .run(line)
        .await
        .unwrap_or_else(|error| panic!("{line}: {error}"));
    assert_eq!(u8::from(result.exit_code), 0, "{line}");
}
/// Runs `line`, whose publication the gate must refuse.
async fn refused(shell: &Shell, line: &str) {
    let Err(error) = shell.run(line).await else {
        panic!("{line}: accepted")
    };
    assert!(
        matches!(error.kind(), ShellErrorKind::Denied { .. }),
        "{line}: {error}"
    );
}
/// Closes `shell`, which must release everything it held.
async fn close(shell: Shell) {
    shell.close(false).await.expect("close shell");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn source_preparation_compares_contents_not_bookkeeping() {
    use super::snapshot::CommandNumber;
    use std::sync::atomic::Ordering;

    let fixture = Fixture::new();
    let shell = fixture.shell().await;
    let snapshot = shell
        .shared
        .live
        .lock()
        .await
        .as_ref()
        .unwrap()
        .resources
        .snapshot
        .as_ref()
        .unwrap()
        .clone();
    let scope = snapshot.session.tracing.internal_scope().unwrap();
    {
        let _guard = scope.enter();
        let original = snapshot.state.lock().unwrap().tree_seq;
        let source = snapshot.prepare_source(CommandNumber(100)).unwrap();
        assert!(source.matches_work);
        snapshot.reclaim(&source.baseline).unwrap();

        // A no-op direct may-write invalidates counters, not an equal private tree.
        snapshot.session.epoch.fetch_add(1, Ordering::AcqRel);
        let source = snapshot.prepare_source(CommandNumber(101)).unwrap();
        assert!(source.matches_work);
        snapshot.reclaim(&source.baseline).unwrap();

        std::fs::write(fixture.seed.join("src/a.txt"), b"external\n").unwrap();
        assert!(snapshot.state.lock().unwrap().tree_seq == original);
        let source = snapshot.prepare_source(CommandNumber(102)).unwrap();
        assert!(!source.matches_work);
        assert_eq!(read(&source.baseline.join("src/a.txt")), "external\n");
        snapshot.reclaim(&source.baseline).unwrap();
    }
    accepted(&shell, "test \"$(cat src/a.txt)\" = external").await;
    assert_eq!(read(&snapshot.path().join("src/a.txt")), "external\n");
    {
        let _guard = scope.enter();
        std::fs::create_dir(fixture.seed.join(".git")).unwrap();
        std::fs::write(fixture.seed.join(".git/HEAD"), b"ref: refs/heads/main\n").unwrap();
        let source = snapshot.prepare_source(CommandNumber(103)).unwrap();
        assert!(!source.matches_work, ".git is part of source validity");
        snapshot.reclaim(&source.baseline).unwrap();
    }
    close(shell).await;
}
