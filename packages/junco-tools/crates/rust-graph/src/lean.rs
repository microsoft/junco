//! Static Lean syntax only: no elaboration, notation expansion, or generated declarations.

use std::collections::HashMap;

use tree_sitter::Node;

use crate::{
    extract::{Captures, Ref},
    model::{NodeKind, Relation},
};

pub(super) fn adjust<'t>(root: Node<'t>, source: &'t str, captures: &mut Captures<'t>) {
    let namespaces: HashMap<_, _> = captures
        .defs
        .iter()
        .enumerate()
        .filter(|(_, d)| d.node.kind() == "namespace")
        .map(|(i, d)| (d.node.id(), i))
        .collect();
    for def in &mut captures.defs {
        if def.node.kind() == "structure" && def.node.child(0).is_some_and(|n| n.kind() == "class")
        {
            def.kind = NodeKind::Interface;
        }
        if let Some(parent) = def.node.parent().filter(|n| n.kind() == "declaration") {
            def.node = parent;
            def.end_byte = parent.end_byte();
            def.end_line = parent.end_position().row as u32 + 1;
        }
        if def.kind == NodeKind::Module {
            def.end_byte = root.end_byte();
            def.end_line = root.end_position().row as u32 + 1;
        }
    }

    // Sections restore variables, but unlike namespaces never qualify declaration names.
    let mut blocks = Vec::new();
    let mut walker = Walker {
        source,
        refs: &mut captures.refs,
        locals: Vec::new(),
        in_type: false,
    };
    let mut cursor = root.walk();
    for command in root.named_children(&mut cursor) {
        match command.kind() {
            "namespace" | "section" | "mutual" => {
                blocks.push((namespaces.get(&command.id()).copied(), walker.locals.len()));
            }
            "end" => {
                if let Some((namespace, locals)) = blocks.pop() {
                    walker.locals.truncate(locals);
                    if let Some(i) = namespace {
                        captures.defs[i].end_byte = command.end_byte();
                        captures.defs[i].end_line = command.end_position().row as u32 + 1;
                    }
                }
            }
            "variable" => walker.variable(command),
            "universe" => {
                let mut cursor = command.walk();
                for name in command.children_by_field_name("name", &mut cursor) {
                    walker.bind_names(name);
                }
            }
            "declaration" => walker.walk(command, Relation::References),
            _ => {
                if let Some(body) = command.child_by_field_name("body") {
                    walker.walk(body, Relation::References);
                }
            }
        }
    }
    // Layout tokens end at the next command's column zero; do not include that
    // command's line merely because the declaration consumed its leading newline.
    for def in &mut captures.defs {
        let text = &source[def.node.start_byte()..def.end_byte];
        let end = text.trim_end().len();
        def.end_line -= text[end..].bytes().filter(|&byte| byte == b'\n').count() as u32;
        def.end_byte = def.node.start_byte() + end;
    }
}

struct Walker<'a, 't> {
    source: &'t str,
    refs: &'a mut Vec<Ref<'t>>,
    locals: Vec<&'t str>,
    in_type: bool,
}

fn binder(kind: &str) -> bool {
    matches!(
        kind,
        "binders"
            | "explicit_binder"
            | "implicit_binder"
            | "strict_implicit_binder"
            | "instance_binder"
            | "tuple_binder"
            | "anon_ctor_binder"
    )
}

fn declaration_name(kind: &str) -> bool {
    matches!(
        kind,
        "def"
            | "abbrev"
            | "opaque"
            | "theorem"
            | "axiom"
            | "constant"
            | "instance"
            | "structure"
            | "inductive"
            | "field"
            | "ctor"
            | "ctor_alt"
            | "where_aux_def"
            | "struct_field"
            | "block_assign"
            | "tactic_case"
    )
}

