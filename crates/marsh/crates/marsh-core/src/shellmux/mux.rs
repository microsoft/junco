//! Multiplexing owns names, streams and receipts. Shell owns every transaction and source lease.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, Weak};

use crate::builtins::BuiltinContext;
use crate::shellmux::error::MuxError;
use crate::shellmux::frontend::{FrontendEvent, ShellFrontend, lock_frontend, notify};
use crate::shellmux::ids::{JobDir, Principal, ShellId};
use crate::shellmux::jobs::{ShellRegistry, validate_size};
use crate::shellmux::types::{MuxProfile, SpawnOptions};
use crate::{Action, MarshTool, OpenFile, ShellBuilder, ShellFd};
use tokio::sync::Notify;

/// Presentation identity and logical source location of one shell instance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sandbox {
    /// Reusable display/lookup name; never a capability principal.
    pub id: ShellId,
    /// Canonical source root: the Git work-tree root containing the initial directory, or that
    /// directory itself outside a work tree. Fixed for the shell's lifetime.
    pub seed: PathBuf,
    /// Initial directory relative to `seed`; unchanged by later `cd`.
    pub dir: JobDir,
    /// The shell's stable Junco principal, also used for retained-handle identity.
    pub uid: Principal,
}

/// A collection of ordinary managed shells and their terminal/pipe lifecycles.
pub struct ShellMux {
    profile: MuxProfile,
    builder: Arc<dyn Fn() -> ShellBuilder + Send + Sync>,
    pub(crate) shells: Mutex<ShellRegistry>,
    pub(crate) launched: Notify,
    pub(crate) tasks: Mutex<tokio::task::JoinSet<()>>,
    pub(crate) runtime: tokio::runtime::Handle,
    pub(crate) resize_lock: tokio::sync::Mutex<()>,
    pub(crate) command_counter: AtomicU64,
    frontend: Arc<Mutex<dyn ShellFrontend>>,
    /// Construction reservations and retained sessions share this close fence.
    managed: Mutex<(bool, Vec<crate::shell::ManagedClose>)>,
}
impl std::fmt::Debug for ShellMux {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ShellMux")
            .field("jobs", &self.jobs().len())
            .finish_non_exhaustive()
    }
}
impl ShellMux {
    /// Creates a mux with normal Shell construction and the frontend's initial geometry.
    pub fn new<V: ShellFrontend>(
        profile: MuxProfile,
        frontend: Arc<Mutex<V>>,
    ) -> Result<Arc<Self>, MuxError> {
        Self::with_builder_factory(profile, frontend, Arc::new(crate::Shell::builder))
    }
    pub(crate) fn with_builder_factory<V: ShellFrontend>(
        profile: MuxProfile,
        frontend: Arc<Mutex<V>>,
        builder: Arc<dyn Fn() -> ShellBuilder + Send + Sync>,
    ) -> Result<Arc<Self>, MuxError> {
        let frontend: Arc<Mutex<dyn ShellFrontend>> = frontend;
        let (rows, cols) = lock_frontend(&frontend).size();
        validate_size(rows, cols)?;
        let runtime = tokio::runtime::Handle::current();
        let mux = Arc::new(Self {
            profile,
            builder,
            shells: Mutex::new(ShellRegistry::new(rows, cols)),
            launched: Notify::new(),
            tasks: Mutex::new(tokio::task::JoinSet::new()),
            runtime,
            resize_lock: tokio::sync::Mutex::new(()),
            command_counter: AtomicU64::new(1),
            frontend: Arc::clone(&frontend),
            managed: Mutex::new((false, Vec::new())),
        });
        let mut bound = lock_frontend(&frontend);
        bound.bind(Arc::downgrade(&mux));
        let _ = bound.update(FrontendEvent::Changed);
        drop(bound);
        Ok(mux)
    }
    pub(crate) fn announce(&self, event: FrontendEvent<'_>) {
        let _ = notify(&self.frontend, event);
    }
    pub(crate) fn frontend(&self) -> Arc<Mutex<dyn ShellFrontend>> {
        Arc::clone(&self.frontend)
    }
    pub(crate) fn detach(&self) {
        lock_frontend(&self.frontend).bind(Weak::new());
    }
    /// Whether shells built by this mux include the named extra or managed builtin.
    pub fn has_builtin(&self, name: &str) -> bool {
        self.profile.builtins.contains_key(name) || matches!(name, "exec" | "release")
    }

