//! Deterministic tree-sitter code graph: symbols, calls, imports, heritage.

pub mod cluster;
mod cluster_query;
mod extract;
mod fstar;
mod fstar_paths;
mod imports;
pub mod lang;
mod lean;
pub mod model;
mod resolve;
mod rocq;
mod search;
mod store;
mod traverse;
mod verus;

use std::path::{Path, PathBuf};

pub use cluster::{ClusterOptions, Clustering, Module, ModuleEdge, cluster};
pub use cluster_query::{
    ClusterMatch, ClusterNeighbor, ClusterQuery, ClusterQueryResult, ClusterSummary, ClusterView,
    cluster_query,
};
pub use fstar_paths::FstarConfig;
pub use model::*;

pub const GRAPH_VERSION: u32 = 1;
/// Bump whenever any `.scm` or extraction rule changes; mismatch → full rebuild.
pub const EXTRACTOR_VERSION: u32 = 3;

pub type Heartbeat<'a> = &'a (dyn Fn() -> Result<(), String> + Sync);

#[derive(Default)]
pub struct BuildOptions {
    pub full: bool,
    /// F* compiler settings over the discovered `*.fst.config.json`, field by field.
    pub fstar: Option<FstarConfig>,
}

pub fn build(
    root: &Path,
    options: BuildOptions,
    heartbeat: Heartbeat<'_>,
) -> Result<(Graph, BuildReport), String> {
    store::build(root, options.full, options.fstar.as_ref(), heartbeat)
}

/// Incremental build; every query refreshes first.
pub fn refresh(
    root: &Path,
    fstar: Option<&FstarConfig>,
    heartbeat: Heartbeat<'_>,
) -> Result<Graph, String> {
    Ok(store::build(root, false, fstar, heartbeat)?.0)
}

pub fn search(graph: &Graph, query: &SearchQuery) -> SearchResult {
    search::search(graph, query)
}

pub fn dependencies(graph: &Graph, query: &DependencyQuery) -> Result<DependencyResult, String> {
    traverse::dependencies(graph, query)
}

pub fn map(graph: &Graph) -> MapResult {
    traverse::map(graph)
}

pub fn cache_path(root: &Path) -> PathBuf {
    root.join(".junco/graph/graph.json")
}
