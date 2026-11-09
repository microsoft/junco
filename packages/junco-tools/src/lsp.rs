//! Typed bindings and binding-environment lifetimes; the Rust library owns all LSP work.

use std::{
    collections::HashMap,
    future::Future,
    path::Path,
    sync::{Arc, LazyLock, Mutex, PoisonError},
};

use junco_lsp::{LspAction, LspError, LspInput, LspOptions, LspResult, LspTool};
use marsh_core::shellmux::SpawnOptions;
use marsh_core::{ManagedCancellation, ShellErrorKind};
use napi::bindgen_prelude::{JsObjectValue, JsValue, Object, PromiseRaw, spawn};
use napi::{Env, Error, Result};
use napi_derive::napi;
use tokio::sync::watch;

use crate::{
    NativeMux,
    mux::{self, RoutedError},
    routed_error,
};

type CloseResult = std::result::Result<(), String>;
type OpenResult = std::result::Result<Arc<LspTool>, BindingError>;
type CallResult = std::result::Result<LspResult, BindingError>;

#[napi(object)]
pub struct NativeLspOptions {
    pub read_only: Option<bool>,
    pub trusted_workspace: Option<bool>,
}

/// The public tool input, converted field-by-field without a second wire protocol.
#[derive(Clone)]
#[napi(object)]
pub struct NativeLspInput {
    #[napi(
        ts_type = "\"diagnostics\" | \"definition\" | \"references\" | \"hover\" | \"symbols\" | \"rename\" | \"rename_file\" | \"code_actions\" | \"type_definition\" | \"implementation\" | \"status\" | \"reload\" | \"capabilities\" | \"request\""
    )]
    pub action: String,
    pub file: Option<String>,
    pub line: Option<f64>,
    pub symbol: Option<String>,
    pub query: Option<String>,
    #[napi(js_name = "new_name")]
    pub new_name: Option<String>,
    pub apply: Option<bool>,
    pub timeout: Option<f64>,
    pub payload: Option<String>,
}

impl NativeLspInput {
    fn into_input(self) -> std::result::Result<LspInput, BindingError> {
        let input = self;
        let action = match input.action.as_str() {
            "diagnostics" => LspAction::Diagnostics,
            "definition" => LspAction::Definition,
            "references" => LspAction::References,
            "hover" => LspAction::Hover,
            "symbols" => LspAction::Symbols,
            "rename" => LspAction::Rename,
            "rename_file" => LspAction::RenameFile,
            "code_actions" => LspAction::CodeActions,
            "type_definition" => LspAction::TypeDefinition,
            "implementation" => LspAction::Implementation,
            "status" => LspAction::Status,
            "reload" => LspAction::Reload,
            "capabilities" => LspAction::Capabilities,
            "request" => LspAction::Request,
            _ => {
                return Err(BindingError::Tool(format!(
                    "Unknown LSP action: {}",
                    input.action
                )));
            }
        };
        Ok(LspInput {
            action,
            file: input.file,
            line: input.line,
            symbol: input.symbol,
            query: input.query,
            new_name: input.new_name,
            apply: input.apply,
            timeout: input.timeout,
            payload: input.payload,
        })
    }
}

impl From<LspInput> for NativeLspInput {
    fn from(input: LspInput) -> Self {
        Self {
            action: input.action.to_string(),
            file: input.file,
            line: input.line,
            symbol: input.symbol,
            query: input.query,
            new_name: input.new_name,
            apply: input.apply,
            timeout: input.timeout,
            payload: input.payload,
        }
    }
}

#[napi(object, object_from_js = false)]
pub struct NativeLspDetails {
    pub server_name: Option<String>,
    #[napi(ts_type = "NativeLspInput['action']")]
    pub action: String,
    pub success: bool,
    pub request: Option<NativeLspInput>,
}

#[napi(object, object_from_js = false)]
pub struct NativeLspResult {
    pub text: String,
    pub details: NativeLspDetails,
    pub is_error: bool,
    pub useless: Option<bool>,
}

