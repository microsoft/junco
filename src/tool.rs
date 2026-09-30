//! Pi's file tools as routed marsh calls.
//!
//! Every call runs once, in a transient shell of the session's mux, as a [`JuncoTool`] the mux's
//! policy routes over the [`Action`] it converts to. A read-only call always runs directly against
//! the seed. A writing call takes the managed route whenever the marsh operand selects it: it then
//! runs inside a private snapshot, writes through its call's context so that its changes are
//! evidence, and is authorized and published like a command. Paths a caller receives name the
//! seed, never the snapshot.

use std::borrow::Cow;
use std::collections::HashSet;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use marsh_core::builtins::BuiltinContext;
use marsh_core::{Action, MarshTool, SandboxPolicy};
use napi::bindgen_prelude::{Buffer, PromiseRaw};
use napi::{Env, Error, Result};
use napi_derive::napi;
use pi_edit::path_policy::canonical_key;
use pi_edit::session::{ApplyRequest, EditWriter, SessionConfig, WriteRequest, WriteResponse};
use pi_edit::text::{normalize_to_lf, strip_bom};
use pi_edit::{EditError, EditResult, FileOp};

use crate::NativeMux;
use crate::ast::{self, AstFindOptions, AstFindResult, AstReplaceOptions, AstReplaceResult};
use crate::edit::{EditApplyOutcome, EditFileOutcome, EditPolicy, EditStore};
use crate::glob::{self, GlobOptions, GlobResult};
use crate::grep::{self, GrepOptions, GrepResult};
use crate::mux::RoutedError;
use crate::routed_error::resolve;

/// A routed call's own failure, reported to JavaScript as its message.
type Outcome<T> = std::result::Result<T, String>;

/// One routed file-tool call and the root it acts on.
pub(crate) enum JuncoTool {
    /// `read` of one file.
    Read { path: PathBuf },
    /// `find`'s walk, or its existence probe, at `root`.
    Find { root: PathBuf },
    /// `grep` under `root`.
    Grep { root: PathBuf },
    /// `ast_grep` under `root`.
    AstGrep { root: PathBuf },
    /// `ast_edit` under `root`; only an applying call writes.
    AstEdit { root: PathBuf, apply: bool },
    /// A hashline `edit` resolved against `cwd`.
    Edit { cwd: PathBuf },
}

/// The one classification of a call: it may write exactly when it applies an edit, whatever the
/// edit turns out to change.
impl From<&JuncoTool> for Action {
    fn from(tool: &JuncoTool) -> Self {
        match tool {
            JuncoTool::Read { .. }
            | JuncoTool::Find { .. }
            | JuncoTool::Grep { .. }
            | JuncoTool::AstGrep { .. }
            | JuncoTool::AstEdit { apply: false, .. } => Self::Read,
            JuncoTool::Edit { .. } | JuncoTool::AstEdit { apply: true, .. } => Self::Edit,
        }
    }
}
impl From<JuncoTool> for Action {
    fn from(tool: JuncoTool) -> Self {
        Self::from(&tool)
    }
}

impl MarshTool for JuncoTool {
    fn description(&self) -> Cow<'_, str> {
        Cow::Owned(match self {
            Self::Read { path } => format!("junco read {}", path.display()),
            Self::Find { root } => format!("junco find {}", root.display()),
            Self::Grep { root } => format!("junco grep {}", root.display()),
            Self::AstGrep { root } => format!("junco ast_grep {}", root.display()),
            Self::AstEdit { root, apply: false } => format!("junco ast_edit {}", root.display()),
            Self::AstEdit { root, apply: true } => {
                format!("junco ast_edit --apply {}", root.display())
            }
            Self::Edit { cwd } => format!("junco edit {}", cwd.display()),
        })
    }
}

/// The marsh operand of a mux's routing policy.
pub(crate) enum SandboxMode {
    /// Sandbox while another live shell shares the seed.
    Shared,
    /// Always sandbox.
    Always,
}

