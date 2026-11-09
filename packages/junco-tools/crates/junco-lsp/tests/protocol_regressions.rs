//! Regression coverage at the Rust consumer boundary, using real traced Node servers.
use junco_lsp::{LspAction, LspError, LspInput, LspOptions, LspResult, LspTool};
use marsh_core::{
    ManagedCancellation, ShellEnvironment, ShellVariable, test_support::shell_builder,
};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

static ACTIVE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

struct Fixture {
    root: tempfile::TempDir,
    seed: PathBuf,
    fs: Arc<marsh_btrfs::fake::CopyTree>,
}
impl Fixture {
    fn new(control: Value) -> Self {
        let root = tempfile::tempdir().unwrap();
        let seed = root.path().join("seed");
        std::fs::create_dir_all(seed.join(".omp")).unwrap();
        for directory in ["home", "tmp"] {
            std::fs::create_dir(root.path().join(directory)).unwrap();
        }
        std::fs::write(seed.join("a.fixture"), "const add = 1;\nadd;\n").unwrap();
        std::fs::write(seed.join("b.fixture"), "add;\n").unwrap();
        std::fs::write(seed.join("control.json"), control.to_string()).unwrap();
        let fs = Arc::new(marsh_btrfs::fake::CopyTree::new());
        fs.register(&seed);
        let fixture = Self { root, seed, fs };
        fixture.config(json!({"fixture": fixture.server()}));
        fixture
    }
    fn server(&self) -> Value {
        let script = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/lsp-fixture.mjs")
            .canonicalize()
            .unwrap();
        json!({
            "command":"node", "args":[script,"stdio-server","--control=control.json"],
            "fileTypes":["fixture"], "rootMarkers":["."], "warmupTimeoutMs":15000
        })
    }
    fn config(&self, servers: Value) {
        // Language-marker fixtures must not select unrelated caller-installed default servers.
        let defaults: Value = serde_json::from_str(include_str!("../src/defaults.json")).unwrap();
        let mut isolated = serde_json::Map::new();
        for name in defaults.as_object().unwrap().keys() {
            isolated.insert(name.clone(), json!({"disabled":true}));
        }
        isolated.extend(
            servers
                .as_object()
                .unwrap()
                .iter()
                .map(|(name, value)| (name.clone(), value.clone())),
        );
        std::fs::write(
            self.seed.join(".omp/lsp.json"),
            json!({"servers":isolated}).to_string(),
        )
        .unwrap();
    }
    async fn tool(&self) -> LspTool {
        let mut environment = ShellEnvironment::new();
        for (key, value) in [
            ("PATH", std::env::var("PATH").unwrap()),
            (
                "HOME",
                self.root.path().join("home").to_string_lossy().into_owned(),
            ),
            (
                "TMPDIR",
                self.root.path().join("tmp").to_string_lossy().into_owned(),
            ),
        ] {
            let mut variable = ShellVariable::new(value);
            variable.export();
            environment.set_global(key.to_owned(), variable).unwrap();
        }
        let session = shell_builder(self.fs.clone())
            .working_dir(self.seed.clone())
            .environment(environment)
            .build_managed_session()
            .await
            .unwrap();
        LspTool::from_session(
            session,
            LspOptions {
                trusted_workspace: true,
                ..Default::default()
            },
        )
    }
}
fn input(action: LspAction) -> LspInput {
    LspInput {
        action,
        file: Some("a.fixture".into()),
        line: None,
        symbol: None,
        query: None,
        new_name: None,
        apply: None,
        timeout: Some(5.0),
        payload: None,
    }
}
async fn execute(tool: &LspTool, input: LspInput) -> Result<LspResult, LspError> {
    tool.execute(input, &ManagedCancellation::default()).await
}
async fn request(tool: &LspTool, method: &str, payload: Value) -> Value {
    let mut call = input(LspAction::Request);
    call.file = None;
    call.query = Some(method.into());
    call.payload = Some(payload.to_string());
    serde_json::from_str(&execute(tool, call).await.unwrap().text).unwrap()
}
fn diagnostic(end: u32) -> Value {
    json!({"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":end}},"message":"same message","severity":1})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn documents_infer_lsp_languages_and_explicit_configuration_still_wins() {
    let _active = ACTIVE.acquire().await.unwrap();
    let fixture = Fixture::new(json!({}));
    let cases = [
        ("a.rs", "rust"),
        ("a.TSX", "typescriptreact"),
        ("a.py", "python"),
        ("Dockerfile.dev", "dockerfile"),
        ("Makefile", "makefile"),
        ("CMakeLists.txt", "cmake"),
        ("a.unknown", "plaintext"),
    ];
    let mut server = fixture.server();
    server["fileTypes"] = json!([
        "rs",
        "tsx",
        "py",
        "Dockerfile.dev",
        "Makefile",
        "CMakeLists.txt",
        "unknown"
    ]);
    fixture.config(json!({"fixture":server}));
    for (file, _) in cases {
        std::fs::write(fixture.seed.join(file), "const add = 1;\n").unwrap();
    }
    let tool = fixture.tool().await;
    for (file, _) in cases {
        let mut hover = input(LspAction::Hover);
        hover.file = Some(file.into());
        execute(&tool, hover).await.unwrap();
    }
    let state = request(&tool, "fixture/state", json!({})).await;
    for (file, language) in cases {
        let document = state["documents"]
            .as_array()
            .unwrap()
            .iter()
            .find(|document| document["uri"].as_str().unwrap().ends_with(file))
            .unwrap();
        assert_eq!(document["languageId"], language, "{file}");
    }
    tool.close().await.unwrap();
    let mut server = fixture.server();
    server["fileTypes"] = json!(["rs"]);
    server["languageId"] = json!("explicit-language");
    fixture.config(json!({"fixture":server}));
    let tool = fixture.tool().await;
    let mut hover = input(LspAction::Hover);
    hover.file = Some("a.rs".into());
    execute(&tool, hover).await.unwrap();
    let state = request(&tool, "fixture/state", json!({})).await;
    assert_eq!(state["documents"][0]["languageId"], "explicit-language");
    tool.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn authoritative_push_finishes_and_cancels_an_outstanding_pull() {
    let _active = ACTIVE.acquire().await.unwrap();
    let fixture = Fixture::new(json!({
        "gates":{"textDocument/diagnostic":"never-created-gate"},
        "diagnostics":[diagnostic(1)]
    }));
    let tool = fixture.tool().await;
    let result = execute(&tool, input(LspAction::Diagnostics)).await.unwrap();
    assert!(result.details.success);
    assert!(
        result.text.starts_with("1 diagnostics (1 errors)"),
        "{}",
        result.text
    );
    let state = request(&tool, "fixture/state", json!({})).await;
    let pull = state["requests"]
        .as_array()
        .unwrap()
        .iter()
        .find(|request| request["method"] == "textDocument/diagnostic")
        .unwrap();
    assert!(
        state["notifications"]
            .as_array()
            .unwrap()
            .iter()
            .any(|notification| notification["method"] == "$/cancelRequest"
                && notification["params"]["id"] == pull["id"])
    );
    tool.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failed_pull_without_authoritative_push_is_not_a_clean_result() {
    let _active = ACTIVE.acquire().await.unwrap();
    let fixture = Fixture::new(json!({"mode":"no-push,pull-fail"}));
    let tool = fixture.tool().await;
    assert!(execute(&tool, input(LspAction::Diagnostics)).await.is_err());
    tool.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn initialization_cache_uses_the_configured_budget_not_a_five_second_cutoff() {
    let _active = ACTIVE.acquire().await.unwrap();
    for (call_seconds, warmup_ms) in [(10.0, 15000), (20.0, 1000)] {
        let fixture = Fixture::new(json!({"mode":"init-fail"}));
        let events = fixture.root.path().join("events.jsonl");
        let mut server = fixture.server();
        server["warmupTimeoutMs"] = json!(warmup_ms);
        server["args"]
            .as_array_mut()
            .unwrap()
            .push(json!(format!("--events={}", events.display())));
        fixture.config(json!({"fixture":server}));
        let tool = fixture.tool().await;
        let mut hover = input(LspAction::Hover);
        hover.timeout = Some(call_seconds);
        assert!(execute(&tool, hover.clone()).await.is_err());
        assert!(execute(&tool, hover).await.is_err());
        let attempts = std::fs::read_to_string(events)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|event| event["method"] == "initialize" && event["phase"] == "dispatch")
            .count();
        assert_eq!(attempts, 2, "warmup={warmup_ms}, call={call_seconds}");
        tool.close().await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cross_server_diagnostics_deduplicate_the_full_range_before_counting() {
    let _active = ACTIVE.acquire().await.unwrap();
    let fixture = Fixture::new(json!({}));
    let mut first = fixture.server();
    first["args"].as_array_mut().unwrap().push(json!(format!(
        "--options={}",
        json!({"diagnostics":[diagnostic(1),diagnostic(2)]})
    )));
    let mut second = fixture.server();
    second["args"].as_array_mut().unwrap().push(json!(format!(
        "--options={}",
        json!({"diagnostics":[diagnostic(1)]})
    )));
    fixture.config(json!({"first":first,"second":second}));
    let tool = fixture.tool().await;
    let result = execute(&tool, input(LspAction::Diagnostics)).await.unwrap();
    assert!(
        result.text.starts_with("2 diagnostics (2 errors)"),
        "{}",
        result.text
    );
    assert_eq!(result.text.matches(":1:1 error: same message").count(), 2);
    tool.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn readable_output_maps_every_path_without_splitting_structured_paths() {
    let _active = ACTIVE.acquire().await.unwrap();
    let mut fixture = Fixture::new(json!({"responses":{
        "textDocument/hover":{"contents":{"kind":"plaintext","value":"${cwd}/a.fixture depends on ${cwd}/b.fixture"}},
        "fixture/paths":{
            "path":"${cwd}/space dir/a.fixture", "uri":"${file:space dir/a.fixture}",
            "flag":"--root=${cwd}/space dir/a.fixture", "label":"cwd=${cwd}/a.fixture"
        }
    }}));
    let spaced = fixture.root.path().join("seed with spaces");
    std::fs::rename(&fixture.seed, &spaced).unwrap();
    fixture.fs.register(&spaced);
    fixture.seed = spaced;
    let tool = fixture.tool().await;
    let result = execute(&tool, input(LspAction::Hover)).await.unwrap();
    assert_eq!(
        result.text,
        format!(
            "{}/a.fixture depends on {}/b.fixture",
            fixture.seed.display(),
            fixture.seed.display()
        )
    );
    let paths = request(&tool, "fixture/paths", json!({})).await;
    let path = fixture.seed.join("space dir/a.fixture");
    assert_eq!(paths["path"], path.to_string_lossy().as_ref());
    assert_eq!(
        paths["uri"],
        url::Url::from_file_path(&path).unwrap().as_str()
    );
    assert_eq!(paths["flag"], format!("--root={}", path.display()));
    assert_eq!(
        paths["label"],
        format!("cwd={}/a.fixture", fixture.seed.display())
    );
    let sibling = format!("{}ory/a.fixture", fixture.seed.display());
    let echoed = request(&tool, "fixture/echo", json!({"path":sibling})).await;
    assert_eq!(echoed["path"], sibling);
    tool.close().await.unwrap();
}

struct FifoGuard {
    path: PathBuf,
    done: Option<std::sync::mpsc::Sender<()>>,
    thread: Option<std::thread::JoinHandle<bool>>,
}
impl FifoGuard {
    fn new(root: &Path) -> Self {
        let path = root.join("blocked.fixture");
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&path)
                .status()
                .unwrap()
                .success()
        );
        let (done, completed) = std::sync::mpsc::channel();
        let unblock = path.clone();
        let thread = std::thread::spawn(move || {
            if completed.recv_timeout(Duration::from_secs(8)).is_ok() {
                return false;
            }
            // O_RDWR opens a FIFO without another reader; dropping it supplies EOF to a regressed read.
            let mut writer = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(unblock)
                .unwrap();
            std::io::Write::write_all(&mut writer, b"unblocked regression\n").unwrap();
            true
        });
        Self {
            path,
            done: Some(done),
            thread: Some(thread),
        }
    }
    fn assert_unused(mut self) {
        let _ = self.done.take().unwrap().send(());
        assert!(
            !self.thread.take().unwrap().join().unwrap(),
            "a special-file read waited for the harness writer"
        );
    }
}
impl Drop for FifoGuard {
    fn drop(&mut self) {
        if let Some(done) = self.done.take() {
            let _ = done.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn special_files_cannot_block_configuration_documents_context_or_workspace_edits() {
    let _active = ACTIVE.acquire().await.unwrap();
    for site in ["config", "preflight", "document", "context", "edit"] {
        let fixture = Fixture::new(json!({}));
        let guard = FifoGuard::new(fixture.root.path());
        let uri = url::Url::from_file_path(&guard.path).unwrap().to_string();
        if site == "config" {
            std::os::unix::fs::symlink(&guard.path, fixture.seed.join("lsp.json")).unwrap();
        }
        if site == "context" {
            std::fs::write(fixture.seed.join("control.json"), json!({"responses":{
                "textDocument/definition":{"uri":uri,"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}}}
            }}).to_string()).unwrap();
        }
        let tool = fixture.tool().await;
        let result = match site {
            "config" => execute(&tool, input(LspAction::Status)).await.map(|_| ()),
            "preflight" | "document" => {
                let mut call = input(if site == "preflight" {
                    LspAction::Hover
                } else {
                    LspAction::Request
                });
                call.file = Some(guard.path.to_string_lossy().into_owned());
                call.query = Some("fixture/echo".into());
                execute(&tool, call).await.map(|_| ())
            }
            "context" => execute(&tool, input(LspAction::Definition))
                .await
                .map(|_| ()),
            "edit" => {
                let mut call = input(LspAction::Request);
                call.query = Some("fixture/applyEdit".into());
                call.payload = Some(json!({"edit":{"changes":{
                    (uri):[{"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":0}},"newText":"X"}]
                }}}).to_string());
                execute(&tool, call).await.map(|_| ())
            }
            _ => unreachable!(),
        };
        guard.assert_unused();
        if matches!(site, "preflight" | "document" | "edit") {
            assert!(result.is_err(), "{site}");
        } else {
            assert!(result.is_ok(), "{site}: {result:?}");
        }
        tool.close().await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn initial_empty_pushes_wait_for_analysis_but_quiet_ready_clean_reports_succeed() {
    let _active = ACTIVE.acquire().await.unwrap();
    for (mode, source, expected) in [
        (
            "initial-empty,no-pull",
            "// ERROR real diagnostic\n",
            "1 diagnostics (1 errors)",
        ),
        (
            "empty,no-pull",
            "const clean = 1;\n",
            "0 diagnostics (0 errors)",
        ),
    ] {
        let fixture = Fixture::new(json!({"mode":mode,"diagnosticDelayMs":40}));
        std::fs::write(fixture.seed.join("a.fixture"), source).unwrap();
        let tool = fixture.tool().await;
        let result = execute(&tool, input(LspAction::Diagnostics)).await.unwrap();
        assert!(result.text.starts_with(expected), "{mode}: {}", result.text);
        tool.close().await.unwrap();
    }
}
