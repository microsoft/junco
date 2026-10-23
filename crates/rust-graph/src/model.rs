use std::{
    borrow::Cow,
    collections::{BTreeMap, HashMap},
};

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Graph {
    pub version: u32,
    pub extractor: u32,
    /// Key = root-relative POSIX path.
    pub files: BTreeMap<String, FileEntry>,
    /// Resolved, sorted by `(source, relation, target)`.
    pub edges: Vec<Edge>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct FileEntry {
    pub size: u64,
    pub mtime_ms: u64,
    /// sha256 hex of the file bytes.
    pub hash: String,
    /// `SupportLang::canonical_name()`.
    pub lang: String,
    /// Excludes the File node itself (File node id == path).
    pub nodes: Vec<Node>,
    pub raw_edges: Vec<RawEdge>,
    pub imports: Vec<ImportSpec>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Node {
    /// `"<path>#<Owner.Chain.name>:<start_line>"`; File node id = path.
    pub id: String,
    pub name: String,
    pub kind: NodeKind,
    pub path: String,
    /// Id of the owning node (class/impl target/etc.).
    pub owner: Option<String>,
    /// 1-based inclusive.
    pub start_line: u32,
    pub end_line: u32,
    /// First line of the definition text, trimmed, ≤200 chars.
    pub signature: String,
    pub exported: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    File,
    Function,
    Method,
    Class,
    Interface,
    Type,
    Module,
    Constant,
    Field,
    Macro,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RawEdge {
    /// Node id or file path.
    pub from: String,
    pub relation: Relation,
    /// Name text.
    pub target: String,
    pub line: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ImportSpec {
    /// Literal text, quotes stripped; `"<kind>:<module>"` when the query captured `@import.kind`.
    pub module: String,
    pub names: Vec<String>,
    pub line: u32,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Relation {
    Contains,
    Calls,
    Imports,
    References,
    Implements,
    Extends,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    Extracted,
    Inferred,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Edge {
    pub source: String,
    pub target: String,
    pub relation: Relation,
    pub confidence: Confidence,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct BuildReport {
    pub files_total: u32,
    pub files_parsed: u32,
    pub files_reused: u32,
    pub files_removed: u32,
    pub nodes: u32,
    pub edges: u32,
    pub languages: BTreeMap<String, u32>,
    pub unresolved_imports: u32,
    pub errors: Vec<(String, String)>,
    pub duration_ms: u64,
    pub cache_path: String,
    pub full: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SearchQuery {
    pub query: String,
    pub kinds: Option<Vec<NodeKind>>,
    pub path_prefix: Option<String>,
    pub lang: Option<String>,
    pub limit: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SearchHit {
    pub node: Node,
    pub score: f64,
    pub in_degree: u32,
    pub out_degree: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    pub total_candidates: u32,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    In,
    Out,
    Both,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct DependencyQuery {
    pub symbol: String,
    pub path: Option<String>,
    pub direction: Direction,
    pub depth: u32,
    pub relations: Option<Vec<Relation>>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct DependencyNode {
    pub node: Node,
    pub depth: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct DependencyResult {
    pub seed: Node,
    pub nodes: Vec<DependencyNode>,
    pub edges: Vec<Edge>,
    pub truncated: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct MapCluster {
    pub dir: String,
    pub files: u32,
    pub symbols: u32,
    pub languages: Vec<String>,
    pub hubs: Vec<Hub>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Hub {
    pub id: String,
    pub name: String,
    pub kind: NodeKind,
    pub path: String,
    pub start_line: u32,
    pub in_degree: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct MapResult {
    pub files: u32,
    pub symbols: u32,
    pub edges: u32,
    pub languages: Vec<String>,
    pub clusters: Vec<MapCluster>,
    pub hotspots: Vec<Hub>,
}

impl Graph {
    /// Synthetic File node for a `files` key.
    pub fn file_node(path: &str) -> Node {
        Node {
            id: path.to_string(),
            name: path.rsplit('/').next().unwrap_or(path).to_string(),
            kind: NodeKind::File,
            path: path.to_string(),
            owner: None,
            start_line: 1,
            end_line: 0,
            signature: String::new(),
            exported: true,
        }
    }

    /// Every node keyed by id, borrowed from the graph: File nodes first (in path order, built on
    /// the fly), then each file's symbols.
    pub fn all_nodes(&self) -> impl Iterator<Item = (&str, Cow<'_, Node>)> {
        let files = self
            .files
            .keys()
            .map(|p| (p.as_str(), Cow::Owned(Self::file_node(p))));
        let symbols = self
            .files
            .values()
            .flat_map(|f| &f.nodes)
            .map(|n| (n.id.as_str(), Cow::Borrowed(n)));
        files.chain(symbols)
    }

    /// `(in_degree, out_degree)` per node id over every relation except `Contains`.
    pub fn degrees(&self) -> HashMap<&str, (u32, u32)> {
        let mut map: HashMap<&str, (u32, u32)> = HashMap::new();
        for e in self
            .edges
            .iter()
            .filter(|e| e.relation != Relation::Contains)
        {
            map.entry(e.target.as_str()).or_default().0 += 1;
            map.entry(e.source.as_str()).or_default().1 += 1;
        }
        map
    }
}

macro_rules! from_str_via_serde {
    ($($ty:ty),*) => {$(
        impl std::str::FromStr for $ty {
            type Err = String;

            /// Parses the snake_case wire name (`"function"`, `"calls"`, `"in"`).
            fn from_str(s: &str) -> Result<Self, String> {
                serde_json::from_value(serde_json::Value::String(s.to_string()))
                    .map_err(|_| format!("invalid {}: {s}", stringify!($ty)))
            }
        }
    )*};
}
from_str_via_serde!(NodeKind, Relation, Direction);
