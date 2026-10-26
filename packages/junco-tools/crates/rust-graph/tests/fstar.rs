use std::{
    env, fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::Command,
};

use rust_graph::*;

fn hb() -> Result<(), String> {
    Ok(())
}

fn write(root: &Path, path: &str, source: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, source).unwrap();
}

fn symbol<'g>(graph: &'g Graph, path: &str, name: &str) -> &'g Node {
    graph.files[path]
        .nodes
        .iter()
        .find(|node| node.name == name)
        .unwrap_or_else(|| panic!("missing {path}#{name}: {:?}", graph.files[path].nodes))
}

fn edge(graph: &Graph, from: &str, to: &str, relation: Relation) -> bool {
    graph
        .edges
        .iter()
        .any(|edge| edge.source == from && edge.target == to && edge.relation == relation)
}

/// The repository root as a recursive include root, without the host's F* library.
const HERMETIC: &str = r#"{"include_dirs": ["."], "options": ["--no_default_includes"]}"#;

/// A scratch directory and its `repo` child, so libraries can be its siblings.
fn scratch() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    fs::create_dir_all(&repo).unwrap();
    (dir, repo)
}

fn fstar(options: &[&str], include_dirs: &[&str]) -> FstarConfig {
    FstarConfig {
        options: Some(options.iter().map(|s| s.to_string()).collect()),
        include_dirs: Some(include_dirs.iter().map(|s| s.to_string()).collect()),
        ..FstarConfig::default()
    }
}

fn run(root: &Path, fstar: Option<FstarConfig>) -> Result<(Graph, BuildReport), String> {
    build(root, BuildOptions { full: false, fstar }, &hb)
}

fn imports<'g>(graph: &'g Graph, file: &str) -> Vec<&'g str> {
    graph
        .edges
        .iter()
        .filter(|edge| edge.source == file && edge.relation == Relation::Imports)
        .map(|edge| edge.target.as_str())
        .collect()
}

/// What `path#name` calls or references, as `path#name`.
fn uses(graph: &Graph, path: &str, name: &str) -> Vec<String> {
    let source = &symbol(graph, path, name).id;
    let nodes: Vec<&Node> = graph.files.values().flat_map(|file| &file.nodes).collect();
    graph
        .edges
        .iter()
        .filter(|edge| {
            edge.source == *source
                && matches!(edge.relation, Relation::Calls | Relation::References)
        })
        .map(|edge| {
            let node = nodes.iter().find(|node| node.id == edge.target).unwrap();
            format!("{}#{}", node.path, node.name)
        })
        .collect()
}

const BASE: &str = "\
module Demo.Base
private let hidden (n:nat) = n
let identité (n:nat) : nat = n
let identity (n:nat) : nat = identité n
val provided (n:nat) : nat
noeq type token =
  | Empty
  | Value of nat
type box = { value:token }
class named = { name:nat }
instance val dictionary : named
instance default_named = { name = 0 }
assume Stable : True
effect Abstract
effect PureAlias (a:Type) = Tot a
new_effect { Custom with { repr = token } }
let ( ++ ) (x:nat) (y:nat) = identity x
let public_text = \"private let fake = identity 0\"
private type secret = { concealed:nat }
";

