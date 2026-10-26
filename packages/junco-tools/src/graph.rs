//! The `code_graph` tool (`map`, `search`, `deps`, `cluster`) over the deterministic tree-sitter graph in
//! `rust-graph`. Results cross napi as JSON strings.

use std::path::Path;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rust_graph::{ClusterQuery, ClusterView, DependencyQuery, Direction, FstarConfig, SearchQuery};

use crate::task;

/// F* compiler settings: each present field replaces that field of the nearest discovered
/// `*.fst.config.json` (arrays included). A relative `cwd` is relative to the graph root; other
/// relative paths are relative to the effective cwd.
#[napi(object)]
pub struct GraphFstarOptions {
    pub cwd: Option<String>,
    pub fstar_exe: Option<String>,
    /// Compiler arguments; only include-path options select files.
    pub options: Option<Vec<String>>,
    /// Appended as `--include <dir>` after `options`.
    pub include_dirs: Option<Vec<String>>,
}

/// Options for `graph`; `action` selects which of the other fields apply.
#[napi(object)]
pub struct GraphOptions<'env> {
    /// `map`, `search`, `deps`, or `cluster`.
    pub action: String,
    /// Repository root; defaults to the call's cwd.
    pub path: Option<String>,
    /// `search`: words, identifiers, or a path fragment.
    pub query: Option<String>,
    /// `search`: node kinds (`function`, `class`, …) to keep.
    pub kinds: Option<Vec<String>>,
    /// `search`: keep nodes whose root-relative path starts with this prefix.
    pub path_prefix: Option<String>,
    /// `search`: language name or alias.
    pub lang: Option<String>,
    /// Maximum rows: search defaults to 10; cluster defaults to 20 (1–100).
    pub limit: Option<u32>,
    /// `deps`: node id, file path, or symbol name.
    pub symbol: Option<String>,
    /// `deps`: root-relative file that disambiguates `symbol`.
    pub symbol_path: Option<String>,
    /// `in`, `out`, or `both`; deps defaults to `in`, cluster neighbors to `both`.
    pub direction: Option<String>,
    /// `deps`: hops to follow (default 1).
    pub depth: Option<u32>,
    /// `deps`: relations to follow (default: all but `contains`).
    pub relations: Option<Vec<String>>,
    /// `cluster`: `list`, `members`, or `neighbors` (default `list`).
    pub cluster_view: Option<String>,
    /// `cluster list`: root-relative directory selector, not repository root.
    pub directory: Option<String>,
    /// `cluster members/neighbors`: exact snapshot-local cluster ID.
    pub cluster_id: Option<String>,
    /// `cluster`: maximum grouping size, except SCCs/library (default 20).
    pub max_size: Option<u32>,
    /// `cluster`: shared-library in-degree threshold; None uses the heuristic.
    pub omnipresent: Option<u32>,
    /// `cluster`: row offset (default 0).
    pub offset: Option<u32>,
    /// F* include-path settings over the discovered editor configuration.
    pub fstar: Option<GraphFstarOptions>,
    pub signal: Option<Unknown<'env>>,
    pub timeout_ms: Option<u32>,
}

enum GraphOp {
    Search(SearchQuery),
    Dependencies(DependencyQuery),
    Cluster(ClusterQuery),
    Map,
}

/// A graph request prepared on the JS thread; `path` is the repository root the routed call maps
/// into its view before running it.
pub(crate) struct GraphSpec {
    pub(crate) path: Option<String>,
    fstar: Option<FstarConfig>,
    op: GraphOp,
}

fn parse_all<T: std::str::FromStr>(
    what: &str,
    values: Option<Vec<String>>,
) -> Result<Option<Vec<T>>> {
    values
        .map(|vs| {
            vs.iter()
                .map(|v| {
                    v.parse()
                        .map_err(|_| Error::from_reason(format!("invalid {what}: {v}")))
                })
                .collect()
        })
        .transpose()
}

pub(crate) fn prepare(o: GraphOptions<'_>) -> Result<(GraphSpec, task::CancelToken)> {
    let op = match o.action.as_str() {
        "map" => GraphOp::Map,
        "search" => GraphOp::Search(SearchQuery {
            query: o
                .query
                .ok_or_else(|| Error::from_reason("search requires query"))?,
            kinds: parse_all("kind", o.kinds)?,
            path_prefix: o.path_prefix,
            lang: o.lang,
            limit: o.limit.unwrap_or(10),
        }),
        "deps" => GraphOp::Dependencies(DependencyQuery {
            symbol: o
                .symbol
                .ok_or_else(|| Error::from_reason("deps requires symbol"))?,
            path: o.symbol_path,
            direction: match o.direction {
                Some(d) => d
                    .parse()
                    .map_err(|_| Error::from_reason(format!("invalid direction: {d}")))?,
                None => Direction::In,
            },
            depth: o.depth.unwrap_or(1),
            relations: parse_all("relation", o.relations)?,
        }),
        "cluster" => GraphOp::Cluster(ClusterQuery {
            view: match o.cluster_view.as_deref().unwrap_or("list") {
                "list" => ClusterView::List,
                "members" => ClusterView::Members,
                "neighbors" => ClusterView::Neighbors,
                other => return Err(Error::from_reason(format!("invalid cluster view: {other}"))),
            },
            directory: o.directory,
            cluster_id: o.cluster_id,
            direction: o
                .direction
                .map(|d| {
                    d.parse()
                        .map_err(|_| Error::from_reason(format!("invalid direction: {d}")))
                })
                .transpose()?,
            max_size: o.max_size.unwrap_or(20),
            omnipresent: o.omnipresent,
            offset: o.offset.unwrap_or(0),
            limit: o.limit.unwrap_or(20),
        }),
        other => return Err(Error::from_reason(format!("invalid action: {other}"))),
    };
    Ok((
        GraphSpec {
            path: o.path,
            fstar: o.fstar.map(|f| FstarConfig {
                cwd: f.cwd,
                fstar_exe: f.fstar_exe,
                options: f.options,
                include_dirs: f.include_dirs,
            }),
            op,
        },
        task::CancelToken::new(o.timeout_ms, o.signal),
    ))
}

macro_rules! json {
    ($value:expr) => {
        serde_json::to_string(&$value).map_err(|e| e.to_string())
    };
}

impl GraphSpec {
    /// Refresh the graph rooted at `path` and query it; returns the result as JSON.
    pub(crate) fn run(self, ct: task::CancelToken) -> std::result::Result<String, String> {
        let root = Path::new(self.path.as_deref().unwrap_or("."));
        let hb = || ct.heartbeat().map_err(|e| e.reason.clone());
        let graph = rust_graph::refresh(root, self.fstar.as_ref(), &hb)?;
        match self.op {
            GraphOp::Map => json!(rust_graph::map(&graph)),
            GraphOp::Search(q) => json!(rust_graph::search(&graph, &q)),
            GraphOp::Dependencies(q) => json!(rust_graph::dependencies(&graph, &q)?),
            GraphOp::Cluster(q) => json!(rust_graph::cluster_query(&graph, &q)?),
        }
    }
}