/// `mode`'s marsh operand conjoined with junco's: a file tool takes the managed route only when it
/// may write. Shell commands and any other call are routed by the marsh operand alone.
pub(crate) fn sandbox_policy(mode: SandboxMode) -> SandboxPolicy {
    let marsh = match mode {
        SandboxMode::Shared => SandboxPolicy::SharedSource,
        SandboxMode::Always => SandboxPolicy::allow(),
    };
    SandboxPolicy::and(
        marsh,
        SandboxPolicy::Base(|ctx| {
            ctx.tool_as::<JuncoTool>()
                .is_none_or(|_| ctx.action.is_write())
        }),
    )
}

/// How one routed call names paths: the seed callers name, and the same directory in the call's
/// view — the private snapshot on the managed route, the seed itself on the direct route.
struct View<'a> {
    ctx: &'a BuiltinContext,
    seed: &'a Path,
    physical_seed: PathBuf,
}

impl<'a> View<'a> {
    fn new(ctx: &'a BuiltinContext, seed: &'a Path) -> Outcome<Self> {
        // Collecting the components drops the separator a join onto the snapshot root leaves.
        let physical_seed = ctx
            .physical_path(seed)
            .map_err(|error| error.to_string())?
            .components()
            .collect();
        Ok(Self {
            ctx,
            seed,
            physical_seed,
        })
    }

    fn managed(&self) -> bool {
        self.physical_seed != self.seed
    }

    /// `path` (absolute, or relative to the call's working directory) in the call's view.
    fn physical(&self, path: &Path) -> Outcome<PathBuf> {
        self.ctx
            .physical_path(path)
            .map_err(|error| error.to_string())
    }

    /// A path in the call's view as callers name it.
    fn logical(&self, path: &Path) -> PathBuf {
        match path.strip_prefix(&self.physical_seed) {
            Ok(relative) if self.managed() => self.seed.join(relative),
            _ => path.to_path_buf(),
        }
    }

    /// A result path as callers name it. A relative one is relative to a root they named.
    fn result_path(&self, path: &mut String) {
        if self.managed()
            && let Ok(relative) = Path::new(path.as_str()).strip_prefix(&self.physical_seed)
        {
            *path = self.seed.join(relative).to_string_lossy().into_owned();
        }
    }

    /// `text` with the view's seed replaced by the seed callers name.
    fn text(&self, text: String) -> String {
        if self.managed() {
            text.replace(
                &*self.physical_seed.to_string_lossy(),
                &self.seed.to_string_lossy(),
            )
        } else {
            text
        }
    }

    fn error(&self, mut error: Error) -> String {
        self.text(std::mem::take(&mut error.reason))
    }
}

/// `path` as the engines take it.
fn utf8(path: &Path) -> Outcome<&str> {
    path.to_str()
        .ok_or_else(|| format!("Path is not valid UTF-8: {}", path.display()))
}

/// A routed call's value, or its routing or operation failure. Only routing classifies a denial;
/// an operation's own failure is an ordinary one.
fn routed<T>(
    outcome: std::result::Result<Outcome<T>, RoutedError>,
) -> std::result::Result<T, RoutedError> {
    outcome.and_then(|value| value.map_err(RoutedError::Other))
}