    /// Builds a transient shell at `directory` with this mux's builder and profile policy, runs
    /// one tool call through it as [`crate::Shell::run_tool`] does, and closes it. The shell has
    /// no streams and is not a job; it is named by its principal. `owner` is the trusted policy
    /// principal the call acts as (see [`crate::ShellBuilder::policy_owner`]); `None` acts as the
    /// transient shell's own uid.
    pub async fn run_tool<T: MarshTool, R: Send + 'static>(
        self: &Arc<Self>,
        directory: &Path,
        owner: Option<Principal>,
        tool: T,
        operation: impl FnOnce(&BuiltinContext) -> R + Send + 'static,
    ) -> Result<R, MuxError>
    where
        for<'a> &'a T: Into<Action>,
    {
        if self.is_closing() {
            return Err(MuxError::ShuttingDown);
        }
        let shell = self
            .build_shell(
                None,
                directory,
                HashMap::new(),
                SpawnOptions {
                    policy_owner: owner,
                    ..Default::default()
                },
            )
            .await?;
        let outcome = shell.run_tool(tool, operation).await;
        let closed = shell.close(false).await;
        match (outcome, closed) {
            (Err(error), _) | (Ok(_), Err(error)) => Err(error.into()),
            (Ok(value), Ok(())) => Ok(value),
        }
    }

    /// Opens a forced-managed typed session with this mux's policy, environment and resources.
    pub async fn open_managed_session(
        self: &Arc<Self>,
        initial_dir: &Path,
        mut options: SpawnOptions,
    ) -> Result<crate::ManagedSession, MuxError> {
        let cancel = crate::ManagedCancellation::default();
        let (ready, registration) =
            tokio::sync::watch::channel(crate::shell::ManagedRegistration::Opening);
        {
            let mut managed = self
                .managed
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if managed.0 || self.is_closing() {
                return Err(MuxError::ShuttingDown);
            }
            managed.1.retain(crate::shell::ManagedClose::live);
            managed.1.push(crate::shell::ManagedClose {
                cancel: cancel.clone(),
                ready: registration,
            });
        }
        options.io = super::JobIo::Pipes;
        options.automatic_close = false;
        options.force_sandbox = true;
        let opened = async {
            self.configured_builder(None, initial_dir, HashMap::new(), options)
                .build_managed_session_with_cancel(cancel.clone())
                .await
                .map_err(MuxError::from)
        }
        .await;
        match opened {
            Ok(mut session) => {
                ready.send_replace(session.registration());
                if cancel.is_cancelled() {
                    session.close().await?;
                    return Err(MuxError::ShuttingDown);
                }
                Ok(session)
            }
            Err(error) => {
                ready.send_replace(crate::shell::ManagedRegistration::Failed);
                Err(error)
            }
        }
    }

    pub(crate) async fn close_managed(&self) -> Result<(), MuxError> {
        let handles = {
            let mut managed = self
                .managed
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            managed.0 = true;
            let handles = std::mem::take(&mut managed.1);
            for handle in &handles {
                handle.cancel.cancel();
            }
            handles
        };
        let mut failure = None;
        for handle in handles {
            if let Err(error) = handle.close().await {
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), |error| Err(error.into()))
    }

    pub(crate) fn cancel_managed(&self) {
        let mut managed = self
            .managed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        managed.0 = true;
        for handle in &managed.1 {
            handle.cancel.cancel();
        }
    }

    pub(crate) fn drop_managed(&self) {
        let handles = {
            let mut managed = self
                .managed
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            managed.0 = true;
            std::mem::take(&mut managed.1)
        };
        for handle in handles {
            handle.cancel.cancel();
            self.runtime.spawn(async move {
                let _ = handle.close().await;
            });
        }
    }

    /// Builds a shell with this mux's builder and profile; `id` is the display name a job
    /// reserved, and a shell without one is named by its principal.
    ///
    /// `options.force_sandbox` replaces the profile's routing policy with one that always takes
    /// the managed route; `options.policy_owner` is the trusted policy principal its managed
    /// commands act as. `options.pipeline_options` is the resource policy of every outermost
    /// pipeline the shell runs. Stream setup and closure are handled by the caller.
    pub(crate) async fn build_shell(
        &self,
        id: Option<ShellId>,
        directory: &Path,
        fds: HashMap<ShellFd, OpenFile>,
        options: SpawnOptions,
    ) -> Result<Arc<crate::Shell>, MuxError> {
        Ok(Arc::new(
            Box::pin(self.configured_builder(id, directory, fds, options).build()).await?,
        ))
    }

    /// One setup path for ordinary jobs and retained typed sessions.
    fn configured_builder(
        &self,
        id: Option<ShellId>,
        directory: &Path,
        fds: HashMap<ShellFd, OpenFile>,
        options: SpawnOptions,
    ) -> ShellBuilder {
        let policy = if options.force_sandbox {
            crate::SandboxPolicy::allow()
        } else {
            self.profile.sandbox_policy.clone()
        };
        let mut builder = (self.builder)()
            .working_dir(directory.to_path_buf())
            .fds(fds)
            .pipeline_options(options.pipeline_options)
            .interactive(false)
            .no_editing(true)
            .external_cmd_leads_session(true)
            .enable_option("monitor".into())
            .sandbox_policy(policy)
            .shell_policy(Arc::clone(&self.profile.shell_policy))
            .policy_observer(self.profile.policy_observer.clone())
            .policy_owner(options.policy_owner);
        if let Some(environment) = options.environment {
            builder = builder.environment(environment);
        } else {
            for (name, variable) in self.profile.environment.iter() {
                builder = builder.var(name.clone(), variable.clone());
            }
        }
        for (name, registration) in &self.profile.builtins {
            builder = builder.builtin(name.clone(), registration.clone());
        }
        // Startup already routes under the name the mux reserved.
        builder.sandbox_id = id;
        builder
    }
}
