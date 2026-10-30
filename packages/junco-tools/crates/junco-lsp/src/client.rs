//! Epoch-local JSON-RPC pumping; capabilities are adapted from OMP 18.13.3 (see ../LICENSE-OMP).
use crate::{
    LspError, LspInput, LspResult,
    config::{Config, ConfigContext, ServerConfig},
    edits::{self, EditSummary},
};
use futures_util::{StreamExt, stream::FuturesUnordered};
use lsp_types::{
    Diagnostic, Uri, WorkspaceEdit,
    notification::{self, Notification},
    request::{self, Request},
};
use marsh_core::{ManagedChild, ManagedEpoch};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    time::Instant,
};

const HEADER_LIMIT: usize = 16 * 1024;
const BODY_LIMIT: usize = 256 * 1024 * 1024;
#[derive(Default)]
pub(crate) struct Framer {
    bytes: Vec<u8>,
    body: Option<usize>,
}
impl Framer {
    fn push(&mut self, bytes: &[u8]) {
        self.bytes.extend_from_slice(bytes);
    }
    fn next(&mut self) -> Result<Option<Value>, LspError> {
        loop {
            if let Some(length) = self.body {
                if self.bytes.len() < length {
                    return Ok(None);
                }
                let message = serde_json::from_slice(&self.bytes[..length]);
                self.bytes.drain(..length);
                self.body = None;
                match message {
                    Ok(message) => return Ok(Some(message)),
                    Err(_) => continue,
                }
            }
            let marker = [b"content-length:".as_slice(), b"content-type:".as_slice()]
                .into_iter()
                .filter_map(|marker| {
                    self.bytes
                        .windows(marker.len())
                        .position(|window| window.eq_ignore_ascii_case(marker))
                })
                .min();
            if let Some(offset) = marker {
                let prefix = &self.bytes[..offset];
                let headers = prefix.ends_with(b"\n")
                    && prefix
                        .split(|&b| b == b'\n')
                        .filter(|line| !line.is_empty())
                        .all(|line| {
                            line.iter().position(|&b| b == b':').is_some_and(|colon| {
                                line[..colon]
                                    .iter()
                                    .all(|b| b.is_ascii_alphanumeric() || *b == b'-')
                            })
                        });
                if offset > 0 && !headers {
                    self.bytes.drain(..offset);
                }
            }
            // Some servers print startup banners. Discard complete non-header lines only.
            while let Some(end) = self.bytes.iter().position(|&b| b == b'\n') {
                let line = &self.bytes[..end];
                if line.iter().position(|&b| b == b':').is_some_and(|colon| {
                    colon > 0
                        && line[..colon]
                            .iter()
                            .all(|b| b.is_ascii_alphanumeric() || *b == b'-')
                }) {
                    break;
                }
                self.bytes.drain(..=end);
            }
            let end = self
                .bytes
                .windows(4)
                .position(|w| w == b"\r\n\r\n")
                .map(|i| (i, 4))
                .or_else(|| {
                    self.bytes
                        .windows(2)
                        .position(|w| w == b"\n\n")
                        .map(|i| (i, 2))
                });
            let Some((end, separator)) = end else {
                if self.bytes.len() > HEADER_LIMIT {
                    return Err(transport("LSP header exceeds 16 KiB"));
                }
                return Ok(None);
            };
            if end + separator > HEADER_LIMIT {
                return Err(transport("LSP header exceeds 16 KiB"));
            }
            let header = std::str::from_utf8(&self.bytes[..end])
                .map_err(|_| transport("non-ASCII LSP header"))?;
            let mut length = None;
            for line in header.lines() {
                let Some((name, value)) = line.trim_end_matches('\r').split_once(':') else {
                    return Err(transport("invalid LSP header"));
                };
                if name.eq_ignore_ascii_case("content-length") {
                    let value = value.trim();
                    if length.is_some()
                        || value.is_empty()
                        || !value.bytes().all(|b| b.is_ascii_digit())
                    {
                        return Err(transport("invalid or duplicate Content-Length"));
                    }
                    let size = value
                        .parse::<usize>()
                        .map_err(|_| transport("Content-Length overflow"))?;
                    if size > BODY_LIMIT {
                        return Err(transport("LSP body exceeds 256 MiB"));
                    }
                    length = Some(size);
                }
            }
            self.body = Some(length.ok_or_else(|| transport("missing Content-Length"))?);
            self.bytes.drain(..end + separator);
        }
    }
}
fn transport(message: impl Into<String>) -> LspError {
    LspError::Transport(message.into())
}

fn detect_language_id(path: &Path) -> &'static str {
    let basename = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    match basename.as_str() {
        "dockerfile" | "containerfile" => return "dockerfile",
        name if name.starts_with("dockerfile.") => return "dockerfile",
        ".emacs" => return "emacs-lisp",
        "makefile" | "gnumakefile" => return "makefile",
        "justfile" => return "just",
        "cmakelists.txt" => return "cmake",
        _ => {}
    }
    match Path::new(&basename)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
    {
        "ts" | "cts" | "mts" => "typescript",
        "tsx" => "typescriptreact",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "javascriptreact",
        "rs" => "rust",
        "go" => "go",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hh" | "hpp" | "hxx" | "cu" | "cuh" | "ino" => "cpp",
        "zig" => "zig",
        "py" | "pyi" => "python",
        "rb" | "rbw" | "gemspec" => "ruby",
        "lua" => "lua",
        "sh" | "bash" | "zsh" | "ksh" | "bats" | "tmux" | "cgi" | "fcgi" | "command" | "tool" => {
            "shellscript"
        }
        "fish" => "fish",
        "pl" | "pm" | "perl" => "perl",
        "php" => "php",
        "java" => "java",
        "kt" | "ktm" | "kts" => "kotlin",
        "scala" | "sc" | "sbt" => "scala",
        "groovy" => "groovy",
        "clj" | "cljc" | "cljs" | "edn" => "clojure",
        "el" => "emacs-lisp",
        "cs" => "csharp",
        "fs" => "fsharp",
        "vb" => "vb",
        "html" | "htm" | "xhtml" => "html",
        "css" => "css",
        "scss" => "scss",
        "sass" => "sass",
        "less" => "less",
        "vue" => "vue",
        "svelte" => "svelte",
        "astro" => "astro",
        "json" => "json",
        "jsonc" => "jsonc",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "xml" | "xsl" | "xslt" | "svg" | "plist" => "xml",
        "ini" => "ini",
        "md" | "markdown" | "mdx" | "mdc" | "mkd" | "mdown" => "markdown",
        "rst" => "restructuredtext",
        "adoc" => "asciidoc",
        "tex" => "latex",
        "sql" => "sql",
        "graphql" | "gql" => "graphql",
        "proto" => "protobuf",
        "dockerfile" | "containerfile" => "dockerfile",
        "tf" => "terraform",
        "hcl" | "tfvars" => "hcl",
        "nix" => "nix",
        "ex" | "exs" => "elixir",
        "erl" | "hrl" => "erlang",
        "hs" => "haskell",
        "ml" | "mli" => "ocaml",
        "swift" => "swift",
        "r" => "r",
        "jl" => "julia",
        "dart" => "dart",
        "elm" => "elm",
        "v" => "v",
        "nim" => "nim",
        "cr" => "crystal",
        "d" => "d",
        "pas" | "pp" => "pascal",
        "lisp" | "lsp" => "lisp",
        "rkt" => "racket",
        "scm" => "scheme",
        "ps1" | "psm1" => "powershell",
        "bat" | "cmd" => "bat",
        "tla" | "tlaplus" => "tlaplus",
        "cmake" => "cmake",
        _ => "plaintext",
    }
}
#[derive(Serialize)]
struct Outgoing<'a> {
    jsonrpc: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<u64>,
    method: &'a str,
    params: Value,
}
#[derive(Deserialize)]
struct Envelope {
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    params: Value,
    #[serde(default)]
    result: Value,
    #[serde(default)]
    error: Option<RpcError>,
}
#[derive(Deserialize, Debug)]
struct RpcError {
    code: i64,
    message: String,
}
fn correlate(
    id: Value,
    result: Value,
    error: Option<RpcError>,
    pending: &HashSet<u64>,
    responses: &mut HashMap<u64, Result<Value, RpcError>>,
) {
    if let Some(id) = id.as_u64().filter(|id| pending.contains(id)) {
        responses.entry(id).or_insert_with(|| match error {
            Some(error) => Err(error),
            None => Ok(result),
        });
    }
}

