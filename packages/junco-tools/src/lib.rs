// Oh My Pi native binding/grep modules transplanted from revision
// 7ae76f8e4daca0c8f409f61bcd514260cd522365 — see LICENSE.oh-my-pi.
mod ast;
mod diff;
mod edit;
mod frontend;
mod glob;
mod glob_util;
mod grep;
mod iofs;
mod js;
mod mux;
mod process;
mod routed_error;
mod task;
#[cfg(test)]
mod testing;
mod tool;
mod utils;

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};

use marsh_btrfs::{LibBtrfs, PersistenceLayer, Subvolumes};
use marsh_core::shellmux::ShellMux;
use napi::bindgen_prelude::{Buffer, PromiseRaw};
use napi::{Env, Error, Result};
use napi_derive::napi;

use frontend::{OutputCallback, PolicyCallback};
use mux::{RunState, Session};
use process::{CloseTimeout, ProcessState};
use tool::SandboxMode;

/// The addon's one ShellMux. Every raw open passes this gate: a second mux is refused while one
/// is opening, open, or closing, however its JavaScript handle is retained or abandoned. The slot
/// is reusable only once that session's close has completed — every task joined, the mux shut
/// down and its backend dropped — even when that teardown reported a failure.
enum MuxSlot {
    Empty,
    Opening,
    Open(Arc<Session>),
}

static MUX_SLOT: Mutex<MuxSlot> = Mutex::new(MuxSlot::Empty);

/// A held opening of [`MUX_SLOT`]. Dropped uncommitted — a failed or abandoned open — it
/// returns the slot to empty.
struct MuxReservation {
    committed: bool,
}

impl MuxReservation {
    fn acquire() -> Result<Self> {
        let mut slot = MUX_SLOT.lock().unwrap_or_else(PoisonError::into_inner);
        let available = match &*slot {
            MuxSlot::Empty => true,
            MuxSlot::Opening => false,
            MuxSlot::Open(session) => session.is_closed(),
        };
        if !available {
            return Err(Error::from_reason(
                "A Junco ShellMux is already open or closing",
            ));
        }
        *slot = MuxSlot::Opening;
        Ok(Self { committed: false })
    }

    fn commit(mut self, session: &Arc<Session>) {
        *MUX_SLOT.lock().unwrap_or_else(PoisonError::into_inner) =
            MuxSlot::Open(Arc::clone(session));
        self.committed = true;
    }
}

impl Drop for MuxReservation {
    fn drop(&mut self) {
        if !self.committed {
            *MUX_SLOT.lock().unwrap_or_else(PoisonError::into_inner) = MuxSlot::Empty;
        }
    }
}

/// Options of a mux the caller opens.
#[napi(object)]
pub struct NativeMuxOptions {
    /// How calls route: `"shared"` (the default) sandboxes a shell command or writing file tool
    /// while another live shell shares the seed, `"always"` sandboxes every one. A read-only file
    /// tool always runs directly.
    pub sandbox: Option<String>,
    /// Also deliver granted capabilities to `onPolicyDecision`; violations always are.
    pub policy_debug: Option<bool>,
}

/// One junco-policy capability decision, as `Authority::check` made it. A grant is tentative: a
/// later denial in its batch or a failed publication rolls it back.
#[napi(object)]
pub struct NativePolicyDecision {
    pub granted: bool,
    pub principal: String,
    #[napi(
        ts_type = "\"Read\" | \"Edit\" | \"Stage\" | \"Unstage\" | \"Commit\" | \"Checkout\" | \"Stash\" | \"Delete\" | \"Clean\" | \"Diff\" | \"History\""
    )]
    pub action: String,
    /// Seed-relative path segments; `[]` is the root.
    pub resource: Vec<String>,
    pub failed_precondition: Option<String>,
    pub allowed_fixes: Option<Vec<String>>,
}

