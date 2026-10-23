//! Deterministic tree-sitter code graph: symbols, calls, imports, heritage.

mod extract;
mod imports;
pub mod lang;
pub mod model;
mod resolve;
mod search;
mod store;
mod traverse;

use std::path::{Path, PathBuf};

pub use model::*;

pub const GRAPH_VERSION: u32 = 1;
/// Bump whenever any `.scm` or extraction rule changes; mismatch → full rebuild.
pub const EXTRACTOR_VERSION: u32 = 1;

pub type Heartbeat<'a> = &'a (dyn Fn() -> Result<(), String> + Sync);

pub struct BuildOptions {
    pub full: bool,
}

pub fn build(
    root: &Path,
    options: BuildOptions,
    heartbeat: Heartbeat<'_>,
) -> Result<(Graph, BuildReport), String> {
    store::build(root, options.full, heartbeat)
}

/// Incremental build; every query refreshes first.
pub fn refresh(root: &Path, heartbeat: Heartbeat<'_>) -> Result<Graph, String> {
    Ok(build(root, BuildOptions { full: false }, heartbeat)?.0)
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
