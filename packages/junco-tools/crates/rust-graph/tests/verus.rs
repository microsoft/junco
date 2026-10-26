use std::{fs, path::Path};

use rust_graph::*;

fn hb() -> Result<(), String> {
    Ok(())
}

fn write(root: &Path, path: &str, source: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, source).unwrap();
}

fn symbol<'a>(graph: &'a Graph, path: &str, name: &str) -> &'a Node {
    let mut nodes = graph.files[path]
        .nodes
        .iter()
        .filter(|node| node.name == name);
    let node = nodes
        .next()
        .unwrap_or_else(|| panic!("missing {path}#{name}"));
    assert!(nodes.next().is_none(), "ambiguous {path}#{name}");
    node
}

fn edge(graph: &Graph, source: &str, target: &str, relation: Relation) -> bool {
    graph.edges.iter().any(|edge| {
        edge.source == source
            && edge.target == target
            && edge.relation == relation
            && edge.confidence == Confidence::Extracted
    })
}

const LIB: &str = r#"mod plain;
mod proof;
use crate::plain::helper;
use crate::proof::{bounded, lemma_bound};
verus! {
pub struct Counter {
    pub value: u64,
}
pub enum State { Idle, Ready }
pub type Count = u64;
pub trait Verified {
    fn verified(&self) -> bool;
}
impl Counter {
    pub fn run(&self) -> (result: u64)
        requires bounded(self.value),
        ensures bounded(result),
    {
        proof { lemma_bound(self.value); }
        let _ = helper(self.value);
        self.value
    }
}
impl Verified for Counter { fn verified(&self) -> bool { true } }
pub fn make(value: u64) -> Counter { Counter { value } }
}
"#;

const PROOF: &str = r#"verus! {
pub open spec fn measure(n: u64) -> u64 { n }
pub open spec fn bounded(n: u64) -> bool { n < 100 }
pub proof fn lemma_bound(n: u64)
    requires bounded(n),
    ensures bounded(n),
    decreases measure(n),
{
    assert(bounded(n)) by { assert(n < 100); }
}
pub fn verified_add(n: u64) -> (result: u64)
    requires bounded(n),
    ensures result == n,
{ n }
}
"#;

const PLAIN: &str = "use crate::proof::verified_add;\npub fn helper(n: u64) -> u64 { n }\npub fn plain_caller(n: u64) -> u64 { verified_add(n) }\n";