#[test]
fn fstar_modules_interfaces_aliases_metadata_and_cached_refresh() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "demo.fst.config.json", HERMETIC);
    write(dir.path(), "Demo.Base.fst", BASE);
    write(
        dir.path(),
        "Demo.Base.fsti",
        "module Demo.Base\nval identity : nat -> nat\n",
    );
    write(
        dir.path(),
        "Demo/Only.fsti",
        "module Demo.Only\nval declared_only : nat -> nat\n",
    );
    write(
        dir.path(),
        "Demo/Included.fst",
        "module Demo.Included\nlet included (n:nat) = n\n",
    );
    write(
        dir.path(),
        "Main.fst",
        "\
module Demo.Main
open Demo.Base
include Demo.Included
friend Demo.Base
module B = Demo.Base
open Demo.Only
let run (n:nat) : nat =
  B.identity (identity n)
let proof (n:nat) : Lemma (B.identity n == n) =
  ()
let from_interface (n:nat) = declared_only n
let from_include (n:nat) = included n
let operator_use (n:nat) = n ++ n
",
    );
    let (graph, report) = build(
        dir.path(),
        BuildOptions {
            full: true,
            fstar: None,
        },
        &hb,
    )
    .unwrap();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(report.languages.get("fstar"), Some(&5));
    assert!(graph.files.values().all(|file| file.lang == "fstar"));
    let file = &graph.files["Main.fst"];
    assert_eq!(
        file.imports
            .iter()
            .map(|import| import.module.as_str())
            .collect::<Vec<_>>(),
        [
            "Demo.Base",
            "Demo.Included",
            "Demo.Base",
            "B:Demo.Base",
            "Demo.Only"
        ]
    );
    for path in ["Demo.Base.fst", "Demo/Only.fsti", "Demo/Included.fst"] {
        assert!(edge(&graph, "Main.fst", path, Relation::Imports), "{path}");
    }
    assert!(!edge(
        &graph,
        "Main.fst",
        "Demo.Base.fsti",
        Relation::Imports
    ));
    assert!(!file.nodes.iter().any(|node| node.name == "B"));
    let module = symbol(&graph, "Main.fst", "Demo.Main");
    let run = symbol(&graph, "Main.fst", "run");
    assert_eq!(run.id, "Main.fst#Demo.Main.run:7");
    assert_eq!((run.start_line, run.end_line), (7, 8));
    assert_eq!(run.signature, "let run (n:nat) : nat =");
    assert_eq!(run.owner.as_deref(), Some(module.id.as_str()));
    assert_eq!(module.end_line, 13);
    let identity = symbol(&graph, "Demo.Base.fst", "identity");
    assert!(edge(&graph, &run.id, &identity.id, Relation::Calls));
    assert!(!edge(
        &graph,
        &run.id,
        &symbol(&graph, "Demo.Base.fsti", "identity").id,
        Relation::Calls
    ));
    assert!(edge(
        &graph,
        &symbol(&graph, "Main.fst", "proof").id,
        &identity.id,
        Relation::References
    ));
    assert!(edge(
        &graph,
        &symbol(&graph, "Main.fst", "from_interface").id,
        &symbol(&graph, "Demo/Only.fsti", "declared_only").id,
        Relation::Calls
    ));
    assert!(edge(
        &graph,
        &symbol(&graph, "Main.fst", "from_include").id,
        &symbol(&graph, "Demo/Included.fst", "included").id,
        Relation::Calls
    ));
    assert!(edge(
        &graph,
        &symbol(&graph, "Main.fst", "operator_use").id,
        &symbol(&graph, "Demo.Base.fst", "++").id,
        Relation::Calls
    ));
    assert!(
        file.raw_edges
            .iter()
            .any(|raw| raw.from == run.id && raw.target == "B.identity")
    );
    for (name, kind) in [
        ("provided", NodeKind::Function),
        ("token", NodeKind::Type),
        ("Empty", NodeKind::Constant),
        ("Value", NodeKind::Constant),
        ("box", NodeKind::Class),
        ("value", NodeKind::Field),
        ("named", NodeKind::Interface),
        ("name", NodeKind::Field),
        ("dictionary", NodeKind::Function),
        ("default_named", NodeKind::Function),
        ("Stable", NodeKind::Constant),
        ("Abstract", NodeKind::Type),
        ("PureAlias", NodeKind::Type),
        ("Custom", NodeKind::Type),
    ] {
        assert_eq!(symbol(&graph, "Demo.Base.fst", name).kind, kind, "{name}");
    }
    for (name, owner) in [
        ("Empty", "token"),
        ("Value", "token"),
        ("value", "box"),
        ("name", "named"),
    ] {
        assert_eq!(
            symbol(&graph, "Demo.Base.fst", name).owner.as_deref(),
            Some(symbol(&graph, "Demo.Base.fst", owner).id.as_str())
        );
    }
    for name in ["hidden", "secret", "concealed"] {
        assert!(!symbol(&graph, "Demo.Base.fst", name).exported, "{name}");
    }
    assert!(symbol(&graph, "Demo.Base.fst", "public_text").exported);
    assert!(
        !graph.files["Demo.Base.fst"]
            .nodes
            .iter()
            .any(|node| node.name == "fake")
    );
    assert!(edge(
        &graph,
        &symbol(&graph, "Demo.Base.fst", "value").id,
        &symbol(&graph, "Demo.Base.fst", "token").id,
        Relation::References
    ));

    assert_eq!(map(&graph).languages, ["fstar"]);
    for alias in ["fstar", "f*", "fst", "fsti"] {
        let result = search(
            &graph,
            &SearchQuery {
                query: "identité".into(),
                kinds: None,
                path_prefix: None,
                lang: Some(alias.into()),
                limit: 10,
            },
        );
        assert!(
            result.hits.iter().any(|hit| hit.node.name == "identité"),
            "{alias}"
        );
    }
    let deps = dependencies(
        &graph,
        &DependencyQuery {
            symbol: run.id.clone(),
            path: None,
            direction: Direction::Out,
            depth: 1,
            relations: Some(vec![Relation::Calls, Relation::References]),
        },
    )
    .unwrap();
    assert!(deps.nodes.iter().any(|node| node.node.id == identity.id));
    let clustering = cluster(
        &graph,
        &ClusterOptions {
            max_size: 1,
            omnipresent: Some(u32::MAX),
            prefixes: vec![],
            excludes: vec![],
        },
    )
    .unwrap();
    assert!(
        clustering
            .modules
            .iter()
            .any(|module| module.members.contains(&run.id))
    );
    let (cached, report) = build(
        dir.path(),
        BuildOptions {
            full: false,
            fstar: None,
        },
        &hb,
    )
    .unwrap();
    assert_eq!(report.files_reused, 5);
    assert_eq!(cached.edges, graph.edges);
    write(
        dir.path(),
        "Main.fst",
        "module Demo.Main\nopen Demo.Only\nlet refreshed (n:nat) = declared_only n\n",
    );
    let refreshed = refresh(dir.path(), None, &hb).unwrap();
    assert!(
        !refreshed.files["Main.fst"]
            .nodes
            .iter()
            .any(|node| node.name == "run")
    );
    assert!(edge(
        &refreshed,
        &symbol(&refreshed, "Main.fst", "refreshed").id,
        &symbol(&refreshed, "Demo/Only.fsti", "declared_only").id,
        Relation::Calls
    ));
}

