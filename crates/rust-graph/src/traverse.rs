//! Dependency walks and repo map.

use std::{
    borrow::Cow,
    collections::{BTreeMap, BTreeSet, HashMap},
};

use crate::model::{
    DependencyNode, DependencyQuery, DependencyResult, Direction, Edge, Graph, Hub, MapCluster,
    MapResult, Node, NodeKind, Relation,
};

const MAX_VISITED: usize = 500;

pub fn dependencies(graph: &Graph, query: &DependencyQuery) -> Result<DependencyResult, String> {
    let nodes: HashMap<&str, Cow<'_, Node>> = graph.all_nodes().collect();
    let symbol = query.symbol.trim();
    let seed = match nodes.get(symbol) {
        Some(n) if query.path.as_deref().is_none_or(|p| n.path == p) => Node::clone(n),
        _ => {
            let mut found: Vec<&Node> = nodes
                .values()
                .map(AsRef::as_ref)
                .filter(|n| n.name == symbol && query.path.as_deref().is_none_or(|p| n.path == p))
                .collect();
            found.sort_by(|a, b| a.id.cmp(&b.id));
            match found.as_slice() {
                [one] => (*one).clone(),
                [] => return Err(format!("no symbol named {symbol}")),
                many => {
                    let ids: Vec<&str> = many.iter().take(20).map(|n| n.id.as_str()).collect();
                    return Err(format!("ambiguous symbol {symbol}: {}", ids.join(", ")));
                }
            }
        }
    };

    let depth = query.depth.clamp(1, 5);
    let wanted = |r: Relation| match &query.relations {
        Some(rs) => rs.contains(&r),
        None => r != Relation::Contains,
    };
    let edges: Vec<&Edge> = graph.edges.iter().filter(|e| wanted(e.relation)).collect();
    let mut out_adj: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut in_adj: HashMap<&str, Vec<&str>> = HashMap::new();
    for e in &edges {
        out_adj.entry(&e.source).or_default().push(&e.target);
        in_adj.entry(&e.target).or_default().push(&e.source);
    }

    let mut visited: HashMap<&str, u32> = HashMap::from([(seed.id.as_str(), 0)]);
    let mut frontier = vec![seed.id.as_str()];
    let mut truncated = false;
    'walk: for d in 1..=depth {
        let mut next = Vec::new();
        for n in frontier {
            let outs = matches!(query.direction, Direction::Out | Direction::Both)
                .then(|| out_adj.get(n))
                .flatten();
            let ins = matches!(query.direction, Direction::In | Direction::Both)
                .then(|| in_adj.get(n))
                .flatten();
            for &m in outs.into_iter().chain(ins).flatten() {
                if visited.contains_key(m) {
                    continue;
                }
                if visited.len() >= MAX_VISITED {
                    truncated = true;
                    break 'walk;
                }
                visited.insert(m, d);
                next.push(m);
            }
        }
        frontier = next;
    }

    let mut found: Vec<DependencyNode> = visited
        .iter()
        .filter(|(id, _)| **id != seed.id)
        .filter_map(|(id, &depth)| {
            nodes.get(*id).map(|n| DependencyNode {
                node: Node::clone(n),
                depth,
            })
        })
        .collect();
    found.sort_by(|a, b| (a.depth, &a.node.id).cmp(&(b.depth, &b.node.id)));
    let edges = edges
        .into_iter()
        .filter(|e| {
            visited.contains_key(e.source.as_str()) && visited.contains_key(e.target.as_str())
        })
        .cloned()
        .collect();
    Ok(DependencyResult {
        seed,
        nodes: found,
        edges,
        truncated,
    })
}

fn hub(node: &Node, in_degree: u32) -> Hub {
    Hub {
        id: node.id.clone(),
        name: node.name.clone(),
        kind: node.kind,
        path: node.path.clone(),
        start_line: node.start_line,
        in_degree,
    }
}

fn top_hubs<'a>(
    nodes: impl Iterator<Item = &'a Node>,
    degrees: &HashMap<&str, (u32, u32)>,
    n: usize,
) -> Vec<Hub> {
    let mut ranked: Vec<(u32, &Node)> = nodes
        .filter(|node| node.kind != NodeKind::File)
        .filter_map(|node| degrees.get(node.id.as_str()).map(|d| (d.0, node)))
        .filter(|(d, _)| *d > 0)
        .collect();
    ranked.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.id.cmp(&b.1.id)));
    ranked
        .into_iter()
        .take(n)
        .map(|(d, node)| hub(node, d))
        .collect()
}

fn depth_of(dir: &str) -> usize {
    if dir == "." {
        0
    } else {
        dir.split('/').count()
    }
}

/// Cluster for `file` one level below `dir` (or `dir` itself for files directly inside it).
fn child_cluster(dir: &str, file: &str) -> String {
    let rest = if dir == "." {
        file
    } else {
        &file[dir.len() + 1..]
    };
    match rest.split_once('/') {
        Some((seg, _)) if dir == "." => seg.to_string(),
        Some((seg, _)) => format!("{dir}/{seg}"),
        None => dir.to_string(),
    }
}

pub fn map(graph: &Graph) -> MapResult {
    let degrees = graph.degrees();
    let total = graph.files.len();
    let mut clusters: BTreeMap<String, Vec<&str>> = BTreeMap::new();
    for path in graph.files.keys() {
        clusters
            .entry(child_cluster(".", path))
            .or_default()
            .push(path);
    }
    let mut settled: BTreeSet<String> = BTreeSet::new();
    while let Some(dir) = clusters
        .iter()
        .find(|(d, f)| f.len() * 10 > total * 6 && depth_of(d) < 4 && !settled.contains(*d))
        .map(|(d, _)| d.clone())
    {
        let files = &clusters[&dir];
        let mut split: BTreeMap<String, Vec<&str>> = BTreeMap::new();
        for f in files {
            split.entry(child_cluster(&dir, f)).or_default().push(f);
        }
        if split.len() == 1 {
            settled.insert(dir);
            continue;
        }
        clusters.remove(&dir);
        clusters.extend(split);
    }

    let mut out: Vec<MapCluster> = clusters
        .into_iter()
        .map(|(dir, files)| {
            let entries: Vec<_> = files.iter().map(|f| &graph.files[*f]).collect();
            let languages: BTreeSet<&str> = entries.iter().map(|e| e.lang.as_str()).collect();
            MapCluster {
                files: files.len() as u32,
                symbols: entries.iter().map(|e| e.nodes.len() as u32).sum(),
                languages: languages.into_iter().map(str::to_string).collect(),
                hubs: top_hubs(entries.iter().flat_map(|e| &e.nodes), &degrees, 3),
                dir,
            }
        })
        .collect();
    out.sort_by(|a, b| b.files.cmp(&a.files).then_with(|| a.dir.cmp(&b.dir)));
    let languages: BTreeSet<&str> = graph.files.values().map(|f| f.lang.as_str()).collect();
    MapResult {
        files: total as u32,
        symbols: graph.files.values().map(|f| f.nodes.len() as u32).sum(),
        edges: graph.edges.len() as u32,
        languages: languages.into_iter().map(str::to_string).collect(),
        clusters: out,
        hotspots: top_hubs(graph.files.values().flat_map(|f| &f.nodes), &degrees, 10),
    }
}
