//! Native LSP transactions. Server output is released only by marsh's durable receipt.
mod actions;
mod client;
mod config;
mod edits;

use marsh_core::{
    Action, ManagedCancellation, ManagedError, ManagedSession, MarshTool, Shell, ShellError,
};
use serde::{Deserialize, Serialize};
use std::{
    borrow::Cow,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tokio::{sync::Mutex, time::Instant};

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct LspOptions {
    pub read_only: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LspAction {
    Diagnostics,
    Definition,
    References,
    Hover,
    Symbols,
    Rename,
    RenameFile,
    CodeActions,
    TypeDefinition,
    Implementation,
    Status,
    Reload,
    Capabilities,
    Request,
}
impl std::fmt::Display for LspAction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Diagnostics => "diagnostics",
            Self::Definition => "definition",
            Self::References => "references",
            Self::Hover => "hover",
            Self::Symbols => "symbols",
            Self::Rename => "rename",
            Self::RenameFile => "rename_file",
            Self::CodeActions => "code_actions",
            Self::TypeDefinition => "type_definition",
            Self::Implementation => "implementation",
            Self::Status => "status",
            Self::Reload => "reload",
            Self::Capabilities => "capabilities",
            Self::Request => "request",
        })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LspInput {
    pub action: LspAction,
    pub file: Option<String>,
    pub line: Option<f64>,
    pub symbol: Option<String>,
    pub query: Option<String>,
    pub new_name: Option<String>,
    pub apply: Option<bool>,
    pub timeout: Option<f64>,
    pub payload: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LspDetails {
    #[serde(rename = "serverName", skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
    pub action: LspAction,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request: Option<LspInput>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LspResult {
    pub text: String,
    pub details: LspDetails,
    #[serde(rename = "isError")]
    pub is_error: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub useless: Option<bool>,
}
#[derive(Debug, thiserror::Error)]
pub enum LspError {
    #[error("{0:?}")]
    Semantic(Box<LspResult>),
    #[error("{0}")]
    Tool(String),
    #[error("{0}")]
    Transport(String),
    #[error(transparent)]
    Marsh(#[from] ShellError),
    #[error("LSP call cancelled")]
    Cancelled,
    #[error("LSP tool is closed")]
    Closed,
}
impl From<std::io::Error> for LspError {
    fn from(e: std::io::Error) -> Self {
        Self::Tool(e.to_string())
    }
}
impl From<serde_json::Error> for LspError {
    fn from(e: serde_json::Error) -> Self {
        Self::Transport(e.to_string())
    }
}
impl From<edits::EditError> for LspError {
    fn from(e: edits::EditError) -> Self {
        Self::Tool(e.to_string())
    }
}

impl LspResult {
    pub(crate) fn new(input: &LspInput, text: impl Into<String>, server: Option<String>) -> Self {
        Self {
            text: text.into(),
            details: LspDetails {
                server_name: server,
                action: input.action,
                success: true,
                request: Some(input.clone()),
            },
            is_error: false,
            useless: None,
        }
    }
    pub(crate) fn failure(input: &LspInput, text: impl Into<String>) -> LspError {
        let mut result = Self::new(input, text, None);
        result.is_error = true;
        result.details.success = false;
        LspError::Semantic(Box::new(result))
    }
}
struct EpochTool(LspAction);
impl From<&EpochTool> for Action {
    fn from(_: &EpochTool) -> Self {
        Self::Edit
    }
}
impl From<EpochTool> for Action {
    fn from(tool: EpochTool) -> Self {
        Self::from(&tool)
    }
}
impl MarshTool for EpochTool {
    fn description(&self) -> Cow<'_, str> {
        Cow::Owned(format!("lsp {}", self.0))
    }
}

struct State {
    session: ManagedSession,
    runtime: client::Runtime,
    close_result: Option<Result<(), String>>,
}
/// A serialized native client registry over one owned managed session.
pub struct LspTool {
    state: Mutex<State>,
    options: LspOptions,
    closing: ManagedCancellation,
    closed: AtomicBool,
}
impl LspTool {
    /// Constructs with the ordinary marsh builder and its default LockPolicy.
    pub async fn open(cwd: &Path, options: LspOptions) -> Result<Self, LspError> {
        Self::open_with_environment(cwd, options, None).await
    }
    /// Captures an embedding runtime's environment without changing the default policy.
    /// JavaScript runtimes may keep environment updates outside libc's environment.
    pub async fn open_with_environment(
        cwd: &Path,
        options: LspOptions,
        environment: Option<marsh_core::ShellEnvironment>,
    ) -> Result<Self, LspError> {
        let mut builder = Shell::builder().working_dir(cwd.to_owned());
        if let Some(environment) = environment {
            builder = builder.environment(environment);
        }
        let session = builder.build_managed_session().await?;
        Ok(Self::from_session(session, options))
    }
    /// Takes ownership without replacing the session's owner, resources or policy.
    pub fn from_session(session: ManagedSession, options: LspOptions) -> Self {
        Self {
            state: Mutex::new(State {
                session,
                runtime: client::Runtime::new(std::env::current_dir()),
                close_result: None,
            }),
            options,
            closing: ManagedCancellation::default(),
            closed: AtomicBool::new(false),
        }
    }
    pub async fn execute(
        &self,
        input: LspInput,
        cancel: &ManagedCancellation,
    ) -> Result<LspResult, LspError> {
        if cancel.is_cancelled() {
            return Err(LspError::Cancelled);
        }
        if self.closed.load(Ordering::Acquire) {
            return Err(LspError::Closed);
        }
        let mut state = tokio::select! { biased; _=cancel.cancelled()=>return Err(LspError::Cancelled),_=self.closing.cancelled()=>return Err(LspError::Closed),state=self.state.lock()=>state };
        if self.closed.load(Ordering::Acquire) {
            return Err(LspError::Closed);
        }
        if cancel.is_cancelled() {
            return Err(LspError::Cancelled);
        }
        actions::validate(&input, self.options)?;
        let seconds = input.timeout.unwrap_or(20.0);
        let deadline = Instant::now() + Duration::from_secs_f64(seconds);
        let wait = Duration::from_secs_f64(input.timeout.unwrap_or(10.0));
        let epoch_cancel = ManagedCancellation::default();
        let State {
            session, runtime, ..
        } = &mut *state;
        let mut attempt = 0;
        loop {
            if cancel.is_cancelled() || self.closing.is_cancelled() || Instant::now() >= deadline {
                epoch_cancel.cancel();
            }
            let result = {
                let operation =
                    session.epoch(EpochTool(input.action), &epoch_cancel, async |epoch| {
                        let result = runtime.execute(epoch, &input, deadline, wait).await;
                        result
                            .map(|mut value| {
                                value.text = client::map_string(epoch, &value.text, false);
                                value
                            })
                            .map_err(|error| client::map_error(epoch, error))
                    });
                tokio::pin!(operation);
                tokio::select! { biased;
                    result=&mut operation=>result,
                    _=cancel.cancelled()=> {epoch_cancel.cancel();operation.await},
                    _=self.closing.cancelled()=> {epoch_cancel.cancel();operation.await},
                    _=tokio::time::sleep_until(deadline)=> {epoch_cancel.cancel();operation.await},
                }
            };
            match result {
                Ok(outcome) => {
                    runtime.commit_failures();
                    if outcome.workspace_mutated {
                        let retired = session.retire().await;
                        runtime.clear();
                        retired?;
                    }
                    return Ok(outcome.value);
                }
                Err(ManagedError::Invalidated) if attempt == 0 => {
                    runtime.clear();
                    attempt += 1;
                }
                Err(error) => {
                    if matches!(&error, ManagedError::Operation(_)) {
                        runtime.commit_failures();
                    }
                    let retired = session.retire().await;
                    runtime.clear();
                    retired?;
                    return Err(match error {
                        ManagedError::Operation(e) => e,
                        ManagedError::Execution(e) => LspError::Marsh(e),
                        ManagedError::Cancelled => LspError::Cancelled,
                        ManagedError::Closed => LspError::Closed,
                        ManagedError::Invalidated => {
                            LspError::Tool("workspace changed before LSP dispatch".into())
                        }
                    });
                }
            }
        }
    }
    /// Fences queued calls, cancels active work and drains the entire owned native tree.
    pub async fn close(&self) -> Result<(), LspError> {
        self.closed.store(true, Ordering::Release);
        self.closing.cancel();
        let mut state = self.state.lock().await;
        if let Some(result) = &state.close_result {
            return result.clone().map_err(LspError::Tool);
        }
        let result = state.session.close().await.map_err(|e| e.to_string());
        state.runtime.clear();
        state.close_result = Some(result.clone());
        result.map_err(LspError::Tool)
    }
}
