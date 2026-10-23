use std::{fs, path::Path};

use rust_graph::*;

fn hb() -> Result<(), String> {
    Ok(())
}

fn write(root: &Path, rel: &str, text: &str) {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
}

fn build_full(root: &Path) -> (Graph, BuildReport) {
    build(root, BuildOptions { full: true }, &hb).unwrap()
}

fn incremental(root: &Path) -> (Graph, BuildReport) {
    build(root, BuildOptions { full: false }, &hb).unwrap()
}

fn node<'g>(g: &'g Graph, id: &str) -> &'g Node {
    g.files
        .values()
        .flat_map(|f| &f.nodes)
        .find(|n| n.id == id)
        .unwrap_or_else(|| panic!("missing node {id}"))
}

fn has_edge(
    g: &Graph,
    source: &str,
    target: &str,
    relation: Relation,
    confidence: Option<Confidence>,
) -> bool {
    g.edges.iter().any(|e| {
        e.source == source
            && e.target == target
            && e.relation == relation
            && confidence.is_none_or(|c| c == e.confidence)
    })
}

fn ts_fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "src/a.ts",
        "export function foo() { return 1 }\nexport class A {}\n",
    );
    write(
        dir.path(),
        "src/b.ts",
        "import { foo } from \"./a\";\nimport { A } from \"./a\";\nexport const bar = () => foo();\nexport class B extends A { run() { return bar() } }\n",
    );
    dir
}

#[test]
fn typescript_symbols_calls_imports_heritage() {
    let dir = ts_fixture();
    let (g, report) = build_full(dir.path());
    assert_eq!(report.files_total, 2);
    let foo = node(&g, "src/a.ts#foo:1");
    assert_eq!(foo.kind, NodeKind::Function);
    assert!(foo.exported);
    assert_eq!(node(&g, "src/b.ts#bar:3").kind, NodeKind::Function);
    let run = node(&g, "src/b.ts#B.run:4");
    assert_eq!(run.kind, NodeKind::Method);
    assert_eq!(run.owner.as_deref(), Some("src/b.ts#B:4"));
    let x = Some(Confidence::Extracted);
    assert!(has_edge(&g, "src/b.ts", "src/a.ts", Relation::Imports, x));
    assert!(has_edge(
        &g,
        "src/b.ts#bar:3",
        "src/a.ts#foo:1",
        Relation::Calls,
        x
    ));
    assert!(has_edge(
        &g,
        "src/b.ts#B:4",
        "src/a.ts#A:2",
        Relation::Extends,
        x
    ));
    assert!(has_edge(
        &g,
        "src/b.ts#B.run:4",
        "src/b.ts#bar:3",
        Relation::Calls,
        x
    ));
    assert!(dir.path().join(".junco/graph/graph.json").is_file());
}

#[test]
fn python_methods_and_imports() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "pkg/__init__.py", "");
    write(
        dir.path(),
        "pkg/x.py",
        "class A:\n    def m(self):\n        pass\n",
    );
    write(
        dir.path(),
        "y.py",
        "from pkg.x import A\n\ndef go():\n    return A().m()\n",
    );
    let (g, _) = build_full(dir.path());
    let m = node(&g, "pkg/x.py#A.m:2");
    assert_eq!(m.kind, NodeKind::Method);
    assert_eq!(m.owner.as_deref(), Some("pkg/x.py#A:1"));
    assert!(has_edge(
        &g,
        "y.py",
        "pkg/x.py",
        Relation::Imports,
        Some(Confidence::Extracted)
    ));
    assert!(has_edge(
        &g,
        "y.py#go:3",
        "pkg/x.py#A:1",
        Relation::Calls,
        Some(Confidence::Extracted)
    ));
    assert!(has_edge(
        &g,
        "y.py#go:3",
        "pkg/x.py#A.m:2",
        Relation::Calls,
        Some(Confidence::Inferred)
    ));
}

#[test]
fn rust_mod_use_and_impl_methods() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "Cargo.toml",
        "[package]\nname=\"t\"\nversion=\"0.1.0\"\n",
    );
    write(
        dir.path(),
        "src/lib.rs",
        "mod util;\nuse crate::util::helper;\npub struct S;\nimpl S { pub fn go(&self) -> u32 { helper() } }\n",
    );
    write(dir.path(), "src/util.rs", "pub fn helper() -> u32 { 1 }\n");
    let (g, _) = build_full(dir.path());
    let imports: Vec<_> = g
        .edges
        .iter()
        .filter(|e| e.relation == Relation::Imports)
        .collect();
    assert_eq!(imports.len(), 1, "{imports:?}");
    assert!(has_edge(
        &g,
        "src/lib.rs",
        "src/util.rs",
        Relation::Imports,
        None
    ));
    assert!(has_edge(
        &g,
        "src/lib.rs#S.go:4",
        "src/util.rs#helper:1",
        Relation::Calls,
        Some(Confidence::Extracted)
    ));
    let go = node(&g, "src/lib.rs#S.go:4");
    assert_eq!(go.kind, NodeKind::Method);
    assert_eq!(go.owner.as_deref(), Some("src/lib.rs#S:3"));
}

