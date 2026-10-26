//! Published F*/Pulse syntax only; no elaboration, generated declarations, or proof execution.

use std::sync::OnceLock;

use tree_sitter::{Node, Parser, Query, Tree};

use crate::{
    extract::{Captures, Ref},
    model::{NodeKind, Relation},
};

fn text<'t>(node: Node<'t>, source: &'t str) -> &'t str {
    node.utf8_text(source.as_bytes()).unwrap_or("")
}

fn name(text: &str) -> &str {
    let text = text.trim();
    text.strip_prefix('(')
        .and_then(|text| text.strip_suffix(')'))
        .unwrap_or(text)
        .trim()
}

pub(super) fn exported(node: Node<'_>, source: &str) -> bool {
    for ancestor in std::iter::successors(Some(node), Node::parent) {
        let mut cursor = ancestor.walk();
        if ancestor
            .named_children(&mut cursor)
            .any(|child| child.kind() == "qualifier" && text(child, source) == "private")
        {
            return false;
        }
    }
    true
}

/// Reparse the mixed file, not snippets: blanking bytes preserves every source coordinate.
pub(super) fn pulse_tree(root: Node<'_>, source: &str) -> Option<Tree> {
    let is_pulse = |extension: Node<'_>| {
        extension
            .child_by_field_name("language")
            .is_some_and(|language| text(language, source) == "pulse")
    };
    let mut cursor = root.walk();
    if !root.named_children(&mut cursor).any(|node| {
        matches!(node.kind(), "syntax_extension" | "language_extension") && is_pulse(node)
    }) {
        return None;
    }
    let mut masked = source.as_bytes().to_vec();
    let mut cursor = root.walk();
    for extension in root
        .named_children(&mut cursor)
        .filter(|node| matches!(node.kind(), "syntax_extension" | "language_extension"))
    {
        let body = is_pulse(extension)
            .then(|| extension.child_by_field_name("body"))
            .flatten();
        for (offset, byte) in masked[extension.byte_range()].iter_mut().enumerate() {
            let offset = extension.start_byte() + offset;
            if !body.is_some_and(|body| body.byte_range().contains(&offset))
                && !matches!(*byte, b'\n' | b'\r')
            {
                *byte = b' ';
            }
        }
    }
    let mut parser = Parser::new();
    parser.set_language(&crate::lang::pulse_language()).ok()?;
    parser.parse(masked, None)
}

pub(super) fn pulse_query() -> &'static Query {
    static QUERY: OnceLock<Query> = OnceLock::new();
    QUERY.get_or_init(|| {
        Query::new(
            &crate::lang::pulse_language(),
            concat!(
                include_str!("../queries/fstar.scm"),
                "\n",
                include_str!("../queries/pulse.scm")
            ),
        )
        .expect("bundled Pulse query matches the published grammar")
    })
}

pub(super) fn adjust<'t>(root: Node<'t>, source: &'t str, captures: &mut Captures<'t>) {
    for def in &mut captures.defs {
        def.name = name(def.name);
        match def.node.kind() {
            "module_declaration" => {
                def.end_byte = root.end_byte();
                def.end_line = root.end_position().row as u32 + 1;
            }
            "val_declaration" | "instance_val_declaration" => def.declaration_only = true,
            "let_declaration" => {
                // _binding is hidden: repeated name/parameters/type/value fields are siblings.
                let declaration = def.node;
                let mut cursor = declaration.walk();
                let mut in_binding = false;
                for (i, child) in declaration.children(&mut cursor).enumerate() {
                    match declaration.field_name_for_child(i as u32) {
                        Some("name") => {
                            in_binding = name(text(child, source)) == def.name;
                            if in_binding && Some(child) != declaration.child_by_field_name("name")
                            {
                                def.node = child;
                            }
                        }
                        Some("value") if in_binding => {
                            def.end_byte = child.end_byte();
                            def.end_line = child.end_position().row as u32 + 1;
                            break;
                        }
                        _ => {}
                    }
                }
            }
            "type_definition" => {
                if let Some(parent) = def.node.parent() {
                    if parent.kind() == "class_declaration" {
                        def.kind = NodeKind::Interface;
                    } else if def
                        .node
                        .child_by_field_name("value")
                        .is_some_and(|n| n.kind() == "record_type")
                    {
                        def.kind = NodeKind::Class;
                    }
                    let mut cursor = parent.walk();
                    if parent
                        .named_children(&mut cursor)
                        .find(|n| n.kind() == "type_definition")
                        == Some(def.node)
                    {
                        def.node = parent;
                    }
                }
            }
            "effect_definition" => {
                if let Some(parent) = def.node.parent() {
                    def.node = parent;
                    def.end_byte = parent.end_byte();
                    def.end_line = parent.end_position().row as u32 + 1;
                }
            }
            _ => {}
        }
        let span = &source[def.node.start_byte()..def.end_byte];
        let trimmed = span.trim_end().len();
        def.end_line -= span[trimmed..]
            .bytes()
            .filter(|&byte| byte == b'\n')
            .count() as u32;
        def.end_byte = def.node.start_byte() + trimmed;
    }
    Walker {
        source,
        refs: &mut captures.refs,
        locals: Vec::new(),
        in_type: false,
    }
    .walk(root, Relation::References);
}

