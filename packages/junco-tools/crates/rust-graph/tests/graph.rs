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
    build(
        root,
        BuildOptions {
            full: true,
            fstar: None,
        },
        &hb,
    )
    .unwrap()
}

fn incremental(root: &Path) -> (Graph, BuildReport) {
    build(
        root,
        BuildOptions {
            full: false,
            fstar: None,
        },
        &hb,
    )
    .unwrap()
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
    let g = refresh(dir.path(), None, &hb).unwrap();
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

fn cluster_fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "src/app.ts",
        concat!(
            "export function log(m: string) { return m }\n",
            "export function a() { log(\"a\"); return b() }\n",
            "export function b() { log(\"b\"); return c() }\n",
            "export function c() { log(\"c\"); return 1 }\n",
            "export function d() { log(\"d\"); return e() }\n",
            "export function e() { log(\"e\"); return 2 }\n",
            "export function x() { log(\"x\"); return y() }\n",
            "export function y() { log(\"y\"); return x() }\n",
            "export function main() { log(\"m\"); return a() + d() + x() }\n",
        ),
    );
    dir
}

fn cluster_options() -> ClusterOptions {
    ClusterOptions {
        max_size: 2,
        omnipresent: Some(5),
        prefixes: vec![],
        excludes: vec![],
    }
}

fn module_for<'a>(clustering: &'a Clustering, symbol: &str) -> &'a Module {
    clustering
        .modules
        .iter()
        .find(|m| m.members.iter().any(|id| id == symbol))
        .unwrap()
}

#[test]
fn cluster_collapses_cycles_extracts_library_and_packs_under_k() {
    let dir = cluster_fixture();
    let (g, _) = build_full(dir.path());
    assert!(has_edge(
        &g,
        "src/app.ts#a:2",
        "src/app.ts#log:1",
        Relation::Calls,
        Some(Confidence::Extracted)
    ));
    let options = cluster_options();
    let c = cluster(&g, &options).unwrap();
    let libraries: Vec<_> = c.modules.iter().filter(|m| m.library).collect();
    assert_eq!(libraries.len(), 1);
    assert_eq!(libraries[0].members, ["src/app.ts#log:1"]);
    assert_eq!(
        module_for(&c, "src/app.ts#x:7"),
        module_for(&c, "src/app.ts#y:8")
    );
    assert!(
        c.modules
            .iter()
            .filter(|m| !m.library)
            .all(|m| m.weight <= 2)
    );
    let (a, b) = (
        module_for(&c, "src/app.ts#a:2"),
        module_for(&c, "src/app.ts#b:3"),
    );
    assert!(c.edges.iter().any(|e| e.from == a.id && e.to == b.id));
    assert_eq!(cluster(&g, &options).unwrap(), c);
    let mut shuffled = g.clone();
    shuffled.edges.reverse();
    for file in shuffled.files.values_mut() {
        file.nodes.reverse();
    }
    assert_eq!(cluster(&shuffled, &options).unwrap(), c);
    let default = ClusterOptions {
        omnipresent: None,
        ..options.clone()
    };
    // Sixteen distinct calls / nine symbols: ceil(3 * 16 / 9) = 6.
    assert_eq!(cluster(&g, &default).unwrap().omnipresent_threshold, 6);
    let mut sparse = g.clone();
    sparse.edges.retain(|e| e.target != "src/app.ts#log:1");
    assert_eq!(cluster(&sparse, &default).unwrap().omnipresent_threshold, 5);
    assert_eq!(
        cluster(
            &g,
            &ClusterOptions {
                prefixes: vec!["absent/".into()],
                ..options.clone()
            }
        )
        .unwrap_err(),
        "no symbols matched"
    );
    assert_eq!(
        cluster(
            &g,
            &ClusterOptions {
                excludes: vec!["src/".into()],
                ..options.clone()
            }
        )
        .unwrap_err(),
        "no symbols matched"
    );
    assert!(
        cluster(
            &g,
            &ClusterOptions {
                max_size: 0,
                ..options.clone()
            }
        )
        .is_err()
    );
    let all_library = cluster(
        &g,
        &ClusterOptions {
            omnipresent: Some(0),
            ..options.clone()
        },
    )
    .unwrap();
    assert_eq!(all_library.modules.len(), 1);
    assert_eq!(all_library.modules[0].weight, 9);
    assert!(all_library.modules[0].library);
    assert!(all_library.edges.is_empty());
    let indivisible = cluster(
        &g,
        &ClusterOptions {
            max_size: 1,
            ..options
        },
    )
    .unwrap();
    assert_eq!(module_for(&indivisible, "src/app.ts#x:7").weight, 2);
}

