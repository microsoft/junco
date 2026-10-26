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

fn node<'g>(graph: &'g Graph, id: &str) -> &'g Node {
    graph
        .files
        .values()
        .flat_map(|file| &file.nodes)
        .find(|node| node.id == id)
        .unwrap_or_else(|| panic!("missing node {id}"))
}

fn edge(graph: &Graph, from: &str, to: &str, relation: Relation) -> bool {
    graph
        .edges
        .iter()
        .any(|edge| edge.source == from && edge.target == to && edge.relation == relation)
}

#[test]
fn rocq_realistic_proofs_namespaces_imports_and_queries() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "Proofs/Base.v",
        concat!(
            "(* Definition phantom := 0. (* Lemma ghost : True. *) *)\n",
            "Module Facts.\n",
            "Section Parameters.\n",
            "Variable A : Type.\n",
            "Definition n : nat := 0.\n",
            "Lemma identity (n : nat) : n = n.\n",
            "Proof.\n",
            "  reflexivity.\n",
            "Qed.\n",
            "Definition alias (x : nat) := x.\n",
            "Inductive count : Type := | zero : count | succ : count -> count.\n",
            "Record box : Type := Build_box { value : nat }.\n",
            "Class named : Type := { label : nat }.\n",
            "Axiom assumed : nat.\n",
            "Fixpoint peel (x : count) : nat :=\n",
            "  match x with | zero => 0 | succ k => peel k end.\n",
            "End Parameters.\n",
            "End Facts.\n",
            "Definition text := \"Lemma string_fake : True. Qed.\".\n",
        ),
    );
    write(
        dir.path(),
        "Proofs/Aux.v",
        "Definition helper : nat := 0.\n",
    );
    write(
        dir.path(),
        "Proofs/Main.v",
        concat!(
            "From Proofs Require Import Base Aux.\n",
            "Module Client.\n",
            "Section Scratch.\n",
            "Lemma reuse (n : nat) : n = n.\n",
            "Proof.\n",
            "  exact (Facts.identity n).\n",
            "Qed.\n",
            "Definition use (x : nat) := Facts.alias x.\n",
            "End Scratch.\n",
            "End Client.\n",
            "Lemma finished : True.\n",
            "Proof. exact I. Defined.\n",
        ),
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
    assert_eq!(report.files_total, 3);
    assert_eq!(report.languages.get("rocq"), Some(&3));
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    let identity = "Proofs/Base.v#Facts.identity:6";
    let reuse = "Proofs/Main.v#Client.reuse:4";
    assert_eq!(node(&graph, identity).end_line, 9);
    assert_eq!(
        node(&graph, identity).owner.as_deref(),
        Some("Proofs/Base.v#Facts:2")
    );
    assert!(
        node(&graph, identity)
            .signature
            .starts_with("Lemma identity (n : nat)")
    );
    assert_eq!(node(&graph, reuse).end_line, 7);
    assert_eq!(node(&graph, "Proofs/Main.v#finished:11").end_line, 12);
    assert_eq!(node(&graph, "Proofs/Base.v#Facts:2").end_line, 18);
    for (id, kind) in [
        ("Proofs/Base.v#Facts.alias:10", NodeKind::Function),
        ("Proofs/Base.v#Facts.count:11", NodeKind::Type),
        ("Proofs/Base.v#Facts.count.zero:11", NodeKind::Constant),
        ("Proofs/Base.v#Facts.count.succ:11", NodeKind::Constant),
        ("Proofs/Base.v#Facts.box:12", NodeKind::Type),
        ("Proofs/Base.v#Facts.box.value:12", NodeKind::Field),
        ("Proofs/Base.v#Facts.named:13", NodeKind::Class),
        ("Proofs/Base.v#Facts.named.label:13", NodeKind::Field),
        ("Proofs/Base.v#Facts.assumed:14", NodeKind::Constant),
        ("Proofs/Base.v#Facts.peel:15", NodeKind::Function),
        ("Proofs/Base.v#text:19", NodeKind::Function),
    ] {
        assert_eq!(node(&graph, id).kind, kind, "{id}");
    }
    let imports: Vec<_> = graph.files["Proofs/Main.v"]
        .imports
        .iter()
        .map(|import| import.module.as_str())
        .collect();
    assert_eq!(imports, ["Proofs:Base", "Proofs:Aux"]);
    for target in ["Proofs/Base.v", "Proofs/Aux.v"] {
        assert!(edge(&graph, "Proofs/Main.v", target, Relation::Imports));
    }
    assert!(edge(&graph, reuse, identity, Relation::References));
    assert!(edge(
        &graph,
        "Proofs/Main.v#Client.use:8",
        "Proofs/Base.v#Facts.alias:10",
        Relation::References
    ));
    assert!(
        graph.files["Proofs/Main.v"].raw_edges.iter().any(|edge| {
            edge.from == reuse && edge.target == "Facts.identity" && edge.line == 6
        })
    );
    assert!(
        !graph.files["Proofs/Base.v"]
            .raw_edges
            .iter()
            .any(|edge| { edge.from == identity && edge.target == "n" })
    );
    assert!(
        !graph
            .files
            .values()
            .flat_map(|file| &file.nodes)
            .any(|node| {
                [
                    "phantom",
                    "ghost",
                    "string_fake",
                    "A",
                    "x",
                    "k",
                    "Parameters",
                    "Scratch",
                ]
                .contains(&node.name.as_str())
            })
    );
    let mapped = map(&graph);
    assert_eq!(mapped.files, 3);
    assert!(mapped.languages.iter().any(|language| language == "rocq"));
    let found = search(
        &graph,
        &SearchQuery {
            query: "identity".into(),
            kinds: None,
            path_prefix: None,
            lang: Some("rocq".into()),
            limit: 10,
        },
    );
    assert!(found.hits.iter().any(|hit| hit.node.id == identity));
    let deps = dependencies(
        &graph,
        &DependencyQuery {
            symbol: reuse.into(),
            path: None,
            direction: Direction::Out,
            depth: 1,
            relations: Some(vec![Relation::References]),
        },
    )
    .unwrap();
    assert!(
        deps.nodes
            .iter()
            .any(|dependency| dependency.node.id == identity)
    );
    let clusters = cluster(
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
        clusters
            .modules
            .iter()
            .any(|module| module.members.iter().any(|id| id == reuse))
    );
    assert!(
        clusters
            .modules
            .iter()
            .any(|module| module.members.iter().any(|id| id == identity))
    );

    let (_, cached) = build(
        dir.path(),
        BuildOptions {
            full: false,
            fstar: None,
        },
        &hb,
    )
    .unwrap();
    assert_eq!((cached.files_parsed, cached.files_reused), (0, 3));
    write(
        dir.path(),
        "Proofs/Main.v",
        concat!(
            "From Proofs Require Import Base.\n",
            "Lemma fresh (n : nat) : n = n.\n",
            "Proof. exact (Facts.identity n). Qed.\n",
        ),
    );
    let refreshed = refresh(dir.path(), None, &hb).unwrap();
    assert!(edge(
        &refreshed,
        "Proofs/Main.v#fresh:2",
        identity,
        Relation::References
    ));
    assert!(!refreshed.edges.iter().any(|edge| edge.source == reuse));
    assert_eq!(node(&refreshed, "Proofs/Main.v#fresh:2").end_line, 3);
}

