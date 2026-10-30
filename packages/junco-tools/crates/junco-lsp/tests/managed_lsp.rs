//! Consumer-visible LSP behavior through real native subprocesses and CopyTree transactions.
use junco_lsp::{LspAction, LspError, LspInput, LspOptions, LspResult, LspTool};
use marsh_core::{
    Action, Event, ManagedCancellation, PolicyDecision, PolicyObserver, Principal, Shell,
    ShellEnvironment, ShellErrorKind, ShellVariable, test_support::shell_builder,
};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

const A: &str = "const add = 1;\nadd;\n";
const B: &str = "add;\n";
// Bound real ptrace/Node cold starts; protocol deadlines are not host-load benchmarks.
static ACTIVE_SCENARIOS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(3);

struct Fixture {
    root: tempfile::TempDir,
    seed: PathBuf,
    fs: Arc<marsh_btrfs::fake::CopyTree>,
    seen: Arc<Mutex<Vec<(Event, bool)>>>,
}
impl Fixture {
    fn new(control: Value) -> Self {
        let root = tempfile::tempdir().unwrap();
        let seed = root.path().join("seed");
        std::fs::create_dir_all(seed.join(".omp")).unwrap();
        std::fs::create_dir_all(root.path().join("home")).unwrap();
        std::fs::create_dir_all(root.path().join("tmp")).unwrap();
        std::fs::write(seed.join("a.fixture"), A).unwrap();
        std::fs::write(seed.join("b.fixture"), B).unwrap();
        std::fs::write(
            seed.join("control.json"),
            serde_json::to_vec(&control).unwrap(),
        )
        .unwrap();
        let script = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/lsp-fixture.mjs")
            .canonicalize()
            .unwrap();
        let config = json!({"servers":{"fixture":{
            "command":"node", "args":[script,"stdio-server","--control=control.json"],
            "fileTypes":["fixture"], "rootMarkers":["."], "languageId":"fixture",
            "warmupTimeoutMs":15000
        }}});
        std::fs::write(
            seed.join(".omp/lsp.json"),
            serde_json::to_vec(&config).unwrap(),
        )
        .unwrap();
        let fs = Arc::new(marsh_btrfs::fake::CopyTree::new());
        fs.register(&seed);
        Self {
            root,
            seed,
            fs,
            seen: Arc::default(),
        }
    }
    fn environment(&self) -> ShellEnvironment {
        let mut environment = ShellEnvironment::new();
        for (name, value) in [
            ("PATH", std::env::var("PATH").unwrap()),
            (
                "HOME",
                self.root.path().join("home").to_string_lossy().into_owned(),
            ),
            (
                "TMPDIR",
                self.root.path().join("tmp").to_string_lossy().into_owned(),
            ),
            ("LANG", "C.UTF-8".to_owned()),
        ] {
            let mut variable = ShellVariable::new(value);
            variable.export();
            environment.set_global(name.to_owned(), variable).unwrap();
        }
        environment
    }
    fn event_log(&self) -> PathBuf {
        let path = self.root.path().join("protocol-events.jsonl");
        let config_path = self.seed.join(".omp/lsp.json");
        let mut config: Value =
            serde_json::from_slice(&std::fs::read(&config_path).unwrap()).unwrap();
        config["servers"]["fixture"]["args"]
            .as_array_mut()
            .unwrap()
            .push(Value::String(format!("--events={}", path.display())));
        std::fs::write(config_path, serde_json::to_vec(&config).unwrap()).unwrap();
        path
    }
    async fn tool(&self, read_only: bool) -> LspTool {
        self.tool_with_environment(read_only, self.environment())
            .await
    }
    async fn tool_with_environment(
        &self,
        read_only: bool,
        environment: ShellEnvironment,
    ) -> LspTool {
        let seen = Arc::clone(&self.seen);
        let observer = PolicyObserver::new(move |event, decision| {
            seen.lock()
                .unwrap()
                .push((event.clone(), matches!(decision, PolicyDecision::Grant)));
        });
        let session = shell_builder(self.fs.clone())
            .working_dir(self.seed.clone())
            .environment(environment)
            .policy_owner(Some(Principal::from("rust-lsp-owner".to_owned())))
            .policy_observer(Some(Arc::new(observer)))
            .build_managed_session()
            .await
            .unwrap();
        LspTool::from_session(session, LspOptions { read_only })
    }
    async fn lock_b(&self) -> Shell {
        let shell = shell_builder(self.fs.clone())
            .working_dir(self.seed.clone())
            .environment(self.environment())
            .sandbox_policy(marsh_core::SandboxPolicy::allow())
            .policy_owner(Some(Principal::from("fixture-owner-a".to_owned())))
            .build()
            .await
            .unwrap();
        assert_eq!(
            u8::from(
                shell
                    .run("cat b.fixture >/dev/null; printf 'add;\\n' > b.fixture")
                    .await
                    .unwrap()
                    .exit_code
            ),
            0
        );
        shell
    }
    fn source(&self, path: &str) -> String {
        std::fs::read_to_string(self.seed.join(path)).unwrap()
    }
}

