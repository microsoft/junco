//! Deterministic symbol groupings and code-dependency evidence, not a workflow schedule.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use petgraph::{
    Graph as PetGraph, Incoming,
    algo::{condensation, dominators::simple_fast},
    visit::EdgeRef,
};
use serde::{Deserialize, Serialize};

use crate::{Graph, Node, Relation};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ClusterOptions {
    /// K: maximum symbols per module (except indivisible cycles and the library).
    pub max_size: u32,
    /// None uses max(5, ceil(3 × mean in-degree)).
    pub omnipresent: Option<u32>,
    pub prefixes: Vec<String>,
    pub excludes: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Module {
    pub id: String,
    pub top: String,
    pub members: Vec<String>,
    pub files: Vec<String>,
    pub weight: u32,
    pub library: bool,
}

/// `from` calls/references `to` (same direction as a symbol edge).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ModuleEdge {
    pub from: String,
    pub to: String,
    pub edges: u32,
    pub targets: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Clustering {
    pub k: u32,
    pub omnipresent_threshold: u32,
    /// Sorted by ID; groupings are evidence, not agent ownership boundaries.
    pub modules: Vec<Module>,
    /// Sorted by (from, to); may contain cycles through the shared library.
    pub edges: Vec<ModuleEdge>,
}

fn mq(assignments: &[usize], edges: &[(usize, usize)], counts: &mut [(u64, u64)]) -> f64 {
    counts.fill((0, 0));
    for &(a, b) in edges {
        let (a, b) = (assignments[a], assignments[b]);
        if a == b {
            counts[a].0 += 1;
        } else {
            counts[a].1 += 1;
            counts[b].1 += 1;
        }
    }
    counts
        .iter()
        .filter(|(inside, _)| *inside > 0)
        .map(|&(inside, outside)| (2 * inside) as f64 / (2 * inside + outside) as f64)
        .sum()
}

fn external_incoming(owner: &[usize], edges: &[(usize, usize)], library: &[bool]) -> Vec<usize> {
    let mut incoming = vec![0; owner.len()];
    for &(a, b) in edges {
        if !library[a] && owner[a] != owner[b] {
            incoming[b] += 1;
        }
    }
    incoming
}

fn entry(members: impl Iterator<Item = usize>, incoming: &[usize]) -> usize {
    members
        .min_by_key(|&n| (std::cmp::Reverse(incoming[n]), n))
        .expect("module has members")
}

/// Cluster symbols, extracting a shared library and retaining actual inter-cluster edges.
///
/// # Errors
/// Returns an error for a zero size cap or an empty symbol selection.
pub fn cluster(graph: &Graph, options: &ClusterOptions) -> Result<Clustering, String> {
    if options.max_size == 0 {
        return Err("max_size must be greater than zero".into());
    }
    let symbols: HashMap<&str, &Node> = graph
        .files
        .values()
        .flat_map(|f| &f.nodes)
        .filter(|n| {
            (options.prefixes.is_empty() || options.prefixes.iter().any(|p| n.path.starts_with(p)))
                && !options.excludes.iter().any(|p| n.path.starts_with(p))
        })
        .map(|n| (n.id.as_str(), n))
        .collect();
    if symbols.is_empty() {
        return Err("no symbols matched".into());
    }
    let mut ids: Vec<_> = symbols.keys().copied().collect();
    ids.sort_unstable();
    let index: HashMap<_, _> = ids.iter().enumerate().map(|(i, &id)| (id, i)).collect();
    let e0: BTreeSet<_> = graph
        .edges
        .iter()
        .filter(|e| e.relation != Relation::Contains)
        .filter_map(|e| {
            Some((
                *index.get(e.source.as_str())?,
                *index.get(e.target.as_str())?,
            ))
        })
        .collect();
    let e0: Vec<_> = e0.into_iter().collect();
    let threshold = options
        .omnipresent
        .unwrap_or_else(|| (3.0 * e0.len() as f64 / ids.len() as f64).ceil().max(5.0) as u32);
    let mut indegree = vec![0_u32; ids.len()];
    for &(_, b) in &e0 {
        indegree[b] += 1;
    }
    let library: Vec<_> = indegree.iter().map(|&d| d >= threshold).collect();
    let mut working = PetGraph::<usize, ()>::new();
    let mut work_index = vec![None; ids.len()];
    for (i, &is_library) in library.iter().enumerate() {
        if !is_library {
            work_index[i] = Some(working.add_node(i));
        }
    }
    for &(a, b) in &e0 {
        if let (Some(a), Some(b)) = (work_index[a], work_index[b]) {
            working.add_edge(a, b, ());
        }
    }
    let mut c = condensation(working, true);
    let count = c.node_count();
    let mut edges: Vec<_> = c
        .edge_references()
        .map(|e| (e.source().index(), e.target().index()))
        .collect();
    edges.sort_unstable();
    let root = c.add_node(Vec::new());
    for i in 0..count {
        let node = petgraph::graph::NodeIndex::new(i);
        if c.neighbors_directed(node, Incoming).next().is_none() {
            c.add_edge(root, node, ());
        }
    }
    let dom = simple_fast(&c, root);
    let mut children = vec![Vec::new(); count + 1];
    for i in 0..count {
        let parent = dom
            .immediate_dominator(petgraph::graph::NodeIndex::new(i))
            .expect("reachable SCC");
        children[parent.index()].push(i);
    }
    let weights: Vec<_> = c.node_weights().map(Vec::len).collect();
    let k = options.max_size as usize;
    let mut order = Vec::with_capacity(count + 1);
    let mut stack = vec![root.index()];
    while let Some(v) = stack.pop() {
        order.push(v);
        stack.extend(children[v].iter().rev());
    }
    let mut rem = weights.clone();
    let mut cut = vec![false; count + 1];
    for &v in order.iter().rev() {
        rem[v] += children[v].iter().map(|&child| rem[child]).sum::<usize>();
        while rem[v] > k {
            let largest = children[v]
                .iter()
                .copied()
                .filter(|&child| !cut[child])
                .min_by_key(|&child| (std::cmp::Reverse(rem[child]), child));
            let Some(child) = largest else { break };
            cut[child] = true;
            rem[v] -= rem[child];
        }
    }
    let mut groups: Vec<Vec<usize>> = Vec::new();
    let mut assignment = vec![usize::MAX; count];
    for start in std::iter::once(root.index()).chain((0..count).filter(|&i| cut[i])) {
        let group = groups.len();
        let mut members = Vec::new();
        let mut stack = vec![start];
        while let Some(v) = stack.pop() {
            if v != root.index() {
                assignment[v] = group;
                members.push(v);
            }
            stack.extend(
                children[v]
                    .iter()
                    .rev()
                    .copied()
                    .filter(|&child| !cut[child]),
            );
        }
        if !members.is_empty() {
            groups.push(members);
        }
    }
    let mut group_weights: Vec<_> = groups
        .iter()
        .map(|g| g.iter().map(|&v| weights[v]).sum::<usize>())
        .collect();
    let region_groups: BTreeSet<_> = children[root.index()]
        .iter()
        .map(|&v| assignment[v])
        .collect();
    let region: Vec<_> = (0..count)
        .filter(|&v| region_groups.contains(&assignment[v]))
        .collect();
    let mut neighbours = vec![BTreeSet::new(); count];
    for &(a, b) in &edges {
        neighbours[a].insert(b);
        neighbours[b].insert(a);
    }
    let mut mq_counts = vec![(0, 0); groups.len()];
    // ponytail: O(E) per evaluation; make incremental if the root region ever exceeds a few hundred nodes.
    for _ in 0..50 {
        let mut moved = false;
        for &v in &region {
            let current = assignment[v];
            let candidates: BTreeSet<_> = neighbours[v]
                .iter()
                .map(|&n| assignment[n])
                .filter(|&g| {
                    g != current && region_groups.contains(&g) && group_weights[g] + weights[v] <= k
                })
                .collect();
            if candidates.is_empty() {
                continue;
            }
            let baseline = mq(&assignment, &edges, &mut mq_counts);
            let mut best = (current, baseline);
            for target in candidates {
                assignment[v] = target;
                let score = mq(&assignment, &edges, &mut mq_counts);
                if score - best.1 > 1e-9 {
                    best = (target, score);
                }
            }
            assignment[v] = best.0;
            if best.0 != current {
                group_weights[current] -= weights[v];
                group_weights[best.0] += weights[v];
                moved = true;
            }
        }
        if !moved {
            break;
        }
    }
    for group in &mut groups {
        group.clear();
    }
    for (v, &group) in assignment.iter().enumerate() {
        groups[group].push(v);
    }

    let mut symbol_owner = vec![usize::MAX; ids.len()];
    for (v, &group) in assignment.iter().enumerate() {
        for &s in &c[petgraph::graph::NodeIndex::new(v)] {
            symbol_owner[s] = group;
        }
    }
    let incoming = external_incoming(&symbol_owner, &e0, &library);
    let tops: Vec<_> = groups
        .iter()
        .map(|g| {
            (!g.is_empty()).then(|| {
                entry(
                    g.iter()
                        .flat_map(|&v| &c[petgraph::graph::NodeIndex::new(v)])
                        .copied(),
                    &incoming,
                )
            })
        })
        .collect();
    let mut pairs = BTreeMap::<(usize, usize), (usize, BTreeSet<usize>)>::new();
    for &(a, b) in &edges {
        let (a_group, b_group) = (assignment[a], assignment[b]);
        if a_group == b_group {
            continue;
        }
        let pair = if tops[a_group] < tops[b_group] {
            (a_group, b_group)
        } else {
            (b_group, a_group)
        };
        let counts = pairs.entry(pair).or_default();
        counts.0 += 1;
        counts.1.insert(b);
    }
    let mut pairs: Vec<_> = pairs.into_iter().collect();
    pairs.sort_by(|((a, b), (e, _)), ((x, y), (f, _))| {
        f.cmp(e)
            .then_with(|| (tops[*a], tops[*b]).cmp(&(tops[*x], tops[*y])))
    });
    // ponytail: one pass, counts not recomputed after merges.
    for ((a, b), (_, targets)) in pairs {
        if groups[a].is_empty()
            || groups[b].is_empty()
            || group_weights[a] + group_weights[b] > k
            || targets.len() < group_weights[a].min(group_weights[b]).div_ceil(2)
        {
            continue;
        }
        let removed = std::mem::take(&mut groups[b]);
        for &v in &removed {
            assignment[v] = a;
        }
        groups[a].extend(removed);
        group_weights[a] += group_weights[b];
        group_weights[b] = 0;
    }
    let mut quotient = PetGraph::<usize, ()>::new();
    let mut quotient_index = vec![None; groups.len()];
    for (g, members) in groups.iter().enumerate() {
        if !members.is_empty() {
            quotient_index[g] = Some(quotient.add_node(g));
        }
    }
    for &(a, b) in &edges {
        if assignment[a] != assignment[b] {
            quotient.update_edge(
                quotient_index[assignment[a]].expect("live group"),
                quotient_index[assignment[b]].expect("live group"),
                (),
            );
        }
    }
    let acyclic = condensation(quotient, true);
    let mut expanded: Vec<Vec<usize>> = acyclic
        .node_weights()
        .map(|component| {
            component
                .iter()
                .flat_map(|&g| &groups[g])
                .flat_map(|&v| &c[petgraph::graph::NodeIndex::new(v)])
                .copied()
                .collect()
        })
        .collect();
    let library_members: Vec<_> = (0..ids.len()).filter(|&i| library[i]).collect();
    let library_group = expanded.len();
    // The shared library is one evidence grouping, independent of the size cap K.
    if !library_members.is_empty() {
        expanded.push(library_members);
    }
    for (g, members) in expanded.iter().enumerate() {
        for &s in members {
            symbol_owner[s] = g;
        }
    }
    let incoming = external_incoming(&symbol_owner, &e0, &library);
    let mut modules: Vec<_> = expanded
        .iter_mut()
        .enumerate()
        .map(|(g, members)| {
            members.sort_unstable();
            let top = entry(members.iter().copied(), &incoming);
            let node = symbols[ids[top]];
            Module {
                id: if g == library_group {
                    "library".into()
                } else {
                    format!("{}@{}", node.name, node.path)
                },
                top: ids[top].into(),
                members: members.iter().map(|&s| ids[s].to_string()).collect(),
                files: members
                    .iter()
                    .map(|&s| symbols[ids[s]].path.as_str())
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .map(str::to_string)
                    .collect(),
                weight: members.len() as u32,
                library: g == library_group,
            }
        })
        .collect();
    let mut naming_order: Vec<_> = (0..modules.len()).collect();
    naming_order.sort_unstable_by(|&a, &b| modules[a].top.cmp(&modules[b].top));
    let mut names = HashMap::<String, usize>::new();
    for i in naming_order {
        let count = names.entry(modules[i].id.clone()).or_default();
        *count += 1;
        if *count > 1 {
            modules[i].id.push_str(&format!("#{count}"));
        }
    }
    let mut output_edges = BTreeMap::<(&str, &str), (u32, BTreeSet<usize>)>::new();
    for &(a, b) in &e0 {
        let (from, to) = (symbol_owner[a], symbol_owner[b]);
        if from == to {
            continue;
        }
        let counts = output_edges
            .entry((&modules[from].id, &modules[to].id))
            .or_default();
        counts.0 += 1;
        counts.1.insert(b);
    }
    let edges: Vec<_> = output_edges
        .into_iter()
        .map(|((from, to), (edges, targets))| ModuleEdge {
            from: from.into(),
            to: to.into(),
            edges,
            targets: targets.len() as u32,
        })
        .collect();
    modules.sort_unstable_by(|a, b| a.id.cmp(&b.id));
    Ok(Clustering {
        k: options.max_size,
        omnipresent_threshold: threshold,
        modules,
        edges,
    })
}
