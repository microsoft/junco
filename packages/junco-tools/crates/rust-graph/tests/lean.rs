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

fn symbol<'g>(graph: &'g Graph, path: &str, name: &str) -> &'g Node {
    graph.files[path]
        .nodes
        .iter()
        .find(|n| n.name == name)
        .unwrap_or_else(|| panic!("missing {path}#{name}: {:?}", graph.files[path].nodes))
}

fn edge(graph: &Graph, from: &str, to: &str, relation: Option<Relation>) -> bool {
    graph
        .edges
        .iter()
        .any(|e| e.source == from && e.target == to && relation.is_none_or(|r| e.relation == r))
}

const BASE: &str = "\
namespace Demo
\ndef identité (n : Nat) : Nat := n
\ntheorem identité_eq (n : Nat) : identité n = n := by
  rfl
\nabbrev Nombre := Nat
\nopaque secret : Nat := 7
\naxiom lawful : True
\nconstant witness : Nat
\ninductive Choice where
  | first : Choice
  | next (n : Nat) : Choice
\nstructure Box where
  mk ::
  value : Nat
\nclass Named where
  name : Nat
\ninstance defaultNamed : Named where
  name := 0
\nnamespace Nested
\nlemma proof : True := lawful
\nend Nested
\nend Demo
\ndef outside : Nat := Demo.identité 0
";

#[test]
fn lean_declarations_namespaces_imports_and_proof_dependencies() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "Demo/Base.lean", BASE);
    write(
        dir.path(),
        "Main.lean",
        "\
import Demo.Base
namespace Client
section Work
variable (n : Nat)
def run : Nat := Demo.identité n
lemma result : Demo.identité n = n := by
  exact Demo.identité_eq n
end Work
end Client
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
    assert_eq!(report.languages.get("lean"), Some(&2));
    assert_eq!(graph.files["Main.lean"].imports[0].module, "Demo.Base");
    assert!(edge(
        &graph,
        "Main.lean",
        "Demo/Base.lean",
        Some(Relation::Imports)
    ));

    let run = symbol(&graph, "Main.lean", "run");
    assert_eq!(run.id, "Main.lean#Client.run:5");
    assert_eq!(run.kind, NodeKind::Function);
    assert_eq!(run.owner.as_deref(), Some("Main.lean#Client:2"));
    assert_eq!(symbol(&graph, "Main.lean", "Client").end_line, 9);
    let result = symbol(&graph, "Main.lean", "result");
    assert_eq!(result.id, "Main.lean#Client.result:6");
    assert_eq!((result.start_line, result.end_line), (6, 7));
    let identity = symbol(&graph, "Demo/Base.lean", "identité");
    assert!(identity.id.contains("#Demo.identité:"));
    assert!(edge(&graph, &run.id, &identity.id, Some(Relation::Calls)));
    assert!(edge(
        &graph,
        &result.id,
        &symbol(&graph, "Demo/Base.lean", "identité_eq").id,
        Some(Relation::Calls)
    ));
    assert!(edge(
        &graph,
        &symbol(&graph, "Demo/Base.lean", "proof").id,
        &symbol(&graph, "Demo/Base.lean", "lawful").id,
        Some(Relation::References)
    ));
    assert!(
        symbol(&graph, "Demo/Base.lean", "proof")
            .id
            .contains("#Demo.Nested.proof:")
    );
    assert_eq!(symbol(&graph, "Demo/Base.lean", "outside").owner, None);
    for (name, kind) in [
        ("Nombre", NodeKind::Function),
        ("secret", NodeKind::Function),
        ("lawful", NodeKind::Constant),
        ("witness", NodeKind::Constant),
        ("Choice", NodeKind::Type),
        ("Box", NodeKind::Class),
        ("Named", NodeKind::Interface),
        ("value", NodeKind::Field),
        ("name", NodeKind::Field),
        ("defaultNamed", NodeKind::Function),
    ] {
        assert_eq!(symbol(&graph, "Demo/Base.lean", name).kind, kind, "{name}");
    }
    for (name, owner) in [
        ("first", "Choice"),
        ("next", "Choice"),
        ("mk", "Box"),
        ("value", "Box"),
        ("name", "Named"),
    ] {
        assert_eq!(
            symbol(&graph, "Demo/Base.lean", name).owner.as_deref(),
            Some(symbol(&graph, "Demo/Base.lean", owner).id.as_str())
        );
    }

    let summary = map(&graph);
    assert_eq!(summary.files, 2);
    assert_eq!(summary.languages, ["lean"]);
    let found = search(
        &graph,
        &SearchQuery {
            query: "identité_eq".into(),
            kinds: None,
            path_prefix: None,
            lang: Some("lean4".into()),
            limit: 10,
        },
    );
    assert!(found.hits.iter().any(|hit| hit.node.name == "identité_eq"));
    let deps = dependencies(
        &graph,
        &DependencyQuery {
            symbol: result.id.clone(),
            path: None,
            direction: Direction::Out,
            depth: 1,
            relations: Some(vec![Relation::Calls, Relation::References]),
        },
    )
    .unwrap();
    assert!(deps.nodes.iter().any(|n| n.node.name == "identité_eq"));
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
            .any(|m| m.members.contains(&result.id))
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
    assert_eq!(report.files_reused, 2);
    assert_eq!(cached.edges, graph.edges);
    write(
        dir.path(),
        "Main.lean",
        "import Demo.Base\ndef refreshed := Demo.secret\n",
    );
    let refreshed = refresh(dir.path(), None, &hb).unwrap();
    assert!(
        !refreshed.files["Main.lean"]
            .nodes
            .iter()
            .any(|n| n.name == "result")
    );
    assert!(edge(
        &refreshed,
        "Main.lean#refreshed:2",
        &symbol(&refreshed, "Demo/Base.lean", "secret").id,
        Some(Relation::References)
    ));
}

