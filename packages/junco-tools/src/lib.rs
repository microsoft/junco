// Oh My Pi native binding/grep modules transplanted from revision
// 7ae76f8e4daca0c8f409f61bcd514260cd522365 — see LICENSE.oh-my-pi.
mod ast;
mod diff;
mod edit;
mod frontend;
mod glob;
mod glob_util;
mod graph;
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
mod tui;

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use marsh_btrfs::{LibBtrfs, PersistenceLayer, Subvolumes};
use marsh_core::shellmux::ShellMux;
use napi::bindgen_prelude::{Buffer, Either, PromiseRaw, Undefined};
use napi::{Env, Error, Result};
use napi_derive::napi;

use frontend::{OutputCallback, PolicyCallback, ResourceCallback};
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
    /// Resource limits and monitoring of this mux's commands; none when omitted.
    pub resources: Option<NativeResourceOptions>,
}

/// Resource limits and monitoring of every shell command and persistent process this mux
/// runs, enforced per outermost pipeline with Linux cgroup v2 (delegated cpu/memory/pids
/// controllers). Without them a command fails closed, reporting `cgroup resource control
/// unavailable` on its standard error instead of running unlimited. File tools spawn no
/// pipelines and are unaffected.
#[napi(object, object_to_js = false)]
pub struct NativeResourceOptions {
    /// Memory ceiling in bytes, swap disabled; a positive integer.
    pub memory_bytes: Option<f64>,
    /// CPU quota in CPUs, for example `0.5`; positive.
    pub cpus: Option<f64>,
    /// Maximum task count; a positive integer no greater than 4294967295.
    pub pids: Option<f64>,
    /// Sampling interval, in milliseconds, of the monitor whose events `onResourceEvent`
    /// receives; positive. Each requires the other.
    pub monitor_interval_ms: Option<f64>,
}

/// Cumulative accounting of one pipeline's cgroup; durations in milliseconds.
#[napi(object)]
pub struct NativeResourceSample {
    pub elapsed_ms: f64,
    pub memory_bytes: f64,
    pub memory_peak_bytes: f64,
    pub cpu_usage_ms: f64,
    pub cpu_user_ms: f64,
    pub cpu_system_ms: f64,
    pub cpu_throttled_ms: f64,
    pub pids: u32,
    pub oom_kills: f64,
}