fn input(action: LspAction) -> LspInput {
    LspInput {
        action,
        file: Some("a.fixture".to_owned()),
        line: None,
        symbol: None,
        query: None,
        new_name: None,
        apply: None,
        timeout: None,
        payload: None,
    }
}
async fn execute(tool: &LspTool, input: LspInput) -> Result<LspResult, LspError> {
    let _active = ACTIVE_SCENARIOS.acquire().await.unwrap();
    tool.execute(input, &ManagedCancellation::default()).await
}
async fn state(tool: &LspTool) -> Value {
    let mut request = input(LspAction::Request);
    request.query = Some("fixture/state".into());
    let result = execute(tool, request).await.unwrap();
    for (offset, _) in result.text.match_indices('{') {
        if let Some(Ok(value)) = serde_json::Deserializer::from_str(&result.text[offset..])
            .into_iter::<Value>()
            .next()
            && value.get("pid").is_some()
        {
            return value;
        }
    }
    panic!(
        "state response contained no protocol state: {}",
        result.text
    );
}
fn pid(state: &Value) -> u64 {
    state["pid"].as_u64().unwrap()
}
fn counter(state: &Value) -> u64 {
    state["counter"].as_u64().unwrap()
}
fn dead(pid: u64) -> bool {
    !Path::new(&format!("/proc/{pid}")).exists()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn query_matrix_and_cached_reads_keep_a_native_server_warm() {
    let fixture = Fixture::new(json!({}));
    let tool = fixture.tool(false).await;
    let first = execute(&tool, input(LspAction::Hover)).await.unwrap();
    assert!(first.details.success && !first.is_error);
    assert!(first.text.contains("add"));
    let before = state(&tool).await;
    fixture.seen.lock().unwrap().clear();
    let cases = [
        LspAction::Diagnostics,
        LspAction::Definition,
        LspAction::TypeDefinition,
        LspAction::Implementation,
        LspAction::References,
        LspAction::Hover,
        LspAction::Symbols,
        LspAction::Capabilities,
        LspAction::Status,
    ];
    for action in cases {
        let result = execute(&tool, input(action)).await.unwrap();
        assert!(
            result.details.success && !result.is_error,
            "{action:?}: {}",
            result.text
        );
        assert!(
            !result.text.contains(".marsh/"),
            "physical view escaped: {}",
            result.text
        );
    }
    let after = state(&tool).await;
    assert_eq!(pid(&after), pid(&before));
    assert!(counter(&after) > counter(&before));
    assert_eq!(Path::new(after["cwd"].as_str().unwrap()), fixture.seed);
    assert!(
        fixture
            .seen
            .lock()
            .unwrap()
            .iter()
            .any(|(event, granted)| *granted
                && event.action == Action::Read
                && event.principal == Principal::from("rust-lsp-owner".to_owned()))
    );
    tool.close().await.unwrap();
    assert!(dead(pid(&after)));
    tool.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rename_preview_then_apply_commits_both_files_and_retires_the_old_pid() {
    let fixture = Fixture::new(json!({}));
    let tool = fixture.tool(false).await;
    let before = state(&tool).await;
    let mut rename = input(LspAction::Rename);
    rename.line = Some(1.0);
    rename.symbol = Some("add".into());
    rename.new_name = Some("sum".into());
    rename.apply = Some(false);
    assert!(
        execute(&tool, rename.clone())
            .await
            .unwrap()
            .details
            .success
    );
    assert_eq!(fixture.source("a.fixture"), A);
    assert_eq!(fixture.source("b.fixture"), B);
    assert_eq!(pid(&state(&tool).await), pid(&before));
    rename.apply = None;
    assert!(execute(&tool, rename).await.unwrap().details.success);
    assert_eq!(fixture.source("a.fixture"), "const sum = 1;\nsum;\n");
    assert_eq!(fixture.source("b.fixture"), "sum;\n");
    assert!(dead(pid(&before)));
    let fresh = state(&tool).await;
    assert_ne!(pid(&fresh), pid(&before));
    tool.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn denied_cross_file_rename_exposes_no_result_and_publishes_no_prefix() {
    let fixture = Fixture::new(json!({}));
    let tool = fixture.tool(false).await;
    let before = state(&tool).await;
    let owner = fixture.lock_b().await;
    let mut rename = input(LspAction::Rename);
    rename.line = Some(1.0);
    rename.symbol = Some("add".into());
    rename.new_name = Some("sum".into());
    let error = execute(&tool, rename.clone()).await.err().unwrap();
    assert!(
        matches!(error, LspError::Marsh(ref error) if matches!(error.kind(), ShellErrorKind::Denied { .. }))
    );
    assert_eq!(fixture.source("a.fixture"), A);
    assert_eq!(fixture.source("b.fixture"), B);
    assert!(dead(pid(&before)));
    assert_eq!(
        u8::from(owner.run("release -- b.fixture").await.unwrap().exit_code),
        0
    );
    assert!(execute(&tool, rename).await.unwrap().details.success);
    assert_eq!(fixture.source("a.fixture"), "const sum = 1;\nsum;\n");
    assert_eq!(fixture.source("b.fixture"), "sum;\n");
    tool.close().await.unwrap();
    owner.close(false).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn server_initiated_edits_on_a_read_only_hover_are_still_transactional() {
    let fixture = Fixture::new(json!({"mode":"apply-edit"}));
    let tool = fixture.tool(true).await;
    let result = execute(&tool, input(LspAction::Hover)).await.unwrap();
    assert!(result.details.success);
    assert_eq!(
        fixture.source("a.fixture"),
        format!("// applied by fixture\n{A}")
    );
    tool.close().await.unwrap();

    let fixture = Fixture::new(json!({"mode":"apply-edit-prefix-failure"}));
    let tool = fixture.tool(true).await;
    assert!(execute(&tool, input(LspAction::Hover)).await.is_err());
    assert_eq!(fixture.source("a.fixture"), A);
    tool.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_write_then_restore_retires_even_with_an_empty_final_diff() {
    let fixture = Fixture::new(json!({"mode":"write-restore"}));
    let tool = fixture.tool(false).await;
    let before = state(&tool).await;
    assert!(
        execute(&tool, input(LspAction::Hover))
            .await
            .unwrap()
            .details
            .success
    );
    assert_eq!(fixture.source("a.fixture"), A);
    assert!(dead(pid(&before)));
    assert_ne!(pid(&state(&tool).await), pid(&before));
    tool.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_changes_while_parked_force_a_fresh_server_before_dispatch() {
    let fixture = Fixture::new(json!({}));
    let tool = fixture.tool(false).await;
    let before = state(&tool).await;
    std::fs::write(fixture.seed.join("a.fixture"), "const changed = 2;\n").unwrap();
    let result = execute(&tool, input(LspAction::Hover)).await.unwrap();
    assert!(result.text.contains("changed"));
    let after = state(&tool).await;
    assert_ne!(pid(&before), pid(&after));
    assert!(dead(pid(&before)));
    tool.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn required_inputs_and_read_only_rejections_keep_their_error_categories() {
    let fixture = Fixture::new(json!({}));
    let tool = fixture.tool(false).await;
    for action in [
        LspAction::Diagnostics,
        LspAction::Symbols,
        LspAction::Rename,
        LspAction::RenameFile,
    ] {
        let mut missing = input(action);
        missing.file = None;
        assert!(
            matches!(execute(&tool, missing).await, Err(LspError::Semantic(_))),
            "{action:?}"
        );
    }
    let mut request = input(LspAction::Request);
    request.query = Some(" ".into());
    assert!(matches!(
        execute(&tool, request).await,
        Err(LspError::Semantic(_))
    ));
    let mut symbols = input(LspAction::Symbols);
    symbols.file = Some("*".into());
    assert!(matches!(
        execute(&tool, symbols).await,
        Err(LspError::Semantic(_))
    ));
    tool.close().await.unwrap();
    let read_only = fixture.tool(true).await;
    for action in [
        LspAction::Rename,
        LspAction::RenameFile,
        LspAction::CodeActions,
        LspAction::Reload,
        LspAction::Request,
    ] {
        assert!(
            matches!(
                execute(&read_only, input(action)).await,
                Err(LspError::Tool(_))
            ),
            "{action:?}"
        );
    }
    read_only.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invalid_edit_positions_never_clamp_to_a_different_location() {
    let fixture = Fixture::new(json!({}));
    let tool = fixture.tool(false).await;
    for line in [-1.0, 0.0, 1.5, 1000.0, f64::INFINITY, f64::NAN] {
        let mut rename = input(LspAction::Rename);
        rename.line = Some(line);
        rename.symbol = Some("add".into());
        rename.new_name = Some("wrong".into());
        assert!(
            matches!(execute(&tool, rename).await, Err(LspError::Semantic(_))),
            "line {line}"
        );
        assert_eq!(fixture.source("a.fixture"), A);
        assert_eq!(fixture.source("b.fixture"), B);
    }
    tool.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn code_action_selection_applies_a_real_typed_edit() {
    let fixture = Fixture::new(json!({"responses":{"textDocument/codeAction":[{
        "title":"Rename declaration", "kind":"refactor.rename",
        "edit":{"changes":{"${uri}":[{"range":{"start":{"line":0,"character":6},
            "end":{"line":0,"character":9}},"newText":"sum"}]}}
    }]}}));
    let tool = fixture.tool(false).await;
    let mut action = input(LspAction::CodeActions);
    assert!(
        execute(&tool, action.clone())
            .await
            .unwrap()
            .details
            .success
    );
    assert_eq!(fixture.source("a.fixture"), A);
    action.apply = Some(true);
    action.query = Some("0".into());
    assert!(execute(&tool, action).await.unwrap().details.success);
    assert_eq!(fixture.source("a.fixture"), "const sum = 1;\nadd;\n");
    tool.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rename_file_preview_and_apply_preserve_source_bytes_until_the_receipt() {
    let fixture = Fixture::new(json!({}));
    let tool = fixture.tool(false).await;
    let mut action = input(LspAction::RenameFile);
    action.new_name = Some("renamed.fixture".into());
    action.apply = Some(false);
    assert!(
        execute(&tool, action.clone())
            .await
            .unwrap()
            .details
            .success
    );
    assert_eq!(fixture.source("a.fixture"), A);
    assert!(!fixture.seed.join("renamed.fixture").exists());
    action.apply = None;
    assert!(execute(&tool, action).await.unwrap().details.success);
    assert!(!fixture.seed.join("a.fixture").exists());
    assert_eq!(fixture.source("renamed.fixture"), A);
    tool.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_json_yaml_precedence_retains_invalid_overrides_and_unrelated_servers() {
    let fixture = Fixture::new(json!({}));
    std::fs::write(fixture.seed.join("lsp.yaml"), "servers:\n  fixture:\n    command: ''\n  unrelated:\n    command: node\n    args: ['--version']\n    fileTypes: [other]\n    rootMarkers: ['.']\n").unwrap();
    let tool = fixture.tool(false).await;
    assert!(
        execute(&tool, input(LspAction::Hover))
            .await
            .unwrap()
            .details
            .success,
        "invalid high-priority override must retain the lower valid definition"
    );
    let mut status = input(LspAction::Status);
    status.file = None;
    assert!(
        execute(&tool, status)
            .await
            .unwrap()
            .text
            .contains("unrelated")
    );
    tool.close().await.unwrap();
}

async fn dispatched(events: &Path, method: &str) -> Value {
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            match std::fs::read_to_string(events) {
                Ok(text) => {
                    for line in text.lines() {
                        if let Ok(event) = serde_json::from_str::<Value>(line)
                            && event["method"] == method
                            && event["phase"] == "dispatch"
                        {
                            return event;
                        }
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => panic!("protocol event gate: {error}"),
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the real server dispatches the gated request")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_queued_calls_cancellation_does_not_cancel_the_active_call() {
    let fixture = Fixture::new(json!({"delays":{"fixture/state":1000}}));
    let events = fixture.event_log();
    let tool = fixture.tool(false).await;
    let active_cancel = ManagedCancellation::default();
    let queued_cancel = ManagedCancellation::default();
    let mut request = input(LspAction::Request);
    request.query = Some("fixture/state".into());
    let (active, ()) = tokio::join!(tool.execute(request, &active_cancel), async {
        dispatched(&events, "fixture/state").await;
        let (queued, ()) = tokio::join!(
            tool.execute(input(LspAction::Hover), &queued_cancel),
            async {
                tokio::task::yield_now().await;
                queued_cancel.cancel();
            },
        );
        assert!(matches!(queued, Err(LspError::Cancelled)));
    },);
    assert!(active.unwrap().details.success);
    assert!(!active_cancel.is_cancelled());
    assert!(
        execute(&tool, input(LspAction::Hover))
            .await
            .unwrap()
            .details
            .success
    );
    tool.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn active_call_cancellation_drains_the_exact_server_tree() {
    let fixture = Fixture::new(json!({"delays":{"fixture/state":30000}}));
    let events = fixture.event_log();
    let tool = fixture.tool(false).await;
    let cancel = ManagedCancellation::default();
    let mut request = input(LspAction::Request);
    request.query = Some("fixture/state".into());
    let (result, server) = tokio::join!(tool.execute(request, &cancel), async {
        let event = dispatched(&events, "fixture/state").await;
        cancel.cancel();
        event
    },);
    assert!(matches!(result, Err(LspError::Cancelled)));
    assert!(dead(pid(&server)));
    assert_eq!(fixture.source("a.fixture"), A);
    tool.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn raw_logical_paths_use_the_private_view_and_the_same_policy_receipt() {
    let fixture = Fixture::new(json!({}));
    let owner = fixture.lock_b().await;
    let tool = fixture.tool(false).await;
    let mut write = input(LspAction::Request);
    write.query = Some("fixture/write".into());
    write.payload = Some(json!({"path":fixture.seed.join("b.fixture"),"text":"raw\n"}).to_string());
    let error = execute(&tool, write.clone()).await.err().unwrap();
    assert!(
        matches!(error, LspError::Marsh(ref error) if matches!(error.kind(), ShellErrorKind::Denied { .. }))
    );
    assert_eq!(fixture.source("b.fixture"), B);
    assert_eq!(
        u8::from(owner.run("release -- b.fixture").await.unwrap().exit_code),
        0
    );
    let result = execute(&tool, write).await.unwrap();
    assert!(result.details.success);
    assert!(!result.text.contains(".marsh/"));
    assert_eq!(fixture.source("b.fixture"), "raw\n");
    tool.close().await.unwrap();
    owner.close(false).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn uri_spaces_and_component_boundaries_do_not_rewrite_unrelated_paths() {
    let fixture = Fixture::new(json!({}));
    std::fs::write(fixture.seed.join("space name.fixture"), "space marker\n").unwrap();
    let sibling = fixture.root.path().join("seed-sibling");
    std::fs::create_dir(&sibling).unwrap();
    std::fs::write(sibling.join("note"), "outside marker\n").unwrap();
    let tool = fixture.tool(false).await;
    for (path, expected) in [
        (
            url::Url::from_file_path(fixture.seed.join("space name.fixture"))
                .unwrap()
                .to_string(),
            "space marker",
        ),
        (
            sibling.join("note").to_string_lossy().into_owned(),
            "outside marker",
        ),
    ] {
        let mut request = input(LspAction::Request);
        request.query = Some("fixture/read".into());
        request.payload = Some(json!({"path":path}).to_string());
        let result = execute(&tool, request).await.unwrap();
        assert!(result.text.contains(expected), "{}", result.text);
        assert!(!result.text.contains(".marsh/"));
    }
    tool.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closing_one_rust_instance_does_not_close_a_sibling() {
    let fixture = Fixture::new(json!({}));
    let first = fixture.tool(false).await;
    let sibling = fixture.tool(false).await;
    let first_pid = pid(&state(&first).await);
    let sibling_pid = pid(&state(&sibling).await);
    first.close().await.unwrap();
    assert!(dead(first_pid));
    assert!(matches!(
        execute(&first, input(LspAction::Hover)).await,
        Err(LspError::Closed)
    ));
    assert!(
        execute(&sibling, input(LspAction::Hover))
            .await
            .unwrap()
            .details
            .success
    );
    assert_eq!(pid(&state(&sibling).await), sibling_pid);
    sibling.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn server_errors_with_protected_content_require_a_history_only_receipt() {
    let fixture = Fixture::new(json!({}));
    let owner = fixture.lock_b().await;
    let tool = fixture.tool(false).await;
    let mut request = input(LspAction::Request);
    request.query = Some("fixture/error".into());
    request.payload = Some(
        json!({"readPath":fixture.seed.join("b.fixture"),
        "writeBefore":{"path":fixture.seed.join("b.fixture"),"text":"partial error edit"}})
        .to_string(),
    );
    let denied = execute(&tool, request.clone()).await.err().unwrap();
    assert!(
        matches!(denied, LspError::Marsh(ref error) if matches!(error.kind(), ShellErrorKind::Denied { .. })),
        "unexpected error receipt: {denied:?}"
    );
    assert!(!denied.to_string().contains("add;"));
    assert_eq!(fixture.source("b.fixture"), B);
    owner.run("release -- b.fixture").await.unwrap();
    let authorized = execute(&tool, request).await.err().unwrap();
    assert!(matches!(authorized, LspError::Semantic(ref result) if result.text.contains("add;")));
    assert_eq!(
        fixture.source("b.fixture"),
        B,
        "authorized errors discard earlier writes too"
    );
    tool.close().await.unwrap();
    owner.close(false).await.unwrap();
}

fn exported(environment: &mut ShellEnvironment, name: &str, value: impl Into<String>) {
    let mut variable = ShellVariable::new(value.into());
    variable.export();
    environment.set_global(name.to_owned(), variable).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_user_roots_follow_node_join_and_foreign_user_config_is_opt_in() {
    let fixture = Fixture::new(json!({}));
    let home = fixture.root.path().join("home");
    let native = home.join("chosen/agent");
    let foreign = home.join(".claude");
    std::fs::create_dir_all(&native).unwrap();
    std::fs::create_dir_all(&foreign).unwrap();
    let definition = |name: &str| {
        json!({"servers":{(name):{"command":"node","args":["--version"],
        "fileTypes":["other"],"rootMarkers":["."]}}})
    };
    std::fs::write(
        native.join("lsp.json"),
        definition("native-home").to_string(),
    )
    .unwrap();
    std::fs::write(
        foreign.join("lsp.json"),
        definition("foreign-opt-in").to_string(),
    )
    .unwrap();
    let mut environment = fixture.environment();
    exported(&mut environment, "PI_CONFIG_DIR", "/chosen");
    let tool = fixture
        .tool_with_environment(false, environment.clone())
        .await;
    let mut status = input(LspAction::Status);
    status.file = None;
    let result = execute(&tool, status.clone()).await.unwrap();
    assert!(result.text.contains("native-home"));
    assert!(!result.text.contains("foreign-opt-in"));
    tool.close().await.unwrap();
    exported(
        &mut environment,
        "CLAUDE_CONFIG_DIR",
        foreign.to_string_lossy(),
    );
    let opted_in = fixture.tool_with_environment(false, environment).await;
    assert!(
        execute(&opted_in, status)
            .await
            .unwrap()
            .text
            .contains("foreign-opt-in")
    );
    opted_in.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_conflict_after_protocol_dispatch_never_replays_the_request() {
    let fixture = Fixture::new(json!({}));
    let events = fixture.event_log();
    let gate = fixture.root.path().join("release-response");
    let tool = fixture.tool(false).await;
    execute(&tool, input(LspAction::Hover)).await.unwrap();
    let peer = shell_builder(fixture.fs.clone())
        .working_dir(fixture.seed.clone())
        .environment(fixture.environment())
        .sandbox_policy(marsh_core::SandboxPolicy::allow())
        .build()
        .await
        .unwrap();
    let mut request = input(LspAction::Request);
    request.query = Some("fixture/delay".into());
    request.payload = Some(json!({"ms":0,"gate":gate}).to_string());
    let (result, ()) = tokio::join!(execute(&tool, request), async {
        dispatched(&events, "fixture/delay").await;
        peer.run("cat a.fixture >/dev/null; printf 'peer\\n' > a.fixture")
            .await
            .unwrap();
        std::fs::write(&gate, "release").unwrap();
    });
    assert!(
        matches!(result, Err(LspError::Marsh(ref error)) if matches!(error.kind(), ShellErrorKind::Stale { .. }))
    );
    assert_eq!(fixture.source("a.fixture"), "peer\n");
    let records = std::fs::read_to_string(events).unwrap();
    let dispatches = records
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|event| event["method"] == "fixture/delay" && event["phase"] == "dispatch")
        .count();
    assert_eq!(
        dispatches, 1,
        "post-dispatch freshness failure must not replay protocol actions"
    );
    tool.close().await.unwrap();
    peer.close(false).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn close_cancels_active_and_queued_calls_and_waits_for_native_drain() {
    let fixture = Fixture::new(json!({"delays":{"fixture/state":30000}}));
    let events = fixture.event_log();
    let tool = fixture.tool(false).await;
    let mut request = input(LspAction::Request);
    request.query = Some("fixture/state".into());
    let (active, (queued, server)) = tokio::join!(execute(&tool, request), async {
        let server = dispatched(&events, "fixture/state").await;
        let (queued, ()) = tokio::join!(execute(&tool, input(LspAction::Hover)), async {
            tokio::task::yield_now().await;
            tool.close().await.unwrap();
        });
        (queued, server)
    });
    assert!(matches!(
        active,
        Err(LspError::Cancelled | LspError::Closed)
    ));
    assert!(matches!(
        queued,
        Err(LspError::Cancelled | LspError::Closed)
    ));
    assert!(dead(pid(&server)));
    assert_eq!(fixture.source("a.fixture"), A);
    tool.close().await.unwrap();
}

fn protocol_events(path: &Path, method: &str) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|event| event["method"] == method && event["phase"] == "dispatch")
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn initialization_failures_cache_only_full_budget_calls_and_reload_clears_them() {
    for shortened in [false, true] {
        let fixture = Fixture::new(json!({"mode":"init-fail"}));
        let events = fixture.event_log();
        let tool = fixture.tool(false).await;
        let mut hover = input(LspAction::Hover);
        if shortened {
            hover.timeout = Some(5.0);
        }
        assert!(execute(&tool, hover.clone()).await.is_err());
        assert!(execute(&tool, hover.clone()).await.is_err());
        let attempts = protocol_events(&events, "initialize");
        assert_eq!(attempts.len(), if shortened { 2 } else { 1 });
        assert!(attempts.iter().all(|event| dead(pid(event))));
        if !shortened {
            let mut reload = input(LspAction::Reload);
            reload.timeout = None;
            let _ = execute(&tool, reload).await;
            assert!(execute(&tool, hover).await.is_err());
            assert_eq!(protocol_events(&events, "initialize").len(), 2);
        }
        tool.close().await.unwrap();
    }
}
