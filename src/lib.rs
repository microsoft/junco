mod frontend;
mod mux;

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use marsh_core::MarshExecutor;
use napi::bindgen_prelude::{Buffer, PromiseRaw};
use napi::threadsafe_function::ThreadsafeFunction;
use napi::{Env, Error, Result};
use napi_derive::napi;

use mux::{RunState, Session};

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
    #[napi]
    pub async fn wait(&self) -> Result<NativeRunResult> {
        self.state.wait().await.map_err(Error::from_reason)
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

impl NativeMux {
    fn from_executor(executor: MarshExecutor) -> Result<Self> {
        Ok(Self {
            session: Session::new(executor).map_err(Error::from_reason)?,
        })
    }
}

#[napi]
impl NativeMux {
    #[napi(factory)]
    pub async fn open(cwd: String) -> Result<Self> {
        let executor = tokio::task::spawn_blocking(move || MarshExecutor::open(Path::new(&cwd)))
            .await
            .map_err(|error| Error::from_reason(error.to_string()))?
            .map_err(|error| Error::from_reason(error.to_string()))?;
        Self::from_executor(executor)
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
                loop {
                    if let Some(result) = closed.borrow_and_update().clone() {
                        return result.map_err(Error::from_reason);
                    }
                    closed.changed().await.map_err(|_| {
                        Error::from_reason("ShellMux close task ended without a result")
                    })?;
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
    pub async fn open_copy_tree(seed: String) -> Result<Self> {
        let executor = tokio::task::spawn_blocking(move || {
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
            let filesystem = Arc::new(marsh_btrfs::fake::CopyTree::new());
            filesystem.register(&seed);
            MarshExecutor::open_with(&seed, filesystem)
                .map_err(|error| Error::from_reason(error.to_string()))
        })
        .await
        .map_err(|error| Error::from_reason(error.to_string()))??;
        Self::from_executor(executor)
    }
}
