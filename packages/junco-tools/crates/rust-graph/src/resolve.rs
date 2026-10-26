//! Global resolution: raw name-level edges + import specs → node-to-node edges.

use std::{
    borrow::Cow,
    collections::{BTreeMap, HashMap, HashSet},
    path::Path,
};

use crate::{
    fstar_paths::FstarScopes,
    imports::{Imports, fstar_module, rocq_module},
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

/// One imported file and its source-level binding information.
struct Imported<'a> {
    path: String,
    names: Cow<'a, [String]>,
    module: Option<Cow<'a, str>>,
    alias: Option<&'a str>,
}

/// Whether two contexts' imports of one file bind every name alike.
fn same_imports(a: &[Imported<'_>], b: &[Imported<'_>]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|(a, b)| {
            (&a.path, &a.module, a.alias, &a.names) == (&b.path, &b.module, b.alias, &b.names)
        })
}

const FORMAL_KINDS: &[NodeKind] = &[
    NodeKind::Function,
    NodeKind::Method,
    NodeKind::Class,
    NodeKind::Interface,
    NodeKind::Type,
    NodeKind::Module,
    NodeKind::Constant,
    NodeKind::Field,
    NodeKind::Macro,
];

/// A formal-language raw edge's binding before a compiler context limits the global fallback.
enum Binding<'a> {
    Bound(&'a Node, Confidence),
    Unbound,
    /// A unique same-family global name (`Names::global`), `Inferred`.
    Global,
}

fn qualified_name(node: &Node) -> &str {
    node.id
        .split_once('#')
        .and_then(|(_, name)| name.rsplit_once(':'))
        .map_or(node.name.as_str(), |(name, _)| name)
}

/// Node lookups for binding a raw edge's target name.
struct Names<'a> {
    by_name: HashMap<&'a str, Vec<&'a Node>>,
    per_file: HashMap<(&'a str, &'a str), Vec<&'a Node>>,
    by_id: HashMap<&'a str, &'a Node>,
    family_of: HashMap<&'a str, Family>,
    declarations: HashSet<&'a str>,
    definitions: HashSet<(&'a str, &'a str)>,
}

