//! Parse one file and run its language query → nodes, raw (name-level) edges, imports.

use std::{cmp::Reverse, collections::HashMap};

use tree_sitter::{Node as TsNode, Parser, Query, QueryCursor, StreamingIterator};

use crate::{
    lang::{Family, LangSpec, Language, spec_for_name},
    model::{ImportSpec, Node, NodeKind, RawEdge, Relation},
};

#[derive(Default)]
pub struct FileExtract {
    /// Canonical language after content-based Rust/Verus parser selection.
    pub lang: Option<&'static str>,
    pub nodes: Vec<Node>,
    pub declarations: Vec<u32>,
    pub raw_edges: Vec<RawEdge>,
    pub imports: Vec<ImportSpec>,
    pub error: Option<String>,
}

/// A `@definition.*` match, merged across patterns that capture the same node.
pub(super) struct Def<'t> {
    pub(super) node: TsNode<'t>,
    pub(super) kind: NodeKind,
    pub(super) name: &'t str,
    /// Explicit `@owner` (Go receiver, C++ `Foo::bar`).
    pub(super) owner_name: Option<&'t str>,
    pub(super) end_byte: usize,
    pub(super) end_line: u32,
    pub(super) declaration_only: bool,
}

/// A `@scope`: names its contents' owner without being a node (Rust `impl`).
pub(super) struct Scope<'t> {
    pub(super) start: usize,
    pub(super) end: usize,
    pub(super) name: &'t str,
}

pub(super) struct Ref<'t> {
    pub(super) start: usize,
    pub(super) line: u32,
    pub(super) relation: Relation,
    pub(super) target: &'t str,
}

/// One import statement, merged across the patterns that match it.
pub(super) struct ImportGroup<'t> {
    pub(super) line: u32,
    pub(super) module: Option<&'t str>,
    pub(super) kind: Option<&'t str>,
    pub(super) names: Vec<&'t str>,
}

/// The innermost definition or scope enclosing a position.
#[derive(Clone, Copy)]
enum Container {
    File,
    Def(usize),
    Scope(usize),
}

fn def_kind(suffix: &str) -> Option<NodeKind> {
    Some(match suffix {
        "function" => NodeKind::Function,
        "method" => NodeKind::Method,
        "class" => NodeKind::Class,
        "interface" => NodeKind::Interface,
        "type" => NodeKind::Type,
        "module" => NodeKind::Module,
        "constant" => NodeKind::Constant,
        "field" => NodeKind::Field,
        "macro" => NodeKind::Macro,
        _ => return None,
    })
}

fn ref_relation(suffix: &str) -> Option<Relation> {
    Some(match suffix {
        "call" | "send" => Relation::Calls,
        "class" | "type" | "interface" => Relation::References,
        "implementation" | "implements" => Relation::Implements,
        "extends" => Relation::Extends,
        _ => return None,
    })
}

/// Reduce a reference/heritage text (`Foo<T>`, `a::b::C`, `\Ns\C`) to its final identifier.
fn simple_name(text: &str) -> &str {
    let text = text.split(['<', '(', '[']).next().unwrap_or("").trim();
    text.rsplit(['.', ':', '\\']).next().unwrap_or("").trim()
}

fn strip_module(text: &str) -> &str {
    text.trim()
        .trim_matches(|c| matches!(c, '"' | '\'' | '`' | '<' | '>'))
}

fn first_line(text: &str) -> String {
    let line = text.lines().next().unwrap_or("").trim();
    match line.char_indices().nth(200) {
        Some((i, _)) => line[..i].to_string(),
        None => line.to_string(),
    }
}

fn line_of(node: TsNode<'_>) -> u32 {
    node.start_position().row as u32 + 1
}

fn is_class_like(kind: NodeKind) -> bool {
    matches!(kind, NodeKind::Class | NodeKind::Interface | NodeKind::Type)
}

