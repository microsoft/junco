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
use napi::threadsafe_function::ThreadsafeFunction;
use napi::{Env, Error, Result};
use napi_derive::napi;

use mux::{RunState, Session};
use tool::SandboxMode;

/// Options of a mux the caller opens.
#[napi(object)]
pub struct NativeMuxOptions {
    /// How calls route: `"shared"` (the default) sandboxes a shell command or writing file tool
    /// while another live shell shares the seed, `"always"` sandboxes every one. A read-only file
    /// tool always runs directly.
    pub sandbox: Option<String>,
}

/// The routing mode `options` select, refused before anything is discovered.
fn sandbox_mode(options: Option<NativeMuxOptions>) -> Result<SandboxMode> {
    match options.and_then(|options| options.sandbox).as_deref() {
        None | Some("shared") => Ok(SandboxMode::Shared),
        Some("always") => Ok(SandboxMode::Always),
        Some(value) => Err(Error::from_reason(format!(
            "Invalid sandbox option: {value}; expected \"shared\" or \"always\""
        ))),
    }
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

#[napi]
pub struct NativeMux {
    session: Arc<Session>,
}
#[napi]
impl NativeMux {
    #[napi(factory)]
    pub async fn open(cwd: String, options: Option<NativeMuxOptions>) -> Result<Self> {
        let policy = tool::sandbox_policy(sandbox_mode(options)?);
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
        Ok(Self {
            session: Session::new(seed, filesystem, policy, ShellMux::new)
                .map_err(Error::from_reason)?,
        })
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
        on_data: ThreadsafeFunction<Buffer, ()>,
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
    #[napi(factory)]
    pub async fn open_copy_tree(seed: String, options: Option<NativeMuxOptions>) -> Result<Self> {
        let policy = tool::sandbox_policy(sandbox_mode(options)?);
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
        Ok(Self {
            session: Session::new(seed, filesystem, policy, move |profile, frontend| {
                marsh_core::test_support::mux(profile, frontend, execution_filesystem)
            })
            .map_err(Error::from_reason)?,
        })
    }
}