#[test]
fn cluster_query_directory_membership_and_pagination() {
    let dir = tempfile::tempdir().unwrap();
    for (path, source) in [
        (
            "src/a.ts",
            "import { b } from \"../src2/b\";\nexport function a() { return b() }\n",
        ),
        (
            "src2/b.ts",
            "import { a } from \"../src/a\";\nexport function b() { return a() }\n",
        ),
        ("src/local.ts", "export function local() { return 1 }\n"),
        ("src2/other.ts", "export function other() { return 2 }\n"),
    ] {
        write(dir.path(), path, source);
    }
    let (g, _) = build_full(dir.path());
    let query = ClusterQuery {
        view: ClusterView::List,
        directory: None,
        cluster_id: None,
        direction: None,
        max_size: 1,
        omnipresent: Some(u32::MAX),
        offset: 0,
        limit: 20,
    };
    let list = |q: &ClusterQuery| {
        let ClusterQueryResult::List {
            clusters,
            total,
            next_offset,
            offset,
            k,
            omnipresent_threshold,
        } = cluster_query(&g, q).unwrap()
        else {
            panic!("expected list")
        };
        assert_eq!((k, omnipresent_threshold, offset), (1, u32::MAX, q.offset));
        (clusters, total, next_offset)
    };
    let (all, total, _) = list(&query);
    assert_eq!(total, 3);
    let a_id = "src/a.ts#a:2";
    let b_id = "src2/b.ts#b:2";
    let clustering = cluster(
        &g,
        &ClusterOptions {
            max_size: 1,
            omnipresent: Some(u32::MAX),
            prefixes: vec![],
            excludes: vec![],
        },
    )
    .unwrap();
    let cycle_id = &module_for(&clustering, a_id).id;
    assert_eq!(module_for(&clustering, a_id), module_for(&clustering, b_id));
    for (directory, local) in [("src", "src/local.ts"), ("src2", "src2/other.ts")] {
        let scoped = ClusterQuery {
            directory: Some(directory.into()),
            ..query.clone()
        };
        let (rows, count, next) = list(&scoped);
        assert_eq!((count, next), (2, None));
        let cycle = rows.iter().find(|r| r.cluster.id == *cycle_id).unwrap();
        assert_eq!(
            (
                cycle.matching_files,
                cycle.contained,
                cycle.cluster.file_count
            ),
            (1, false, 2)
        );
        assert_eq!(cycle.cluster.sample_files, ["src/a.ts", "src2/b.ts"]);
        let other = rows.iter().find(|r| r.cluster.id != *cycle_id).unwrap();
        assert_eq!(
            (
                other.matching_files,
                other.contained,
                other.cluster.file_count
            ),
            (1, true, 1)
        );
        assert_eq!(other.cluster.sample_files, [local]);
        assert_eq!(
            list(&ClusterQuery {
                directory: Some(format!("./{directory}//./")),
                ..query.clone()
            }),
            (rows, count, next)
        );
    }
    assert_eq!(
        list(&ClusterQuery {
            directory: Some(".".into()),
            ..query.clone()
        })
        .0,
        all
    );
    assert_eq!(
        list(&ClusterQuery {
            directory: Some("absent".into()),
            ..query.clone()
        })
        .1,
        0
    );
    let members_query = ClusterQuery {
        view: ClusterView::Members,
        cluster_id: Some(format!(" {cycle_id} ")),
        ..query.clone()
    };
    let ClusterQueryResult::Members {
        members,
        total,
        cluster,
        next_offset,
        ..
    } = cluster_query(&g, &members_query).unwrap()
    else {
        panic!("expected members")
    };
    assert_eq!((total, next_offset, cluster.file_count), (2, None, 2));
    assert_eq!(members, [node(&g, a_id).clone(), node(&g, b_id).clone()]);
    for member in &members {
        assert_eq!((member.start_line, member.end_line), (2, 2));
        assert!(member.signature.chars().count() <= 200);
    }
    let mut seen = Vec::new();
    let mut page = ClusterQuery {
        limit: 1,
        ..query.clone()
    };
    loop {
        let (rows, total, next) = list(&page);
        assert_eq!(total, 3);
        seen.extend(rows.into_iter().map(|row| row.cluster.id));
        match next {
            Some(offset) => page.offset = offset,
            None => break,
        }
    }
    assert_eq!(
        seen,
        all.iter()
            .map(|row| row.cluster.id.clone())
            .collect::<Vec<_>>()
    );
    assert_eq!(
        list(&ClusterQuery {
            offset: u32::MAX,
            ..query.clone()
        }),
        (vec![], 3, None)
    );
    let ClusterQueryResult::Members {
        members,
        total,
        next_offset,
        ..
    } = cluster_query(
        &g,
        &ClusterQuery {
            offset: 1,
            limit: 1,
            ..members_query.clone()
        },
    )
    .unwrap()
    else {
        panic!("expected members page")
    };
    assert_eq!(
        (members, total, next_offset),
        (vec![node(&g, b_id).clone()], 2, None)
    );
    let mut reversed = g.clone();
    reversed.edges.reverse();
    for file in reversed.files.values_mut() {
        file.nodes.reverse();
    }
    for q in [
        &query,
        &members_query,
        &ClusterQuery {
            directory: Some("src".into()),
            ..query.clone()
        },
    ] {
        assert_eq!(cluster_query(&reversed, q), cluster_query(&g, q));
    }
    let empty = Graph {
        files: Default::default(),
        edges: vec![],
        ..g.clone()
    };
    assert_eq!(
        cluster_query(&empty, &query).unwrap_err(),
        "no symbols matched"
    );
    let mut invalid = vec![
        (
            ClusterQuery {
                max_size: 0,
                ..query.clone()
            },
            "max_size must be greater than zero",
        ),
        (
            ClusterQuery {
                limit: 0,
                ..query.clone()
            },
            "cluster limit must be between 1 and 100",
        ),
        (
            ClusterQuery {
                limit: 101,
                ..query.clone()
            },
            "cluster limit must be between 1 and 100",
        ),
        (
            ClusterQuery {
                cluster_id: Some("anything".into()),
                ..query.clone()
            },
            "cluster list does not accept clusterId or direction",
        ),
        (
            ClusterQuery {
                direction: Some(Direction::In),
                ..query.clone()
            },
            "cluster list does not accept clusterId or direction",
        ),
        (
            ClusterQuery {
                directory: Some("src".into()),
                ..members_query.clone()
            },
            "cluster members does not accept directory or direction",
        ),
        (
            ClusterQuery {
                direction: Some(Direction::Out),
                ..members_query.clone()
            },
            "cluster members does not accept directory or direction",
        ),
        (
            ClusterQuery {
                view: ClusterView::Neighbors,
                directory: Some("src".into()),
                ..members_query.clone()
            },
            "cluster neighbors does not accept directory",
        ),
    ];
    for value in ["", "  ", "/src", "src/../src2", "../src/../lib"] {
        invalid.push((
            ClusterQuery {
                directory: Some(value.into()),
                ..query.clone()
            },
            "cluster directory must be a non-empty root-relative directory",
        ));
    }
    for (view, error) in [
        (ClusterView::Members, "cluster members requires clusterId"),
        (
            ClusterView::Neighbors,
            "cluster neighbors requires clusterId",
        ),
    ] {
        for cluster_id in [None, Some("  ".into())] {
            invalid.push((
                ClusterQuery {
                    view,
                    cluster_id,
                    ..query.clone()
                },
                error,
            ));
        }
        assert_eq!(
            cluster_query(
                &g,
                &ClusterQuery {
                    view,
                    cluster_id: Some(" unknown ".into()),
                    ..query.clone()
                }
            )
            .unwrap_err(),
            "no cluster named unknown"
        );
    }
    for (q, error) in invalid {
        assert_eq!(cluster_query(&g, &q).unwrap_err(), error);
        assert_eq!(cluster_query(&empty, &q).unwrap_err(), error); // Validate before clustering.
    }
    // Spaces are literal path components, not trimming instructions.
    let mut spaced = g.clone();
    for file in spaced.files.values_mut() {
        for node in &mut file.nodes {
            node.path = format!("space dir/{}", node.path);
        }
    }
    let ClusterQueryResult::List { total, .. } = cluster_query(
        &spaced,
        &ClusterQuery {
            directory: Some("space dir/src".into()),
            ..query
        },
    )
    .unwrap() else {
        panic!("expected directory with spaces")
    };
    assert_eq!(total, 2);
}

