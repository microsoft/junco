//! Snapshot-local browsing of symbol groupings and their actual dependency edges.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

use crate::{ClusterOptions, Direction, Graph, Module, ModuleEdge, Node, cluster};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ClusterView {
    List,
    Members,
    Neighbors,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ClusterQuery {
    pub view: ClusterView,
    pub directory: Option<String>,
    pub cluster_id: Option<String>,
    pub direction: Option<Direction>,
    pub max_size: u32,
    pub omnipresent: Option<u32>,
    pub offset: u32,
    pub limit: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ClusterSummary {
    pub id: String,
    pub top: String,
    pub weight: u32,
    pub library: bool,
    pub file_count: u32,
    pub sample_files: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ClusterMatch {
    pub cluster: ClusterSummary,
    pub matching_files: u32,
    pub contained: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ClusterNeighbor {
    pub cluster: ClusterSummary,
    pub incoming: Option<ModuleEdge>,
    pub outgoing: Option<ModuleEdge>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "view", rename_all = "lowercase")]
pub enum ClusterQueryResult {
    List {
        k: u32,
        omnipresent_threshold: u32,
        total: u32,
        offset: u32,
        next_offset: Option<u32>,
        clusters: Vec<ClusterMatch>,
    },
    Members {
        k: u32,
        omnipresent_threshold: u32,
        total: u32,
        offset: u32,
        next_offset: Option<u32>,
        cluster: ClusterSummary,
        members: Vec<Node>,
    },
    Neighbors {
        k: u32,
        omnipresent_threshold: u32,
        total: u32,
        offset: u32,
        next_offset: Option<u32>,
        cluster: ClusterSummary,
        neighbors: Vec<ClusterNeighbor>,
    },
}

fn summary(module: &Module) -> ClusterSummary {
    ClusterSummary {
        id: module.id.clone(),
        top: module.top.clone(),
        weight: module.weight,
        library: module.library,
        file_count: module.files.len() as u32,
        sample_files: module.files.iter().take(5).cloned().collect(),
    }
}

/// A normalized directory selector over graph keys: root-relative, or leading `..` components for
/// files outside the root (F* include roots), never an interior `..`.
fn directory(value: &str) -> Result<String, String> {
    let parts: Vec<&str> = value
        .split('/')
        .filter(|p| !p.is_empty() && *p != ".")
        .collect();
    let outside = parts.iter().take_while(|p| **p == "..").count();
    if value.trim().is_empty() || value.starts_with('/') || parts[outside..].contains(&"..") {
        return Err("cluster directory must be a non-empty root-relative directory".into());
    }
    Ok(parts.join("/"))
}

fn next_offset(query: &ClusterQuery, total: u32, returned: usize) -> Option<u32> {
    let next = query.offset.saturating_add(returned as u32);
    (next < total).then_some(next)
}

/// Browse complete-graph clusters; a directory filters list rows, never membership.
/// IDs are handles for this graph and these clustering options, not durable identities.
///
/// # Errors
/// Rejects invalid selectors, pagination, size caps, unknown IDs, and graphs without symbols.
pub fn cluster_query(graph: &Graph, query: &ClusterQuery) -> Result<ClusterQueryResult, String> {
    if query.max_size == 0 {
        return Err("max_size must be greater than zero".into());
    }
    if !(1..=100).contains(&query.limit) {
        return Err("cluster limit must be between 1 and 100".into());
    }
    let id = query.cluster_id.as_deref().map(str::trim);
    match query.view {
        ClusterView::List => {
            if query.cluster_id.is_some() || query.direction.is_some() {
                return Err("cluster list does not accept clusterId or direction".into());
            }
        }
        ClusterView::Members => {
            if id.is_none_or(str::is_empty) {
                return Err("cluster members requires clusterId".into());
            }
            if query.directory.is_some() || query.direction.is_some() {
                return Err("cluster members does not accept directory or direction".into());
            }
        }
        ClusterView::Neighbors => {
            if id.is_none_or(str::is_empty) {
                return Err("cluster neighbors requires clusterId".into());
            }
            if query.directory.is_some() {
                return Err("cluster neighbors does not accept directory".into());
            }
        }
    }
    let directory = query.directory.as_deref().map(directory).transpose()?;
    let clustering = cluster(
        graph,
        &ClusterOptions {
            max_size: query.max_size,
            omnipresent: query.omnipresent,
            prefixes: Vec::new(),
            excludes: Vec::new(),
        },
    )?;
    let k = clustering.k;
    let omnipresent_threshold = clustering.omnipresent_threshold;
    let offset = query.offset;
    let start = offset as usize;
    let limit = query.limit as usize;
    if query.view == ClusterView::List {
        let prefix = directory
            .as_ref()
            .filter(|d| !d.is_empty())
            .map(|d| format!("{d}/"));
        let selected: Vec<_> = clustering
            .modules
            .iter()
            .filter_map(|module| {
                let matching_files = module
                    .files
                    .iter()
                    .filter(|path| prefix.as_ref().is_none_or(|p| path.starts_with(p)))
                    .count() as u32;
                (matching_files > 0).then_some((module, matching_files))
            })
            .collect();
        let total = selected.len() as u32;
        let clusters: Vec<_> = selected
            .into_iter()
            .skip(start)
            .take(limit)
            .map(|(module, matching_files)| ClusterMatch {
                cluster: summary(module),
                matching_files,
                contained: matching_files as usize == module.files.len(),
            })
            .collect();
        return Ok(ClusterQueryResult::List {
            k,
            omnipresent_threshold,
            total,
            offset,
            next_offset: next_offset(query, total, clusters.len()),
            clusters,
        });
    }
    let id = id.expect("validated cluster ID");
    let selected = clustering
        .modules
        .binary_search_by(|module| module.id.as_str().cmp(id))
        .map(|i| &clustering.modules[i])
        .map_err(|_| format!("no cluster named {id}"))?;
    match query.view {
        ClusterView::Members => {
            let nodes: HashMap<_, _> = graph
                .files
                .values()
                .flat_map(|f| &f.nodes)
                .map(|node| (node.id.as_str(), node))
                .collect();
            let total = selected.members.len() as u32;
            let members: Vec<_> = selected
                .members
                .iter()
                .skip(start)
                .take(limit)
                .map(|id| nodes[id.as_str()].clone())
                .collect();
            Ok(ClusterQueryResult::Members {
                k,
                omnipresent_threshold,
                total,
                offset,
                next_offset: next_offset(query, total, members.len()),
                cluster: summary(selected),
                members,
            })
        }
        ClusterView::Neighbors => {
            let mut connections =
                BTreeMap::<&str, (Option<&ModuleEdge>, Option<&ModuleEdge>)>::new();
            for edge in &clustering.edges {
                if edge.to == id {
                    connections.entry(&edge.from).or_default().0 = Some(edge);
                }
                if edge.from == id {
                    connections.entry(&edge.to).or_default().1 = Some(edge);
                }
            }
            let direction = query.direction.unwrap_or(Direction::Both);
            let selected_neighbors: Vec<_> = connections
                .into_iter()
                .filter(|(_, (incoming, outgoing))| match direction {
                    Direction::In => incoming.is_some(),
                    Direction::Out => outgoing.is_some(),
                    Direction::Both => true,
                })
                .collect();
            let total = selected_neighbors.len() as u32;
            let neighbors: Vec<_> = selected_neighbors
                .into_iter()
                .skip(start)
                .take(limit)
                .map(|(id, (incoming, outgoing))| {
                    let index = clustering
                        .modules
                        .binary_search_by(|m| m.id.as_str().cmp(id))
                        .expect("edge endpoint exists");
                    ClusterNeighbor {
                        cluster: summary(&clustering.modules[index]),
                        incoming: incoming.cloned(),
                        outgoing: outgoing.cloned(),
                    }
                })
                .collect();
            Ok(ClusterQueryResult::Neighbors {
                k,
                omnipresent_threshold,
                total,
                offset,
                next_offset: next_offset(query, total, neighbors.len()),
                cluster: summary(selected),
                neighbors,
            })
        }
        ClusterView::List => unreachable!("list returned above"),
    }
}