#[test]
fn lean_binders_tactic_locals_and_strings_are_not_global_dependencies() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "Scope.lean",
        "\
def n := 9
def h := 9
def x := 9
def localProof := 9
def helper (n : Nat) : Nat := n
def Alias (α : Type) := α
def typed (x : Alias Nat) : Nat := x
def term (n : Nat) : Nat :=
  let x := helper n; x
def lambda := fun n => helper n
theorem tactic (n : Nat) : n = n := by
  have localProof : n = n := by rfl
  exact localProof
theorem introductions : ∀ n : Nat, n = n := by
  intro n
  rfl
def patterns (n : Nat) : Nat := match n with
  | 0 => helper 0
  | x => helper x
section Shared
variable (h : Nat)
def sectionVar := h
end Shared
def after := h
-- def fake := helper 0
def message := \"def fakeString := helper\"
namespace Unclosed
mutual
def left : Nat := right
def right : Nat := 0
end
def stillInside : Nat := left
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
    let file = &graph.files["Scope.lean"];
    assert!(
        !file
            .nodes
            .iter()
            .any(|n| matches!(n.name.as_str(), "fake" | "fakeString" | "Shared"))
    );
    for name in [
        "term",
        "lambda",
        "tactic",
        "introductions",
        "patterns",
        "sectionVar",
    ] {
        let node = symbol(&graph, "Scope.lean", name);
        for local in ["n", "h", "x", "localProof"] {
            assert!(
                !edge(
                    &graph,
                    &node.id,
                    &symbol(&graph, "Scope.lean", local).id,
                    None
                ),
                "{name} -> {local}"
            );
        }
    }
    for name in ["term", "lambda", "patterns"] {
        assert!(edge(
            &graph,
            &symbol(&graph, "Scope.lean", name).id,
            &symbol(&graph, "Scope.lean", "helper").id,
            Some(Relation::Calls)
        ));
    }
    let typed = &symbol(&graph, "Scope.lean", "typed").id;
    let alias = &symbol(&graph, "Scope.lean", "Alias").id;
    assert!(edge(&graph, typed, alias, Some(Relation::References)));
    assert!(!edge(&graph, typed, alias, Some(Relation::Calls)));
    assert!(edge(
        &graph,
        &symbol(&graph, "Scope.lean", "after").id,
        &symbol(&graph, "Scope.lean", "h").id,
        Some(Relation::References)
    ));
    assert!(
        symbol(&graph, "Scope.lean", "stillInside")
            .id
            .contains("#Unclosed.stillInside:")
    );
    assert_eq!(
        symbol(&graph, "Scope.lean", "stillInside").owner.as_deref(),
        Some(symbol(&graph, "Scope.lean", "Unclosed").id.as_str())
    );
    assert!(
        file.raw_edges
            .iter()
            .all(|r| !matches!(r.target.as_str(), "exact" | "intro" | "rfl" | "fakeString"))
    );
}