impl<'t> Walker<'_, 't> {
    fn text(&self, node: Node<'t>) -> &'t str {
        node.utf8_text(self.source.as_bytes()).unwrap_or("")
    }

    fn reference(&mut self, node: Node<'t>, relation: Relation) {
        let target = self.text(node);
        // A dotted local is projection syntax, not a qualified global identifier.
        let head = target.split('.').next().unwrap_or(target);
        if !target.is_empty() && !self.locals.contains(&head) {
            self.refs.push(Ref {
                start: node.start_byte(),
                line: node.start_position().row as u32 + 1,
                relation,
                target,
            });
        }
    }

    fn bind_names(&mut self, node: Node<'t>) {
        if node.kind() == "identifier" {
            self.locals.push(self.text(node));
        } else {
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                self.bind_names(child);
            }
        }
    }

    fn bind(&mut self, node: Node<'t>) {
        if matches!(node.kind(), "binders" | "tuple_binder" | "anon_ctor_binder") {
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                if binder(child.kind()) {
                    self.bind(child);
                } else {
                    self.bind_names(child);
                }
            }
            return;
        }
        // A binder is not in scope in its own type or default value.
        let mut cursor = node.walk();
        for (i, child) in node.children(&mut cursor).enumerate() {
            if child.is_named() && node.field_name_for_child(i as u32) != Some("name") {
                self.field(
                    child,
                    node.field_name_for_child(i as u32),
                    Relation::References,
                );
            }
        }
        let mut cursor = node.walk();
        for name in node.children_by_field_name("name", &mut cursor) {
            self.bind_names(name);
        }
    }

    fn variable(&mut self, node: Node<'t>) {
        let saved = self.locals.len();
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            if binder(child.kind()) {
                self.bind(child);
            }
        }
        if let Some(body) = node.child_by_field_name("body") {
            self.walk(body, Relation::References);
            self.locals.truncate(saved);
        }
    }

    fn pattern(&mut self, node: Node<'t>) {
        match node.kind() {
            "identifier" if !self.text(node).contains('.') => self.bind_names(node),
            "identifier" => self.reference(node, Relation::References),
            "app" => {
                if let Some(function) = node.child_by_field_name("fn") {
                    if function.kind() == "identifier" {
                        self.reference(function, Relation::References);
                    } else {
                        self.pattern(function);
                    }
                }
                if let Some(arg) = node.child_by_field_name("arg") {
                    self.pattern(arg);
                }
            }
            "dot_ident" => self.walk(node, Relation::References),
            _ => {
                let mut cursor = node.walk();
                for child in node.named_children(&mut cursor) {
                    self.pattern(child);
                }
            }
        }
    }

    fn local_name(&mut self, node: Node<'t>) {
        if let Some(name) = node.child_by_field_name("name") {
            self.bind_names(name);
        }
    }

    fn tactic(&mut self, node: Node<'t>) {
        if node.kind() == "binary_op"
            && node
                .child_by_field_name("op")
                .is_some_and(|n| self.text(n) == "<;>")
        {
            if let Some(lhs) = node.child_by_field_name("lhs") {
                self.tactic(lhs);
            }
            if let Some(rhs) = node.child_by_field_name("rhs") {
                self.tactic(rhs);
            }
            return;
        }
        let mut head = node;
        while head.kind() == "app" {
            let Some(function) = head.child_by_field_name("fn") else {
                break;
            };
            head = function;
        }
        if head.kind() != "identifier" {
            self.walk(node, Relation::References);
            return;
        }
        let binding = matches!(self.text(head), "intro" | "intros" | "rintro" | "rename_i");
        // Tactic heads are syntax, not calls to same-spelled term declarations.
        self.tactic_args(node, head.id(), binding, false);
    }

    fn tactic_args(&mut self, node: Node<'t>, head: usize, binding: bool, applied: bool) {
        if node.id() == head {
            return;
        }
        if node.kind() == "app" {
            if let Some(function) = node.child_by_field_name("fn") {
                self.tactic_args(function, head, binding, true);
            }
            if let Some(arg) = node.child_by_field_name("arg") {
                if binding {
                    self.bind_names(arg);
                } else {
                    // In `exact lemma arg`, the grammar flattens the proof application
                    // into the tactic's application chain; lemma still has a call edge.
                    self.walk(
                        arg,
                        if applied {
                            Relation::Calls
                        } else {
                            Relation::References
                        },
                    );
                }
            }
        } else {
            self.walk(node, Relation::References);
        }
    }

    fn field(&mut self, node: Node<'t>, field: Option<&str>, relation: Relation) {
        let saved = self.in_type;
        self.in_type |= field == Some("type");
        self.walk(node, relation);
        self.in_type = saved;
    }

    fn walk(&mut self, node: Node<'t>, relation: Relation) {
        let kind = node.kind();
        if kind == "identifier" {
            self.reference(node, relation);
            return;
        }
        if matches!(
            kind,
            "comment"
                | "line_comment"
                | "block_comment"
                | "doc_comment"
                | "module_doc_comment"
                | "str_lit"
                | "raw_string"
                | "char_lit"
                | "name_lit"
                | "quotation"
                | "antiquot"
                | "named_hole"
                | "attributes"
                | "decl_modifiers"
                | "namespace"
                | "section"
                | "end"
                | "import"
                | "export"
                | "universe"
        ) {
            return;
        }
        if matches!(kind, "open" | "set_option") {
            if let Some(body) = node.child_by_field_name("body") {
                self.walk(body, relation);
            }
            return;
        }
        let saved = self.locals.len();
        if kind == "variable" {
            self.variable(node);
        } else if matches!(kind, "by" | "do_block") {
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                if kind == "by" {
                    self.tactic(child);
                } else {
                    self.walk(child, Relation::References);
                }
                if matches!(child.kind(), "let" | "have" | "suffices" | "by_cases") {
                    self.local_name(child);
                }
            }
        } else if matches!(kind, "let" | "have" | "suffices" | "by_cases") {
            let mut cursor = node.walk();
            if kind == "let" && node.children(&mut cursor).any(|n| n.kind() == "rec") {
                self.local_name(node);
            }
            let mut cursor = node.walk();
            for (i, child) in node.children(&mut cursor).enumerate() {
                if !child.is_named() {
                    continue;
                }
                match node.field_name_for_child(i as u32) {
                    Some("name" | "body") => {}
                    _ if binder(child.kind()) => self.bind(child),
                    field => self.field(child, field, Relation::References),
                }
            }
            self.locals.truncate(saved);
            self.local_name(node);
            if let Some(body) = node.child_by_field_name("body") {
                self.walk(body, relation);
            }
        } else {
            // Auxiliary `where` names are local to their enclosing declaration.
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                if child.kind() == "where_decls" {
                    let mut cursor = child.walk();
                    for helper in child.named_children(&mut cursor) {
                        self.local_name(helper);
                    }
                }
            }
            let mut cursor = node.walk();
            for (i, child) in node.children(&mut cursor).enumerate() {
                if !child.is_named() {
                    continue;
                }
                let field = node.field_name_for_child(i as u32);
                if binder(child.kind()) {
                    self.bind(child);
                } else if field == Some("level") {
                    self.bind_names(child);
                } else if (field == Some("name") && declaration_name(kind))
                    || field == Some("arg_name")
                    || (kind == "proj" && field == Some("field"))
                    || (kind == "induction" && field == Some("gen"))
                    || (kind == "instance" && matches!(field, Some("attr" | "value")))
                {
                    continue;
                } else if field == Some("pattern") {
                    // ponytail: syntax cannot distinguish an unqualified nullary constructor
                    // from a pattern variable; elaboration is required for that distinction.
                    self.pattern(child);
                } else if field == Some("binder")
                    || field == Some("hyp")
                    || (kind == "tactic_case" && field == Some("arg"))
                {
                    self.bind_names(child);
                } else if field == Some("body")
                    && (kind == "tactic_case"
                        || (kind == "match_alt"
                            && node.parent().is_some_and(|p| p.kind() == "induction")))
                {
                    self.tactic(child);
                } else {
                    let relation = if kind == "app" && !self.in_type {
                        if field == Some("fn") {
                            Relation::Calls
                        } else {
                            Relation::References
                        }
                    } else {
                        relation
                    };
                    self.field(child, field, relation);
                }
            }
        }
        self.locals.truncate(saved);
    }
}