/// The routing mode `options` select, refused before anything is discovered, and the policy log
/// a supplied callback receives decisions through.
fn mux_options(
    options: Option<NativeMuxOptions>,
    on_policy_decision: Option<PolicyCallback>,
) -> Result<(SandboxMode, Option<Arc<frontend::PolicyLog>>)> {
    let (sandbox, debug) = options.map_or((None, None), |options| {
        (options.sandbox, options.policy_debug)
    });
    let mode = match sandbox.as_deref() {
        None | Some("shared") => SandboxMode::Shared,
        Some("always") => SandboxMode::Always,
        Some(value) => {
            return Err(Error::from_reason(format!(
                "Invalid sandbox option: {value}; expected \"shared\" or \"always\""
            )));
        }
    };
    let log = on_policy_decision
        .map(|callback| frontend::PolicyLog::new(callback, debug.unwrap_or(false)));
    Ok((mode, log))
}

#[napi(object)]
pub struct NativeRunOptions {
    pub command: String,
    pub cwd: String,
    pub principal: String,
    pub env: HashMap<String, String>,
    pub timeout_ms: Option<f64>,
}

#[napi(object)]
#[derive(Clone)]
pub struct NativeRunResult {
    pub exit_code: Option<i32>,
    pub cancelled: bool,
    pub timed_out: bool,
}

#[napi]
pub struct NativeRun {
    state: Arc<RunState>,
}

#[napi]
impl NativeRun {
    #[napi(ts_return_type = "Promise<NativeRunResult>")]
    pub fn wait<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, NativeRunResult>> {
        let state = Arc::clone(&self.state);
        env.spawn_future_with_callback(async move { Ok(state.wait().await) }, |env, outcome| {
            routed_error::resolve(env, outcome)
        })
    }

    #[napi]
    pub fn abort(&self) {
        self.state.abort();
    }
}

/// One persistent process the mux runs through its managed `exec` builtin.
#[napi(object)]
pub struct NativeProcessOptions {
    /// The program, resolved through `PATH` unless it names a path; never a builtin or function.
    pub command: String,
    /// Its arguments, each passed as one literal word.
    pub args: Option<Vec<String>>,
    pub cwd: String,
    /// Orders this process behind earlier work under the same name; not a policy identity.
    pub principal: String,
    /// The process's complete environment, replacing the inherited and profile variables.
    pub env: HashMap<String, String>,
}

/// A running persistent process. Its program and descendants are one managed command, always
/// on the audited route: their effects publish only if its final verdict authorizes them.
#[napi]
pub struct NativeProcess {
    state: Arc<ProcessState>,
}

#[napi]
impl NativeProcess {
    /// Writes `data` to the program's standard input after every earlier write.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn write<'env>(&self, env: &'env Env, data: Buffer) -> Result<PromiseRaw<'env, ()>> {
        let receipt = self.state.write(data.to_vec());
        env.spawn_future_with_callback(
            async move {
                receipt
                    .await
                    .map_err(|_| Error::from_reason("ShellMux process write was abandoned"))?
                    .map_err(Error::from_reason)
            },
            |_, ()| Ok(()),
        )
    }

    /// Ends standard input, bounds the rest of execution — `min(500, closeTimeoutMs)` to exit
    /// on its own, then `SIGTERM` and `closeTimeoutMs`, then cancellation — and resolves with
    /// the actual final verdict once every output callback has returned. Later calls join the
    /// first request. An invalid `closeTimeoutMs` rejects without requesting termination.
    #[napi(ts_return_type = "Promise<NativeRunResult>")]
    pub fn finish<'env>(
        &self,
        env: &'env Env,
        close_timeout_ms: Option<f64>,
    ) -> Result<PromiseRaw<'env, NativeRunResult>> {
        let timeout = CloseTimeout::from_millis(close_timeout_ms);
        if let Ok(timeout) = timeout {
            self.state.finish(timeout);
        }
        let run = Arc::clone(self.state.run());
        env.spawn_future_with_callback(
            async move {
                timeout.map_err(Error::from_reason)?;
                Ok(run.wait().await)
            },
            routed_error::resolve,
        )
    }

    /// Forced cancellation; the result reports it as cancelled.
    #[napi]
    pub fn abort(&self) {
        self.state.abort();
    }

    /// The same final result `finish` publishes, without requesting termination.
    #[napi(ts_return_type = "Promise<NativeRunResult>")]
    pub fn wait<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, NativeRunResult>> {
        let run = Arc::clone(self.state.run());
        env.spawn_future_with_callback(async move { Ok(run.wait().await) }, |env, outcome| {
            routed_error::resolve(env, outcome)
        })
    }
}