pub(crate) struct Document {
    pub content: String,
    pub version: i32,
    pub language: String,
    pub last_use: Instant,
    pub opened: Instant,
    reopened: bool,
}
pub(crate) struct Published {
    pub diagnostics: Vec<Diagnostic>,
    pub version: Option<i32>,
    pub received: Instant,
}
struct PullReport {
    version: i32,
    result_id: Option<String>,
    diagnostics: Vec<Diagnostic>,
}
struct WriteFrame {
    sequence: u64,
    header: [u8; 64],
    header_length: usize,
    body: Vec<u8>,
    offset: usize,
}
enum ClientEvent {
    Message(Value),
    Written,
}
pub(crate) struct Client {
    pub identity: String,
    pub config: ServerConfig,
    pub child: ManagedChild,
    framer: Framer,
    write_buffer: Vec<u8>,
    stderr: Vec<u8>,
    stderr_closed: bool,
    outgoing: VecDeque<WriteFrame>,
    next_write: u64,
    written: u64,
    pub capabilities: Value,
    pub documents: HashMap<String, Document>,
    pub diagnostics: HashMap<String, Published>,
    pull_reports: HashMap<String, PullReport>,
    closed_versions: HashMap<String, i32>,
    started: Instant,
    responses: HashMap<u64, Result<Value, RpcError>>,
    next_id: u64,
    pending: HashSet<u64>,
    pub progress: HashSet<String>,
    project_loaded: bool,
    pub diagnostic_registration: HashSet<String>,
    pub ready: bool,
    pub rust_ready: bool,
    pub last_use: Instant,
}
impl Client {
    fn new(identity: String, config: ServerConfig, child: ManagedChild) -> Self {
        Self {
            identity,
            config,
            child,
            framer: Framer::default(),
            write_buffer: Vec::new(),
            outgoing: VecDeque::new(),
            next_write: 1,
            written: 0,
            stderr: Vec::new(),
            stderr_closed: false,
            capabilities: Value::Null,
            documents: HashMap::new(),
            diagnostics: HashMap::new(),
            pull_reports: HashMap::new(),
            closed_versions: HashMap::new(),
            started: Instant::now(),
            responses: HashMap::new(),
            next_id: 1,
            pending: HashSet::new(),
            progress: HashSet::new(),
            project_loaded: false,
            diagnostic_registration: HashSet::new(),
            ready: false,
            rust_ready: false,
            last_use: Instant::now(),
        }
    }
    fn enqueue(&mut self, value: &impl Serialize) -> Result<u64, LspError> {
        self.write_buffer.clear();
        serde_json::to_writer(&mut self.write_buffer, value)?;
        let sequence = self.next_write;
        self.next_write = sequence
            .checked_add(1)
            .ok_or_else(|| transport("LSP write sequence overflow"))?;
        let mut header = [0; 64];
        let header_length = {
            let mut cursor = std::io::Cursor::new(header.as_mut_slice());
            std::io::Write::write_fmt(
                &mut cursor,
                format_args!("Content-Length: {}\r\n\r\n", self.write_buffer.len()),
            )?;
            usize::try_from(cursor.position()).map_err(|e| transport(e.to_string()))?
        };
        self.outgoing.push_back(WriteFrame {
            sequence,
            header,
            header_length,
            body: std::mem::take(&mut self.write_buffer),
            offset: 0,
        });
        Ok(sequence)
    }
    async fn event(&mut self, epoch: &ManagedEpoch<'_>) -> Result<ClientEvent, LspError> {
        enum StreamEvent {
            Out(std::io::Result<usize>),
            Err(std::io::Result<usize>),
            Write(std::io::Result<usize>),
        }
        loop {
            if let Some(frame) = self.framer.next()? {
                return Ok(ClientEvent::Message(frame));
            }
            let mut io = self.child.io(epoch)?;
            let mut stdout = [0; 8192];
            let mut stderr = [0; 4096];
            let event = {
                let next = self.outgoing.front();
                let write = async {
                    if let Some(frame) = next {
                        let bytes = if frame.offset < frame.header_length {
                            &frame.header[frame.offset..frame.header_length]
                        } else {
                            &frame.body[frame.offset - frame.header_length..]
                        };
                        io.stdin.write(bytes).await
                    } else {
                        std::future::pending().await
                    }
                };
                tokio::pin!(write);
                tokio::select! {
                    result=&mut write=>StreamEvent::Write(result),
                    result=io.stdout.read(&mut stdout)=>StreamEvent::Out(result),
                    result=io.stderr.read(&mut stderr),if !self.stderr_closed=>StreamEvent::Err(result),
                }
            };
            match event {
                StreamEvent::Out(result) => {
                    let n = result.map_err(|e| transport(e.to_string()))?;
                    if n == 0 {
                        return Err(transport(format!("{} closed stdout", self.config.name)));
                    }
                    self.framer.push(&stdout[..n]);
                }
                StreamEvent::Err(result) => {
                    let n = result.map_err(|e| transport(e.to_string()))?;
                    if n == 0 {
                        self.stderr_closed = true;
                    } else {
                        let remaining = 65536usize.saturating_sub(self.stderr.len());
                        self.stderr.extend_from_slice(&stderr[..n.min(remaining)]);
                    }
                }
                StreamEvent::Write(result) => {
                    let n = result.map_err(|e| transport(e.to_string()))?;
                    if n == 0 {
                        return Err(transport("LSP stdin returned a zero-length write"));
                    }
                    let frame = self
                        .outgoing
                        .front_mut()
                        .ok_or_else(|| transport("missing queued frame"))?;
                    frame.offset += n;
                    if frame.offset == frame.header_length + frame.body.len() {
                        let frame = self
                            .outgoing
                            .pop_front()
                            .ok_or_else(|| transport("missing completed frame"))?;
                        self.written = frame.sequence;
                        if frame.body.capacity() > self.write_buffer.capacity() {
                            self.write_buffer = frame.body;
                        }
                    }
                    self.last_use = Instant::now();
                    return Ok(ClientEvent::Written);
                }
            }
        }
    }
    pub fn supports_diagnostics(&self) -> bool {
        self.capabilities
            .get("diagnosticProvider")
            .is_some_and(|v| !v.is_null() && v != &Value::Bool(false))
            || !self.diagnostic_registration.is_empty()
    }
    fn close_document(&mut self, uri: &str) {
        if let Some(document) = self.documents.remove(uri) {
            self.closed_versions
                .insert(uri.to_owned(), document.version);
        }
        self.diagnostics.remove(uri);
        self.pull_reports.remove(uri);
    }
    fn current_diagnostics(&self, uri: &str) -> Option<&[Diagnostic]> {
        let document = self.documents.get(uri)?;
        let published = self.diagnostics.get(uri)?;
        // A first/reopened empty report can precede analysis for the very same version.
        if published.diagnostics.is_empty()
            && (document.version == 1 || document.reopened)
            && document.opened.elapsed() < Duration::from_secs(12)
            && (!self.project_loaded || published.received.elapsed() < Duration::from_millis(250))
        {
            return None;
        }
        if let Some(version) = published.version {
            return (version == document.version).then_some(published.diagnostics.as_slice());
        }
        if published.received.elapsed() < Duration::from_millis(250) {
            return None;
        }
        Some(&published.diagnostics)
    }
    pub fn is_rust(&self) -> bool {
        self.config
            .command
            .file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s == "rust-analyzer" || s == "rust-analyzer.exe")
    }
}