#[test]
fn wrapped_verus_definitions_contracts_program_calls_and_refresh() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "Cargo.toml",
        "[package]\nname=\"verus_graph_fixture\"\nversion=\"0.1.0\"\n",
    );
    write(dir.path(), "src/lib.rs", LIB);
    write(dir.path(), "src/proof.rs", PROOF);
    write(dir.path(), "src/plain.rs", PLAIN);
    let (graph, report) = build(
        dir.path(),
        BuildOptions {
            full: true,
            fstar: None,
        },
        &hb,
    )
    .unwrap();
    assert_eq!(report.files_total, 3);
    assert_eq!(graph.files["src/lib.rs"].lang, "verus");
    assert_eq!(graph.files["src/proof.rs"].lang, "verus");
    assert_eq!(graph.files["src/plain.rs"].lang, "rust");
    assert!(graph.files.values().all(|file| file.error.is_none()));

    let counter = symbol(&graph, "src/lib.rs", "Counter");
    assert_eq!(counter.id, "src/lib.rs#Counter:6");
    assert_eq!((counter.start_line, counter.end_line), (6, 8));
    let field = symbol(&graph, "src/lib.rs", "value");
    assert_eq!(field.kind, NodeKind::Field);
    assert_eq!(field.id, "src/lib.rs#Counter.value:7");
    assert_eq!(field.owner.as_deref(), Some(counter.id.as_str()));
    let run = symbol(&graph, "src/lib.rs", "run");
    assert_eq!(run.id, "src/lib.rs#Counter.run:15");
    assert_eq!(run.kind, NodeKind::Method);
    assert_eq!(run.owner.as_deref(), Some(counter.id.as_str()));
    assert_eq!((run.start_line, run.end_line), (15, 22));
    assert!(run.exported);
    assert_eq!(symbol(&graph, "src/lib.rs", "State").kind, NodeKind::Class);
    assert_eq!(symbol(&graph, "src/lib.rs", "Count").kind, NodeKind::Type);
    let verified = symbol(&graph, "src/lib.rs", "Verified");
    assert_eq!(verified.kind, NodeKind::Interface);
    let trait_method = graph.files["src/lib.rs"]
        .nodes
        .iter()
        .find(|node| node.id == "src/lib.rs#Verified.verified:12")
        .unwrap();
    assert_eq!(trait_method.kind, NodeKind::Method);
    assert_eq!(trait_method.owner.as_deref(), Some(verified.id.as_str()));
    assert!(edge(
        &graph,
        &counter.id,
        &verified.id,
        Relation::Implements
    ));
    assert!(
        !graph
            .files
            .values()
            .flat_map(|file| &file.nodes)
            .any(|node| node.name == "result")
    );

    let bounded = symbol(&graph, "src/proof.rs", "bounded");
    let measure = symbol(&graph, "src/proof.rs", "measure");
    let lemma = symbol(&graph, "src/proof.rs", "lemma_bound");
    assert_eq!(lemma.id, "src/proof.rs#lemma_bound:4");
    assert_eq!((lemma.start_line, lemma.end_line), (4, 10));
    assert!(lemma.exported && bounded.exported && measure.exported);
    let helper = symbol(&graph, "src/plain.rs", "helper");
    let caller = symbol(&graph, "src/plain.rs", "plain_caller");
    let verified_add = symbol(&graph, "src/proof.rs", "verified_add");
    for (from, to) in [
        (&run.id, &bounded.id),
        (&run.id, &lemma.id),
        (&run.id, &helper.id),
        (&lemma.id, &bounded.id),
        (&lemma.id, &measure.id),
        (&verified_add.id, &bounded.id),
        (&caller.id, &verified_add.id),
    ] {
        assert!(
            edge(&graph, from, to, Relation::Calls),
            "missing {from} -> {to}"
        );
    }
    for (from, to) in [
        ("src/lib.rs", "src/proof.rs"),
        ("src/lib.rs", "src/plain.rs"),
        ("src/plain.rs", "src/proof.rs"),
    ] {
        assert!(
            edge(&graph, from, to, Relation::Imports),
            "missing {from} -> {to}"
        );
    }
    let contract_lines: Vec<_> = graph.files["src/proof.rs"]
        .raw_edges
        .iter()
        .filter(|reference| reference.from == lemma.id && reference.target == "bounded")
        .map(|reference| reference.line)
        .collect();
    assert_eq!(contract_lines, [5, 6, 9]);

    let overview = map(&graph);
    assert_eq!(overview.languages, ["rust", "verus"]);
    assert!(overview.symbols >= 15);
    let found = search(
        &graph,
        &SearchQuery {
            query: "lemma_bound".into(),
            kinds: None,
            path_prefix: None,
            lang: Some("verus".into()),
            limit: 10,
        },
    );
    assert_eq!(found.hits[0].node.id, lemma.id);
    let deps = dependencies(
        &graph,
        &DependencyQuery {
            symbol: run.id.clone(),
            path: None,
            direction: Direction::Out,
            depth: 2,
            relations: Some(vec![Relation::Calls]),
        },
    )
    .unwrap();
    assert!(deps.nodes.iter().any(|node| node.node.id == measure.id));
    let clustered = cluster(
        &graph,
        &ClusterOptions {
            max_size: 1,
            omnipresent: Some(u32::MAX),
            prefixes: vec![],
            excludes: vec![],
        },
    )
    .unwrap();
    let module_for = |id: &str| {
        &clustered
            .modules
            .iter()
            .find(|module| module.members.iter().any(|member| member == id))
            .unwrap()
            .id
    };
    assert!(
        clustered
            .edges
            .iter()
            .any(|edge| { edge.from == *module_for(&run.id) && edge.to == *module_for(&lemma.id) })
    );

    let (unchanged, cached) = build(
        dir.path(),
        BuildOptions {
            full: false,
            fstar: None,
        },
        &hb,
    )
    .unwrap();
    assert_eq!((cached.files_parsed, cached.files_reused), (0, 3));
    assert_eq!(graph, unchanged);
    write(
        dir.path(),
        "src/proof.rs",
        &format!("{PROOF}verus! {{ pub proof fn refreshed() {{ lemma_bound(0); }} }}\n"),
    );
    let (refreshed, changed) = build(
        dir.path(),
        BuildOptions {
            full: false,
            fstar: None,
        },
        &hb,
    )
    .unwrap();
    assert_eq!((changed.files_parsed, changed.files_reused), (1, 2));
    let extra = symbol(&refreshed, "src/proof.rs", "refreshed");
    assert!(edge(&refreshed, &extra.id, &lemma.id, Relation::Calls));
}

