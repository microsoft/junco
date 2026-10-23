//! Global resolution: raw name-level edges + import specs → node-to-node edges.

use std::{
    borrow::Cow,
    collections::{BTreeMap, HashMap},
    path::Path,
};

use crate::{
    imports::Imports,
    lang::{Family, spec_for_name},
    model::{Confidence, Edge, FileEntry, Node, NodeKind, RawEdge, Relation},
};

/// Call names too generic to bind by name alone; `macro_invocation` is captured as a call, so
/// Rust's list includes std macros (`format!` must not bind to some unique `fn format`).
fn stoplist(family: Family) -> &'static str {
    match family {
        Family::Js => {
            "log map filter foreach push then catch get set has add delete join split slice keys values entries \
             tostring require resolve reject find includes startswith endswith some every reduce sort indexof \
             replace trim"
        }
        Family::Python => {
            "print len range str int list dict set super isinstance append get items keys values join format open \
             sorted enumerate zip min max sum any all"
        }
        Family::Rust => {
            "new clone unwrap expect into from as_ref to_string iter map collect len push get insert remove ok err \
             some none default join format println eprintln print eprint write writeln vec assert assert_eq \
             assert_ne debug_assert panic matches todo unreachable concat stringify include_str env"
        }
        Family::Go => {
            "len append make new panic print println error string int delete copy cap close"
        }
        Family::Jvm => "get set add put size equals hashcode tostring println length append of",
        Family::C => "printf malloc free memcpy memset strlen sizeof assert",
        _ => "",
    }
}

fn kinds_for(relation: Relation) -> &'static [NodeKind] {
    match relation {
        Relation::Calls => &[
            NodeKind::Function,
            NodeKind::Method,
            NodeKind::Class,
            NodeKind::Macro,
        ],
        _ => &[
            NodeKind::Class,
            NodeKind::Interface,
            NodeKind::Type,
            NodeKind::Module,
        ],
    }
}

/// The single item, or `None` for zero or several.
fn only<T>(items: impl IntoIterator<Item = T>) -> Option<T> {
    let mut items = items.into_iter();
    let first = items.next()?;
    items.next().is_none().then_some(first)
}

/// An import edge's target file and the names it brings in (empty = every name).
type Imported<'a> = (String, Cow<'a, [String]>);

/// Node lookups for binding a raw edge's target name.
struct Names<'a> {
    by_name: HashMap<&'a str, Vec<&'a Node>>,
    per_file: HashMap<(&'a str, &'a str), Vec<&'a Node>>,
    by_id: HashMap<&'a str, &'a Node>,
    family_of: HashMap<&'a str, Family>,
}

impl<'a> Names<'a> {
    fn new(files: &'a BTreeMap<String, FileEntry>) -> Self {
        let mut names = Self {
            by_name: HashMap::new(),
            per_file: HashMap::new(),
            by_id: HashMap::new(),
            family_of: HashMap::new(),
        };
        for (path, entry) in files {
            if let Some(spec) = spec_for_name(&entry.lang) {
                names.family_of.insert(path, spec.family);
            }
            for node in &entry.nodes {
                names.by_name.entry(&node.name).or_default().push(node);
                names
                    .per_file
                    .entry((path, &node.name))
                    .or_default()
                    .push(node);
                names.by_id.insert(&node.id, node);
            }
        }
        names
    }

