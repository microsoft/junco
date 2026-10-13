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
mod policy;
mod process;
mod routed_error;
mod task;
#[cfg(test)]
mod testing;
mod tool;
mod utils;

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use marsh_btrfs::{LibBtrfs, PersistenceLayer, Subvolumes};
use marsh_core::shellmux::ShellMux;
use napi::bindgen_prelude::{Buffer, PromiseRaw};
use napi::{Env, Error, Result};
use napi_derive::napi;

use frontend::{OutputCallback, PolicyCallback};
use mux::{RunState, Session};
use policy::NativePolicy;
use process::{CloseTimeout, ProcessState};
use tool::SandboxMode;

/// Options of a mux the caller opens.
#[napi(object, object_to_js = false)]
pub struct NativeMuxOptions {
    /// How calls route: `"shared"` (the default) sandboxes a shell command or writing file tool
    /// while another live shell shares the seed, `"always"` sandboxes every one. A read-only file
    /// tool always runs directly.
    pub sandbox: Option<String>,
    /// The authorization policy every managed command of this mux is checked against; the
    /// ownership-lock policy when omitted.
    #[napi(ts_type = "NativePolicy")]
    pub policy: Option<policy::PolicyArg>,
    /// Also deliver granted capabilities to `onPolicyDecision`; violations always are.
    pub policy_debug: Option<bool>,
}

/// One junco-policy capability decision, as `Authority::check` made it. A grant is tentative: a
/// later denial in its batch or a failed publication rolls it back.
#[napi(object)]
pub struct NativePolicyDecision {
    pub granted: bool,
    pub principal: String,
    #[napi(ts_type = "\"Read\" | \"Edit\" | \"Release\" | \"Remove\"")]
    pub action: String,
    /// Seed-relative path segments; `[]` is the root.
    pub resource: Vec<String>,
    pub failed_precondition: Option<String>,
    pub allowed_fixes: Option<Vec<String>>,
}

/// The routing mode and authorization policy `options` select, refused before anything is
/// discovered, and the policy log a supplied callback receives decisions through.
fn mux_options(
    options: Option<NativeMuxOptions>,
    on_policy_decision: Option<PolicyCallback>,
) -> Result<(
    SandboxMode,
    Arc<dyn marsh_core::Policy>,
    Option<Arc<frontend::PolicyLog>>,
)> {
    let (sandbox, policy, debug) = options.map_or((None, None, None), |options| {
        (options.sandbox, options.policy, options.policy_debug)
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
    let policy = policy.map_or_else(|| NativePolicy::lock().0, |policy| policy.0);
    let log = on_policy_decision
        .map(|callback| frontend::PolicyLog::new(callback, debug.unwrap_or(false)));
    Ok((mode, policy, log))
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

/// One handle on a mux session. Every handle acts as its own policy owner: `open` handles as
/// each call's fresh shell, `forkOwner` handles as one stable owner minted for it.
#[napi]
pub struct NativeMux {
    session: Arc<Session>,
    sandbox: SandboxMode,
    owner: Option<marsh_core::Principal>,
}

#[napi]
impl NativeMux {
    /// Opens one mux, independent of every other.
    #[napi(factory)]
    pub async fn open(
        cwd: String,
        options: Option<NativeMuxOptions>,
        #[napi(ts_arg_type = "(error: Error | null, data: NativePolicyDecision) => void")]
        on_policy_decision: Option<PolicyCallback>,
    ) -> Result<Self> {
        let (sandbox, shell_policy, policy_log) = mux_options(options, on_policy_decision)?;
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
        let session = Session::new(
            seed,
            filesystem,
            tool::sandbox_policy(sandbox),
            shell_policy,
            policy_log,
            ShellMux::new,
        )
        .map_err(Error::from_reason)?;
        Ok(Self {
            session,
            sandbox,
            owner: None,
        })
    }

    /// A handle over this same session whose every call, command and process acts as one fresh
    /// policy owner. It shares this mux's admission and close: closing either closes both.
    #[napi]
    pub fn fork_owner(&self) -> Result<NativeMux> {
        Ok(Self {
            session: Arc::clone(&self.session),
            sandbox: self.sandbox,
            owner: Some(
                marsh_core::fresh_principal()
                    .map_err(|error| Error::from_reason(error.to_string()))?,
            ),
        })
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
        let spawned = self
            .session
            .spawn(options, self.owner.clone(), on_stdout, on_stderr);
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
                .start(options, self.owner.clone(), on_data)
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

/// The CopyTree backend every fixture mux shares, so muxes over one fixture source share
/// marsh's source authority as production muxes do over one real filesystem.
#[cfg(feature = "test-fs")]
static COPY_TREE: std::sync::LazyLock<Arc<marsh_btrfs::fake::CopyTree>> =
    std::sync::LazyLock::new(|| Arc::new(marsh_btrfs::fake::CopyTree::new()));

#[cfg(feature = "test-fs")]
#[napi]
impl NativeMux {
    /// Opens one mux over a CopyTree fixture, registering `seed` unless a registered root
    /// already covers it.
    #[napi(factory)]
    pub async fn open_copy_tree(
        seed: String,
        options: Option<NativeMuxOptions>,
        #[napi(ts_arg_type = "(error: Error | null, data: NativePolicyDecision) => void")]
        on_policy_decision: Option<PolicyCallback>,
    ) -> Result<Self> {
        let (sandbox, shell_policy, policy_log) = mux_options(options, on_policy_decision)?;
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
            let fake = Arc::clone(&COPY_TREE);
            let filesystem: Arc<dyn Subvolumes> = fake.clone();
            let layer = match PersistenceLayer::discover(&seed, filesystem.as_ref()) {
                Ok((layer, _)) => layer,
                Err(marsh_btrfs::Error::NoSubvolume(_)) => {
                    fake.register(&seed);
                    PersistenceLayer::discover(&seed, filesystem.as_ref())
                        .map_err(|error| Error::from_reason(error.to_string()))?
                        .0
                }
                Err(error) => return Err(Error::from_reason(error.to_string())),
            };
            Ok::<_, Error>((layer.seed, filesystem))
        })
        .await
        .map_err(|error| Error::from_reason(error.to_string()))??;
        let execution_filesystem = Arc::clone(&filesystem);
        let session = Session::new(
            seed,
            filesystem,
            tool::sandbox_policy(sandbox),
            shell_policy,
            policy_log,
            move |profile, frontend| {
                marsh_core::test_support::mux(profile, frontend, execution_filesystem)
            },
        )
        .map_err(Error::from_reason)?;
        Ok(Self {
            session,
            sandbox,
            owner: None,
        })
    }
}