#[test]
fn fstar_mutual_bindings_have_individual_spans_and_lexical_scopes() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "demo.fst.config.json", HERMETIC);
    write(
        dir.path(),
        "Scope.fst",
        "\
module Scope
let n = 9
let x = 9
let h = 9
let a = 9
let helper (n:nat) = n
let rec left (x:nat) : nat =
  right x
and right (n:nat) : nat =
  helper n
let parameter (helper:nat) = helper
let lambda = fun x -> helper x
let local (n:nat) = let x = helper n in x
let local_function (n:nat) = let h (x:nat) = helper x in h n
let recursive_local (n:nat) = let rec h (x:nat) = if x = 0 then x else h x in h n
let patterns (n:nat) = match n with | 0 -> helper 0 | x -> helper x
let quantified : Type = forall (x:nat). helper x == x
val dependent : x:nat -> y:nat{x == y} -> nat
let typed (#a:Type) (x:a) : a = x
let after = x
(* let fake = helper 0 (* nested helper *) *)
// let fake_line = helper 0
let message = \"helper x; #lang-pulse fn fake_string() {}\"
let (.()) (n:nat) = helper n
let mixfix_use (n:nat) = (.()) n
",
    );
    let (graph, report) = build(
        dir.path(),
        BuildOptions {
            full: true,
            fstar: None,
        },
        &hb,
    )
    .unwrap();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    let left = symbol(&graph, "Scope.fst", "left");
    let right = symbol(&graph, "Scope.fst", "right");
    let module = symbol(&graph, "Scope.fst", "Scope");
    assert_eq!((left.start_line, left.end_line), (7, 8));
    assert_eq!((right.start_line, right.end_line), (9, 10));
    assert_eq!(left.signature, "let rec left (x:nat) : nat =");
    assert_eq!(right.signature, "right (n:nat) : nat =");
    assert_eq!(right.owner.as_deref(), Some(module.id.as_str()));
    assert!(edge(&graph, &left.id, &right.id, Relation::Calls));
    let helper = symbol(&graph, "Scope.fst", "helper");
    assert!(edge(&graph, &right.id, &helper.id, Relation::Calls));
    assert!(!edge(&graph, &left.id, &helper.id, Relation::Calls));
    for name in [
        "left",
        "right",
        "lambda",
        "local",
        "local_function",
        "recursive_local",
        "patterns",
        "quantified",
        "dependent",
        "typed",
    ] {
        let node = symbol(&graph, "Scope.fst", name);
        for local in ["n", "x", "h", "a"] {
            assert!(
                !graph.edges.iter().any(|edge| edge.source == node.id
                    && edge.target == symbol(&graph, "Scope.fst", local).id
                    && edge.relation != Relation::Contains),
                "{name} -> {local}"
            );
        }
    }
    assert!(!graph.edges.iter().any(|edge| edge.source
        == symbol(&graph, "Scope.fst", "parameter").id
        && edge.target == helper.id));
    for name in ["lambda", "local", "local_function", "patterns"] {
        assert!(
            edge(
                &graph,
                &symbol(&graph, "Scope.fst", name).id,
                &helper.id,
                Relation::Calls
            ),
            "{name}"
        );
    }
    assert!(edge(
        &graph,
        &symbol(&graph, "Scope.fst", "quantified").id,
        &helper.id,
        Relation::References
    ));
    assert!(edge(
        &graph,
        &symbol(&graph, "Scope.fst", "after").id,
        &symbol(&graph, "Scope.fst", "x").id,
        Relation::References
    ));
    let file = &graph.files["Scope.fst"];
    assert!(
        !file
            .nodes
            .iter()
            .any(|node| matches!(node.name.as_str(), "fake" | "fake_line" | "fake_string"))
    );
    assert!(
        !file
            .raw_edges
            .iter()
            .any(|raw| raw.from == symbol(&graph, "Scope.fst", "message").id)
    );
    assert!(edge(
        &graph,
        &symbol(&graph, "Scope.fst", "mixfix_use").id,
        &symbol(&graph, "Scope.fst", ".()").id,
        Relation::Calls
    ));
}

#[test]
fn fstar_pulse_fences_and_language_tail_preserve_offsets_contracts_and_locals() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "demo.fst.config.json", HERMETIC);
    write(
        dir.path(),
        "Pulse.Base.fst",
        "module Pulse.Base\nlet helper (n:nat) = n\nlet ready (n:nat) = true\n",
    );
    write(
        dir.path(),
        "Fenced.fst",
        "\
module Pulse.Fenced
open Pulse.Base
let x = 9
let result = 9
let local = 9
let before = \"λ ```pulse fn false_marker() {}\"
(* #lang-pulse fn comment_marker() {} *)
```unknown
fn opaque_marker() { helper 0 }
```
```pulse
let predicate owns (x:nat) = ready x
fn declared (x:nat) requires owns x
private fn execute (x:nat)
  requires owns x
  returns result:nat
  ensures ready result
{
  let local = helper x;
  return local;
}
```
let after = helper 0
```pulse
fn second (x:nat) { return helper x; }
```
",
    );
    write(
        dir.path(),
        "Tail.fsti",
        "\
module Pulse.Tail
open Pulse.Base
#lang-pulse
let predicate valid (x:nat) = ready x
fn tail (x:nat)
  requires valid x
  returns result:nat
  ensures ready result
{ return helper x; }
",
    );
    let (graph, report) = build(
        dir.path(),
        BuildOptions {
            full: true,
            fstar: None,
        },
        &hb,
    )
    .unwrap();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(report.languages.get("fstar"), Some(&3));
    let execute = symbol(&graph, "Fenced.fst", "execute");
    assert_eq!((execute.start_line, execute.end_line), (14, 21));
    assert_eq!(execute.signature, "private fn execute (x:nat)");
    assert!(!execute.exported);
    assert_eq!(
        execute.owner.as_deref(),
        Some(symbol(&graph, "Fenced.fst", "Pulse.Fenced").id.as_str())
    );
    let second = symbol(&graph, "Fenced.fst", "second");
    assert_eq!((second.start_line, second.end_line), (25, 25));
    let tail = symbol(&graph, "Tail.fsti", "tail");
    assert_eq!((tail.start_line, tail.end_line), (5, 9));
    let helper = symbol(&graph, "Pulse.Base.fst", "helper");
    for node in [execute, second, tail, symbol(&graph, "Fenced.fst", "after")] {
        assert!(
            edge(&graph, &node.id, &helper.id, Relation::Calls),
            "{}",
            node.id
        );
    }
    assert!(edge(
        &graph,
        &execute.id,
        &symbol(&graph, "Fenced.fst", "owns").id,
        Relation::Calls
    ));
    assert!(edge(
        &graph,
        &tail.id,
        &symbol(&graph, "Tail.fsti", "valid").id,
        Relation::Calls
    ));
    assert!(edge(
        &graph,
        &execute.id,
        &symbol(&graph, "Pulse.Base.fst", "ready").id,
        Relation::Calls
    ));
    assert_eq!(
        symbol(&graph, "Fenced.fst", "declared").kind,
        NodeKind::Function
    );
    for local in ["x", "result", "local"] {
        assert!(!graph.edges.iter().any(|edge| edge.source == execute.id
            && edge.target == symbol(&graph, "Fenced.fst", local).id));
    }
    for file in graph.files.values() {
        assert!(!file.nodes.iter().any(|node| matches!(
            node.name.as_str(),
            "false_marker" | "comment_marker" | "opaque_marker"
        )));
        assert!(!file.raw_edges.iter().any(|raw| matches!(
            raw.target.as_str(),
            "false_marker" | "comment_marker" | "opaque_marker"
        )));
    }
    let clustering = cluster(
        &graph,
        &ClusterOptions {
            max_size: 2,
            omnipresent: Some(u32::MAX),
            prefixes: vec![],
            excludes: vec![],
        },
    )
    .unwrap();
    assert!(
        clustering
            .modules
            .iter()
            .any(|module| module.members.contains(&execute.id))
    );
    let (cached, report) = build(
        dir.path(),
        BuildOptions {
            full: false,
            fstar: None,
        },
        &hb,
    )
    .unwrap();
    assert_eq!(report.files_reused, 3);
    assert_eq!(cached.edges, graph.edges);
}