#[test]
fn ambiguous_global_names_stay_unresolved() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "a.py", "def run(): pass\n");
    write(dir.path(), "b.py", "def run(): pass\n");
    write(dir.path(), "c.py", "def go():\n    run()\n");
    let (g, _) = build_full(dir.path());
    assert!(
        !g.edges
            .iter()
            .any(|e| e.source == "c.py#go:1" && e.relation == Relation::Calls)
    );
}

#[test]
fn incremental_rebuild_reuses_unchanged_files() {
    let dir = ts_fixture();
    build_full(dir.path());
    let a = dir.path().join("src/a.ts");
    let mut text = fs::read_to_string(&a).unwrap();
    text.push_str("export function extra() {}\n");
    fs::write(&a, text).unwrap();
    let (g, report) = incremental(dir.path());
    assert!(!report.full);
    assert_eq!((report.files_parsed, report.files_reused), (1, 1));
    node(&g, "src/a.ts#extra:3");

    fs::remove_file(dir.path().join("src/b.ts")).unwrap();
    let (g, report) = incremental(dir.path());
    assert_eq!(report.files_removed, 1);
    assert!(!g.edges.iter().any(|e| e.source.starts_with("src/b.ts")));

    let cache = cache_path(dir.path());
    let mut json: serde_json::Value = serde_json::from_slice(&fs::read(&cache).unwrap()).unwrap();
    json["extractor"] = 999.into();
    fs::write(&cache, serde_json::to_vec(&json).unwrap()).unwrap();
    let (_, report) = incremental(dir.path());
    assert!(report.full);
    assert_eq!(report.files_reused, 0);
}

fn query(q: &str) -> SearchQuery {
    SearchQuery {
        query: q.into(),
        kinds: None,
        path_prefix: None,
        lang: None,
        limit: 10,
    }
}

#[test]
fn search_ranks_and_filters() {
    let dir = ts_fixture();
    let (g, _) = build_full(dir.path());
    assert_eq!(search(&g, &query("foo")).hits[0].node.id, "src/a.ts#foo:1");
    let classes = search(
        &g,
        &SearchQuery {
            kinds: Some(vec![NodeKind::Class]),
            ..query("a b src")
        },
    );
    let mut names: Vec<_> = classes.hits.iter().map(|h| h.node.name.as_str()).collect();
    names.sort();
    assert_eq!(names, ["A", "B"]);
    let scoped = search(
        &g,
        &SearchQuery {
            path_prefix: Some("src/b".into()),
            ..query("foo src")
        },
    );
    assert!(!scoped.hits.is_empty());
    assert!(scoped.hits.iter().all(|h| h.node.path == "src/b.ts"));
}

fn deps(symbol: &str, path: Option<&str>, direction: Direction, depth: u32) -> DependencyQuery {
    DependencyQuery {
        symbol: symbol.into(),
        path: path.map(Into::into),
        direction,
        depth,
        relations: None,
    }
}

#[test]
fn dependency_walks_and_ambiguity() {
    let dir = ts_fixture();
    let (g, _) = build_full(dir.path());
    let r = dependencies(&g, &deps("foo", None, Direction::In, 2)).unwrap();
    let found: Vec<_> = r
        .nodes
        .iter()
        .map(|n| (n.node.id.as_str(), n.depth))
        .collect();
    assert!(found.contains(&("src/b.ts#bar:3", 1)), "{found:?}");
    assert!(found.contains(&("src/b.ts#B.run:4", 2)), "{found:?}");
    assert!(dependencies(&g, &deps("run", None, Direction::Out, 1)).is_ok());

    write(dir.path(), "src/c.ts", "export function run() {}\n");
    let g = refresh(dir.path(), &hb).unwrap();
    let err = dependencies(&g, &deps("run", None, Direction::Out, 1)).unwrap_err();
    assert!(
        err.contains("src/b.ts#B.run:4") && err.contains("src/c.ts#run:1"),
        "{err}"
    );
    let r = dependencies(&g, &deps("run", Some("src/c.ts"), Direction::Out, 1)).unwrap();
    assert_eq!(r.seed.id, "src/c.ts#run:1");
    assert!(
        dependencies(&g, &deps("nope", None, Direction::In, 1))
            .unwrap_err()
            .contains("no symbol named nope")
    );
}

#[test]
fn map_clusters_and_hotspots() {
    let dir = ts_fixture();
    write(dir.path(), "lib/z.ts", "export const z = 1;\n");
    let (g, _) = build_full(dir.path());
    let m = map(&g);
    let clusters: Vec<_> = m
        .clusters
        .iter()
        .map(|c| (c.dir.as_str(), c.files))
        .collect();
    assert_eq!(clusters, [("src", 2), ("lib", 1)]);
    let mut hot: Vec<_> = m.hotspots.iter().map(|h| h.id.as_str()).collect();
    hot.sort();
    assert_eq!(hot, ["src/a.ts#A:2", "src/a.ts#foo:1", "src/b.ts#bar:3"]);
}