/// A file's editable text, read as `pi_edit::EditStore::record_file` reads it: `None` when it is
/// unreadable, not UTF-8, or larger than pi-edit anchors.
fn snapshot_text(path: &Path) -> Option<String> {
    let limit = pi_edit::store::MAX_SNAPSHOT_FILE_BYTES;
    if std::fs::metadata(path).ok()?.len() > limit {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    (u64::try_from(text.len()).ok()? <= limit).then_some(text)
}

/// The snapshot tag recorded for one matched file.
#[napi(object)]
pub struct GrepSnapshot {
    /// The file's path exactly as the result's matches name it.
    pub path: String,
    /// Null when the file cannot back a hashline snapshot.
    pub tag: Option<String>,
}

/// A routed grep's result and the snapshots its matched files were recorded as.
#[napi(object)]
pub struct NativeGrepResult {
    pub result: GrepResult,
    pub snapshots: Vec<GrepSnapshot>,
}

/// One matched file's text, read in the call's view.
struct GrepFile {
    /// As the result names it.
    path: String,
    /// Absolute, as callers name it.
    logical: PathBuf,
    text: Option<String>,
}

#[napi]
impl NativeMux {
    /// The bytes of `path` (absolute, or relative to `cwd`), read as a routed `read`.
    #[napi(ts_return_type = "Promise<Buffer>")]
    pub fn read_file<'env>(
        &self,
        env: &'env Env,
        cwd: String,
        path: String,
    ) -> Result<PromiseRaw<'env, Buffer>> {
        let tool = JuncoTool::Read {
            path: PathBuf::from(&path),
        };
        let session = Arc::clone(&self.session);
        env.spawn_future_with_callback(
            async move {
                Ok(routed(
                    session
                        .run_tool(cwd, tool, move |ctx| {
                            let physical = ctx
                                .physical_path(Path::new(&path))
                                .map_err(|error| error.to_string())?;
                            std::fs::read(physical).map_err(|error| format!("{error}: {path}"))
                        })
                        .await,
                ))
            },
            |env, outcome| resolve(env, outcome).map(Buffer::from),
        )
    }

    /// Whether `path` (absolute, or relative to `cwd`) exists, probed as a routed `find`.
    #[napi(ts_return_type = "Promise<boolean>")]
    pub fn exists<'env>(
        &self,
        env: &'env Env,
        cwd: String,
        path: String,
    ) -> Result<PromiseRaw<'env, bool>> {
        let tool = JuncoTool::Find {
            root: PathBuf::from(&path),
        };
        let session = Arc::clone(&self.session);
        env.spawn_future_with_callback(
            async move {
                Ok(routed(
                    session
                        .run_tool(cwd, tool, move |ctx| {
                            let physical = ctx
                                .physical_path(Path::new(&path))
                                .map_err(|error| error.to_string())?;
                            Ok(physical.exists())
                        })
                        .await,
                ))
            },
            resolve,
        )
    }

    /// A routed `find` walk of `options.path`.
    #[napi(ts_return_type = "Promise<GlobResult>")]
    pub fn glob<'env>(
        &self,
        env: &'env Env,
        cwd: String,
        options: GlobOptions<'env>,
    ) -> Result<PromiseRaw<'env, GlobResult>> {
        let (spec, ct) = glob::prepare(options);
        let tool = JuncoTool::Find {
            root: PathBuf::from(spec.path()),
        };
        let session = Arc::clone(&self.session);
        env.spawn_future_with_callback(
            async move {
                let seed = session.seed().to_path_buf();
                Ok(routed(
                    session
                        .run_tool(cwd, tool, move |ctx| {
                            let view = View::new(ctx, &seed)?;
                            let root = view.physical(Path::new(spec.path()))?;
                            let mut result = spec
                                .run(utf8(&root)?, ct)
                                .map_err(|error| view.error(error))?;
                            for entry in &mut result.matches {
                                view.result_path(&mut entry.path);
                            }
                            Ok(result)
                        })
                        .await,
                ))
            },
            resolve,
        )
    }

    /// A routed `grep` of `options.path`. Every matched file other than a notebook is recorded in
    /// `store` from the same view the search read, and its tag returned.
    #[napi(ts_return_type = "Promise<NativeGrepResult>")]
    pub fn grep<'env>(
        &self,
        env: &'env Env,
        cwd: String,
        options: GrepOptions<'env>,
        store: &EditStore,
    ) -> Result<PromiseRaw<'env, NativeGrepResult>> {
        let (mut config, ct) = grep::prepare(options);
        let root = PathBuf::from(&config.path);
        let tool = JuncoTool::Grep { root: root.clone() };
        let session = Arc::clone(&self.session);
        let snapshots = store.inner.clone();
        let keys = Arc::clone(&store.keys);
        env.spawn_future_with_callback(
            async move {
                let seed = session.seed().to_path_buf();
                let outcome = routed(
                    session
                        .run_tool(cwd, tool, move |ctx| {
                            let view = View::new(ctx, &seed)?;
                            let root = view.physical(&root)?;
                            utf8(&root)?.clone_into(&mut config.path);
                            let mut result = grep::grep_sync(config, None, ct)
                                .map_err(|error| view.error(error))?;
                            let mut read = HashSet::new();
                            let mut files = Vec::new();
                            for entry in &mut result.matches {
                                let found = Path::new(&entry.path);
                                let physical = if found.is_absolute() {
                                    found.to_path_buf()
                                } else {
                                    root.join(found)
                                };
                                view.result_path(&mut entry.path);
                                let notebook = physical.extension().is_some_and(|extension| {
                                    extension.eq_ignore_ascii_case("ipynb")
                                });
                                if !notebook && read.insert(entry.path.clone()) {
                                    files.push(GrepFile {
                                        path: entry.path.clone(),
                                        logical: view.logical(&physical),
                                        text: snapshot_text(&physical),
                                    });
                                }
                            }
                            Ok((result, files))
                        })
                        .await,
                );
                // Recorded after the call, off its traced thread: the store is this process's own.
                Ok(outcome.map(|(result, files)| {
                    let mut keys = keys.lock();
                    let snapshots = files
                        .into_iter()
                        .map(|file| GrepSnapshot {
                            tag: file.text.map(|text| {
                                let key = canonical_key(&file.logical);
                                let tag = snapshots.record(
                                    &key,
                                    &normalize_to_lf(strip_bom(&text).1),
                                    None,
                                );
                                keys.insert(key);
                                tag
                            }),
                            path: file.path,
                        })
                        .collect();
                    NativeGrepResult { result, snapshots }
                }))
            },
            resolve,
        )
    }

    /// A routed `ast_grep` scan of `options.path`, or of `cwd` when it is absent.
    #[napi(ts_return_type = "Promise<AstFindResult>")]
    pub fn ast_grep<'env>(
        &self,
        env: &'env Env,
        cwd: String,
        options: AstFindOptions<'env>,
    ) -> Result<PromiseRaw<'env, AstFindResult>> {
        let (mut spec, ct) = ast::prepare_find(options);
        let root = PathBuf::from(spec.path.as_deref().unwrap_or(&cwd));
        let tool = JuncoTool::AstGrep { root: root.clone() };
        let session = Arc::clone(&self.session);
        env.spawn_future_with_callback(
            async move {
                let seed = session.seed().to_path_buf();
                Ok(routed(
                    session
                        .run_tool(cwd, tool, move |ctx| {
                            let view = View::new(ctx, &seed)?;
                            spec.path = Some(utf8(&view.physical(&root)?)?.to_owned());
                            let mut result =
                                spec.run(ct).map_err(|error| view.error(error))?;
                            for entry in &mut result.matches {
                                view.result_path(&mut entry.path);
                            }
                            if let Some(errors) = &mut result.parse_errors {
                                for error in errors {
                                    *error = view.text(std::mem::take(error));
                                }
                            }
                            Ok(result)
                        })
                        .await,
                ))
            },
            resolve,
        )
    }

    /// A routed `ast_edit` of `options.path`, or of `cwd` when it is absent. Only an explicit
    /// `dryRun: false` writes, and then as an edit the mux's policy may sandbox.
    #[napi(ts_return_type = "Promise<AstReplaceResult>")]
    pub fn ast_edit<'env>(
        &self,
        env: &'env Env,
        cwd: String,
        options: AstReplaceOptions<'env>,
    ) -> Result<PromiseRaw<'env, AstReplaceResult>> {
        let (mut spec, ct) = ast::prepare_replace(options);
        let root = PathBuf::from(spec.path.as_deref().unwrap_or(&cwd));
        let tool = JuncoTool::AstEdit {
            root: root.clone(),
            apply: spec.dry_run == Some(false),
        };
        let session = Arc::clone(&self.session);
        env.spawn_future_with_callback(
            async move {
                let seed = session.seed().to_path_buf();
                Ok(routed(
                    session
                        .run_tool(cwd, tool, move |ctx| {
                            let view = View::new(ctx, &seed)?;
                            spec.path = Some(utf8(&view.physical(&root)?)?.to_owned());
                            let mut persist = |path: &Path, output: &str| {
                                replace_file(ctx, &view.logical(path), output)
                            };
                            let mut result = spec
                                .run(ct, &mut persist)
                                .map_err(|error| view.error(error))?;
                            for change in &mut result.changes {
                                view.result_path(&mut change.path);
                            }
                            for change in &mut result.file_changes {
                                view.result_path(&mut change.path);
                            }
                            if let Some(errors) = &mut result.parse_errors {
                                for error in errors {
                                    *error = view.text(std::mem::take(error));
                                }
                            }
                            Ok(result)
                        })
                        .await,
                ))
            },
            resolve,
        )
    }

    /// A routed hashline `edit`: `argsJson` staged against `store`'s anchors under `policy`, and
    /// applied through the call's context. Engine failures resolve as `isError` outcomes; a
    /// routing or publication failure rejects, and discards the anchors the edit recorded.
    #[napi(ts_return_type = "Promise<EditApplyOutcome>")]
    pub fn edit<'env>(
        &self,
        env: &'env Env,
        cwd: String,
        store: &EditStore,
        policy: EditPolicy,
        args_json: String,
    ) -> Result<PromiseRaw<'env, EditApplyOutcome>> {
        let tool = JuncoTool::Edit {
            cwd: PathBuf::from(&cwd),
        };
        let session = Arc::clone(&self.session);
        let touched = Arc::new(Mutex::new(Vec::new()));
        let edit = HashlineEdit {
            config: policy.into_config()?,
            args_json,
            seed: session.seed().to_path_buf(),
            snapshots: store.inner.clone(),
            keys: Arc::clone(&store.keys),
            touched: Arc::clone(&touched),
        };
        let snapshots = store.inner.clone();
        let keys = Arc::clone(&store.keys);
        env.spawn_future_with_callback(
            async move {
                let outcome = session
                    .run_tool(cwd, tool, move |ctx| edit.apply(ctx))
                    .await;
                let touched =
                    std::mem::take(&mut *touched.lock().unwrap_or_else(PoisonError::into_inner));
                // Attempted either way: a partially completed write or move must not leave a
                // stale scan-cache entry looking fresh.
                for path in &touched {
                    pi_walker::invalidate_path_string(&path.to_string_lossy());
                }
                if outcome.is_err() {
                    // Nothing was published, so no post-edit anchor may back a later edit.
                    let mut keys = keys.lock();
                    for path in &touched {
                        let key = canonical_key(path);
                        snapshots.invalidate(&key);
                        keys.remove(&key);
                    }
                }
                Ok(outcome)
            },
            resolve,
        )
    }
}