#[test]
fn fstar_aliases_keep_qualified_targets_distinct() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "demo.fst.config.json", HERMETIC);
    write(
        dir.path(),
        "Demo.A.fst",
        "module Demo.A\nlet choose (n:nat) = n\n",
    );
    write(
        dir.path(),
        "Demo/B.fst",
        "module Demo.B\nlet choose (n:nat) = n\n",
    );
    write(
        dir.path(),
        "Main.fst",
        "\
module Demo.Main
module A = Demo.A
module B = Demo.B
let first (n:nat) = A.choose n
let second (n:nat) = B.choose n
let qualified (n:nat) = Demo.A.choose n
",
    );
    let (graph, report) = build(
        dir.path(),
        BuildOptions {
            full: true,
            fstar: None,
        },
        &hb,
    )
    .unwrap();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    let a = symbol(&graph, "Demo.A.fst", "choose");
    let b = symbol(&graph, "Demo/B.fst", "choose");
    for (name, target, other) in [("first", a, b), ("second", b, a), ("qualified", a, b)] {
        let source = symbol(&graph, "Main.fst", name);
        assert!(
            edge(&graph, &source.id, &target.id, Relation::Calls),
            "{name}"
        );
        assert!(
            !edge(&graph, &source.id, &other.id, Relation::Calls),
            "{name}"
        );
    }
    assert!(
        graph.files["Main.fst"]
            .raw_edges
            .iter()
            .any(|raw| raw.target == "Demo.A.choose")
    );
}

#[test]
fn fstar_val_and_implementation_pairs_resolve_to_the_body() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "demo.fst.config.json", HERMETIC);
    write(
        dir.path(),
        "Demo.Base.fst",
        "module Demo.Base\nval identity : nat -> nat\nlet identity (n:nat) = n\nlet local (n:nat) = identity n\n",
    );
    write(
        dir.path(),
        "Demo.Use.fst",
        "module Demo.Use\nopen Demo.Base\nlet caller (n:nat) = identity n\n",
    );
    let (graph, _) = build(
        dir.path(),
        BuildOptions {
            full: true,
            fstar: None,
        },
        &hb,
    )
    .unwrap();
    let base = &graph.files["Demo.Base.fst"];
    let body = base
        .nodes
        .iter()
        .find(|node| node.name == "identity" && node.start_line == 3)
        .unwrap();
    let declaration = base
        .nodes
        .iter()
        .find(|node| node.name == "identity" && node.start_line == 2)
        .unwrap();
    for caller in [
        symbol(&graph, "Demo.Base.fst", "local"),
        symbol(&graph, "Demo.Use.fst", "caller"),
    ] {
        assert!(edge(&graph, &caller.id, &body.id, Relation::Calls));
        assert!(!edge(&graph, &caller.id, &declaration.id, Relation::Calls));
    }
    let (cached, report) = build(
        dir.path(),
        BuildOptions {
            full: false,
            fstar: None,
        },
        &hb,
    )
    .unwrap();
    assert_eq!(report.files_reused, 2);
    assert_eq!(cached.edges, graph.edges);
}

