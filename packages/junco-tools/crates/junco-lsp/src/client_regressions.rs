//! Real-server regressions needing access to production document/readiness state transitions.
use super::*;
use crate::{EpochTool, LspAction, LspOptions, LspTool, State};
use marsh_core::{
    ManagedCancellation, ShellEnvironment, ShellVariable, test_support::shell_builder,
};
use std::{os::unix::fs::PermissionsExt as _, sync::Arc};

async fn fixture(control: Value, rust: bool) -> (tempfile::TempDir, LspTool) {
    let root = tempfile::tempdir().unwrap();
    let seed = root.path().join("seed");
    std::fs::create_dir_all(seed.join(".omp")).unwrap();
    for directory in ["home", "tmp"] {
        std::fs::create_dir(root.path().join(directory)).unwrap();
    }
    for file in ["a.fixture", "b.fixture"] {
        std::fs::write(seed.join(file), "const add = 1;\n").unwrap();
    }
    std::fs::write(seed.join("control.json"), control.to_string()).unwrap();
    let script = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/lsp-fixture.mjs")
        .canonicalize()
        .unwrap();
    let command = if rust {
        let launcher = seed.join("rust-analyzer");
        std::fs::write(&launcher, "#!/bin/sh\nexec node \"$@\"\n").unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
        launcher
    } else {
        PathBuf::from("node")
    };
    std::fs::write(seed.join(".omp/lsp.json"), json!({"servers":{"fixture":{
        "command":command,"args":[script,"stdio-server","--control=control.json",format!("--events={}",root.path().join("events.jsonl").display())],
        "fileTypes":["fixture"],"rootMarkers":["."],"warmupTimeoutMs":15000,
        "workspaceReadyTimings":{"timeoutMs":400,"pollMs":20,"settleMs":80,"statusRequestTimeoutMs":100}
    }}}).to_string()).unwrap();
    let mut environment = ShellEnvironment::new();
    for (name, value) in [
        ("PATH", std::env::var("PATH").unwrap()),
        (
            "HOME",
            root.path().join("home").to_string_lossy().into_owned(),
        ),
        (
            "TMPDIR",
            root.path().join("tmp").to_string_lossy().into_owned(),
        ),
    ] {
        let mut variable = ShellVariable::new(value);
        variable.export();
        environment.set_global(name.to_owned(), variable).unwrap();
    }
    let fs = Arc::new(marsh_btrfs::fake::CopyTree::new());
    fs.register(&seed);
    let session = shell_builder(fs)
        .working_dir(seed)
        .environment(environment)
        .build_managed_session()
        .await
        .unwrap();
    (root, LspTool::from_session(session, LspOptions::default()))
}
fn input(action: LspAction, file: Option<&str>) -> LspInput {
    LspInput {
        action,
        file: file.map(str::to_owned),
        line: None,
        symbol: None,
        query: None,
        new_name: None,
        apply: None,
        timeout: Some(5.0),
        payload: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn idle_close_and_reopen_advance_versions_and_reject_delayed_old_diagnostics() {
    let (_root, tool) = fixture(json!({"mode":"no-push,no-pull"}), false).await;
    tool.execute(
        input(LspAction::Hover, Some("a.fixture")),
        &ManagedCancellation::default(),
    )
    .await
    .unwrap();
    let uri = {
        let mut state = tool.state.lock().await;
        let client = &mut state.runtime.clients[0];
        let uri = client.documents.keys().next().unwrap().clone();
        client.documents.get_mut(&uri).unwrap().last_use =
            Instant::now() - Duration::from_secs(301);
        uri
    };
    // Opening another file takes the actual idle-close path; no five-minute sleep.
    tool.execute(
        input(LspAction::Hover, Some("b.fixture")),
        &ManagedCancellation::default(),
    )
    .await
    .unwrap();
    tool.execute(
        input(LspAction::Hover, Some("a.fixture")),
        &ManagedCancellation::default(),
    )
    .await
    .unwrap();
    {
        let mut state = tool.state.lock().await;
        let State {
            session, runtime, ..
        } = &mut *state;
        session.epoch(EpochTool(LspAction::Diagnostics), &ManagedCancellation::default(), async |_epoch| {
            assert_eq!(runtime.clients[0].documents[&uri].version, 2);
            let diagnostic = json!({"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}},"message":"delayed old diagnostic"});
            // Feed a delayed frame through the real notification handler after the real reopen.
            runtime.notification(0, notification::PublishDiagnostics::METHOD,
                json!({"uri":uri,"version":1,"diagnostics":[diagnostic]}))?;
            assert!(runtime.clients[0].current_diagnostics(&uri).is_none());
            runtime.notification(0, notification::PublishDiagnostics::METHOD,
                json!({"uri":uri,"version":2,"diagnostics":[]}))?;
            assert!(runtime.clients[0].current_diagnostics(&uri).is_none());
            runtime.notification(0, notification::PublishDiagnostics::METHOD,
                json!({"uri":uri,"version":2,"diagnostics":[{"range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}},"message":"current lifetime diagnostic"}]}))?;
            assert_eq!(runtime.clients[0].current_diagnostics(&uri).unwrap()[0].message, "current lifetime diagnostic");
            Ok::<_, LspError>(())
        }).await.unwrap();
    }
    let mut call = input(LspAction::Request, None);
    call.query = Some("fixture/state".into());
    let result = tool
        .execute(call, &ManagedCancellation::default())
        .await
        .unwrap();
    let wire: Value = serde_json::from_str(&result.text).unwrap();
    let opened = wire["notifications"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|notification| {
            notification["method"] == "textDocument/didOpen"
                && notification["params"]["textDocument"]["uri"]
                    .as_str()
                    .unwrap()
                    .ends_with("a.fixture")
        })
        .map(|notification| {
            notification["params"]["textDocument"]["version"]
                .as_i64()
                .unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(opened, [1, 2]);
    tool.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rust_readiness_gets_its_configured_polling_budget_after_the_generic_wait() {
    let (root, tool) = fixture(json!({"progressDelayMs":30000}), true).await;
    // This starts the real client without the semantic action's generic project wait.
    let mut call = input(LspAction::Request, None);
    call.query = Some("fixture/echo".into());
    tool.execute(call, &ManagedCancellation::default())
        .await
        .unwrap();
    {
        let mut state = tool.state.lock().await;
        let State {
            session, runtime, ..
        } = &mut *state;
        let deadline = Instant::now() + Duration::from_secs(3);
        runtime.deadline = deadline;
        session
            .epoch(
                EpochTool(LspAction::Hover),
                &ManagedCancellation::default(),
                async |epoch| {
                    assert!(!runtime.clients[0].project_loaded);
                    runtime
                        .project_ready(epoch, 0, deadline, Duration::from_millis(25))
                        .await?;
                    assert!(runtime.clients[0].rust_ready);
                    Ok::<_, LspError>(())
                },
            )
            .await
            .unwrap();
    }
    let polls = std::fs::read_to_string(root.path().join("events.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|event| {
            event["method"] == "rust-analyzer/analyzerStatus" && event["phase"] == "dispatch"
        })
        .count();
    assert!(
        polls >= 2,
        "configured settle/poll timings were not observed: {polls}"
    );
    tool.close().await.unwrap();
}