impl<'a> Names<'a> {
    fn new(files: &'a BTreeMap<String, FileEntry>) -> Self {
        let mut names = Self {
            by_name: HashMap::new(),
            per_file: HashMap::new(),
            by_id: HashMap::new(),
            family_of: HashMap::new(),
            declarations: files
                .values()
                .flat_map(|entry| {
                    entry
                        .declarations
                        .iter()
                        .filter_map(|&index| entry.nodes.get(index as usize))
                })
                .map(|node| node.id.as_str())
                .collect(),
            definitions: HashSet::new(),
        };
        for (path, entry) in files {
            if let Some(spec) = spec_for_name(&entry.lang) {
                names.family_of.insert(path, spec.family);
            }
            for node in &entry.nodes {
                if names.family_of.get(path.as_str()) == Some(&Family::Fstar)
                    && !names.declarations.contains(node.id.as_str())
                {
                    names
                        .definitions
                        .insert((path.as_str(), qualified_name(node)));
                }
                names.by_name.entry(&node.name).or_default().push(node);
                names
                    .per_file
                    .entry((path, &node.name))
                    .or_default()
                    .push(node);
                if matches!(
                    names.family_of.get(path.as_str()),
                    Some(Family::Rocq | Family::Lean | Family::Fstar)
                ) {
                    let qualified = qualified_name(node);
                    let leaf = node.name.rsplit('.').next().unwrap_or(&node.name);
                    for alias in [leaf, qualified] {
                        if alias != node.name && (alias != leaf || qualified != leaf) {
                            names.by_name.entry(alias).or_default().push(node);
                            names.per_file.entry((path, alias)).or_default().push(node);
                        }
                    }
                }
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
            .filter(|n| kinds.contains(&n.kind) && self.preferred(n))
            .collect()
    }

    fn preferred(&self, node: &Node) -> bool {
        !self.declarations.contains(node.id.as_str())
            || !self
                .definitions
                .contains(&(node.path.as_str(), qualified_name(node)))
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
        if matches!(family, Family::Rocq | Family::Lean | Family::Fstar) {
            return match self.formal_target(path, family, imports, raw) {
                Binding::Bound(node, confidence) => Some((node, confidence)),
                Binding::Unbound => None,
                Binding::Global => self
                    .global(&raw.target, family, None)
                    .map(|node| (node, Confidence::Inferred)),
            };
        }
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
            .filter(|import| import.names.is_empty() || import.names.iter().any(|n| n == name))
            .flat_map(|import| self.in_file(&import.path, name, kinds))
            .collect();
        if !via_import.is_empty() {
            via_import.sort_by(|a, b| a.id.cmp(&b.id));
            via_import.dedup_by(|a, b| a.id == b.id);
            return only(via_import).map(|n| (n, Confidence::Extracted));
        }
        if raw.relation == Relation::Calls
            && stoplist(family)
                .split_whitespace()
                .any(|s| s.eq_ignore_ascii_case(name))
        {
            return None;
        }
        let global = self.by_name.get(name).into_iter().flatten().filter(|n| {
            kinds.contains(&n.kind) && self.family_of.get(n.path.as_str()) == Some(&family)
        });
        only(global).map(|n| (*n, Confidence::Inferred))
    }

    /// The binding before any compiler context applies: only the global fallback depends on it.
    fn formal_target(
        &self,
        path: &str,
        family: Family,
        imports: &[Imported<'_>],
        raw: &RawEdge,
    ) -> Binding<'a> {
        let name = raw.target.as_str();
        let leaf = if family == Family::Fstar
            && self.by_name.contains_key(name)
            && !name
                .chars()
                .next()
                .is_some_and(|c| c.is_alphabetic() || c == '_' || c == '\'')
        {
            name
        } else {
            name.rsplit('.').next().unwrap_or(name)
        };
        let local = self.in_file(path, leaf, FORMAL_KINDS);
        let mut owner = self
            .by_id
            .get(raw.from.as_str())
            .and_then(|node| node.owner.as_deref());
        while let Some(id) = owner {
            let Some(scope) = self.by_id.get(id) else {
                return Binding::Unbound;
            };
            let in_scope = local.iter().copied().filter(|node| {
                qualified_name(node)
                    .strip_suffix(name)
                    .and_then(|prefix| prefix.strip_suffix('.'))
                    == Some(qualified_name(scope))
            });
            if let Some(node) = only(in_scope) {
                return Binding::Bound(node, Confidence::Extracted);
            }
            owner = scope.owner.as_deref();
        }
        if let Some(node) = only(
            local
                .iter()
                .copied()
                .filter(|node| qualified_name(node) == name),
        ) {
            return Binding::Bound(node, Confidence::Extracted);
        }
        let mut imported_nodes: Vec<_> = imports
            .iter()
            .flat_map(|import| {
                self.in_file(&import.path, leaf, FORMAL_KINDS)
                    .into_iter()
                    .filter(move |node| {
                        let qualified = qualified_name(node);
                        qualified == name
                            || import.alias.is_some_and(|alias| {
                                let tail = name
                                    .strip_prefix(alias)
                                    .and_then(|tail| tail.strip_prefix('.'));
                                tail.is_some_and(|tail| {
                                    qualified == tail
                                        || import.module.as_deref().is_some_and(|module| {
                                            qualified
                                                .strip_prefix(module)
                                                .and_then(|name| name.strip_prefix('.'))
                                                == Some(tail)
                                        })
                                })
                            })
                            || import.module.as_deref().is_some_and(|module| {
                                name.strip_prefix(module)
                                    .and_then(|tail| tail.strip_prefix('.'))
                                    == Some(qualified)
                                    || qualified
                                        .strip_prefix(module)
                                        .and_then(|tail| tail.strip_prefix('.'))
                                        == Some(name)
                            })
                    })
            })
            .collect();
        imported_nodes.sort_by(|a, b| a.id.cmp(&b.id));
        imported_nodes.dedup_by(|a, b| a.id == b.id);
        if !imported_nodes.is_empty() {
            return only(imported_nodes).map_or(Binding::Unbound, |node| {
                Binding::Bound(node, Confidence::Extracted)
            });
        }
        Binding::Global
    }

    /// Same-family definitions named `name`, the global fallback's candidates.
    fn global_candidates(&self, name: &str, family: Family) -> impl Iterator<Item = &'a Node> {
        self.by_name
            .get(name)
            .into_iter()
            .flatten()
            .copied()
            .filter(|node| self.preferred(node))
            .filter(move |node| {
                FORMAL_KINDS.contains(&node.kind)
                    && self.family_of.get(node.path.as_str()) == Some(&family)
            })
    }

    /// The unique global candidate, among `visible` files when a compiler context limits them.
    fn global(
        &self,
        name: &str,
        family: Family,
        visible: Option<&HashSet<String>>,
    ) -> Option<&'a Node> {
        only(
            self.global_candidates(name, family)
                .filter(|node| visible.is_none_or(|files| files.contains(&node.path))),
        )
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

/// All edges, sorted by `(source, relation, target)`, and the number of unresolved imports. An F*
/// file binds once per compiler context in `fstar`; their edges are unioned.
pub fn resolve(
    files: &BTreeMap<String, FileEntry>,
    root: &Path,
    fstar: &FstarScopes,
) -> (Vec<Edge>, u32) {
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
    // Keyed by importer and its F* context (`None` for other languages).
    let mut imported: HashMap<(&str, Option<usize>), Vec<Imported<'_>>> = HashMap::new();
    for (path, entry) in files {
        let Some(spec) = spec_for_name(&entry.lang) else {
            continue;
        };
        if spec.family == Family::Fstar {
            for import in &entry.imports {
                let (module, alias) = fstar_module(&import.module);
                // Distinct targets across contexts: one edge each, however many scopes agree.
                let mut targets: Vec<&str> = Vec::new();
                for &context in fstar.contexts(path) {
                    let Some(target) = fstar.module(context, module) else {
                        continue;
                    };
                    if !targets.contains(&target) {
                        targets.push(target);
                        if target != path {
                            edges.push(edge(
                                path,
                                target,
                                Relation::Imports,
                                Confidence::Extracted,
                            ));
                        }
                    }
                    imported
                        .entry((path, Some(context)))
                        .or_default()
                        .push(Imported {
                            path: target.to_string(),
                            names: Cow::Borrowed(&import.names),
                            module: Some(Cow::Borrowed(module)),
                            alias,
                        });
                }
                unresolved += u32::from(targets.is_empty());
            }
            continue;
        }
        for import in &entry.imports {
            let resolved = resolver.resolve(path, &import.module, spec.imports);
            if resolved.paths.is_empty() {
                unresolved += 1;
            }
            let names: Cow<'_, [String]> = resolved
                .names
                .map_or(Cow::Borrowed(&import.names), Cow::Owned);
            for target in resolved.paths {
                if target != *path {
                    edges.push(edge(
                        path,
                        &target,
                        Relation::Imports,
                        Confidence::Extracted,
                    ));
                }
                let module = match spec.family {
                    Family::Rocq => Some(rocq_module(&import.module)),
                    Family::Lean => Some(Cow::Borrowed(import.module.as_str())),
                    _ => None,
                };
                imported.entry((path, None)).or_default().push(Imported {
                    path: target,
                    names: names.clone(),
                    module,
                    alias: None,
                });
            }
        }
    }

    let names = Names::new(files);
    // Reused per raw edge: global candidates before each context's visibility filter.
    let mut candidates: Vec<&Node> = Vec::new();
    for (path, entry) in files {
        let Some(&family) = names.family_of.get(path.as_str()) else {
            continue;
        };
        let mut push = |raw: &RawEdge, node: &Node, confidence| {
            if node.id != raw.from {
                edges.push(edge(&raw.from, &node.id, raw.relation, confidence));
            }
        };
        if family != Family::Fstar {
            let imports = imported
                .get(&(path.as_str(), None))
                .map_or(&[][..], Vec::as_slice);
            for raw in &entry.raw_edges {
                if let Some((node, confidence)) = names.target(path, family, imports, raw) {
                    push(raw, node, confidence);
                }
            }
            continue;
        }
        // Contexts importing alike bind alike, except for the global fallback over each one's
        // visible files: an installed library is bound once, not once per project scope.
        let mut groups: Vec<(&[Imported<'_>], Vec<usize>)> = Vec::new();
        for &context in fstar.contexts(path) {
            let imports = imported
                .get(&(path.as_str(), Some(context)))
                .map_or(&[][..], Vec::as_slice);
            match groups
                .iter_mut()
                .find(|(other, _)| same_imports(other, imports))
            {
                Some((_, contexts)) => contexts.push(context),
                None => groups.push((imports, vec![context])),
            }
        }
        for (imports, contexts) in &groups {
            for raw in &entry.raw_edges {
                match names.formal_target(path, family, imports, raw) {
                    Binding::Bound(node, confidence) => push(raw, node, confidence),
                    Binding::Unbound => {}
                    Binding::Global => {
                        candidates.clear();
                        candidates.extend(names.global_candidates(&raw.target, family));
                        let [first, rest @ ..] = candidates.as_slice() else {
                            continue;
                        };
                        if rest.is_empty() {
                            // Unique anywhere: unique wherever it is visible.
                            if contexts
                                .iter()
                                .any(|&c| fstar.visible(c).contains(&first.path))
                            {
                                push(raw, first, Confidence::Inferred);
                            }
                            continue;
                        }
                        // Two candidates every context sees: ambiguous in each of them.
                        let everywhere = fstar.everywhere();
                        let shared = candidates.iter().filter(|n| everywhere.contains(&n.path));
                        if shared.take(2).count() == 2 {
                            continue;
                        }
                        let mut bound: Vec<&Node> = Vec::new();
                        for &context in contexts {
                            let visible = fstar.visible(context);
                            let mut seen = candidates.iter().filter(|n| visible.contains(&n.path));
                            if let (Some(&node), None) = (seen.next(), seen.next())
                                && !bound.iter().any(|other| std::ptr::eq(*other, node))
                            {
                                bound.push(node);
                                push(raw, node, Confidence::Inferred);
                            }
                        }
                    }
                }
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
