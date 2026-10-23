//! The `code_graph` tool (`map`, `search`, `deps`) over the deterministic tree-sitter graph in
//! `rust-graph`. Results cross napi as JSON strings.

use std::path::Path;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use rust_graph::{DependencyQuery, Direction, SearchQuery};

use crate::task;

/// Options for `graph`; `action` selects which of the other fields apply.
#[napi(object)]
pub struct GraphOptions<'env> {
    /// `map`, `search`, or `deps`.
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
    /// `search`: maximum hits (default 10).
    pub limit: Option<u32>,
    /// `deps`: node id, file path, or symbol name.
    pub symbol: Option<String>,
    /// `deps`: root-relative file that disambiguates `symbol`.
    pub symbol_path: Option<String>,
    /// `deps`: `in`, `out`, or `both` (default `in`).
    pub direction: Option<String>,
    /// `deps`: hops to follow (default 1).
    pub depth: Option<u32>,
    /// `deps`: relations to follow (default: all but `contains`).
    pub relations: Option<Vec<String>>,
    pub signal: Option<Unknown<'env>>,
    pub timeout_ms: Option<u32>,
}

enum GraphOp {
    Search(SearchQuery),
    Dependencies(DependencyQuery),
    Map,
}

/// A graph request prepared on the JS thread; `path` is the repository root the routed call maps
/// into its view before running it.
pub(crate) struct GraphSpec {
    pub(crate) path: Option<String>,
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
        other => return Err(Error::from_reason(format!("invalid action: {other}"))),
    };
    Ok((
        GraphSpec { path: o.path, op },
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
        let graph = rust_graph::refresh(root, &hb)?;
        match self.op {
            GraphOp::Map => json!(rust_graph::map(&graph)),
            GraphOp::Search(q) => json!(rust_graph::search(&graph, &q)),
            GraphOp::Dependencies(q) => json!(rust_graph::dependencies(&graph, &q)?),
        }
    }
}