impl From<LspResult> for NativeLspResult {
    fn from(result: LspResult) -> Self {
        Self {
            text: result.text,
            details: NativeLspDetails {
                server_name: result.details.server_name,
                action: result.details.action.to_string(),
                success: result.details.success,
                request: result.details.request.map(Into::into),
            },
            is_error: result.is_error,
            useless: result.useless,
        }
    }
}

#[derive(Clone)]
enum BindingError {
    Tool(String),
    Abort,
    Routed(RoutedError),
}

impl From<LspError> for BindingError {
    fn from(error: LspError) -> Self {
        match error {
            LspError::Marsh(error) => {
                Self::Routed(if matches!(error.kind(), ShellErrorKind::Denied { .. }) {
                    RoutedError::Denied(format!("Marsh policy denied publication: {error}"))
                } else {
                    RoutedError::Other(error.to_string())
                })
            }
            LspError::Cancelled => Self::Abort,
            LspError::Tool(message) | LspError::Transport(message) => Self::Tool(message),
            LspError::Closed => Self::Tool("LSP tool is closed".to_string()),
            // Semantic results are intercepted at the call boundary, not rejected natively.
            LspError::Semantic(result) => Self::Tool(result.text),
        }
    }
}

fn resolve<T>(env: &Env, result: std::result::Result<T, BindingError>) -> Result<T> {
    match result {
        Ok(value) => Ok(value),
        Err(BindingError::Routed(error)) => routed_error::resolve(env, Err(error)),
        Err(error) => {
            let (name, message) = match error {
                BindingError::Tool(message) => ("ToolError", message),
                BindingError::Abort => ("AbortError", "LSP call cancelled".to_string()),
                BindingError::Routed(_) => unreachable!(),
            };
            let mut error = env.create_error(Error::from_reason(message))?;
            error.set_named_property("name", name)?;
            Err(Error::from(error.to_unknown()))
        }
    }
}

struct LspState {
    cancel: ManagedCancellation,
    ready: watch::Receiver<Option<OpenResult>>,
    closed: watch::Receiver<Option<CloseResult>>,
}

impl Drop for LspState {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

async fn receipt<T: Clone>(
    mut receiver: watch::Receiver<Option<T>>,
    missing: &str,
) -> std::result::Result<T, String> {
    let published = receiver
        .wait_for(Option::is_some)
        .await
        .map_err(|_| missing.to_string())?
        .clone();
    published.ok_or_else(|| missing.to_string())
}

/// Owns opening and cleanup independently of any JavaScript promise's lifetime.
async fn lifetime(
    open: impl Future<Output = std::result::Result<LspTool, BindingError>>,
    cancel: ManagedCancellation,
    ready: watch::Sender<Option<OpenResult>>,
    closed: watch::Sender<Option<CloseResult>>,
) {
    match open.await {
        Ok(tool) => {
            let tool = Arc::new(tool);
            if cancel.is_cancelled() {
                let result = tool.close().await.map_err(|error| error.to_string());
                ready.send_replace(Some(Err(BindingError::Tool(
                    "LSP tool is closed".to_string(),
                ))));
                closed.send_replace(Some(result));
                return;
            }
            ready.send_replace(Some(Ok(Arc::clone(&tool))));
            cancel.cancelled().await;
            let result = tool.close().await.map_err(|error| error.to_string());
            // The retained JavaScript handle must not retain the managed session after close.
            ready.send_replace(Some(Err(BindingError::Tool(
                "LSP tool is closed".to_string(),
            ))));
            drop(tool);
            closed.send_replace(Some(result));
        }
        Err(error) => {
            ready.send_replace(Some(Err(error)));
            closed.send_replace(Some(Ok(())));
        }
    }
}

#[derive(Default)]
struct Registry {
    // Keep close receipts observable after JavaScript finalization until the next sweep.
    handles: Vec<Arc<LspState>>,
    shutdown: Option<watch::Receiver<Option<CloseResult>>>,
}

static REGISTRIES: LazyLock<Mutex<HashMap<usize, Arc<Mutex<Registry>>>>> =
    LazyLock::new(Default::default);

fn registry(env: &Env) -> Result<Arc<Mutex<Registry>>> {
    let key = env.raw() as usize;
    let mut registries = REGISTRIES.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(registry) = registries.get(&key) {
        return Ok(Arc::clone(registry));
    }
    let registry = Arc::new(Mutex::new(Registry::default()));
    env.add_env_cleanup_hook(key, |key| {
        if let Some(registry) = REGISTRIES
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&key)
        {
            let registry = registry.lock().unwrap_or_else(PoisonError::into_inner);
            for handle in &registry.handles {
                handle.cancel.cancel();
            }
        }
    })?;
    registries.insert(key, Arc::clone(&registry));
    Ok(registry)
}