#[test]
fn fstar_last_include_root_wins_and_external_keys_round_trip() {
    let (dir, repo) = scratch();
    let root = dir.path();
    write(
        root,
        "lib1/A.fst",
        "module A\nlet pick (n:nat) = n\nlet only_one (n:nat) = n\n",
    );
    write(root, "lib2/A.fst", "module A\nlet pick (n:nat) = n\n");
    write(
        root,
        "repo/Main.fst",
        "\
module Main
open A
module X = A
let run (n:nat) = pick n
let aliased (n:nat) = X.pick n
let qualified (n:nat) = A.pick n
let missing (n:nat) = only_one n
",
    );
    let configure = |includes: &str| {
        write(
            root,
            "repo/main.fst.config.json",
            &format!(r#"{{"include_dirs": [{includes}], "options": ["--no_default_includes"]}}"#),
        )
    };
    configure(r#""../lib1", "../lib2""#);
    let (graph, report) = run(&repo, None).unwrap();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(imports(&graph, "Main.fst"), ["../lib2/A.fst"]);
    for name in ["run", "aliased", "qualified"] {
        assert_eq!(
            uses(&graph, "Main.fst", name),
            ["../lib2/A.fst#pick"],
            "{name}"
        );
    }
    assert!(uses(&graph, "Main.fst", "missing").is_empty());
    assert!(!graph.files.contains_key("../lib1/A.fst"));

    // External keys work wherever repository keys do.
    let pick = symbol(&graph, "../lib2/A.fst", "pick").id.clone();
    let hits = search(
        &graph,
        &SearchQuery {
            query: "pick".into(),
            kinds: None,
            path_prefix: Some("../lib2".into()),
            lang: None,
            limit: 10,
        },
    );
    assert!(hits.hits.iter().any(|hit| hit.node.id == pick));
    let contained = dependencies(
        &graph,
        &DependencyQuery {
            symbol: "../lib2/A.fst".into(),
            path: None,
            direction: Direction::Out,
            depth: 2,
            relations: Some(vec![Relation::Contains]),
        },
    )
    .unwrap();
    assert!(contained.nodes.iter().any(|node| node.node.id == pick));
    let callers = dependencies(
        &graph,
        &DependencyQuery {
            symbol: "pick".into(),
            path: Some("../lib2/A.fst".into()),
            direction: Direction::In,
            depth: 1,
            relations: None,
        },
    )
    .unwrap();
    let run_id = &symbol(&graph, "Main.fst", "run").id;
    assert!(callers.nodes.iter().any(|node| node.node.id == *run_id));
    let map = map(&graph);
    assert!(map.clusters.iter().all(|cluster| !cluster.dir.is_empty()));
    assert!(map.clusters.iter().any(|cluster| cluster.dir == ".."));
    let query = ClusterQuery {
        view: ClusterView::List,
        directory: Some("./../lib2/".into()),
        cluster_id: None,
        direction: None,
        max_size: 20,
        omnipresent: Some(u32::MAX),
        offset: 0,
        limit: 20,
    };
    let ClusterQueryResult::List { clusters, .. } = cluster_query(&graph, &query).unwrap() else {
        panic!("list view");
    };
    assert!(!clusters.is_empty() && clusters.iter().all(|row| row.matching_files > 0));
    let members = cluster_query(
        &graph,
        &ClusterQuery {
            view: ClusterView::Members,
            directory: None,
            cluster_id: Some(clusters[0].cluster.id.clone()),
            ..query.clone()
        },
    )
    .unwrap();
    let ClusterQueryResult::Members { members, .. } = members else {
        panic!("members view");
    };
    assert!(members.iter().any(|node| node.path == "../lib2/A.fst"));
    assert!(!root.join("lib2/.junco").exists());

    configure(r#""../lib2", "../lib1""#);
    let (graph, report) = run(&repo, None).unwrap();
    assert_eq!(
        (
            report.files_parsed,
            report.files_reused,
            report.files_removed
        ),
        (1, 1, 1)
    );
    assert_eq!(imports(&graph, "Main.fst"), ["../lib1/A.fst"]);
    for name in ["run", "aliased", "qualified"] {
        assert_eq!(
            uses(&graph, "Main.fst", name),
            ["../lib1/A.fst#pick"],
            "{name}"
        );
    }
    assert_eq!(
        uses(&graph, "Main.fst", "missing"),
        ["../lib1/A.fst#only_one"]
    );

    // Absolute, symlinked, and relative spellings of one root are one file.
    symlink(root.join("lib1"), root.join("alias")).unwrap();
    let absolute = root.join("lib1").display().to_string();
    configure(&format!(r#""{absolute}", "../alias", "../lib1/../lib1""#));
    let (graph, _) = run(&repo, None).unwrap();
    let sources: Vec<&String> = graph
        .files
        .keys()
        .filter(|p| p.ends_with("A.fst"))
        .collect();
    assert_eq!(sources, ["../lib1/A.fst"]);
}

#[test]
fn fstar_cwd_and_uncovered_input_parents_are_flat_roots() {
    let (dir, repo) = scratch();
    let root = dir.path();
    write(root, "lib1/A.fst", "module A\nlet pick (n:nat) = n\n");
    write(root, "repo/A.fst", "module A\nlet pick (n:nat) = n\n");
    write(
        root,
        "repo/src/Helper.fst",
        "module Helper\nlet help (n:nat) = n\n",
    );
    write(
        root,
        "repo/src/Main.fst",
        "module Main\nopen A\nopen Helper\n",
    );
    write(
        root,
        "repo/src/Qualified.fst",
        "module Qualified\nopen Src.Helper\n",
    );
    let configure = |includes: &str| {
        write(
            root,
            "repo/p.fst.config.json",
            &format!(r#"{{"include_dirs": [{includes}], "options": ["--no_default_includes"]}}"#),
        )
    };
    configure(r#""../lib1""#);
    let (graph, _) = run(&repo, None).unwrap();
    // The cwd root comes last, shadowing explicit roots; `src` is an uncovered input parent.
    assert_eq!(imports(&graph, "src/Main.fst"), ["A.fst", "src/Helper.fst"]);
    assert!(imports(&graph, "src/Qualified.fst").is_empty());
    // A recursive explicit root that covers `src` leaves only the namespaced name.
    configure(r#""../lib1", ".""#);
    let (graph, _) = run(&repo, None).unwrap();
    assert_eq!(imports(&graph, "src/Main.fst"), ["A.fst"]);
    assert_eq!(imports(&graph, "src/Qualified.fst"), ["src/Helper.fst"]);
}

#[test]
fn fstar_manifests_namespaces_and_nested_include_roots() {
    let (dir, repo) = scratch();
    let root = dir.path();
    // Like the compiler, an absent child (installed libraries list optional ones) adds nothing.
    write(
        root,
        "lib/fstar.include",
        "# children\r\n\r\n  child  \r\nabsent\n",
    );
    write(root, "lib/Top.fst", "module Top\nlet top = 0\n");
    write(root, "lib/Sub/Flat.fst", "module Sub.Flat\nlet flat = 0\n");
    write(root, "lib/child/A/B/C.fst", "module A.B.C\nlet deep = 0\n");
    write(root, "lib/child/bad-dir/D.fst", "module D\nlet d = 0\n");
    write(
        root,
        "repo/Main.fst",
        "module Main\nopen Top\nopen Sub.Flat\nopen A.B.C\nopen C\nopen B.C\nopen D\n",
    );
    let options = ["--no_default_includes"];
    let (graph, report) = run(&repo, Some(fstar(&options, &["../lib"]))).unwrap();
    assert_eq!(
        imports(&graph, "Main.fst"),
        ["../lib/Top.fst", "../lib/child/A/B/C.fst"]
    );
    assert_eq!(report.unresolved_imports, 4);
    // An include root owns its subtree; a named root needs no namespace-valid name.
    let includes = ["../lib", "../lib/child/A", "../lib/child/bad-dir"];
    let (graph, report) = run(&repo, Some(fstar(&options, &includes))).unwrap();
    assert_eq!(
        imports(&graph, "Main.fst"),
        [
            "../lib/Top.fst",
            "../lib/child/A/B/C.fst",
            "../lib/child/bad-dir/D.fst"
        ]
    );
    assert_eq!(report.unresolved_imports, 3);

    write(root, "lib2/N/E.fst", "module N.E\nlet e = 0\n");
    write(root, "repo/Other.fst", "module Other\nopen N.E\n");
    let (graph, _) = run(&repo, Some(fstar(&options, &["../lib2"]))).unwrap();
    assert_eq!(imports(&graph, "Other.fst"), ["../lib2/N/E.fst"]);
    // A manifest makes its directory flat.
    write(root, "lib2/fstar.include", "");
    let (graph, report) = run(&repo, Some(fstar(&options, &["../lib2"]))).unwrap();
    assert!(imports(&graph, "Other.fst").is_empty());
    assert!(!graph.files.contains_key("../lib2/N/E.fst"));
    assert_eq!(report.files_removed, 1);
}

#[test]
fn fstar_same_root_duplicates_fail_and_roles_shadow_independently() {
    let (dir, repo) = scratch();
    let root = dir.path();
    write(
        root,
        "repo/Main.fst",
        "module Main\nopen M\nlet run (n:nat) = pick n\n",
    );
    let request = |includes: &[&str]| Some(fstar(&["--no_default_includes"], includes));
    write(root, "dup/A.B.fst", "module A.B\n");
    write(root, "dup/A/B.fst", "module A.B\n");
    let error = run(&repo, request(&["../dup"])).unwrap_err();
    assert!(
        error.contains("dup/A.B.fst") && error.contains("dup/A/B.fst"),
        "{error}"
    );
    fs::remove_dir_all(root.join("dup/A")).unwrap();
    write(root, "dup/a.b.fst", "module A.B\n");
    let error = run(&repo, request(&["../dup"])).unwrap_err();
    assert!(
        error.contains("dup/A.B.fst") && error.contains("dup/a.b.fst"),
        "{error}"
    );
    fs::remove_file(root.join("dup/a.b.fst")).unwrap();
    write(root, "dup/A.B.fsti", "module A.B\n");
    run(&repo, request(&["../dup"])).unwrap();

    write(root, "lib1/M.fsti", "module M\nval pick : nat -> nat\n");
    write(root, "lib1/M.fst", "module M\nlet pick (n:nat) = n\n");
    write(root, "lib2/M.fsti", "module M\nval pick : nat -> nat\n");
    let (graph, _) = run(&repo, request(&["../lib1", "../lib2"])).unwrap();
    assert_eq!(imports(&graph, "Main.fst"), ["../lib1/M.fst"]);
    assert_eq!(uses(&graph, "Main.fst", "run"), ["../lib1/M.fst#pick"]);
    assert!(graph.files.contains_key("../lib2/M.fsti"));
    assert!(!graph.files.contains_key("../lib1/M.fsti"));
    fs::remove_file(root.join("lib1/M.fst")).unwrap();
    let (graph, _) = run(&repo, request(&["../lib1", "../lib2"])).unwrap();
    assert_eq!(imports(&graph, "Main.fst"), ["../lib2/M.fsti"]);
    assert_eq!(uses(&graph, "Main.fst", "run"), ["../lib2/M.fsti#pick"]);
}

#[test]
fn fstar_nested_projects_bind_only_their_own_roots() {
    let (dir, repo) = scratch();
    let root = dir.path();
    write(root, "lib1/A.fst", "module A\nlet pick (n:nat) = n\n");
    write(
        root,
        "lib2/A.fst",
        "module A\nlet pick (n:nat) = n\nlet only_two (n:nat) = n\n",
    );
    write(root, "lib2/B.fst", "module B\nlet bee (n:nat) = n\n");
    write(
        root,
        "shared/S.fst",
        "module S\nopen A\nlet shared (n:nat) = pick n\n",
    );
    write(root, "lib1/H.fst", "module H\nlet helper (n:nat) = n\n");
    write(root, "lib2/H.fst", "module H\nlet helper (n:nat) = n\n");
    write(
        root,
        "shared/T.fst",
        "module T\nlet unopened (n:nat) = helper n\n",
    );
    for (project, lib) in [("p1", "lib1"), ("p2", "lib2")] {
        write(
            root,
            &format!("repo/{project}/{project}.fst.config.json"),
            &format!(
                r#"{{"include_dirs": ["../../{lib}", "../../shared"], "options": ["--no_default_includes"]}}"#
            ),
        );
        write(
            root,
            &format!("repo/{project}/Main.fst"),
            "\
module Main
open A
module X = A
let aliased (n:nat) = X.pick n
let qualified (n:nat) = A.pick n
let opened (n:nat) = pick n
let unrelated (n:nat) = only_two n
let fallback (n:nat) = bee n
#lang-pulse
fn body (x:nat) { return pick x; }
",
        );
    }
    let (graph, report) = run(&repo, None).unwrap();
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    for (project, lib) in [("p1", "lib1"), ("p2", "lib2")] {
        let main = format!("{project}/Main.fst");
        assert_eq!(imports(&graph, &main), [format!("../{lib}/A.fst")]);
        for name in ["aliased", "qualified", "opened", "body"] {
            assert_eq!(
                uses(&graph, &main, name),
                [format!("../{lib}/A.fst#pick")],
                "{main} {name}"
            );
        }
    }
    assert!(uses(&graph, "p1/Main.fst", "unrelated").is_empty());
    assert!(uses(&graph, "p1/Main.fst", "fallback").is_empty());
    assert_eq!(
        uses(&graph, "p2/Main.fst", "unrelated"),
        ["../lib2/A.fst#only_two"]
    );
    assert_eq!(
        uses(&graph, "p2/Main.fst", "fallback"),
        ["../lib2/B.fst#bee"]
    );
    // A shared source binds once per context that selects it.
    assert_eq!(
        imports(&graph, "../shared/S.fst"),
        ["../lib1/A.fst", "../lib2/A.fst"]
    );
    assert_eq!(
        uses(&graph, "../shared/S.fst", "shared"),
        ["../lib1/A.fst#pick", "../lib2/A.fst#pick"]
    );
    // Imports alike, but each context sees only its own unique `helper`.
    assert_eq!(
        uses(&graph, "../shared/T.fst", "unopened"),
        ["../lib1/H.fst#helper", "../lib2/H.fst#helper"]
    );
}

#[test]
fn fstar_configuration_discovery_overrides_arguments_and_errors() {
    let (dir, repo) = scratch();
    let root = dir.path();
    write(root, "lib1/A.fst", "module A\nlet pick (n:nat) = n\n");
    write(root, "lib2/A.fst", "module A\nlet pick (n:nat) = n\n");
    write(root, "repo/Main.fst", "module Main\nopen A\n");
    write(root, "repo/sub/Main.fst", "module Main\nopen A\n");
    write(
        root,
        "repo/root.fst.config.json",
        r#"{"_comment": "kept", "include_dirs": ["../lib1"], "options": ["--no_default_includes"]}"#,
    );
    let sub = |config: &str| write(root, "repo/sub/sub.fst.config.json", config);
    // The nearest config wins whole; parents are not merged.
    sub(r#"{"options": ["--no_default_includes"]}"#);
    let (graph, _) = run(&repo, None).unwrap();
    assert_eq!(imports(&graph, "Main.fst"), ["../lib1/A.fst"]);
    assert!(imports(&graph, "sub/Main.fst").is_empty());

    // Request fields replace only themselves; `[]` clears.
    let lib2 = root.join("lib2").display().to_string();
    let request = FstarConfig {
        include_dirs: Some(vec![lib2]),
        ..FstarConfig::default()
    };
    let (graph, _) = run(&repo, Some(request)).unwrap();
    assert_eq!(imports(&graph, "Main.fst"), ["../lib2/A.fst"]);
    assert_eq!(imports(&graph, "sub/Main.fst"), ["../lib2/A.fst"]);
    let request = FstarConfig {
        include_dirs: Some(Vec::new()),
        ..FstarConfig::default()
    };
    let (graph, _) = run(&repo, Some(request)).unwrap();
    assert!(imports(&graph, "Main.fst").is_empty());

    // A config's cwd is relative to the config; a request's to the graph root. Paths follow cwd.
    sub(
        r#"{"cwd": "../../lib2", "include_dirs": ["../lib1"], "options": ["--no_default_includes"]}"#,
    );
    let (graph, _) = run(&repo, None).unwrap();
    assert_eq!(imports(&graph, "sub/Main.fst"), ["../lib2/A.fst"]);
    let request = FstarConfig {
        cwd: Some(".".into()),
        include_dirs: Some(vec!["../lib1".into()]),
        ..FstarConfig::default()
    };
    let (graph, _) = run(&repo, Some(request)).unwrap();
    assert_eq!(imports(&graph, "sub/Main.fst"), ["../lib1/A.fst"]);

    // Options precede include_dirs; response files nest, all relative to one cwd.
    let selected = |config: &str| {
        sub(config);
        let (graph, _) = run(&repo, None).unwrap();
        imports(&graph, "sub/Main.fst")
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
    };
    assert_eq!(
        selected(
            r#"{"options": ["--no_default_includes", "--include", "../../lib2"], "include_dirs": ["../../lib1"]}"#
        ),
        ["../lib1/A.fst"]
    );
    write(
        root,
        "repo/sub/rsp/one.rsp",
        "--include\n../../lib1\n@rsp/two.rsp\n",
    );
    write(root, "repo/sub/rsp/two.rsp", "--include\n../../lib2\n");
    assert_eq!(
        selected(r#"{"options": ["--no_default_includes", "@rsp/one.rsp"]}"#),
        ["../lib2/A.fst"]
    );
    // Response files are reread on every refresh.
    write(root, "repo/sub/rsp/two.rsp", "--cache_dir\n../../absent\n");
    assert_eq!(
        selected(r#"{"options": ["--no_default_includes", "@rsp/one.rsp"]}"#),
        ["../lib1/A.fst"]
    );
    // Operands of other options are neither options nor response files.
    assert_eq!(
        selected(
            r#"{"options": ["--admit_except", "--include", "--warn_error", "@absent.rsp", "--no_default_includes"], "include_dirs": ["../../lib1"]}"#
        ),
        ["../lib1/A.fst"]
    );

    write(root, "repo/sub/rsp/loop.rsp", "@rsp/loop.rsp\n");
    write(root, "cycle/fstar.include", ".\n");
    fs::create_dir_all(root.join("links/N")).unwrap();
    symlink(root.join("links/N"), root.join("links/N/Loop")).unwrap();
    let cache = fs::read(cache_path(&repo)).unwrap();
    for (config, needle) in [
        ("{", "sub.fst.config.json"),
        (r#"{"options": 3}"#, "sub.fst.config.json"),
        (
            r#"{"options": ["--no_default_includes"], "include_dirs": ["$JUNCO_SURELY_UNSET_VARIABLE/x"]}"#,
            "JUNCO_SURELY_UNSET_VARIABLE",
        ),
        (
            r#"{"options": ["--no_default_includes"], "include_dirs": ["absent"]}"#,
            "absent",
        ),
        (
            r#"{"options": ["--no_default_includes"], "include_dirs": [""]}"#,
            "empty F* include",
        ),
        (
            r#"{"options": ["--no_default_includes", "--include"]}"#,
            "--include",
        ),
        (
            r#"{"options": ["--no_default_includes", "--frobnicate"]}"#,
            "--frobnicate",
        ),
        (
            r#"{"options": ["--no_default_includes", "Main.fst"]}"#,
            "Main.fst",
        ),
        (
            r#"{"options": ["--no_default_includes", "@rsp/loop.rsp"]}"#,
            "response files form a cycle",
        ),
        (
            r#"{"options": ["--no_default_includes"], "include_dirs": ["../../cycle"]}"#,
            "manifests form a cycle",
        ),
        (
            r#"{"options": ["--no_default_includes"], "include_dirs": ["../../links"]}"#,
            "loops",
        ),
    ] {
        sub(config);
        let error = run(&repo, None).unwrap_err();
        assert!(error.contains(needle), "{needle}: {error}");
        assert_eq!(fs::read(cache_path(&repo)).unwrap(), cache, "{needle}");
    }
    sub(r#"{"options": ["--no_default_includes"]}"#);
    write(root, "repo/sub/other.fst.config.json", "{}");
    let error = run(&repo, None).unwrap_err();
    assert!(error.contains("several F* configurations"), "{error}");
    assert_eq!(fs::read(cache_path(&repo)).unwrap(), cache);
    // Without F* sources nothing reads F* configuration.
    let (plain, plain_repo) = scratch();
    write(plain.path(), "repo/a.ts", "export const a = 1;\n");
    write(plain.path(), "repo/bad.fst.config.json", "{");
    run(&plain_repo, None).unwrap();
}

#[test]
fn fstar_refresh_tracks_external_sources_and_configuration() {
    let (dir, repo) = scratch();
    let root = dir.path();
    write(root, "lib1/A.fst", "module A\nlet pick (n:nat) = n\n");
    write(root, "lib2/A.fst", "module A\nlet pick (n:nat) = n\n");
    write(root, "repo/Main.fst", "module Main\nopen A\nopen B\n");
    write(root, "repo/sub/Use.fst", "module Use\nopen A\n");
    let configure = |includes: &str| {
        write(
            root,
            "repo/root.fst.config.json",
            &format!(r#"{{"include_dirs": [{includes}], "options": ["--no_default_includes"]}}"#),
        )
    };
    configure(r#""../lib1""#);
    run(&repo, None).unwrap();
    let (_, report) = run(&repo, None).unwrap();
    assert_eq!((report.files_parsed, report.files_reused), (0, 3));

    write(
        root,
        "lib1/A.fst",
        "module A\nlet pick (n:nat) = n\nlet fresh (n:nat) = n\n",
    );
    write(root, "lib1/B.fst", "module B\nlet bee (n:nat) = n\n");
    let (graph, report) = run(&repo, None).unwrap();
    assert_eq!((report.files_parsed, report.files_removed), (2, 0));
    assert!(
        graph.files["../lib1/A.fst"]
            .nodes
            .iter()
            .any(|n| n.name == "fresh")
    );
    assert_eq!(
        imports(&graph, "Main.fst"),
        ["../lib1/A.fst", "../lib1/B.fst"]
    );
    fs::remove_file(root.join("lib1/B.fst")).unwrap();
    let (graph, report) = run(&repo, None).unwrap();
    assert_eq!(report.files_removed, 1);
    assert_eq!(imports(&graph, "Main.fst"), ["../lib1/A.fst"]);

    // A nearer config takes over at once.
    write(
        root,
        "repo/sub/sub.fst.config.json",
        r#"{"include_dirs": ["../../lib2"], "options": ["--no_default_includes"]}"#,
    );
    let (graph, _) = run(&repo, None).unwrap();
    assert_eq!(imports(&graph, "sub/Use.fst"), ["../lib2/A.fst"]);
    assert_eq!(imports(&graph, "Main.fst"), ["../lib1/A.fst"]);
    // Dropping an include drops its sources.
    configure("");
    let (graph, report) = run(&repo, None).unwrap();
    assert_eq!(report.files_removed, 1);
    assert!(!graph.files.keys().any(|path| path.starts_with("../lib1/")));
    // A request configures a repository without F* sources from the graph root.
    let (plain, plain_repo) = scratch();
    write(plain.path(), "repo/a.ts", "export const a = 1;\n");
    write(plain.path(), "lib/L.fst", "module L\nlet l = 0\n");
    let (graph, _) = run(
        &plain_repo,
        Some(fstar(&["--no_default_includes"], &["../lib"])),
    )
    .unwrap();
    assert!(graph.files.contains_key("../lib/L.fst"));
    assert!(graph.files.contains_key("a.ts"));
}

/// Environment-dependent discovery runs in child processes with their own environment.
#[test]
fn fstar_environment_locates_libraries() {
    let (dir, _) = scratch();
    let root = dir.path();
    write(root, "lib1/A.fst", "module A\nlet pick (n:nat) = n\n");
    write(
        root,
        "repo/Main.fst",
        "module Main\nopen A\nopen L\nopen FStarC.X\n",
    );
    write(root, "inst/bin/fstar.exe", "#!/bin/sh\nexit 1\n");
    fs::set_permissions(
        root.join("inst/bin/fstar.exe"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    write(root, "inst/lib/fstar/L.fst", "module L\nlet l = 0\n");
    write(
        root,
        "inst/lib/fstar/fstarc/FStarC.X.fst",
        "module FStarC.X\nlet x = 0\n",
    );
    fs::create_dir_all(root.join("empty")).unwrap();
    for (scenario, fstar_lib, path) in [
        ("fstar_lib", Some("lib1"), "empty"),
        ("installed", None, "inst/bin"),
        ("absent", None, "empty"),
    ] {
        let mut child = Command::new(env::current_exe().unwrap());
        child
            .args(["fstar_environment_child", "--exact", "--ignored"])
            .env("JUNCO_FSTAR_SCENARIO", scenario)
            .env("JUNCO_FSTAR_ROOT", root)
            .env("JUNCO_FSTAR_LIBS", root)
            .env("PATH", root.join(path))
            .env_remove("FSTAR_LIB");
        if let Some(lib) = fstar_lib {
            child.env("FSTAR_LIB", root.join(lib));
        }
        let output = child.output().unwrap();
        assert!(
            output.status.success() && String::from_utf8_lossy(&output.stdout).contains("1 passed"),
            "{scenario}: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
#[ignore = "run by fstar_environment_locates_libraries with its environment"]
fn fstar_environment_child() {
    let (Ok(scenario), Ok(root)) = (
        env::var("JUNCO_FSTAR_SCENARIO"),
        env::var("JUNCO_FSTAR_ROOT"),
    ) else {
        return;
    };
    let root = Path::new(&root);
    let repo = root.join("repo");
    let selected = |fstar: Option<FstarConfig>| {
        let (graph, _) = run(&repo, fstar).unwrap();
        imports(&graph, "Main.fst")
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
    };
    let exe = Some("../inst/bin/fstar.exe".to_string());
    let fstarc = FstarConfig {
        fstar_exe: exe.clone(),
        ..fstar(&["--no_default_includes", "--with_fstarc"], &[])
    };
    match scenario.as_str() {
        "fstar_lib" => {
            assert_eq!(selected(None), ["../lib1/A.fst"]);
            assert!(selected(Some(fstar(&["--no_default_includes"], &[]))).is_empty());
            assert_eq!(
                selected(Some(fstarc)),
                ["../inst/lib/fstar/fstarc/FStarC.X.fst"]
            );
            let variables = fstar(
                &["--no_default_includes"],
                &["${JUNCO_FSTAR_LIBS}/inst", "$JUNCO_FSTAR_LIBS/lib1"],
            );
            assert_eq!(selected(Some(variables)), ["../lib1/A.fst"]);
        }
        "installed" => {
            // The previous scenario's FSTAR_LIB roots leave the shared cache on refresh.
            let (graph, report) = run(&repo, None).unwrap();
            assert!(report.files_removed > 0);
            assert!(!graph.files.contains_key("../lib1/A.fst"));
            assert_eq!(imports(&graph, "Main.fst"), ["../inst/lib/fstar/L.fst"]);
            let missing = FstarConfig {
                fstar_exe: Some("absent.exe".into()),
                ..FstarConfig::default()
            };
            let error = run(&repo, Some(missing)).unwrap_err();
            assert!(error.contains("absent.exe"), "{error}");
        }
        "absent" => {
            assert!(selected(None).is_empty());
            let error = run(&repo, Some(fstar(&["--with_fstarc"], &[]))).unwrap_err();
            assert!(error.contains("--with_fstarc"), "{error}");
            assert_eq!(
                selected(Some(fstarc)),
                ["../inst/lib/fstar/fstarc/FStarC.X.fst"]
            );
        }
        other => panic!("unknown scenario {other}"),
    }
}