    fn in_file(&self, path: &str, name: &str, kinds: &[NodeKind]) -> Vec<&'a Node> {
        self.per_file
            .get(&(path, name))
            .into_iter()
            .flatten()
            .copied()
            .filter(|n| kinds.contains(&n.kind))
            .collect()
    }

    /// Same file first (several → the one sharing the source's owner), then the files `path`
    /// imports `name` from, then a unique same-family global name (`Inferred`). Any ambiguity
    /// drops the edge.
    fn target(
        &self,
        path: &str,
        family: Family,
        imports: &[Imported<'_>],
        raw: &RawEdge,
    ) -> Option<(&'a Node, Confidence)> {
        let name = raw.target.as_str();
        let kinds = kinds_for(raw.relation);
        let local = self.in_file(path, name, kinds);
        match local.as_slice() {
            [one] => return Some((one, Confidence::Extracted)),
            [] => {}
            many => {
                let owner = self
                    .by_id
                    .get(raw.from.as_str())
                    .and_then(|n| n.owner.as_deref());
                return only(many.iter().filter(|n| n.owner.as_deref() == owner))
                    .map(|n| (*n, Confidence::Extracted));
            }
        }
        let mut via_import: Vec<&Node> = imports
            .iter()
            .filter(|(_, names)| names.is_empty() || names.iter().any(|n| n == name))
            .flat_map(|(p, _)| self.in_file(p, name, kinds))
            .collect();
        if !via_import.is_empty() {
            via_import.sort_by(|a, b| a.id.cmp(&b.id));
            via_import.dedup_by(|a, b| a.id == b.id);
            return only(via_import).map(|n| (n, Confidence::Extracted));
        }
        let global = self.by_name.get(name).into_iter().flatten().filter(|n| {
            kinds.contains(&n.kind) && self.family_of.get(n.path.as_str()) == Some(&family)
        });
        only(global).map(|n| (*n, Confidence::Inferred))
    }
}

fn edge(source: &str, target: &str, relation: Relation, confidence: Confidence) -> Edge {
    Edge {
        source: source.to_string(),
        target: target.to_string(),
        relation,
        confidence,
    }
}

/// All edges, sorted by `(source, relation, target)`, and the number of unresolved imports.
pub fn resolve(files: &BTreeMap<String, FileEntry>, root: &Path) -> (Vec<Edge>, u32) {
    let mut edges: Vec<Edge> = files
        .iter()
        .flat_map(|(path, entry)| entry.nodes.iter().map(move |n| (path, n)))
        .map(|(path, n)| {
            edge(
                n.owner.as_deref().unwrap_or(path),
                &n.id,
                Relation::Contains,
                Confidence::Extracted,
            )
        })
        .collect();

    let mut resolver = Imports::new(files, root);
    let mut unresolved = 0u32;
    let mut imported: HashMap<&str, Vec<Imported<'_>>> = HashMap::new();
    for (path, entry) in files {
        let Some(spec) = spec_for_name(&entry.lang) else {
            continue;
        };
        for import in &entry.imports {
            let resolved = resolver.resolve(path, &import.module, spec.imports);
            if resolved.paths.is_empty() {
                unresolved += 1;
            }
            let names: Cow<'_, [String]> = resolved
                .names
                .map_or(Cow::Borrowed(&import.names), Cow::Owned);
            for target in resolved.paths.into_iter().filter(|t| t != path) {
                edges.push(edge(
                    path,
                    &target,
                    Relation::Imports,
                    Confidence::Extracted,
                ));
                imported
                    .entry(path)
                    .or_default()
                    .push((target, names.clone()));
            }
        }
    }

    let names = Names::new(files);
    for (path, entry) in files {
        let Some(&family) = names.family_of.get(path.as_str()) else {
            continue;
        };
        let stop = stoplist(family);
        let imports = imported.get(path.as_str()).map_or(&[][..], Vec::as_slice);
        for raw in &entry.raw_edges {
            if raw.relation == Relation::Calls
                && stop
                    .split_whitespace()
                    .any(|s| s.eq_ignore_ascii_case(&raw.target))
            {
                continue;
            }
            if let Some((node, confidence)) = names.target(path, family, imports, raw)
                && node.id != raw.from
            {
                edges.push(edge(&raw.from, &node.id, raw.relation, confidence));
            }
        }
    }

    // Duplicates keep `Extracted` over `Inferred` (it sorts first).
    edges.sort_by(|a, b| {
        (&a.source, a.relation, &a.target, a.confidence).cmp(&(
            &b.source,
            b.relation,
            &b.target,
            b.confidence,
        ))
    });
    edges.dedup_by(|a, b| a.source == b.source && a.target == b.target && a.relation == b.relation);
    (edges, unresolved)
}