#[napi]
pub struct NativeMux {
    session: Arc<Session>,
    sandbox: SandboxMode,
}

impl NativeMux {
    /// Commits the addon's one mux.
    fn committed(session: Arc<Session>, sandbox: SandboxMode, reservation: MuxReservation) -> Self {
        reservation.commit(&session);
        Self { session, sandbox }
    }
}

#[napi]
impl NativeMux {
    /// Opens the addon's one mux; refused while another is opening, open, or closing.
    #[napi(factory)]
    pub async fn open(
        cwd: String,
        options: Option<NativeMuxOptions>,
        #[napi(ts_arg_type = "(error: Error | null, data: NativePolicyDecision) => void")]
        on_policy_decision: Option<PolicyCallback>,
    ) -> Result<Self> {
        let (sandbox, policy_log) = mux_options(options, on_policy_decision)?;
        let reservation = MuxReservation::acquire()?;
        let policy = tool::sandbox_policy(sandbox);
        let (seed, filesystem) = tokio::task::spawn_blocking(move || {
            let filesystem: Arc<dyn Subvolumes> = Arc::new(LibBtrfs);
            // Discovery only. Materialization, the seed's exclusive lease, its log recovery
            // and its validator belong to the first shell this session opens, so an idle
            // handle over a seed another process is publishing into is legal.
            let (layer, _) = PersistenceLayer::discover(Path::new(&cwd), filesystem.as_ref())
                .map_err(|error| Error::from_reason(error.to_string()))?;
            Ok::<_, Error>((layer.seed, filesystem))
        })
        .await
        .map_err(|error| Error::from_reason(error.to_string()))??;
        let session = Session::new(seed, filesystem, policy, policy_log, ShellMux::new)
            .map_err(Error::from_reason)?;
        Ok(Self::committed(session, sandbox, reservation))
    }