/// Replaces `path` (as callers name it) with `content` through the call's context, so that on the
/// managed route the write is the call's evidence.
fn replace_file(ctx: &BuiltinContext, path: &Path, content: &str) -> std::io::Result<()> {
    ctx.open(
        path,
        std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true),
    )?
    .write_all(content.as_bytes())
}

/// One hashline edit call, applied inside its call's view.
struct HashlineEdit {
    config: SessionConfig,
    args_json: String,
    seed: PathBuf,
    snapshots: pi_edit::EditStore,
    keys: Arc<parking_lot::Mutex<HashSet<PathBuf>>>,
    /// Paths, as callers name them, whose bytes or names the call attempted to change.
    touched: Arc<Mutex<Vec<PathBuf>>>,
}

impl HashlineEdit {
    fn apply(self, ctx: &BuiltinContext) -> EditApplyOutcome {
        let failed = |text: String| EditApplyOutcome {
            text,
            files: Vec::new(),
            is_error: true,
        };
        let Self {
            mut config,
            args_json,
            seed,
            snapshots,
            keys,
            touched,
        } = self;
        let view = match View::new(ctx, &seed) {
            Ok(view) => view,
            Err(error) => return failed(error),
        };
        if let Err(error) = map_policy(&view, &mut config.policy) {
            return failed(view.text(error));
        }
        // pi-edit keys every anchor by the canonical path it edits, which on the managed route is
        // inside the snapshot: anchors move in for the call and back out after it.
        let inside = view.managed().then(|| {
            std::fs::canonicalize(&view.physical_seed)
                .unwrap_or_else(|_| view.physical_seed.clone())
        });
        let outside = |key: &Path| -> PathBuf {
            match inside.as_deref().map(|inside| key.strip_prefix(inside)) {
                Some(Ok(relative)) => seed.join(relative),
                _ => key.to_path_buf(),
            }
        };
        let moved: Vec<(PathBuf, PathBuf)> = match &inside {
            Some(inside) => keys
                .lock()
                .iter()
                .filter_map(|key| {
                    let relative = key.strip_prefix(&seed).ok()?;
                    Some((key.clone(), inside.join(relative)))
                })
                .collect(),
            None => Vec::new(),
        };
        for (logical, physical) in &moved {
            snapshots.relocate(logical, physical);
        }

        let mut session = pi_edit::Session::new(config, snapshots.clone());
        session.set_args_json(&args_json);
        session.finish();
        let writer = FsWriter {
            ctx,
            view: &view,
            touched: &touched,
            keyed: Mutex::new(Vec::new()),
        };
        let applied = tokio::runtime::Handle::current().block_on(session.apply(
            ApplyRequest {
                lsp_batch_id: None,
                lsp_flush: false,
            },
            &writer,
        ));

        // Every key pi-edit may have recorded: the anchors moved in, every path it wrote, and
        // every file of a completed outcome (a no-op may still record its snapshot).
        let mut recorded = writer
            .keyed
            .into_inner()
            .unwrap_or_else(PoisonError::into_inner);
        if let Ok(outcome) = &applied {
            for file in &outcome.files {
                recorded.push(file.absolute.clone());
                recorded.extend(file.move_to.clone());
            }
        }
        let mut keys = keys.lock();
        for (logical, physical) in moved {
            snapshots.relocate(&physical, &logical);
        }
        for path in recorded {
            let key = canonical_key(&path);
            let logical = outside(&key);
            if logical != key {
                snapshots.relocate(&key, &logical);
            }
            keys.insert(logical);
        }
        drop(keys);

        match applied {
            Ok(outcome) => EditApplyOutcome {
                text: view.text(outcome.text),
                files: outcome
                    .files
                    .into_iter()
                    .map(|file| EditFileOutcome {
                        path: view.logical(&file.absolute).to_string_lossy().into_owned(),
                        display_path: view.text(file.display),
                        op: file.op.as_str().to_owned(),
                        move_to: file
                            .move_to
                            .map(|path| view.logical(&path).to_string_lossy().into_owned()),
                        diff: view.text(file.diff),
                        first_changed_line: file.first_changed_line,
                        old_text: file.old_text,
                        new_text: file.new_text,
                        snapshots_pruned: file.snapshots_pruned,
                        diagnostics_json: file.diagnostics_json.map(|json| view.text(json)),
                        warnings: file
                            .warnings
                            .into_iter()
                            .map(|warning| view.text(warning))
                            .collect(),
                        text: view.text(file.text),
                        parse_regressed: file.parse_regressed,
                    })
                    .collect(),
                is_error: false,
            },
            Err(error) => failed(view.text(error.to_string())),
        }
    }
}