pub(crate) struct Runtime {
    pub config: Option<Config>,
    context: Option<ConfigContext>,
    construction_cwd: Result<PathBuf, String>,
    pub clients: Vec<Client>,
    pub failures: HashMap<String, (Instant, String)>,
    pending_failures: HashMap<String, (Instant, String)>,
    pub poison: Option<String>,
    deadline: Instant,
}
impl Runtime {
    pub fn new(construction_cwd: std::io::Result<PathBuf>) -> Self {
        Self {
            config: None,
            context: None,
            construction_cwd: construction_cwd.map_err(|e| e.to_string()),
            clients: Vec::new(),
            failures: HashMap::new(),
            pending_failures: HashMap::new(),
            poison: None,
            deadline: Instant::now(),
        }
    }
    pub fn clear(&mut self) {
        self.clients.clear();
        self.config = None;
        self.poison = None;
        self.pending_failures.clear();
    }
    pub fn commit_failures(&mut self) {
        self.failures.extend(self.pending_failures.drain());
    }
    pub fn clear_failures(&mut self, identity: Option<&str>) {
        if let Some(identity) = identity {
            self.failures.remove(identity);
            self.pending_failures.remove(identity);
        } else {
            self.failures.clear();
            self.pending_failures.clear();
        }
    }
    pub async fn execute(
        &mut self,
        epoch: &ManagedEpoch<'_>,
        input: &LspInput,
        deadline: Instant,
        wait: Duration,
    ) -> Result<LspResult, LspError> {
        self.deadline = deadline;
        if self.context.is_none() {
            let cwd = self.construction_cwd.as_ref().map_err(|reason| {
                LspError::Tool(format!("cannot determine construction cwd: {reason}"))
            })?;
            self.context = Some(ConfigContext::from_epoch(epoch, cwd.clone()));
        }
        if self.config.is_none() {
            self.load_config(epoch)?;
        }
        self.reap_idle(epoch).await?;
        let result = crate::actions::execute(self, epoch, input, deadline, wait).await;
        if result.is_ok() {
            self.pause(epoch, Duration::from_millis(20), deadline)
                .await?;
        }
        if let Some(reason) = self.poison.take() {
            return Err(LspError::Tool(reason));
        }
        result
    }
    pub fn load_config(&mut self, epoch: &ManagedEpoch<'_>) -> Result<(), LspError> {
        let context = self
            .context
            .as_ref()
            .ok_or_else(|| LspError::Tool("missing configuration context".into()))?;
        self.config = Some(Config::load(epoch, context)?);
        Ok(())
    }
    pub fn servers(&self) -> &[ServerConfig] {
        self.config
            .as_ref()
            .map_or(&[], |config| config.servers.as_slice())
    }
    pub fn selected(&self, file: Option<&Path>, semantic: bool) -> Vec<ServerConfig> {
        self.servers()
            .iter()
            .filter(|s| {
                s.available
                    && (!semantic || s.custom.is_none())
                    && file.is_none_or(|file| s.matches(file))
            })
            .cloned()
            .collect()
    }
    async fn reap_idle(&mut self, epoch: &ManagedEpoch<'_>) -> Result<(), LspError> {
        let timeout = self
            .config
            .as_ref()
            .and_then(|c| c.idle_timeout_ms)
            .filter(|n| n.is_finite() && *n > 0.0)
            .map(|ms| Duration::try_from_secs_f64(ms / 1000.0).unwrap_or(Duration::MAX));
        if let Some(timeout) = timeout {
            let mut i = self.clients.len();
            while i > 0 {
                i -= 1;
                if self.clients[i].pending.is_empty()
                    && self.clients[i].last_use.elapsed() >= timeout
                {
                    self.stop(epoch, i).await?;
                }
            }
        }
        Ok(())
    }
    pub async fn stop(&mut self, epoch: &ManagedEpoch<'_>, index: usize) -> Result<(), LspError> {
        let client = self.clients.remove(index);
        client.child.kill()?;
        client.child.wait(epoch).await?;
        Ok(())
    }
    pub async fn ensure(
        &mut self,
        epoch: &ManagedEpoch<'_>,
        mut config: ServerConfig,
        deadline: Instant,
    ) -> Result<usize, LspError> {
        let identity = config.identity();
        if let Some(index) = self
            .clients
            .iter()
            .position(|client| client.identity == identity)
        {
            return Ok(index);
        }
        if let Some((when, reason)) = self
            .pending_failures
            .get(&identity)
            .or_else(|| self.failures.get(&identity))
            && when.elapsed() < Duration::from_secs(180)
        {
            return Err(LspError::Tool(reason.clone()));
        }
        config
            .args
            .iter_mut()
            .for_each(|arg| *arg = map_string(epoch, arg, true));
        map_value(epoch, &mut config.init_options, true);
        map_value(epoch, &mut config.settings, true);
        let mut command = Command::new(&config.command);
        command
            .args(&config.args)
            .env_clear()
            .envs(epoch.environment())
            .current_dir(epoch.physical_path(epoch.cwd())?)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = epoch.spawn(format!("LSP {}", config.name), command)?;
        let index = self.clients.len();
        self.clients
            .push(Client::new(identity.clone(), config, child));
        let budget = Duration::from_secs_f64(
            self.clients[index]
                .config
                .warmup_timeout_ms
                .filter(|n| n.is_finite() && *n > 0.0)
                .unwrap_or(5000.0)
                .min(300000.0)
                / 1000.0,
        );
        let full_deadline = Instant::now() + budget;
        let init_deadline = deadline.min(full_deadline);
        let shortened = budget < Duration::from_secs(5) || init_deadline < full_deadline;
        let initialized = self.initialize(epoch, index, init_deadline).await;
        match initialized {
            Ok(()) => {
                self.failures.remove(&identity);
                self.pending_failures.remove(&identity);
                Ok(index)
            }
            Err(error) => {
                if !shortened && !matches!(error, LspError::Cancelled | LspError::Marsh(_)) {
                    let reason = format!(
                        "{} initialization failed; reload to retry before the three-minute retry window",
                        self.clients[index].config.name
                    );
                    self.pending_failures
                        .insert(identity, (Instant::now(), reason));
                }
                self.stop(epoch, index).await?;
                Err(error)
            }
        }
    }
    async fn initialize(
        &mut self,
        epoch: &ManagedEpoch<'_>,
        index: usize,
        deadline: Instant,
    ) -> Result<(), LspError> {
        let cwd = epoch.physical_path(epoch.cwd())?;
        let uri = edits::path_to_uri(&cwd)?;
        let params = json!({"processId":std::process::id(),"rootPath":cwd,"rootUri":uri,"workspaceFolders":[{"uri":uri,"name":epoch.cwd().file_name().and_then(|s|s.to_str()).unwrap_or("workspace")}],"initializationOptions":self.clients[index].config.init_options,"capabilities":client_capabilities(),"clientInfo":{"name":"junco","version":env!("CARGO_PKG_VERSION")}});
        let result = self
            .call::<request::Initialize>(epoch, index, params, deadline)
            .await?;
        let encoding = result
            .pointer("/capabilities/positionEncoding")
            .and_then(Value::as_str)
            .unwrap_or("utf-16");
        if encoding != "utf-16" {
            return Err(transport(format!(
                "server negotiated unsupported position encoding {encoding}"
            )));
        }
        self.clients[index].capabilities =
            result.get("capabilities").cloned().unwrap_or(Value::Null);
        self.notify::<notification::Initialized>(epoch, index, json!({}))
            .await?;
        self.notify::<notification::DidChangeConfiguration>(
            epoch,
            index,
            json!({"settings":self.clients[index].config.settings}),
        )
        .await?;
        self.clients[index].ready = true;
        Ok(())
    }
    pub async fn notify<N: Notification>(
        &mut self,
        epoch: &ManagedEpoch<'_>,
        index: usize,
        params: Value,
    ) -> Result<(), LspError> {
        let params: N::Params = serde_json::from_value(params)?;
        self.send(
            epoch,
            index,
            &Outgoing {
                jsonrpc: "2.0",
                id: None,
                method: N::METHOD,
                params: serde_json::to_value(params)?,
            },
        )
        .await
    }
    pub async fn call<R: Request>(
        &mut self,
        epoch: &ManagedEpoch<'_>,
        index: usize,
        params: Value,
        deadline: Instant,
    ) -> Result<Value, LspError> {
        let params: R::Params = serde_json::from_value(params)?;
        let result = self
            .raw(
                epoch,
                index,
                R::METHOD,
                serde_json::to_value(params)?,
                deadline,
            )
            .await?;
        // Decode the associated response type, but retain extension fields and snippet flags.
        let _: R::Result = serde_json::from_value(result.clone())?;
        Ok(result)
    }
    async fn begin_request(
        &mut self,
        epoch: &ManagedEpoch<'_>,
        index: usize,
        method: &str,
        params: Value,
        deadline: Instant,
    ) -> Result<u64, LspError> {
        let id = self.clients[index].next_id;
        self.clients[index].next_id = id
            .checked_add(1)
            .ok_or_else(|| transport("LSP request id overflow"))?;
        self.clients[index].pending.insert(id);
        let previous_deadline = self.deadline;
        self.deadline = self.deadline.min(deadline);
        let sent = self
            .send(
                epoch,
                index,
                &Outgoing {
                    jsonrpc: "2.0",
                    id: Some(id),
                    method,
                    params,
                },
            )
            .await;
        self.deadline = previous_deadline;
        if let Err(error) = sent {
            self.clients[index].pending.remove(&id);
            return Err(error);
        }
        Ok(id)
    }
    pub async fn raw(
        &mut self,
        epoch: &ManagedEpoch<'_>,
        index: usize,
        method: &str,
        params: Value,
        deadline: Instant,
    ) -> Result<Value, LspError> {
        let id = self
            .begin_request(epoch, index, method, params, deadline)
            .await?;
        loop {
            if let Some(response) = self.clients[index].responses.remove(&id) {
                self.clients[index].pending.remove(&id);
                return response.map_err(|e| {
                    LspError::Tool(format!("LSP {method} failed ({}): {}", e.code, e.message))
                });
            }
            if !self.pump_until(epoch, deadline).await? {
                self.cancel_request(epoch, index, id).await?;
                return Err(LspError::Tool(format!("LSP request {method} timed out")));
            }
            if let Some(reason) = &self.poison {
                return Err(LspError::Tool(reason.clone()));
            }
        }
    }
    async fn cancel_request(
        &mut self,
        epoch: &ManagedEpoch<'_>,
        index: usize,
        id: u64,
    ) -> Result<(), LspError> {
        self.clients[index].pending.remove(&id);
        self.clients[index].responses.remove(&id);
        self.notify::<notification::Cancel>(epoch, index, json!({"id":id}))
            .await
    }
    async fn send(
        &mut self,
        epoch: &ManagedEpoch<'_>,
        index: usize,
        message: &(impl Serialize + Sync),
    ) -> Result<(), LspError> {
        let sequence = self.clients[index].enqueue(message)?;
        while self.clients[index].written < sequence {
            if !Box::pin(self.pump_until(epoch, self.deadline)).await? {
                return Err(LspError::Tool("LSP transport delivery timed out".into()));
            }
        }
        Ok(())
    }
    pub async fn pump_until(
        &mut self,
        epoch: &ManagedEpoch<'_>,
        deadline: Instant,
    ) -> Result<bool, LspError> {
        if self.clients.is_empty() {
            tokio::time::sleep_until(deadline).await;
            return Ok(false);
        }
        let event = {
            let mut reads = FuturesUnordered::new();
            for (index, client) in self.clients.iter_mut().enumerate() {
                reads.push(async move { (index, client.event(epoch).await) });
            }
            tokio::select! {event=reads.next()=>event,_=tokio::time::sleep_until(deadline)=>None}
        };
        let Some((index, event)) = event else {
            return Ok(false);
        };
        if let ClientEvent::Message(frame) = event? {
            self.handle(epoch, index, frame).await?;
        }
        Ok(true)
    }
    pub async fn pause(
        &mut self,
        epoch: &ManagedEpoch<'_>,
        duration: Duration,
        deadline: Instant,
    ) -> Result<(), LspError> {
        let until = deadline.min(Instant::now() + duration);
        while self.pump_until(epoch, until).await? {}
        Ok(())
    }
    async fn handle(
        &mut self,
        epoch: &ManagedEpoch<'_>,
        index: usize,
        frame: Value,
    ) -> Result<(), LspError> {
        let envelope: Envelope = match serde_json::from_value(frame) {
            Ok(value) => value,
            Err(_) => return Ok(()),
        };
        if let Some(method) = envelope.method {
            if let Some(id) = envelope.id {
                let result = self
                    .server_request(epoch, index, &method, envelope.params)
                    .await;
                let response = match result {
                    Ok(value) => json!({"jsonrpc":"2.0","id":id,"result":value}),
                    Err((code, message)) => {
                        json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
                    }
                };
                self.send(epoch, index, &response).await?;
            } else {
                self.notification(index, &method, envelope.params)?;
            }
        } else if let Some(id) = envelope.id {
            let client = &mut self.clients[index];
            correlate(
                id,
                envelope.result,
                envelope.error,
                &client.pending,
                &mut client.responses,
            );
        }
        Ok(())
    }
    fn notification(&mut self, index: usize, method: &str, params: Value) -> Result<(), LspError> {
        match method {
            notification::PublishDiagnostics::METHOD => {
                let params: lsp_types::PublishDiagnosticsParams = serde_json::from_value(params)?;
                self.clients[index].diagnostics.insert(
                    params.uri.as_str().into(),
                    Published {
                        diagnostics: params.diagnostics,
                        version: params.version,
                        received: Instant::now(),
                    },
                );
            }
            "$/progress" => {
                let token = params
                    .get("token")
                    .map(Value::to_string)
                    .unwrap_or_default();
                match params.pointer("/value/kind").and_then(Value::as_str) {
                    Some("begin") => {
                        self.clients[index].progress.insert(token);
                    }
                    Some("end")
                        if self.clients[index].progress.remove(&token)
                            && self.clients[index].progress.is_empty() =>
                    {
                        self.clients[index].project_loaded = true;
                    }
                    _ => {}
                }
            }
            "experimental/serverStatus" | "rust-analyzer/serverStatus"
                if params.get("quiescent").and_then(Value::as_bool) == Some(true) =>
            {
                self.clients[index].progress.clear();
                self.clients[index].project_loaded = true;
            }
            _ => {}
        }
        Ok(())
    }
    async fn server_request(
        &mut self,
        epoch: &ManagedEpoch<'_>,
        index: usize,
        method: &str,
        params: Value,
    ) -> Result<Value, (i64, String)> {
        match method {
            request::WorkspaceConfiguration::METHOD => {
                let params: lsp_types::ConfigurationParams =
                    serde_json::from_value(params).map_err(|e| (-32602, e.to_string()))?;
                Ok(Value::Array(
                    params
                        .items
                        .iter()
                        .map(|item| {
                            item.section.as_deref().map_or_else(
                                || self.clients[index].config.settings.clone(),
                                |section| {
                                    self.clients[index]
                                        .config
                                        .settings
                                        .get(section)
                                        .cloned()
                                        .unwrap_or(Value::Null)
                                },
                            )
                        })
                        .collect(),
                ))
            }
            request::WorkspaceFoldersRequest::METHOD => {
                let cwd = epoch
                    .physical_path(epoch.cwd())
                    .map_err(|e| (-32603, e.to_string()))?;
                let uri = edits::path_to_uri(&cwd).map_err(|e| (-32603, e.to_string()))?;
                Ok(
                    json!([{"uri":uri,"name":epoch.cwd().file_name().and_then(|n|n.to_str()).unwrap_or("workspace")}]),
                )
            }
            request::ApplyWorkspaceEdit::METHOD => {
                let value = params.get("edit").cloned().unwrap_or(Value::Null);
                let applied =
                    match edits::reject_workspace_edit_snippets(&value).map_err(LspError::from) {
                        Ok(()) => match serde_json::from_value::<WorkspaceEdit>(value) {
                            Ok(edit) => self.apply(epoch, &edit, true, Some(index)).await,
                            Err(e) => Err(LspError::from(e)),
                        },
                        Err(e) => Err(e),
                    };
                match applied {
                    Ok(_) => Ok(json!({"applied":true})),
                    Err(error) => {
                        let reason = error.to_string();
                        self.poison = Some(reason.clone());
                        Ok(json!({"applied":false,"failureReason":reason}))
                    }
                }
            }
            request::RegisterCapability::METHOD => {
                let params: lsp_types::RegistrationParams =
                    serde_json::from_value(params).map_err(|e| (-32602, e.to_string()))?;
                for registration in params.registrations {
                    if registration.method == request::DocumentDiagnosticRequest::METHOD {
                        self.clients[index]
                            .diagnostic_registration
                            .insert(registration.id);
                    }
                }
                Ok(Value::Null)
            }
            request::UnregisterCapability::METHOD => {
                let params: lsp_types::UnregistrationParams =
                    serde_json::from_value(params).map_err(|e| (-32602, e.to_string()))?;
                for registration in params.unregisterations {
                    self.clients[index]
                        .diagnostic_registration
                        .remove(&registration.id);
                }
                Ok(Value::Null)
            }
            request::ShowDocument::METHOD => Ok(json!({"success":false})),
            request::WorkDoneProgressCreate::METHOD
            | request::ShowMessageRequest::METHOD
            | "workspace/semanticTokens/refresh"
            | "workspace/inlayHint/refresh"
            | "workspace/codeLens/refresh"
            | "workspace/codeAction/refresh"
            | "workspace/inlineValue/refresh"
            | "workspace/foldingRange/refresh"
            | "workspace/diagnostic/refresh" => Ok(Value::Null),
            _ => Err((-32601, format!("unsupported client method {method}"))),
        }
    }
    pub fn known_versions(&self, source: Option<usize>) -> HashMap<String, i32> {
        let mut versions = HashMap::new();
        let mut ambiguous = HashSet::new();
        for client in &self.clients {
            for (uri, document) in &client.documents {
                if versions
                    .insert(uri.clone(), document.version)
                    .is_some_and(|prior| prior != document.version)
                {
                    ambiguous.insert(uri.clone());
                }
            }
        }
        versions.retain(|uri, _| !ambiguous.contains(uri));
        if let Some(client) = source.and_then(|index| self.clients.get(index)) {
            for (uri, document) in &client.documents {
                versions.insert(uri.clone(), document.version);
            }
        }
        versions
    }
    pub async fn apply(
        &mut self,
        epoch: &ManagedEpoch<'_>,
        edit: &WorkspaceEdit,
        apply: bool,
        source: Option<usize>,
    ) -> Result<EditSummary, LspError> {
        let summary =
            edits::apply_workspace_edit(epoch, edit, &self.known_versions(source), apply)?;
        if apply {
            self.fanout(epoch, &summary).await?;
        }
        Ok(summary)
    }
    pub async fn fanout(
        &mut self,
        epoch: &ManagedEpoch<'_>,
        summary: &EditSummary,
    ) -> Result<(), LspError> {
        for index in 0..self.clients.len() {
            let close: Vec<String> = self.clients[index]
                .documents
                .keys()
                .filter(|uri| {
                    let path = uri
                        .parse::<Uri>()
                        .ok()
                        .and_then(|uri| edits::uri_to_path(epoch, &uri).ok());
                    path.is_some_and(|p| {
                        summary.deleted.iter().any(|d| p.starts_with(d))
                            || summary.renamed.iter().any(|(old, _)| p.starts_with(old))
                    })
                })
                .cloned()
                .collect();
            for uri in close {
                self.notify::<notification::DidCloseTextDocument>(
                    epoch,
                    index,
                    json!({"textDocument":{"uri":uri}}),
                )
                .await?;
                self.clients[index].close_document(&uri);
            }
            for path in &summary.changed {
                let uri = edits::path_to_uri(path)?;
                if self.clients[index].documents.contains_key(uri.as_str()) {
                    self.document(epoch, index, path, false).await?;
                }
            }
            if !summary.renamed.is_empty() {
                let files=summary.renamed.iter().map(|(from,to)|Ok(json!({"oldUri":edits::path_to_uri(from)?,"newUri":edits::path_to_uri(to)?}))).collect::<Result<Vec<_>,LspError>>()?;
                self.notify::<notification::DidRenameFiles>(epoch, index, json!({"files":files}))
                    .await?;
            }
            let mut changes = Vec::new();
            for path in &summary.changed {
                changes.push(json!({"uri":edits::path_to_uri(path)?,"type":if summary.created.contains(path){1}else{2}}));
            }
            for path in &summary.deleted {
                changes.push(json!({"uri":edits::path_to_uri(path)?,"type":3}));
            }
            for (from, to) in &summary.renamed {
                changes.push(json!({"uri":edits::path_to_uri(from)?,"type":3}));
                changes.push(json!({"uri":edits::path_to_uri(to)?,"type":1}));
            }
            if !changes.is_empty() && self.clients[index].ready {
                self.notify::<notification::DidChangeWatchedFiles>(
                    epoch,
                    index,
                    json!({"changes":changes}),
                )
                .await?;
            }
        }
        Ok(())
    }
    pub async fn document(
        &mut self,
        epoch: &ManagedEpoch<'_>,
        index: usize,
        path: &Path,
        save: bool,
    ) -> Result<(String, String), LspError> {
        let physical = epoch.physical_path(path)?;
        let uri = edits::path_to_uri(&physical)?.as_str().to_owned();
        let content = epoch.read_to_string(&physical)?;
        let stale: Vec<_> = self.clients[index]
            .documents
            .iter()
            .filter(|(other, doc)| {
                *other != &uri && doc.last_use.elapsed() >= Duration::from_secs(300)
            })
            .map(|(uri, _)| uri.clone())
            .collect();
        for old in stale {
            self.notify::<notification::DidCloseTextDocument>(
                epoch,
                index,
                json!({"textDocument":{"uri":old}}),
            )
            .await?;
            self.clients[index].close_document(&old);
        }
        if let Some(document) = self.clients[index].documents.get_mut(&uri) {
            document.last_use = Instant::now();
            if document.content != content {
                document.version = document
                    .version
                    .checked_add(1)
                    .ok_or_else(|| transport("document version overflow"))?;
                document.content.clone_from(&content);
                let version = document.version;
                self.clients[index].diagnostics.remove(&uri);
                self.clients[index].pull_reports.remove(&uri);
                self.notify::<notification::DidChangeTextDocument>(epoch,index,json!({"textDocument":{"uri":uri,"version":version},"contentChanges":[{"text":content}]})).await?;
            }
        } else {
            let language = self.clients[index]
                .config
                .language_id
                .clone()
                .unwrap_or_else(|| detect_language_id(path).into());
            let closed_version = self.clients[index].closed_versions.get(&uri).copied();
            let version = closed_version
                .unwrap_or(0)
                .checked_add(1)
                .ok_or_else(|| transport("document version overflow"))?;
            self.notify::<notification::DidOpenTextDocument>(epoch,index,json!({"textDocument":{"uri":uri,"languageId":language,"version":version,"text":content}})).await?;
            let reopened = closed_version.is_some();
            self.clients[index].documents.insert(
                uri.clone(),
                Document {
                    content: content.clone(),
                    version,
                    language,
                    last_use: Instant::now(),
                    opened: Instant::now(),
                    reopened,
                },
            );
            self.clients[index].diagnostics.remove(&uri);
            self.clients[index].pull_reports.remove(&uri);
        }
        if save {
            let options = self.clients[index].capabilities.get("textDocumentSync");
            let save = options.and_then(|v| v.get("save"));
            if save.is_some_and(|v| v != &Value::Bool(false) && !v.is_null()) {
                let mut params = json!({"textDocument":{"uri":uri}});
                if save
                    .and_then(|v| v.get("includeText"))
                    .and_then(Value::as_bool)
                    == Some(true)
                {
                    params["text"] = json!(content);
                }
                self.notify::<notification::DidSaveTextDocument>(epoch, index, params)
                    .await?;
            }
        }
        Ok((uri, content))
    }
    pub async fn reconcile_all(&mut self, epoch: &ManagedEpoch<'_>) -> Result<(), LspError> {
        for index in 0..self.clients.len() {
            let uris: Vec<_> = self.clients[index].documents.keys().cloned().collect();
            for uri in uris {
                let uri = uri.parse::<Uri>().map_err(|e| transport(e.to_string()))?;
                let path = edits::uri_to_path(epoch, &uri)?;
                match epoch.metadata(&path) {
                    Ok(_) => {
                        self.document(epoch, index, &path, false).await?;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        self.notify::<notification::DidCloseTextDocument>(
                            epoch,
                            index,
                            json!({"textDocument":{"uri":uri}}),
                        )
                        .await?;
                        self.clients[index].close_document(uri.as_str());
                    }
                    Err(e) => return Err(e.into()),
                }
            }
        }
        Ok(())
    }
    pub async fn refresh_documents(
        &mut self,
        epoch: &ManagedEpoch<'_>,
        index: usize,
    ) -> Result<(), LspError> {
        let open = self.clients[index]
            .documents
            .iter()
            .map(|(uri, document)| (uri.clone(), document.language.clone(), document.version))
            .collect::<Vec<_>>();
        for (uri, language, version) in open {
            let path = edits::uri_to_path(
                epoch,
                &uri.parse::<Uri>().map_err(|e| transport(e.to_string()))?,
            )?;
            let content = epoch.read_to_string(&path)?;
            let version = version
                .checked_add(1)
                .ok_or_else(|| transport("document version overflow"))?;
            self.notify::<notification::DidCloseTextDocument>(
                epoch,
                index,
                json!({"textDocument":{"uri":uri}}),
            )
            .await?;
            self.clients[index].diagnostics.remove(&uri);
            self.clients[index].pull_reports.remove(&uri);
            self.clients[index].documents.insert(
                uri.clone(),
                Document {
                    content: content.clone(),
                    version,
                    language: language.clone(),
                    last_use: Instant::now(),
                    opened: Instant::now(),
                    reopened: true,
                },
            );
            self.notify::<notification::DidOpenTextDocument>(epoch,index,json!({"textDocument":{"uri":uri,"languageId":language,"version":version,"text":content}})).await?;
        }
        Ok(())
    }
    pub async fn project_ready(
        &mut self,
        epoch: &ManagedEpoch<'_>,
        index: usize,
        deadline: Instant,
        wait: Duration,
    ) -> Result<(), LspError> {
        let until = deadline.min(Instant::now() + wait);
        let fallback = self.clients[index].started + Duration::from_secs(15);
        while !self.clients[index].project_loaded && Instant::now() < until.min(fallback) {
            self.pump_until(epoch, until.min(fallback)).await?;
        }
        if Instant::now() >= fallback {
            self.clients[index].project_loaded = true;
        }
        if self.clients[index].is_rust() && !self.clients[index].rust_ready {
            let timing = self.clients[index].config.workspace_ready_timings.clone();
            let number = |key: &str, default: f64| {
                timing
                    .get(key)
                    .and_then(Value::as_f64)
                    .filter(|n| n.is_finite() && *n >= 0.0)
                    .unwrap_or(default)
                    .min(300000.0)
            };
            let start = Instant::now();
            let until =
                deadline.min(start + Duration::from_secs_f64(number("timeoutMs", 5000.0) / 1000.0));
            while Instant::now() < until {
                let status_deadline = until.min(
                    Instant::now()
                        + Duration::from_secs_f64(
                            number("statusRequestTimeoutMs", 1000.0) / 1000.0,
                        ),
                );
                let status = self
                    .raw(
                        epoch,
                        index,
                        "rust-analyzer/analyzerStatus",
                        json!({}),
                        status_deadline,
                    )
                    .await;
                match status {
                    Ok(status) => {
                        if status
                            .as_str()
                            .is_some_and(|s| !s.starts_with("No workspaces"))
                            && start.elapsed()
                                >= Duration::from_secs_f64(number("settleMs", 2000.0) / 1000.0)
                        {
                            self.clients[index].rust_ready = true;
                            break;
                        }
                    }
                    Err(LspError::Tool(_)) => {}
                    Err(e) => return Err(e),
                }
                self.pause(
                    epoch,
                    Duration::from_secs_f64(number("pollMs", 100.0) / 1000.0),
                    until,
                )
                .await?;
            }
        }
        Ok(())
    }
    pub async fn diagnostics(
        &mut self,
        epoch: &ManagedEpoch<'_>,
        index: usize,
        path: &Path,
        deadline: Instant,
        wait: Duration,
    ) -> Result<Vec<Diagnostic>, LspError> {
        let (uri, _) = self.document(epoch, index, path, true).await?;
        if self.clients[index].config.project_aware() {
            self.project_ready(epoch, index, deadline, wait).await?;
        }
        let version = self.clients[index].documents[&uri].version;
        let until = deadline.min(Instant::now() + wait);
        let mut diagnostics = None;
        let mut pull = None;
        if self.clients[index].supports_diagnostics() {
            let previous = self.clients[index]
                .pull_reports
                .get(&uri)
                .filter(|report| report.version == version)
                .and_then(|report| report.result_id.clone());
            let mut params = json!({"textDocument":{"uri":uri}});
            if let Some(previous) = previous {
                params["previousResultId"] = json!(previous);
            }
            let params: <request::DocumentDiagnosticRequest as Request>::Params =
                serde_json::from_value(params)?;
            pull = Some(
                self.begin_request(
                    epoch,
                    index,
                    request::DocumentDiagnosticRequest::METHOD,
                    serde_json::to_value(params)?,
                    until,
                )
                .await?,
            );
        }
        loop {
            if self.clients[index]
                .documents
                .get(&uri)
                .is_none_or(|document| document.version != version)
            {
                return Err(LspError::Tool(
                    "document changed while diagnostics were pending".into(),
                ));
            }
            if let Some(published) = self.clients[index].current_diagnostics(&uri) {
                diagnostics
                    .get_or_insert_with(Vec::new)
                    .extend_from_slice(published);
                if let Some(id) = pull.take() {
                    self.cancel_request(epoch, index, id).await?;
                }
                break;
            }
            if let Some(id) = pull
                && let Some(response) = self.clients[index].responses.remove(&id)
            {
                pull = None;
                self.clients[index].pending.remove(&id);
                match response {
                    Ok(report) => {
                        let _: <request::DocumentDiagnosticRequest as Request>::Result =
                            serde_json::from_value(report.clone())?;
                        if report.get("kind").and_then(Value::as_str) == Some("full") {
                            let items: Vec<Diagnostic> = serde_json::from_value(
                                report.get("items").cloned().unwrap_or_else(|| json!([])),
                            )?;
                            self.clients[index].pull_reports.insert(
                                uri.clone(),
                                PullReport {
                                    version,
                                    result_id: report
                                        .get("resultId")
                                        .and_then(Value::as_str)
                                        .map(str::to_owned),
                                    diagnostics: items.clone(),
                                },
                            );
                            diagnostics = Some(items);
                        } else if let Some(report) = self.clients[index]
                            .pull_reports
                            .get(&uri)
                            .filter(|report| report.version == version)
                        {
                            diagnostics = Some(report.diagnostics.clone());
                        } else {
                            return Err(LspError::Tool(
                                "unchanged diagnostic report without a previous result".to_owned(),
                            ));
                        }
                    }
                    Err(error) => {
                        return Err(LspError::Tool(format!(
                            "LSP diagnostic pull failed ({}): {}",
                            error.code, error.message,
                        )));
                    }
                }
                continue;
            }
            if diagnostics.is_some() {
                break;
            }
            if Instant::now() >= until {
                if let Some(id) = pull.take() {
                    self.cancel_request(epoch, index, id).await?;
                }
                return Err(LspError::Tool(format!(
                    "{} has not reported current diagnostics",
                    self.clients[index].config.name,
                )));
            }
            self.pump_until(epoch, until.min(Instant::now() + Duration::from_millis(25)))
                .await?;
            if let Some(reason) = &self.poison {
                return Err(LspError::Tool(reason.clone()));
            }
        }
        let mut diagnostics = diagnostics.unwrap_or_default();
        sort_diagnostics(&mut diagnostics);
        Ok(diagnostics)
    }
}