/// One native client lifetime. Explicit close drains it without closing a borrowed mux.
#[napi]
pub struct NativeLsp {
    state: Arc<LspState>,
}

#[napi]
impl NativeLsp {
    #[napi(ts_return_type = "Promise<NativeLsp>")]
    pub fn open<'env>(
        env: &'env Env,
        cwd: String,
        options: Option<NativeLspOptions>,
        mux: Option<&NativeMux>,
    ) -> Result<PromiseRaw<'env, NativeLsp>> {
        let registry = registry(env)?;
        let options = LspOptions {
            read_only: options
                .as_ref()
                .and_then(|options| options.read_only)
                .unwrap_or(false),
            trusted_workspace: options
                .and_then(|options| options.trusted_workspace)
                .unwrap_or(false),
        };
        // Bun's process.env changes need not update libc; capture the caller's runtime.
        let environment = env
            .get_global()?
            .get_named_property::<Object>("process")?
            .get_named_property::<HashMap<String, String>>("env")?;
        let environment = resolve(
            env,
            mux::shell_environment(environment).map_err(BindingError::Tool),
        )?;
        let (ready, ready_receiver) = watch::channel(None);
        let (closed, closed_receiver) = watch::channel(None);
        let state = Arc::new(LspState {
            cancel: ManagedCancellation::default(),
            ready: ready_receiver,
            closed: closed_receiver,
        });
        let started = {
            let mut registry = registry.lock().unwrap_or_else(PoisonError::into_inner);
            if registry.shutdown.is_some() {
                Err(BindingError::Tool(
                    "LSP shutdown is in progress".to_string(),
                ))
            } else if let Some(mux) = mux {
                match mux.owner.clone() {
                    None => Err(BindingError::Tool(
                        "LspTool requires an owner-bound NativeMux".to_string(),
                    )),
                    Some(owner) => {
                        let cancel = state.cancel.clone();
                        let registered = mux.session.register_lsp(
                            cancel.clone(),
                            state.closed.clone(),
                            move |backend, runtime, seed| {
                                let open = async move {
                                    let filesystem = Arc::clone(&backend.filesystem);
                                    let directory = runtime
                                        .spawn_blocking(move || {
                                            mux::working_directory(&cwd, &seed, filesystem.as_ref())
                                        })
                                        .await
                                        .map_err(|error| {
                                            BindingError::Tool(format!(
                                                "Cannot resolve working directory: {error}"
                                            ))
                                        })?
                                        .map_err(BindingError::Tool)?;
                                    let pipeline_options =
                                        backend.pipeline_options(&runtime, Some(&owner));
                                    let session = backend
                                        .mux
                                        .open_managed_session(
                                            &directory,
                                            SpawnOptions {
                                                environment: Some(environment),
                                                pipeline_options,
                                                policy_owner: Some(owner),
                                                ..Default::default()
                                            },
                                        )
                                        .await
                                        .map_err(|error| match error {
                                            marsh_core::shellmux::MuxError::Marsh(error) => {
                                                BindingError::from(LspError::Marsh(error))
                                            }
                                            error => BindingError::Tool(error.to_string()),
                                        })?;
                                    Ok(LspTool::from_session(session, options))
                                };
                                lifetime(open, cancel, ready, closed)
                            },
                        );
                        registered.map_err(BindingError::Tool)
                    }
                }
            } else {
                let cancel = state.cancel.clone();
                spawn(lifetime(
                    async move {
                        LspTool::open_with_environment(Path::new(&cwd), options, Some(environment))
                            .await
                            .map_err(Into::into)
                    },
                    cancel,
                    ready,
                    closed,
                ));
                Ok(())
            }
            .map(|()| {
                registry.handles.push(Arc::clone(&state));
            })
        };
        env.spawn_future_with_callback(
            async move {
                let outcome = match started {
                    Err(error) => Err(error),
                    Ok(()) => receipt(
                        state.ready.clone(),
                        "LSP opening task ended without a result",
                    )
                    .await
                    .map_err(BindingError::Tool)
                    .and_then(|result| result)
                    .map(|_| state),
                };
                Ok(outcome)
            },
            |env, outcome| {
                let state = resolve(env, outcome)?;
                if state.cancel.is_cancelled() {
                    return resolve(
                        env,
                        Err(BindingError::Tool("LSP tool is closed".to_string())),
                    );
                }
                Ok(NativeLsp { state })
            },
        )
    }

    #[napi]
    pub fn start(&self, input: NativeLspInput) -> NativeLspCall {
        let cancel = ManagedCancellation::default();
        let (sender, result) = watch::channel(None);
        let state = Arc::clone(&self.state);
        let cancellation = cancel.clone();
        spawn(async move {
            let result = async {
                if cancellation.is_cancelled() {
                    return Err(BindingError::Abort);
                }
                if state.cancel.is_cancelled() {
                    return Err(BindingError::Tool("LSP tool is closed".to_string()));
                }
                let input = input.into_input()?;
                let tool = receipt(
                    state.ready.clone(),
                    "LSP opening task ended without a result",
                )
                .await
                .map_err(BindingError::Tool)??;
                match tool.execute(input, &cancellation).await {
                    Ok(result) => Ok(result),
                    Err(LspError::Semantic(result)) => Ok(*result),
                    Err(error) => Err(error.into()),
                }
            }
            .await;
            sender.send_replace(Some(result));
        });
        NativeLspCall {
            cancel,
            result,
            wait_started: std::sync::atomic::AtomicBool::new(false),
        }
    }

    #[napi(ts_return_type = "Promise<void>")]
    pub fn close<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, ()>> {
        self.state.cancel.cancel();
        let closed = self.state.closed.clone();
        env.spawn_future_with_callback(
            async move {
                Ok(
                    receipt(closed, "LSP lifetime ended without a close receipt")
                        .await
                        .and_then(|result| result)
                        .map_err(BindingError::Tool),
                )
            },
            resolve,
        )
    }

    #[napi(ts_return_type = "Promise<void>")]
    pub fn shutdown_all<'env>(env: &'env Env) -> Result<PromiseRaw<'env, ()>> {
        let registry = registry(env)?;
        let shutdown = {
            let mut state = registry.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(shutdown) = &state.shutdown {
                shutdown.clone()
            } else {
                let (sender, receiver) = watch::channel(None);
                // Consume each registration once, without erasing its handle's close receipt.
                let handles = std::mem::take(&mut state.handles);
                for handle in &handles {
                    handle.cancel.cancel();
                }
                state.shutdown = Some(receiver.clone());
                let registry = Arc::clone(&registry);
                spawn(async move {
                    let mut errors = Vec::new();
                    for handle in handles {
                        if let Err(error) = receipt(
                            handle.closed.clone(),
                            "LSP lifetime ended without a close receipt",
                        )
                        .await
                        .and_then(|result| result)
                        {
                            errors.push(error);
                        }
                    }
                    let mut registry = registry.lock().unwrap_or_else(PoisonError::into_inner);
                    registry.shutdown = None;
                    sender.send_replace(Some(if errors.is_empty() {
                        Ok(())
                    } else {
                        Err(errors.join("\n"))
                    }));
                });
                receiver
            }
        };
        env.spawn_future_with_callback(
            async move {
                Ok(
                    receipt(shutdown, "LSP shutdown task ended without a result")
                        .await
                        .and_then(|result| result)
                        .map_err(BindingError::Tool),
                )
            },
            resolve,
        )
    }
}