/// Resolves the edit policy's roots in the call's view, where pi-edit reads and stages.
fn map_policy(view: &View<'_>, policy: &mut pi_edit::PathPolicy) -> Outcome<()> {
    policy.cwd = view.physical(&policy.cwd)?;
    policy.home_dir = view.physical(&policy.home_dir)?;
    if let Some(root) = &mut policy.local_sandbox_root {
        *root = view.physical(root)?;
    }
    for (_, root) in policy.vault_roots.iter_mut().flatten() {
        *root = view.physical(root)?;
    }
    Ok(())
}

/// Persists a staged hashline edit through the call's context, as the removed Node writer did:
/// on the managed route every change is the call's evidence.
struct FsWriter<'a> {
    ctx: &'a BuiltinContext,
    view: &'a View<'a>,
    touched: &'a Mutex<Vec<PathBuf>>,
    /// Every path, as pi-edit names it, a request asked to change.
    keyed: Mutex<Vec<PathBuf>>,
}

impl FsWriter<'_> {
    /// Notes `path` (as pi-edit names it) before the call touches it; returns it as callers do.
    fn touch(&self, path: &Path) -> PathBuf {
        self.keyed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(path.to_path_buf());
        let logical = self.view.logical(path);
        self.touched
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(logical.clone());
        logical
    }

    fn create_parent(&self, path: &Path) -> std::io::Result<()> {
        match path.parent() {
            Some(parent) => self.ctx.create_dir_all(parent),
            None => Ok(()),
        }
    }

    fn persist(&self, request: WriteRequest) -> EditResult<String> {
        let failed = |error: std::io::Error| EditError::Writer(error.to_string());
        if let Some(destination) = &request.move_to {
            let content = request.content.ok_or_else(|| {
                EditError::Writer("Native edit move request omitted content".to_owned())
            })?;
            let source = self.touch(&request.absolute);
            let destination = self.touch(destination);
            self.create_parent(&destination).map_err(failed)?;
            replace_file(self.ctx, &destination, &content).map_err(failed)?;
            self.ctx.remove_file(&source).map_err(failed)?;
            return Ok(content);
        }
        match request.op {
            FileOp::Delete => {
                let path = self.touch(&request.absolute);
                self.ctx.remove_file(&path).map_err(failed)?;
                Ok(String::new())
            }
            FileOp::Create | FileOp::Update => {
                let content = request.content.ok_or_else(|| {
                    EditError::Writer(format!(
                        "Native edit {} request omitted content",
                        request.op.as_str()
                    ))
                })?;
                let path = self.touch(&request.absolute);
                if request.op == FileOp::Create {
                    self.create_parent(&path).map_err(failed)?;
                }
                replace_file(self.ctx, &path, &content).map_err(failed)?;
                Ok(content)
            }
            FileOp::Noop => Err(EditError::Writer(
                "Unknown native edit operation: noop".to_owned(),
            )),
        }
    }
}

#[async_trait]
impl EditWriter for FsWriter<'_> {
    async fn write(&self, request: WriteRequest) -> EditResult<WriteResponse> {
        Ok(WriteResponse {
            written: self.persist(request)?,
            diagnostics_json: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_action_classification() {
        let root = || PathBuf::from("/seed");
        let cases = [
            (JuncoTool::Read { path: root() }, Action::Read),
            (JuncoTool::Find { root: root() }, Action::Read),
            (JuncoTool::Grep { root: root() }, Action::Read),
            (JuncoTool::AstGrep { root: root() }, Action::Read),
            (
                JuncoTool::AstEdit {
                    root: root(),
                    apply: false,
                },
                Action::Read,
            ),
            (
                JuncoTool::AstEdit {
                    root: root(),
                    apply: true,
                },
                Action::Edit,
            ),
            (JuncoTool::Edit { cwd: root() }, Action::Edit),
        ];
        for (tool, expected) in cases {
            let actual: Action = (&tool).into();
            assert_eq!(actual, expected, "{}", tool.description());
        }
    }
}