    /// The routing mode this mux was opened with.
    #[napi(getter, ts_return_type = "\"shared\" | \"always\"")]
    pub fn sandbox(&self) -> &'static str {
        self.sandbox.name()
    }

    /// Resolves once `cwd` is a directory of exactly this mux's seed, as every operation at it
    /// requires; rejects with the reason otherwise, or once the mux is closed.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn validate_cwd<'env>(&self, env: &'env Env, cwd: String) -> Result<PromiseRaw<'env, ()>> {
        let session = Arc::clone(&self.session);
        env.spawn_future_with_callback(
            async move { session.validate_cwd(cwd).await.map_err(Error::from_reason) },
            |_, ()| Ok(()),
        )
    }

    /// Launches one persistent process, resolving once Marsh admits its command. `onStdout`
    /// and `onStderr` receive each stream's chunks in order; a callback that throws stops this
    /// process only. A failure before admission rejects after its shell is drained.
    #[napi(ts_return_type = "Promise<NativeProcess>")]
    pub fn spawn<'env>(
        &self,
        env: &'env Env,
        options: NativeProcessOptions,
        #[napi(ts_arg_type = "(error: Error | null, data: Buffer) => void")]
        on_stdout: OutputCallback,
        #[napi(ts_arg_type = "(error: Error | null, data: Buffer) => void")]
        on_stderr: OutputCallback,
    ) -> Result<PromiseRaw<'env, NativeProcess>> {
        // Registered in the session's task table now, not when the promise is polled; a refusal
        // (closed mux, NUL in the command line) rejects the returned promise.
        let spawned = self.session.spawn(options, on_stdout, on_stderr);
        env.spawn_future_with_callback(
            async move {
                Ok(match spawned {
                    Ok((state, admitted)) => admitted.wait().await.map(|()| state),
                    Err(refusal) => Err(mux::RoutedError::Other(refusal)),
                })
            },
            |env, outcome| {
                Ok(NativeProcess {
                    state: routed_error::resolve(env, outcome)?,
                })
            },
        )
    }

    #[napi(getter)]
    pub fn seed(&self) -> String {
        self.session.seed().to_string_lossy().into_owned()
    }

    #[napi]
    pub fn start(
        &self,
        options: NativeRunOptions,
        #[napi(ts_arg_type = "(error: Error | null, data: Buffer) => void")]
        on_data: OutputCallback,
    ) -> Result<NativeRun> {
        Ok(NativeRun {
            state: self
                .session
                .start(options, on_data)
                .map_err(Error::from_reason)?,
        })
    }

    #[napi(ts_return_type = "Promise<void>")]
    pub fn close<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, ()>> {
        // Fence admission on the JS call, not when the asynchronous waiter is polled.
        let mut closed = self.session.begin_close();
        env.spawn_future_with_callback(
            async move {
                let published = closed
                    .wait_for(Option::is_some)
                    .await
                    .map_err(|_| Error::from_reason("ShellMux close task ended without a result"))?
                    .clone();
                match published {
                    Some(result) => result.map_err(Error::from_reason),
                    None => Err(Error::from_reason(
                        "ShellMux close task ended without a result",
                    )),
                }
            },
            |_, ()| Ok(()),
        )
    }
}

#[cfg(feature = "test-fs")]
#[napi]
impl NativeMux {
    /// Opens the addon's one mux over a CopyTree fixture; gated exactly like `open`.
    #[napi(factory)]
    pub async fn open_copy_tree(
        seed: String,
        options: Option<NativeMuxOptions>,
        #[napi(ts_arg_type = "(error: Error | null, data: NativePolicyDecision) => void")]
        on_policy_decision: Option<PolicyCallback>,
    ) -> Result<Self> {
        let (sandbox, policy_log) = mux_options(options, on_policy_decision)?;
        let reservation = MuxReservation::acquire()?;
        let policy = tool::sandbox_policy(sandbox);
        let (seed, filesystem) = tokio::task::spawn_blocking(move || {
            let seed = Path::new(&seed)
                .canonicalize()
                .map_err(|error| Error::from_reason(error.to_string()))?;
            let metadata = seed
                .metadata()
                .map_err(|error| Error::from_reason(error.to_string()))?;
            if !metadata.is_dir() {
                return Err(Error::from_reason(format!(
                    "CopyTree fixture is not a directory: {}",
                    seed.display()
                )));
            }
            let fake = Arc::new(marsh_btrfs::fake::CopyTree::new());
            fake.register(&seed);
            // One instance for discovery and for the session: a second CopyTree would know
            // none of this one's registered roots.
            let filesystem: Arc<dyn Subvolumes> = fake;
            let (layer, _) = PersistenceLayer::discover(&seed, filesystem.as_ref())
                .map_err(|error| Error::from_reason(error.to_string()))?;
            Ok::<_, Error>((layer.seed, filesystem))
        })
        .await
        .map_err(|error| Error::from_reason(error.to_string()))??;
        let execution_filesystem = Arc::clone(&filesystem);
        let session = Session::new(seed, filesystem, policy, policy_log, move |profile, frontend| {
            marsh_core::test_support::mux(profile, frontend, execution_filesystem)
        })
        .map_err(Error::from_reason)?;
        Ok(Self::committed(session, sandbox, reservation))
    }
}