impl Drop for NativeLsp {
    fn drop(&mut self) {
        self.state.cancel.cancel();
    }
}

/// A call-specific cancellation handle; it can never cancel the next queued invocation.
#[napi]
pub struct NativeLspCall {
    cancel: ManagedCancellation,
    result: watch::Receiver<Option<CallResult>>,
    wait_started: std::sync::atomic::AtomicBool,
}

#[napi]
impl NativeLspCall {
    #[napi]
    pub fn abort(&self) {
        self.cancel.cancel();
    }

    #[napi(ts_return_type = "Promise<NativeLspResult>")]
    pub fn wait<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, NativeLspResult>> {
        let result = self.result.clone();
        let promise = env.spawn_future_with_callback(
            async move {
                Ok(receipt(result, "LSP call task ended without a result")
                    .await
                    .map_err(BindingError::Tool)
                    .and_then(|result| result))
            },
            |env, result| resolve(env, result).map(Into::into),
        )?;
        // The promise owns an awaited invocation, even if a temporary JS handle is collected.
        self.wait_started
            .store(true, std::sync::atomic::Ordering::Release);
        Ok(promise)
    }
}

impl Drop for NativeLspCall {
    fn drop(&mut self) {
        if !self.wait_started.load(std::sync::atomic::Ordering::Acquire) {
            self.cancel.cancel();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(action: &str) -> NativeLspInput {
        NativeLspInput {
            action: action.to_string(),
            file: Some("logical/a.fixture".to_string()),
            line: Some(1.5),
            symbol: Some("add".to_string()),
            query: None,
            new_name: Some("sum".to_string()),
            apply: Some(false),
            timeout: Some(5.5),
            payload: None,
        }
    }

    #[test]
    fn action_conversion_preserves_every_public_field() {
        for action in [
            "diagnostics",
            "definition",
            "references",
            "hover",
            "symbols",
            "rename",
            "rename_file",
            "code_actions",
            "type_definition",
            "implementation",
            "status",
            "reload",
            "capabilities",
            "request",
        ] {
            let converted = match input(action).into_input() {
                Ok(input) => NativeLspInput::from(input),
                Err(_) => panic!("known action rejected: {action}"),
            };
            assert_eq!(converted.action, action);
            assert_eq!(converted.file.as_deref(), Some("logical/a.fixture"));
            assert_eq!(converted.line, Some(1.5));
            assert_eq!(converted.symbol.as_deref(), Some("add"));
            assert_eq!(converted.new_name.as_deref(), Some("sum"));
            assert_eq!(converted.apply, Some(false));
            assert_eq!(converted.timeout, Some(5.5));
            assert!(converted.query.is_none());
            assert!(converted.payload.is_none());
        }
        assert!(matches!(
            input("Hover").into_input(),
            Err(BindingError::Tool(_))
        ));
    }

    #[test]
    fn semantic_result_conversion_keeps_optional_request_and_flags() {
        let result = NativeLspResult::from(LspResult {
            text: "No definitions".to_string(),
            details: junco_lsp::LspDetails {
                server_name: None,
                action: LspAction::Definition,
                success: true,
                request: None,
            },
            is_error: false,
            useless: Some(true),
        });
        assert_eq!(result.details.action, "definition");
        assert!(result.details.request.is_none());
        assert!(result.details.server_name.is_none());
        assert!(result.details.success);
        assert!(!result.is_error);
        assert_eq!(result.useless, Some(true));
    }
}