/// C/C++ tags capture the `function_declarator`; widen to the enclosing definition so its body is
/// the container.
fn widen(node: TsNode<'_>) -> TsNode<'_> {
    if node.kind() != "function_declarator" {
        return node;
    }
    let mut cur = node;
    while let Some(parent) = cur.parent() {
        match parent.kind() {
            "pointer_declarator" | "reference_declarator" | "function_declarator" => cur = parent,
            "function_definition" => return parent,
            _ => break,
        }
    }
    node
}

fn exported(family: Family, def: &Def<'_>, signature: &str, source: &str) -> bool {
    match family {
        Family::Js => std::iter::successors(Some(def.node), TsNode::parent)
            .take(3)
            .any(|n| n.kind() == "export_statement"),
        Family::Rust => signature.starts_with("pub"),
        Family::Go => def.name.chars().next().is_some_and(char::is_uppercase),
        Family::Python => !def.name.starts_with('_'),
        Family::Fstar => crate::fstar::exported(def.node, source),
        // ponytail: heuristic; language-exact export rules when a consumer needs them.
        _ => true,
    }
}

/// Query matches of one file, merged per definition node and per import statement.
#[derive(Default)]
pub(super) struct Captures<'t> {
    pub(super) defs: Vec<Def<'t>>,
    def_index: HashMap<(usize, usize, &'t str), usize>,
    pub(super) scopes: Vec<Scope<'t>>,
    pub(super) refs: Vec<Ref<'t>>,
    pub(super) imports: Vec<ImportGroup<'t>>,
    import_index: HashMap<(usize, usize), usize>,
}

impl<'t> Captures<'t> {
    fn collect(query: &Query, root: TsNode<'t>, source: &'t str, family: Family) -> Self {
        let text = |n: TsNode<'t>| n.utf8_text(source.as_bytes()).unwrap_or("");
        let names = query.capture_names();
        let mut out = Self::default();
        let mut cursor = QueryCursor::new();
        let mut matches = cursor.matches(query, root, source.as_bytes());
        while let Some(m) = matches.next() {
            let (mut name, mut owner, mut def, mut scope, mut reference) =
                (None, None, None, None, None);
            let (mut import, mut module, mut kind, mut import_names) =
                (None, None, None, Vec::new());
            for cap in m.captures {
                let node = cap.node;
                match names[cap.index as usize] {
                    "name" => {
                        name.get_or_insert(node);
                    }
                    "owner" => owner = Some(text(node)),
                    "scope" => scope = Some(node),
                    "import" => import = Some(node),
                    "import.module" => module = Some(strip_module(text(node))),
                    "import.kind" => kind = Some(text(node)),
                    "import.name" => import_names.push(text(node)),
                    other => {
                        if let Some(k) = other.strip_prefix("definition.").and_then(def_kind) {
                            def = Some((node, k));
                        } else if let Some(r) =
                            other.strip_prefix("reference.").and_then(ref_relation)
                        {
                            reference = Some((node, r));
                        }
                    }
                }
            }
            if let Some(import) = import {
                out.add_import(import, module, kind, import_names);
                continue;
            }
            let Some(name) = name.map(text) else { continue };
            if let Some((node, kind)) = def {
                out.add_def(widen(node), kind, name, owner);
            } else if let Some(node) = scope {
                let name = simple_name(name);
                if !name.is_empty() {
                    out.scopes.push(Scope {
                        start: node.start_byte(),
                        end: node.end_byte(),
                        name,
                    });
                }
            } else if let Some((node, relation)) = reference {
                let target = if matches!(family, Family::Rocq | Family::Lean | Family::Fstar) {
                    name.trim()
                } else {
                    simple_name(name)
                };
                if !target.is_empty() {
                    out.refs.push(Ref {
                        start: node.start_byte(),
                        line: line_of(node),
                        relation,
                        target,
                    });
                }
            }
        }
        out
    }

    /// Several patterns may capture one node (Rust `function_item` as method and function):
    /// Method beats Function, and an explicit owner sticks.
    pub(super) fn add_def(
        &mut self,
        node: TsNode<'t>,
        kind: NodeKind,
        name: &'t str,
        owner_name: Option<&'t str>,
    ) {
        if name.is_empty() {
            return;
        }
        let key = (node.start_byte(), node.end_byte(), name);
        if let Some(&i) = self.def_index.get(&key) {
            let existing = &mut self.defs[i];
            if existing.kind == NodeKind::Function && kind == NodeKind::Method {
                existing.kind = kind;
            }
            existing.owner_name = existing.owner_name.or(owner_name);
        } else {
            self.def_index.insert(key, self.defs.len());
            self.defs.push(Def {
                node,
                kind,
                name,
                owner_name,
                end_byte: node.end_byte(),
                end_line: node.end_position().row as u32 + 1,
                declaration_only: false,
            });
        }
    }

    pub(super) fn add_import(
        &mut self,
        node: TsNode<'t>,
        module: Option<&'t str>,
        kind: Option<&'t str>,
        names: Vec<&'t str>,
    ) {
        let key = (node.start_byte(), node.end_byte());
        let i = *self.import_index.entry(key).or_insert_with(|| {
            self.imports.push(ImportGroup {
                line: line_of(node),
                module: None,
                kind: None,
                names: Vec::new(),
            });
            self.imports.len() - 1
        });
        let group = &mut self.imports[i];
        group.module = group.module.or(module.filter(|m| !m.is_empty()));
        group.kind = group.kind.or(kind);
        for name in names {
            if !group.names.contains(&name) {
                group.names.push(name);
            }
        }
    }
}

/// Where each definition and reference sits: definitions' ancestor containers (outermost first),
/// their innermost container, and each reference's innermost container.
struct Nesting {
    ancestors: Vec<Vec<Container>>,
    def_container: Vec<Container>,
    ref_container: Vec<Container>,
}

/// Innermost open container at `pos` on a stack of `(end, container)`, closing those that ended.
fn innermost(stack: &mut Vec<(usize, Container)>, pos: usize) -> Container {
    while stack.last().is_some_and(|&(end, _)| end <= pos) {
        stack.pop();
    }
    stack.last().map_or(Container::File, |&(_, c)| c)
}

/// One document-order sweep over containers and references (sorted by start) with a stack of
/// open containers. A container starting where a reference starts encloses it (Rust `impl Trait
/// for S` contains its own `Implements` reference).
fn nest(defs: &[Def<'_>], scopes: &[Scope<'_>], refs: &[Ref<'_>]) -> Nesting {
    let mut items: Vec<(usize, usize, Container)> = defs
        .iter()
        .enumerate()
        .map(|(i, d)| (d.node.start_byte(), d.end_byte, Container::Def(i)))
        .chain(
            scopes
                .iter()
                .enumerate()
                .map(|(i, s)| (s.start, s.end, Container::Scope(i))),
        )
        .collect();
    items.sort_by_key(|&(start, end, _)| (start, Reverse(end)));

    let mut out = Nesting {
        ancestors: vec![Vec::new(); defs.len()],
        def_container: vec![Container::File; defs.len()],
        ref_container: vec![Container::File; refs.len()],
    };
    // Open containers as `(end, container)`.
    let mut stack: Vec<(usize, Container)> = Vec::new();
    let mut refs = refs.iter().enumerate().peekable();
    for (start, end, c) in items {
        while let Some((i, r)) = refs.next_if(|(_, r)| r.start < start) {
            out.ref_container[i] = innermost(&mut stack, r.start);
        }
        let top = innermost(&mut stack, start);
        if let Container::Def(i) = c {
            out.ancestors[i] = stack.iter().map(|&(_, c)| c).collect();
            out.def_container[i] = top;
        }
        stack.push((end, c));
    }
    for (i, r) in refs {
        out.ref_container[i] = innermost(&mut stack, r.start);
    }
    out
}

pub fn extract(path: &str, source: &str, spec: &LangSpec) -> FileExtract {
    let mut parser = Parser::new();
    let mut parse = |spec: &LangSpec| {
        parser
            .set_language(&spec.lang.get_ts_language())
            .ok()
            .and_then(|()| parser.parse(source, None))
    };
    let mut spec = spec;
    let Some(mut tree) = parse(spec) else {
        return FileExtract {
            error: Some("parse failed".into()),
            ..FileExtract::default()
        };
    };
    if spec.lang == Language::Builtin(pi_ast::SupportLang::Rust)
        && crate::verus::is_verus(tree.root_node(), source)
    {
        spec = spec_for_name("verus").expect("vendored Verus grammar is registered");
        let Some(verus_tree) = parse(spec) else {
            return FileExtract {
                lang: Some("verus"),
                error: Some("parse failed".into()),
                ..FileExtract::default()
            };
        };
        tree = verus_tree;
    }
    let mut query = spec.query();
    if spec.lang == Language::Fstar
        && let Some(pulse_tree) = crate::fstar::pulse_tree(tree.root_node(), source)
    {
        tree = pulse_tree;
        query = crate::fstar::pulse_query();
    }
    let mut captures = Captures::collect(query, tree.root_node(), source, spec.family);
    match spec.lang {
        Language::Rocq => crate::rocq::adjust(tree.root_node(), source, &mut captures),
        Language::Lean => crate::lean::adjust(tree.root_node(), source, &mut captures),
        Language::Verus => crate::verus::adjust(tree.root_node(), source, &mut captures),
        Language::Fstar => crate::fstar::adjust(tree.root_node(), source, &mut captures),
        Language::Builtin(_) => {}
    }
    let Captures {
        defs,
        scopes,
        mut refs,
        imports,
        ..
    } = captures;
    refs.sort_by_key(|r| r.start);
    let nesting = nest(&defs, &scopes, &refs);

    let label = |c: Container| match c {
        Container::Def(i) => defs[i].name,
        Container::Scope(i) => scopes[i].name,
        Container::File => "",
    };
    let ids: Vec<String> = defs
        .iter()
        .zip(&nesting.ancestors)
        .map(|(d, ancestors)| {
            let mut chain: Vec<&str> = ancestors.iter().map(|&c| label(c)).collect();
            if chain.is_empty()
                && let Some(owner) = d.owner_name
            {
                chain.push(owner);
            }
            chain.push(d.name);
            format!("{path}#{}:{}", chain.join("."), line_of(d.node))
        })
        .collect();

    // Owner by name: the file's unique class-like definition of that name.
    let mut class_like: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, d) in defs
        .iter()
        .enumerate()
        .filter(|(_, d)| is_class_like(d.kind))
    {
        class_like.entry(d.name).or_default().push(i);
    }
    let unique_class = |name: &str| match class_like.get(name).map(Vec::as_slice) {
        Some(&[i]) => Some(i),
        _ => None,
    };
    let scope_owner: Vec<Option<usize>> = scopes.iter().map(|s| unique_class(s.name)).collect();

    let mut nodes: Vec<Node> = Vec::with_capacity(defs.len());
    let mut seen: HashMap<&str, (usize, bool)> = HashMap::with_capacity(defs.len());
    for (i, d) in defs.iter().enumerate() {
        let container = nesting.def_container[i];
        let owner = match (d.owner_name, container) {
            (Some(o), _) => unique_class(o),
            (None, Container::Def(j)) => Some(j),
            (None, Container::Scope(s)) => scope_owner[s],
            (None, Container::File) => None,
        };
        let owner_kind = owner.map(|j| defs[j].kind);
        let kind = match d.kind {
            NodeKind::Function
                if d.owner_name.is_some()
                    || owner_kind.is_some_and(is_class_like)
                    || matches!(container, Container::Scope(_)) =>
            {
                NodeKind::Method
            }
            NodeKind::Method if owner_kind == Some(NodeKind::Module) => NodeKind::Function,
            kind => kind,
        };
        let signature = first_line(&source[d.node.start_byte()..d.end_byte]);
        let node = Node {
            id: ids[i].clone(),
            name: d.name.to_string(),
            kind,
            path: path.to_string(),
            owner: owner.map(|j| ids[j].clone()),
            start_line: line_of(d.node),
            end_line: d.end_line,
            exported: exported(spec.family, d, &signature, source),
            signature,
        };
        // Distinct nodes can still share an id (same qualified name and line): Method beats
        // Function; an implementation beats a declaration, otherwise the first wins.
        match seen.get(ids[i].as_str()) {
            Some(&(j, declaration_only))
                if (nodes[j].kind == NodeKind::Function && kind == NodeKind::Method)
                    || (declaration_only && !d.declaration_only) =>
            {
                nodes[j] = node;
                seen.insert(&ids[i], (j, d.declaration_only));
            }
            Some(_) => {}
            None => {
                seen.insert(&ids[i], (nodes.len(), d.declaration_only));
                nodes.push(node);
            }
        }
    }
    nodes.sort_by(|a, b| (a.start_line, &a.id).cmp(&(b.start_line, &b.id)));
    let declarations = nodes
        .iter()
        .enumerate()
        .filter(|(_, node)| {
            seen.get(node.id.as_str())
                .is_some_and(|(_, declaration)| *declaration)
        })
        .map(|(i, _)| i as u32)
        .collect();

    let from = |c: Container| match c {
        Container::Def(i) => ids[i].clone(),
        Container::Scope(s) => scope_owner[s].map_or_else(|| path.to_string(), |j| ids[j].clone()),
        Container::File => path.to_string(),
    };
    let mut raw_edges: Vec<RawEdge> = refs
        .iter()
        .zip(&nesting.ref_container)
        .map(|(r, &c)| RawEdge {
            from: from(c),
            relation: r.relation,
            target: r.target.to_string(),
            line: r.line,
        })
        .collect();
    raw_edges.sort_by(|a, b| {
        (a.line, a.relation, &a.target, &a.from).cmp(&(b.line, b.relation, &b.target, &b.from))
    });
    raw_edges.dedup();

    let imports = imports
        .into_iter()
        .filter_map(|g| {
            let module = g.module?;
            Some(ImportSpec {
                module: g
                    .kind
                    .map_or_else(|| module.to_string(), |kind| format!("{kind}:{module}")),
                names: g.names.into_iter().map(str::to_string).collect(),
                line: g.line,
            })
        })
        .collect();
    FileExtract {
        lang: Some(spec.lang.canonical_name()),
        nodes,
        declarations,
        raw_edges,
        imports,
        error: None,
    }
}