pub(crate) fn sort_diagnostics(diagnostics: &mut Vec<Diagnostic>) {
    diagnostics.sort_by(|a, b| {
        (
            a.range.start.line,
            a.range.start.character,
            a.range.end.line,
            a.range.end.character,
            &a.message,
        )
            .cmp(&(
                b.range.start.line,
                b.range.start.character,
                b.range.end.line,
                b.range.end.character,
                &b.message,
            ))
    });
    diagnostics.dedup_by(|a, b| a.range == b.range && a.message == b.message);
}

pub(crate) fn map_value(epoch: &ManagedEpoch<'_>, value: &mut Value, physical: bool) {
    match value {
        Value::String(text) => *text = map_string(epoch, text, physical),
        Value::Array(values) => {
            for value in values {
                map_value(epoch, value, physical)
            }
        }
        Value::Object(values) => {
            let old = std::mem::take(values);
            for (key, mut value) in old {
                map_value(epoch, &mut value, physical);
                values.insert(map_string(epoch, &key, physical), value);
            }
        }
        _ => {}
    }
}
pub(crate) fn map_string(epoch: &ManagedEpoch<'_>, text: &str, physical: bool) -> String {
    let map = |path: &Path| {
        if physical {
            epoch.physical_path(path)
        } else {
            epoch.logical_path(path)
        }
    };
    if let Ok(url) = url::Url::parse(text)
        && url.scheme() == "file"
        && let Ok(path) = url.to_file_path()
        && let Ok(mapped) = map(&path)
        && let Ok(uri) = url::Url::from_file_path(mapped)
    {
        return uri.to_string();
    }
    let mut mapped_path = None;
    if Path::new(text).is_absolute()
        && !text.contains('\n')
        && let Ok(mapped) = map(Path::new(text))
        && mapped != Path::new(text)
    {
        mapped_path = Some(mapped.to_string_lossy().into_owned());
    }
    // Keep an intact path's spaces, then translate any later paths in readable text too.
    let text = mapped_path.as_deref().unwrap_or(text);
    if let Some((flag, value)) = text.split_once('=')
        && flag.starts_with('-')
    {
        let mapped = map_string(epoch, value, physical);
        if mapped != value {
            return format!("{flag}={mapped}");
        }
    }
    // Component-bounded tokens also translate paths embedded in readable diagnostics.
    let mut result = String::with_capacity(text.len());
    let mut start = 0;
    for (offset, ch) in text.char_indices() {
        if ch.is_whitespace() || matches!(ch, '"' | '\'' | '(' | ')' | '[' | ']' | '{' | '}' | ',')
        {
            if start < offset {
                result.push_str(&map_token(epoch, &text[start..offset], physical));
            }
            result.push(ch);
            start = offset + ch.len_utf8();
        }
    }
    if start < text.len() {
        result.push_str(&map_token(epoch, &text[start..], physical));
    }
    if result.contains('/')
        && epoch
            .cwd()
            .to_string_lossy()
            .chars()
            .any(char::is_whitespace)
    {
        map_spaced_roots(epoch, result, physical)
    } else {
        result
    }
}