#[test]
fn routing_ignores_literals_comments_and_opaque_macro_templates() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "ordinary.rs",
        r##"// verus! { pub proof fn comment() {} }
/* pub open spec fn block_comment() {} */
pub const EXAMPLE: &str = "verus! { pub proof fn string_fake() {} }";
pub const RAW: &str = r#"proof fn raw_fake() {} verus! {}"#;
macro_rules! template { () => { proof fn opaque_fake() {} } }
pub fn ordinary(proof: u64, spec: u64) -> u64 { proof + spec }
"##,
    );
    write(
        dir.path(),
        "standalone.rs",
        "pub open spec fn predicate(n: u64) -> bool { n == n }\npub proof fn standalone(n: u64)\n    requires predicate(n),\n    ensures predicate(n),\n{ assert(predicate(n)); }\n",
    );
    write(
        dir.path(),
        "contracts.rs",
        "pub fn contract(n: u64) -> u64\n    requires n < 100,\n    ensures true,\n{ n }\n",
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
    assert_eq!(graph.files["ordinary.rs"].lang, "rust");
    assert_eq!(graph.files["standalone.rs"].lang, "verus");
    assert_eq!(graph.files["contracts.rs"].lang, "verus");
    let names: Vec<_> = graph.files["ordinary.rs"]
        .nodes
        .iter()
        .map(|node| node.name.as_str())
        .collect();
    assert_eq!(names, ["template", "ordinary"]);
    let predicate = symbol(&graph, "standalone.rs", "predicate");
    let proof = symbol(&graph, "standalone.rs", "standalone");
    assert!(edge(&graph, &proof.id, &predicate.id, Relation::Calls));
    assert_eq!(symbol(&graph, "contracts.rs", "contract").end_line, 4);
}

#[test]
fn lexical_call_binders_do_not_become_global_proof_dependencies() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "proof.rs",
        r#"verus! {
pub open spec fn callback(n: u64) -> bool { n == n }
pub open spec fn local(n: u64) -> bool { n == n }
pub open spec fn predicate(n: u64) -> bool { n == n }
pub proof fn higher(callback: fn(u64) -> bool)
    requires callback(0),
    ensures callback(0),
{
    let local = |n: u64| n == n;
    assert(local(0));
    assert(forall|predicate: fn(u64) -> bool| predicate(0));
}
pub proof fn globals() {
    assert(callback(0));
    assert(local(0));
    assert(predicate(0));
}
pub proof fn nested() {
    assert(local(0));
    { let local = |n: u64| n == n; assert(local(0)); }
    assert(local(0));
}
}
"#,
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
    let higher = symbol(&graph, "proof.rs", "higher");
    let globals = symbol(&graph, "proof.rs", "globals");
    for name in ["callback", "local", "predicate"] {
        let target = symbol(&graph, "proof.rs", name);
        assert!(
            !edge(&graph, &higher.id, &target.id, Relation::Calls),
            "local {name} leaked"
        );
        assert!(edge(&graph, &globals.id, &target.id, Relation::Calls));
    }
    let nested = symbol(&graph, "proof.rs", "nested");
    let local_lines: Vec<_> = graph.files["proof.rs"]
        .raw_edges
        .iter()
        .filter(|reference| reference.from == nested.id && reference.target == "local")
        .map(|reference| reference.line)
        .collect();
    assert_eq!(local_lines, [19, 21]);
    assert!(
        !graph.files["proof.rs"]
            .nodes
            .iter()
            .any(|node| node.name == "n")
    );
}