#[test]
fn cluster_query_preserves_library_connections() {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "app.ts",
        concat!(
            "export function helper() { return 1 }\n",
            "export function log() { return helper() }\n",
            "export function one() { return log() }\n",
            "export function two() { return log() }\n",
            "export function three() { return log() }\n",
        ),
    );
    let (mut g, _) = build_full(dir.path());
    let options = ClusterOptions {
        max_size: 1,
        omnipresent: Some(3),
        prefixes: vec![],
        excludes: vec![],
    };
    let c = cluster(&g, &options).unwrap();
    let helper = &module_for(&c, "app.ts#helper:1").id;
    assert_eq!(module_for(&c, "app.ts#log:2").id, "library");
    assert!(
        c.edges
            .iter()
            .any(|e| e.from == "library" && e.to == *helper)
    );
    let query = ClusterQuery {
        view: ClusterView::Neighbors,
        directory: None,
        cluster_id: Some("library".into()),
        direction: None,
        max_size: 1,
        omnipresent: Some(3),
        offset: 0,
        limit: 20,
    };
    let neighbors = |g: &Graph, direction| {
        let ClusterQueryResult::Neighbors {
            neighbors,
            total,
            next_offset,
            ..
        } = cluster_query(
            g,
            &ClusterQuery {
                direction,
                ..query.clone()
            },
        )
        .unwrap()
        else {
            panic!("expected neighbors")
        };
        assert_eq!(total as usize, neighbors.len());
        assert_eq!(next_offset, None);
        neighbors
    };
    let outgoing = neighbors(&g, Some(Direction::Out));
    assert_eq!(outgoing.len(), 1);
    assert_eq!(outgoing[0].cluster.id, *helper);
    assert_eq!(outgoing[0].incoming, None);
    let edge = outgoing[0].outgoing.as_ref().unwrap();
    assert_eq!((edge.edges, edge.targets), (1, 1));
    let incoming = neighbors(&g, Some(Direction::In));
    assert_eq!(
        incoming
            .iter()
            .map(|n| n.cluster.top.as_str())
            .collect::<Vec<_>>(),
        ["app.ts#one:3", "app.ts#three:5", "app.ts#two:4"]
    );
    assert!(
        incoming
            .iter()
            .all(|n| n.incoming.is_some() && n.outgoing.is_none())
    );
    let both = neighbors(&g, None);
    let mut union = incoming.clone();
    union.extend(outgoing);
    union.sort_by(|a, b| a.cluster.id.cmp(&b.cluster.id));
    assert_eq!(both, union);
    g.edges.push(Edge {
        source: "app.ts#helper:1".into(),
        target: "app.ts#log:2".into(),
        relation: Relation::Calls,
        confidence: Confidence::Extracted,
    });
    g.edges.push(Edge {
        source: "app.ts#log:2".into(),
        target: "app.ts#helper:1".into(),
        relation: Relation::References,
        confidence: Confidence::Inferred,
    });
    let cyclic = cluster(&g, &options).unwrap();
    assert!(
        cyclic
            .edges
            .iter()
            .any(|e| e.from == *helper && e.to == "library")
    );
    let both = neighbors(&g, Some(Direction::Both));
    assert_eq!(both.len(), 4);
    let link = both.iter().find(|n| n.cluster.id == *helper).unwrap();
    for edge in [
        link.incoming.as_ref().unwrap(),
        link.outgoing.as_ref().unwrap(),
    ] {
        assert_eq!((edge.edges, edge.targets), (1, 1));
    }
    let out = neighbors(&g, Some(Direction::Out));
    assert_eq!(out, [link.clone()]); // Include both actual edges despite the direction filter.
    let ClusterQueryResult::Neighbors {
        neighbors,
        total,
        next_offset,
        ..
    } = cluster_query(
        &g,
        &ClusterQuery {
            offset: 1,
            limit: 1,
            ..query
        },
    )
    .unwrap()
    else {
        panic!("expected page")
    };
    assert_eq!((total, next_offset), (4, Some(2)));
    assert_eq!(neighbors, both[1..2]);
}