#[test]
fn rocq_nested_modules_sections_and_local_binders() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "Nested.v",
        concat!(
            "Definition x : nat := 0.\n",
            "Definition H : True := I.\n",
            "Module Outer.\n",
            "Module Inner.\n",
            "Section S.\n",
            "Lemma bound : forall (x : nat), x = x.\n",
            "Proof. intros x. reflexivity. Qed.\n",
            "Lemma shadow : True -> True.\n",
            "Proof. intros H. exact H. Defined.\n",
            "End S.\n",
            "End Inner.\n",
            "End Outer.\n",
            "Lemma unqualified : True. Proof. exact I. Admitted.\n",
        ),
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
    assert_eq!(node(&graph, "Nested.v#Outer.Inner.bound:6").end_line, 7);
    assert_eq!(node(&graph, "Nested.v#Outer.Inner.shadow:8").end_line, 9);
    assert_eq!(node(&graph, "Nested.v#unqualified:13").owner, None);
    assert_eq!(
        node(&graph, "Nested.v#Outer.Inner:4").owner.as_deref(),
        Some("Nested.v#Outer:3")
    );
    assert!(!graph.edges.iter().any(|edge| {
        (edge.source == "Nested.v#Outer.Inner.bound:6" && edge.target == "Nested.v#x:1")
            || (edge.source == "Nested.v#Outer.Inner.shadow:8" && edge.target == "Nested.v#H:2")
    }));
}