fn map_spaced_roots(epoch: &ManagedEpoch<'_>, mut text: String, physical: bool) -> String {
    // Token boundaries cannot split a workspace prefix containing spaces. Derive the highest
    // translated ancestor through the authoritative component-based identity conversion.
    let mut roots = None;
    for logical in epoch.cwd().ancestors() {
        let Ok(mapped) = epoch.physical_path(logical) else {
            return text;
        };
        if mapped == logical {
            break;
        }
        roots = Some((logical, mapped));
    }
    let Some((logical, work)) = roots else {
        return text;
    };
    let logical = logical.to_string_lossy();
    let work = work.to_string_lossy();
    let (from, to) = if physical {
        (logical.as_ref(), work.as_ref())
    } else {
        (work.as_ref(), logical.as_ref())
    };
    let from = from.trim_end_matches('/');
    let to = to.trim_end_matches('/');
    if from.is_empty() {
        return text;
    }
    let mut cursor = 0;
    while let Some(offset) = text[cursor..].find(from) {
        let start = cursor + offset;
        let end = start + from.len();
        let before = text[..start].chars().next_back();
        let after = text[end..].chars().next();
        let begins = before.is_none_or(|c| {
            c.is_whitespace() || matches!(c, '=' | ':' | '"' | '\'' | '(' | '[' | '{' | '`')
        });
        let ends = after
            .is_none_or(|c| matches!(c, '/' | '\n' | '\r' | '"' | '\'' | ')' | ']' | '}' | '`'));
        if begins && ends {
            text.replace_range(start..end, to);
            cursor = start + to.len();
        } else {
            cursor = end;
        }
    }
    text
}
fn map_token(epoch: &ManagedEpoch<'_>, token: &str, physical: bool) -> String {
    if let Some((label, value)) = token.split_once('=')
        && (value.starts_with('/') || value.starts_with("file://"))
    {
        let mapped = map_token(epoch, value, physical);
        if mapped != value {
            return format!("{label}={mapped}");
        }
    }
    if token.starts_with("file://")
        && let Ok(url) = url::Url::parse(token)
        && let Ok(path) = url.to_file_path()
    {
        let mapped = if physical {
            epoch.physical_path(&path)
        } else {
            epoch.logical_path(&path)
        };
        if let Ok(mapped) = mapped
            && let Ok(url) = url::Url::from_file_path(mapped)
        {
            return url.into();
        }
    }
    if token.starts_with('/') {
        let split = token.find(':').unwrap_or(token.len());
        let (path, suffix) = token.split_at(split);
        let mapped = if physical {
            epoch.physical_path(Path::new(path))
        } else {
            epoch.logical_path(Path::new(path))
        };
        if let Ok(mapped) = mapped {
            return format!("{}{suffix}", mapped.display());
        }
    }
    token.into()
}
pub(crate) fn map_error(epoch: &ManagedEpoch<'_>, error: LspError) -> LspError {
    match error {
        LspError::Semantic(mut result) => {
            result.text = map_string(epoch, &result.text, false);
            LspError::Semantic(result)
        }
        LspError::Tool(text) => LspError::Tool(map_string(epoch, &text, false)),
        LspError::Transport(text) => LspError::Transport(map_string(epoch, &text, false)),
        error => error,
    }
}
fn client_capabilities() -> Value {
    json!({"general":{"positionEncodings":["utf-16"]},"textDocument":{"synchronization":{"didSave":true,"dynamicRegistration":false,"willSave":false,"willSaveWaitUntil":false},"hover":{"contentFormat":["markdown","plaintext"],"dynamicRegistration":false},"definition":{"dynamicRegistration":false,"linkSupport":true},"typeDefinition":{"dynamicRegistration":false,"linkSupport":true},"implementation":{"dynamicRegistration":false,"linkSupport":true},"references":{"dynamicRegistration":false},"documentSymbol":{"dynamicRegistration":false,"hierarchicalDocumentSymbolSupport":true,"symbolKind":{"valueSet":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26]}},"rename":{"dynamicRegistration":false,"prepareSupport":true},"codeAction":{"dynamicRegistration":false,"codeActionLiteralSupport":{"codeActionKind":{"valueSet":["quickfix","refactor","refactor.extract","refactor.inline","refactor.rewrite","source","source.organizeImports","source.fixAll"]}},"resolveSupport":{"properties":["edit"]}},"formatting":{"dynamicRegistration":false},"rangeFormatting":{"dynamicRegistration":false},"publishDiagnostics":{"relatedInformation":true,"versionSupport":true,"tagSupport":{"valueSet":[1,2]},"codeDescriptionSupport":true,"dataSupport":true},"diagnostic":{"dynamicRegistration":true}},"window":{"workDoneProgress":true},"workspace":{"applyEdit":true,"workspaceEdit":{"documentChanges":true,"resourceOperations":["create","rename","delete"],"failureHandling":"abort"},"configuration":true,"workspaceFolders":true,"symbol":{"dynamicRegistration":false,"symbolKind":{"valueSet":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26]}},"fileOperations":{"dynamicRegistration":false,"willCreate":false,"didCreate":false,"willRename":true,"didRename":true,"willDelete":false,"didDelete":false}}})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frames_survive_chunking_junk_and_bad_json() {
        let mut frame = Framer::default();
        for byte in b"banner\nContent-Length: 1\r\n\r\n!Content-Length: 7\r\n\r\n{\"x\":1}" {
            frame.push(&[*byte]);
            if let Some(value) = frame.next().unwrap() {
                assert_eq!(value, json!({"x":1}));
            }
        }
        assert!(frame.next().unwrap().is_none());
    }
    #[test]
    fn invalid_lengths_fail_closed() {
        for header in [
            "Content-Length: 1\r\nContent-Length: 1\r\n\r\n",
            "Content-Length: -1\r\n\r\n",
            "Content-Length: 999999999999999999999999999\r\n\r\n",
            "Content-Length: 268435457\r\n\r\n",
        ] {
            let mut frame = Framer::default();
            frame.push(header.as_bytes());
            assert!(frame.next().is_err());
        }
    }
    #[test]
    fn retains_multiple_frames() {
        let mut frame = Framer::default();
        frame.push(b"Content-Length: 4\r\n\r\nnullContent-Length: 1\r\n\r\n0");
        assert_eq!(frame.next().unwrap(), Some(Value::Null));
        assert_eq!(frame.next().unwrap(), Some(json!(0)));
    }
    #[test]
    fn correlates_only_pending_numeric_ids_once() {
        let pending = HashSet::from([1, 2]);
        let mut responses = HashMap::new();
        correlate(json!(3), json!("unknown"), None, &pending, &mut responses);
        correlate(json!("1"), json!("string"), None, &pending, &mut responses);
        correlate(json!(2), json!("second"), None, &pending, &mut responses);
        correlate(json!(2), json!("duplicate"), None, &pending, &mut responses);
        correlate(
            json!(1),
            Value::Null,
            Some(RpcError {
                code: -1,
                message: "failed".into(),
            }),
            &pending,
            &mut responses,
        );
        assert_eq!(responses.len(), 2);
        assert_eq!(responses.remove(&2).unwrap().unwrap(), json!("second"));
        assert_eq!(responses.remove(&1).unwrap().unwrap_err().code, -1);
    }
    #[test]
    fn resynchronizes_without_banner_newline() {
        let mut frame = Framer::default();
        frame.push(b"stdout junk:!Content-Length: 4\r\n\r\nnull");
        assert_eq!(frame.next().unwrap(), Some(Value::Null));
    }
    #[test]
    fn enforces_header_limit() {
        let mut frame = Framer::default();
        frame.push(b"Content-Length: 4\r\nExtra: ");
        frame.push(&vec![b'x'; HEADER_LIMIT]);
        assert!(frame.next().is_err());
    }
}

#[cfg(test)]
#[path = "client_regressions.rs"]
mod regressions;