/// One monitor event of a pipeline this mux ran. `started` carries `command` (the pipeline's
/// source text); `sample` (periodic, lossy) and `finished` (always delivered) carry `sample`.
#[napi(object)]
pub struct NativeResourceEvent {
    #[napi(ts_type = "\"started\" | \"sample\" | \"finished\"")]
    pub kind: String,
    pub pipeline_id: f64,
    /// Policy owner of the shell that ran the pipeline; absent for an unforked handle.
    pub owner: Option<String>,
    pub command: Option<String>,
    pub sample: Option<NativeResourceSample>,
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

type ResourceEvents = (Duration, Arc<frontend::ResourceLog>);

/// What `NativeMuxOptions` and the open callbacks select, refused before anything is discovered.
pub(crate) struct MuxSetup {
    pub(crate) sandbox: SandboxMode,
    pub(crate) shell_policy: Arc<dyn marsh_core::Policy>,
    pub(crate) policy_log: Option<Arc<frontend::PolicyLog>>,
    pub(crate) pipeline_options: marsh_core::PipelineOptions,
    /// The monitor interval and the sink, when monitoring is on.
    pub(crate) resource_events: Option<ResourceEvents>,
}

fn mux_options(
    options: Option<NativeMuxOptions>,
    on_policy_decision: Option<PolicyCallback>,
    on_resource_event: Option<ResourceCallback>,
) -> Result<MuxSetup> {
    let (sandbox, policy, debug, resources) = options.map_or((None, None, None, None), |options| {
        (
            options.sandbox,
            options.policy,
            options.policy_debug,
            options.resources,
        )
    });
    let sandbox = match sandbox.as_deref() {
        None | Some("shared") => SandboxMode::Shared,
        Some("always") => SandboxMode::Always,
        Some(value) => {
            return Err(Error::from_reason(format!(
                "Invalid sandbox option: {value}; expected \"shared\" or \"always\""
            )));
        }
    };
    let shell_policy = policy.map_or_else(|| NativePolicy::lock().0, |policy| policy.0);
    let policy_log = on_policy_decision
        .map(|callback| frontend::PolicyLog::new(callback, debug.unwrap_or(false)));
    let (pipeline_options, resource_events) = pipeline_options(resources, on_resource_event)?;
    Ok(MuxSetup {
        sandbox,
        shell_policy,
        policy_log,
        pipeline_options,
        resource_events,
    })
}

fn pipeline_options(
    resources: Option<NativeResourceOptions>,
    on_resource_event: Option<ResourceCallback>,
) -> Result<(marsh_core::PipelineOptions, Option<ResourceEvents>)> {
    use marsh_core::{CpuLimit, MemoryLimit, PipelineOptions, ResourceLimits};

    let mut limits = ResourceLimits::default();
    let mut interval = None;
    if let Some(resources) = resources {
        if let Some(value) = resources.memory_bytes {
            if !value.is_finite()
                || value <= 0.0
                || value.fract() != 0.0
                || value > 9_007_199_254_740_992.0
            {
                return Err(Error::from_reason(
                    "Invalid resources option: memoryBytes must be a positive integer",
                ));
            }
            limits.memory = Some(MemoryLimit::new(value as u64));
        }
        if let Some(value) = resources.cpus {
            if !value.is_finite() || value <= 0.0 {
                return Err(Error::from_reason(
                    "Invalid resources option: cpus must be a positive number",
                ));
            }
            limits.cpu = Some(CpuLimit::new(value));
        }
        if let Some(value) = resources.pids {
            if !value.is_finite()
                || value <= 0.0
                || value.fract() != 0.0
                || value > f64::from(u32::MAX)
            {
                return Err(Error::from_reason(
                    "Invalid resources option: pids must be positive and an integer no greater than 4294967295",
                ));
            }
            limits.pids = Some(value as u32);
        }
        if let Some(value) = resources.monitor_interval_ms {
            if !value.is_finite() || value <= 0.0 {
                return Err(Error::from_reason(
                    "Invalid resources option: monitorIntervalMs must be a positive number",
                ));
            }
            let duration = Duration::try_from_secs_f64(value / 1000.0).map_err(|_| {
                Error::from_reason("Invalid resources option: monitorIntervalMs is out of range")
            })?;
            if duration.is_zero() {
                return Err(Error::from_reason(
                    "Invalid resources option: monitorIntervalMs is out of range",
                ));
            }
            interval = Some(duration);
        }
    }
    let mut options = PipelineOptions::default();
    if limits != ResourceLimits::default() {
        options = options.with_resource_limits(limits);
    }
    let events = match (interval, on_resource_event) {
        (Some(_), None) => {
            return Err(Error::from_reason(
                "Invalid resources option: monitorIntervalMs requires an onResourceEvent callback",
            ));
        }
        (None, Some(_)) => {
            return Err(Error::from_reason(
                "onResourceEvent requires resources.monitorIntervalMs",
            ));
        }
        (Some(interval), Some(callback)) => Some((interval, frontend::ResourceLog::new(callback))),
        (None, None) => None,
    };
    Ok((options, events))
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
        #[napi(ts_arg_type = "(error: Error | null, data: NativeResourceEvent) => void")]
        on_resource_event: Option<ResourceCallback>,
    ) -> Result<Self> {
        let setup = mux_options(options, on_policy_decision, on_resource_event)?;
        let sandbox = setup.sandbox;
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
        let session =
            Session::new(seed, filesystem, setup, ShellMux::new).map_err(Error::from_reason)?;
        Ok(Self {
            session,
            sandbox,
            owner: None,
        })
    }

    /// The policy owner this handle acts as: a `forkOwner` handle has one, an `open` handle none.
    #[napi(getter)]
    pub fn owner(&self) -> Either<String, Undefined> {
        match &self.owner {
            Some(principal) => Either::A(principal.as_str().to_owned()),
            None => Either::B(()),
        }
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
        #[napi(ts_arg_type = "(error: Error | null, data: NativeResourceEvent) => void")]
        on_resource_event: Option<ResourceCallback>,
    ) -> Result<Self> {
        let setup = mux_options(options, on_policy_decision, on_resource_event)?;
        let sandbox = setup.sandbox;
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
        let session = Session::new(seed, filesystem, setup, move |profile, frontend| {
            marsh_core::test_support::mux(profile, frontend, execution_filesystem)
        })
        .map_err(Error::from_reason)?;
        Ok(Self {
            session,
            sandbox,
            owner: None,
        })
    }
}
