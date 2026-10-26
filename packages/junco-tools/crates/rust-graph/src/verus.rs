//! Verus routing and lexical-call filtering; declarations use the shared query pipeline.

use tree_sitter::Node;

use crate::{extract::Captures, model::Relation};

/// Inspect the initial Rust tree, never text inside comments, literals or opaque macros.
/// Valid ordinary Rust stays on its parser; standalone Verus modes/contracts need recovery
/// in the Rust tree, while `verus!` is a regular Rust macro invocation.
pub(super) fn is_verus(root: Node<'_>, source: &str) -> bool {
    let mut cursor = root.walk();
    let recovered = root.has_error();
    let mut mode = false;
    let mut header = false;
    let mut parens = 0usize;
    let mut brackets = 0usize;
    let mut parameters_done = false;
    loop {
        let node = cursor.node();
        let kind = node.kind();
        if kind == "macro_invocation"
            && node
                .child_by_field_name("macro")
                .is_some_and(|name| name.utf8_text(source.as_bytes()) == Ok("verus"))
        {
            return true;
        }
        let comment = matches!(kind, "line_comment" | "block_comment");
        let opaque = comment
            || matches!(
                kind,
                "string_literal"
                    | "raw_string_literal"
                    | "char_literal"
                    | "macro_invocation"
                    | "macro_definition"
                    | "token_tree"
                    | "attribute_item"
                    | "inner_attribute_item"
            );
        if recovered && !opaque && node.child_count() == 0 {
            let text = node.utf8_text(source.as_bytes()).unwrap_or("");
            if text == "fn" && mode {
                return true;
            }
            mode = matches!(text, "spec" | "proof" | "exec");
            match text {
                "fn" => {
                    header = true;
                    parens = 0;
                    brackets = 0;
                    parameters_done = false;
                }
                "(" if header => parens += 1,
                ")" if header => {
                    parens = parens.saturating_sub(1);
                    parameters_done |= parens == 0;
                }
                "[" if header => brackets += 1,
                "]" if header => brackets = brackets.saturating_sub(1),
                "{" | ";" => header = false,
                "requires" | "ensures" | "decreases" | "recommends"
                    if kind == "identifier"
                        && header
                        && parameters_done
                        && parens == 0
                        && brackets == 0 =>
                {
                    return true;
                }
                _ => {}
            }
        } else if opaque && !comment {
            mode = false;
        }
        if !opaque && cursor.goto_first_child() {
            continue;
        }
        while !cursor.goto_next_sibling() {
            if !cursor.goto_parent() {
                return false;
            }
        }
    }
}

fn text_is(node: Node<'_>, name: &str, source: &str) -> bool {
    node.utf8_text(source.as_bytes()) == Ok(name)
}

/// Follow binding patterns only, not their type names, constructors or match guards.
fn binds(node: Node<'_>, name: &str, source: &str) -> bool {
    match node.kind() {
        "identifier" | "shorthand_field_identifier" => text_is(node, name, source),
        "parameter" => node
            .child_by_field_name("pattern")
            .is_some_and(|pattern| binds(pattern, name, source)),
        "field_pattern" => node
            .child_by_field_name("pattern")
            .or_else(|| node.child_by_field_name("name"))
            .is_some_and(|pattern| binds(pattern, name, source)),
        "parameters"
        | "closure_parameters"
        | "tuple_pattern"
        | "tuple_struct_pattern"
        | "struct_pattern"
        | "slice_pattern"
        | "mut_pattern"
        | "ref_pattern"
        | "reference_pattern"
        | "or_pattern"
        | "captured_pattern"
        | "match_pattern" => {
            let ty = node.child_by_field_name("type");
            let condition = node.child_by_field_name("condition");
            let mut cursor = node.walk();
            let found = node.named_children(&mut cursor).any(|child| {
                Some(child) != ty && Some(child) != condition && binds(child, name, source)
            });
            found
        }
        _ => false,
    }
}

fn shadowed(mut node: Node<'_>, name: &str, source: &str) -> bool {
    let start = node.start_byte();
    while let Some(parent) = node.parent() {
        match parent.kind() {
            "function_item" | "function_signature_item" => {
                return parent
                    .child_by_field_name("parameters")
                    .is_some_and(|parameters| binds(parameters, name, source))
                    || parent
                        .children_by_field_name("name", &mut parent.walk())
                        .skip(1)
                        .any(|result| text_is(result, name, source));
            }
            "closure_expression" => {
                if parent
                    .child_by_field_name("parameters")
                    .is_some_and(|parameters| binds(parameters, name, source))
                {
                    return true;
                }
            }
            "logic_predicate_expression" => {
                if parent
                    .children_by_field_name("predicate", &mut parent.walk())
                    .any(|predicate| text_is(predicate, name, source))
                {
                    return true;
                }
            }
            "for_expression" | "match_arm" => {
                if (parent.kind() == "match_arm"
                    || parent.child_by_field_name("value") != Some(node))
                    && parent
                        .child_by_field_name("pattern")
                        .is_some_and(|pattern| binds(pattern, name, source))
                {
                    return true;
                }
            }
            "block" => {
                let mut cursor = parent.walk();
                if parent
                    .named_children(&mut cursor)
                    .take_while(|child| child.end_byte() <= start)
                    .any(|child| {
                        child.kind() == "let_declaration"
                            && child
                                .child_by_field_name("pattern")
                                .is_some_and(|pattern| binds(pattern, name, source))
                    })
                {
                    return true;
                }
            }
            _ => {}
        }
        node = parent;
    }
    false
}

/// Keep ordinary shared extraction, excluding calls through obvious lexical binders.
pub(super) fn adjust<'t>(root: Node<'t>, source: &'t str, captures: &mut Captures<'t>) {
    captures.refs.retain(|reference| {
        if reference.relation != Relation::Calls {
            return true;
        }
        let Some(mut node) = root.descendant_for_byte_range(reference.start, reference.start + 1)
        else {
            return true;
        };
        while node.start_byte() == reference.start {
            if node.kind() == "call_expression" {
                let Some(mut callee) = node.child_by_field_name("function") else {
                    return true;
                };
                if callee.kind() == "generic_function"
                    && let Some(function) = callee.child_by_field_name("function")
                {
                    callee = function;
                }
                return callee.kind() != "identifier"
                    || !text_is(callee, reference.target, source)
                    || !shadowed(node, reference.target, source);
            }
            let Some(parent) = node.parent() else { break };
            node = parent;
        }
        true
    });
}