struct Walker<'a, 't> {
    source: &'t str,
    refs: &'a mut Vec<Ref<'t>>,
    locals: Vec<&'t str>,
    in_type: bool,
}

impl<'t> Walker<'_, 't> {
    fn reference(&mut self, node: Node<'t>, relation: Relation) {
        let target = name(text(node, self.source));
        let head = target.split('.').next().unwrap_or(target);
        if !target.is_empty() && !target.starts_with('\'') && !self.locals.contains(&head) {
            self.refs.push(Ref {
                start: node.start_byte(),
                line: node.start_position().row as u32 + 1,
                relation,
                target,
            });
        }
    }

    fn bind_name(&mut self, node: Node<'t>) {
        if node.kind() != "wildcard" {
            self.locals.push(name(text(node, self.source)));
        }
    }

    fn field(&mut self, child: Node<'t>, field: Option<&str>, relation: Relation) {
        let saved = self.in_type;
        self.in_type |= field == Some("type");
        self.walk(
            child,
            if self.in_type {
                Relation::References
            } else {
                relation
            },
        );
        self.in_type = saved;
    }

    /// Parameter patterns and dependent binders introduce names, never dependencies.
    fn bind(&mut self, node: Node<'t>) {
        match node.kind() {
            "identifier" | "operator_identifier" => self.bind_name(node),
            "constructor_pattern" | "quoted_pattern" => self.walk(node, Relation::References),
            "implicit_binder" => {
                if let Some(value) = node.child_by_field_name("value") {
                    self.bind(value);
                }
            }
            "record_pattern_field" => {
                if let Some(field) = node.child_by_field_name("field") {
                    self.reference(field, Relation::References);
                    if let Some(pattern) = node.child_by_field_name("pattern") {
                        self.bind(pattern);
                    } else {
                        self.bind_name(field);
                    }
                }
            }
            _ => {
                // Names are not in scope in their own annotation, but are in refinements.
                if let Some(typ) = node.child_by_field_name("type") {
                    self.field(typ, Some("type"), Relation::References);
                }
                let mut cursor = node.walk();
                for (i, child) in node.children(&mut cursor).enumerate() {
                    if child.is_named() {
                        match node.field_name_for_child(i as u32) {
                            Some("type" | "condition") => {}
                            Some("name") => self.bind_name(child),
                            _ if !matches!(
                                child.kind(),
                                "argument_qualifier"
                                    | "binder_attribute"
                                    | "constant_pattern"
                                    | "inline_constraint"
                            ) =>
                            {
                                self.bind(child)
                            }
                            _ => {}
                        }
                    }
                }
                if let Some(condition) = node.child_by_field_name("condition") {
                    self.field(condition, Some("type"), Relation::References);
                }
            }
        }
    }

    fn bindings(&mut self, node: Node<'t>, local: bool) {
        let outer = self.locals.len();
        let recursive =
            (0..node.child_count()).any(|i| node.child(i).is_some_and(|n| n.kind() == "rec"));
        if local && recursive {
            let mut cursor = node.walk();
            for binding in node.children_by_field_name("name", &mut cursor) {
                self.bind_name(binding);
            }
        }
        let rhs_scope = self.locals.len();
        let mut cursor = node.walk();
        for (i, child) in node.children(&mut cursor).enumerate() {
            if !child.is_named() {
                continue;
            }
            match node.field_name_for_child(i as u32) {
                Some("name" | "pattern") => {
                    self.locals.truncate(rhs_scope);
                    if node.field_name_for_child(i as u32) == Some("pattern") {
                        self.bind(child);
                        self.locals.truncate(rhs_scope);
                    }
                }
                Some("parameters") => self.bind(child),
                Some("body") => {
                    self.locals.truncate(outer);
                    let mut names = node.walk();
                    for (j, binding) in node.children(&mut names).enumerate() {
                        match node.field_name_for_child(j as u32) {
                            Some("name") => self.bind_name(binding),
                            Some("pattern") => self.bind(binding),
                            _ => {}
                        }
                    }
                    self.walk(child, Relation::References);
                }
                field => self.field(child, field, Relation::References),
            }
        }
        self.locals.truncate(outer);
    }

    fn walk(&mut self, node: Node<'t>, relation: Relation) {
        let saved = self.locals.len();
        let in_type = self.in_type;
        self.in_type |= matches!(
            node.kind(),
            "quantifier_expression" | "proof_forall" | "proof_exists"
        );
        match node.kind() {
            "line_comment"
            | "block_comment"
            | "string"
            | "character"
            | "universe"
            | "syntax_extension"
            | "language_extension"
            | "attribute"
            | "binder_attribute"
            | "qualifier"
            | "module_declaration"
            | "module_alias"
            | "open_declaration"
            | "include_declaration"
            | "friend_declaration"
            | "pulse_open_statement"
            | "pulse_goto_statement"
            | "ERROR" => return,
            "identifier"
            | "constructor_identifier"
            | "qualified_identifier"
            | "operator_identifier"
            | "operator" => {
                self.reference(node, relation);
                return;
            }
            "let_declaration" | "instance_declaration" => self.bindings(node, false),
            "let_expression" => self.bindings(node, true),
            "pulse_statement_sequence" => {
                let mut cursor = node.walk();
                for child in node.named_children(&mut cursor) {
                    self.walk(child, relation);
                    match child.kind() {
                        "pulse_let_statement" => {
                            if let Some(pattern) = child.child_by_field_name("pattern") {
                                self.bind(pattern);
                            }
                        }
                        "pulse_local_function_statement" => {
                            if let Some(name) = child.child_by_field_name("name") {
                                self.bind_name(name);
                            }
                        }
                        _ => {}
                    }
                }
            }
            "bind_expression" | "pulse_let_statement" => {
                let mut cursor = node.walk();
                for (i, child) in node.children(&mut cursor).enumerate() {
                    if child.is_named() {
                        match node.field_name_for_child(i as u32) {
                            Some("name" | "pattern") => {}
                            Some("body") => {
                                if let Some(name) = node.child_by_field_name("name") {
                                    self.bind_name(name);
                                }
                                self.walk(child, relation);
                            }
                            field => self.field(child, field, relation),
                        }
                    }
                }
            }
            "arrow_type" | "dependent_tuple_type" => {
                if let Some(left) = node.child_by_field_name("left") {
                    if matches!(
                        left.kind(),
                        "refinement_type" | "implicit_binder" | "binder" | "typeclass_constraint"
                    ) {
                        self.bind(left);
                    } else {
                        self.field(left, Some("type"), Relation::References);
                    }
                }
                if let Some(right) = node.child_by_field_name("right") {
                    self.field(right, Some("type"), Relation::References);
                }
            }
            "refinement_type" | "binder" | "constraint" => self.bind(node),
            "let_operator_expression" => {
                let mut cursor = node.walk();
                for child in node.named_children(&mut cursor) {
                    if child.kind() == "operator_binding" {
                        let mut fields = child.walk();
                        for (i, part) in child.children(&mut fields).enumerate() {
                            if part.is_named()
                                && child.field_name_for_child(i as u32) != Some("pattern")
                            {
                                self.field(part, child.field_name_for_child(i as u32), relation);
                            }
                        }
                        if let Some(pattern) = child.child_by_field_name("pattern") {
                            self.bind(pattern);
                        }
                    } else {
                        self.walk(child, relation);
                    }
                }
            }
            _ => {
                let declaration = node.kind().ends_with("_declaration")
                    || matches!(
                        node.kind(),
                        "type_definition"
                            | "effect_definition"
                            | "pulse_function_definition"
                            | "pulse_local_function_statement"
                    );
                if node.kind() == "pulse_local_function_statement" {
                    if let Some(name) = node.child_by_field_name("name") {
                        self.bind_name(name);
                    }
                }
                let mut cursor = node.walk();
                for (i, child) in node.children(&mut cursor).enumerate() {
                    if !child.is_named() {
                        continue;
                    }
                    let field = node.field_name_for_child(i as u32);
                    match field {
                        Some("parameters" | "pattern") => self.bind(child),
                        Some("name") if declaration => {}
                        Some("name") if node.kind() == "pulse_contract" => {}
                        Some("name")
                            if matches!(
                                node.kind(),
                                "returns_annotation" | "pulse_label_statement"
                            ) =>
                        {
                            self.bind_name(child)
                        }
                        Some("function") => self.walk(
                            child,
                            if self.in_type {
                                Relation::References
                            } else {
                                Relation::Calls
                            },
                        ),
                        Some("operator")
                            if matches!(node.kind(), "binary_expression" | "unary_expression") =>
                        {
                            self.walk(
                                child,
                                if self.in_type {
                                    Relation::References
                                } else {
                                    Relation::Calls
                                },
                            )
                        }
                        Some("value") if node.kind() == "type_definition" => {
                            self.field(child, Some("type"), Relation::References)
                        }
                        Some("value")
                            if node.kind() == "pulse_contract"
                                && node
                                    .child_by_field_name("kind")
                                    .is_some_and(|kind| text(kind, self.source) == "returns") =>
                        {
                            self.field(child, Some("type"), Relation::References)
                        }
                        _ => self.field(child, field, relation),
                    }
                    // Return binders scope over subsequent contracts and the function body.
                    if matches!(child.kind(), "pulse_contract" | "returns_annotation") {
                        if let Some(name) = child.child_by_field_name("name") {
                            self.bind_name(name);
                        }
                    }
                }
            }
        }
        self.in_type = in_type;
        self.locals.truncate(saved);
    }
}
