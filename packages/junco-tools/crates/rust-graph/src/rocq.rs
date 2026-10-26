//! Recover vernacular commands omitted by the deliberately small upstream grammar.

use tree_sitter::Node;

use crate::{
    extract::{Captures, Ref},
    model::{NodeKind, Relation},
};

#[derive(Clone, Copy)]
struct Token<'t> {
    node: Node<'t>,
    text: &'t str,
    start: usize,
    end: usize,
    line: u32,
}

fn word(text: &str) -> bool {
    text.chars()
        .next()
        .is_some_and(|c| c.is_alphabetic() || c == '_')
        && text
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | '\''))
}

fn tokens<'t>(node: Node<'t>, source: &'t str, out: &mut Vec<Token<'t>>) {
    if matches!(node.kind(), "comment" | "string") {
        return;
    }
    if node.child_count() != 0 {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            tokens(child, source, out);
        }
        return;
    }
    // ERROR leaves can contain punctuation absent from the grammar (notably `=`).
    // Only split concrete parser leaves; comments and strings never enter recovery.
    let text = &source[node.byte_range()];
    let mut chars = text.char_indices().peekable();
    let mut line = node.start_position().row as u32 + 1;
    while let Some((start, c)) = chars.next() {
        if c.is_whitespace() {
            line += u32::from(c == '\n');
            continue;
        }
        let mut end = start + c.len_utf8();
        if c.is_alphanumeric() || c == '_' {
            while let Some(&(i, next)) = chars.peek() {
                if !next.is_alphanumeric() && !matches!(next, '_' | '\'') {
                    break;
                }
                chars.next();
                end = i + next.len_utf8();
            }
        } else if let Some(&(i, next)) = chars.peek()
            && matches!((c, next), (':', '=') | ('=', '>') | ('-', '>') | ('<', '-'))
        {
            chars.next();
            end = i + next.len_utf8();
        }
        out.push(Token {
            node,
            text: &text[start..end],
            start: node.start_byte() + start,
            end: node.start_byte() + end,
            line,
        });
    }
}

fn qualified<'t>(tokens: &[Token<'t>], at: usize, source: &'t str) -> (&'t str, usize) {
    let mut end = at + 1;
    while end + 1 < tokens.len()
        && tokens[end].text == "."
        && word(tokens[end + 1].text)
        && tokens[end - 1].end == tokens[end].start
        && tokens[end].end == tokens[end + 1].start
    {
        end += 2;
    }
    (&source[tokens[at].start..tokens[end - 1].end], end)
}

fn declaration<'t>(
    captures: &mut Captures<'t>,
    token: Token<'t>,
    name: Token<'t>,
    kind: NodeKind,
    end: Token<'t>,
) -> usize {
    let existing = captures.defs.iter().position(|d| {
        d.name == name.text
            && (d
                .node
                .child_by_field_name("name")
                .is_some_and(|n| n.start_byte() == name.start)
                || (d.node.start_byte() >= token.start && d.node.start_byte() <= name.start))
    });
    let index = existing.unwrap_or_else(|| {
        let mut node = token.node;
        while let Some(parent) = node.parent() {
            if parent.kind() == "source_file" || parent.start_byte() != token.start {
                break;
            }
            node = parent;
        }
        captures.add_def(node, kind, name.text, None);
        captures.defs.len() - 1
    });
    let def = &mut captures.defs[index];
    def.end_byte = end.end;
    def.end_line = end.line;
    index
}

fn keyword(text: &str) -> bool {
    matches!(
        text,
        "Type"
            | "Prop"
            | "Set"
            | "SProp"
            | "forall"
            | "fun"
            | "let"
            | "in"
            | "match"
            | "with"
            | "end"
            | "return"
            | "as"
            | "if"
            | "then"
            | "else"
            | "fix"
            | "cofix"
            | "struct"
            | "Proof"
            | "Qed"
            | "Defined"
            | "Admitted"
            | "Abort"
            | "using"
            | "intros"
            | "intro"
            | "apply"
            | "eapply"
            | "exact"
            | "eexact"
            | "refine"
            | "reflexivity"
            | "assumption"
            | "rewrite"
            | "erewrite"
            | "simpl"
            | "cbn"
            | "cbv"
            | "subst"
            | "split"
            | "constructor"
            | "destruct"
            | "induction"
            | "inversion"
            | "auto"
            | "eauto"
            | "trivial"
            | "now"
            | "easy"
            | "assert"
            | "pose"
            | "set"
            | "remember"
            | "specialize"
            | "revert"
            | "clear"
            | "rename"
            | "by"
            | "try"
            | "repeat"
            | "first"
            | "solve"
            | "all"
            | "do"
            | "fail"
            | "Definition"
            | "Fixpoint"
            | "CoFixpoint"
            | "Lemma"
            | "Theorem"
            | "Fact"
            | "Remark"
            | "Corollary"
            | "Proposition"
            | "Example"
            | "Inductive"
            | "CoInductive"
            | "Variant"
            | "Record"
            | "Structure"
            | "Class"
            | "Instance"
            | "Axiom"
            | "Axioms"
            | "Parameter"
            | "Parameters"
            | "Conjecture"
            | "Ltac"
            | "Local"
            | "Global"
            | "Polymorphic"
            | "Monomorphic"
            | "Program"
    )
}

fn binders<'t>(tokens: &[Token<'t>], locals: &mut Vec<&'t str>) {
    for (i, token) in tokens.iter().enumerate() {
        if matches!(token.text, "(" | "{" | "[") {
            let mut end = i + 1;
            while end < tokens.len() && word(tokens[end].text) {
                end += 1;
            }
            if end < tokens.len() && tokens[end].text == ":" {
                locals.extend(tokens[i + 1..end].iter().map(|t| t.text));
            }
        }
        if matches!(token.text, "forall" | "fun") {
            for next in &tokens[i + 1..] {
                if matches!(next.text, "," | "=>" | ":") {
                    break;
                }
                if word(next.text) {
                    locals.push(next.text);
                }
            }
        }
        if matches!(token.text, "let" | "fix" | "cofix")
            && let Some(next) = tokens.get(i + 1)
            && word(next.text)
        {
            locals.push(next.text);
        }
        if matches!(token.text, "intro" | "intros") {
            for next in &tokens[i + 1..] {
                if !word(next.text) {
                    break;
                }
                locals.push(next.text);
            }
        }
        if token.text == "as" {
            for next in &tokens[i + 1..] {
                if matches!(next.text, ";" | "." | ":=" | "=>" | "return" | "with") {
                    break;
                }
                if word(next.text) {
                    locals.push(next.text);
                }
            }
        }
        if token.text == "|"
            && let Some(end) = tokens[i + 1..]
                .iter()
                .position(|t| matches!(t.text, "=>" | "|"))
            && tokens[i + 1 + end].text == "=>"
        {
            // Gallina patterns do not syntactically distinguish variables from
            // constructors. Retain the pattern head; subsequent names are binders.
            let pattern = &tokens[i + 1..i + 1 + end];
            locals.extend(
                pattern
                    .iter()
                    .skip(1)
                    .filter(|t| word(t.text))
                    .map(|t| t.text),
            );
        }
    }
}

pub(super) fn adjust<'t>(root: Node<'t>, source: &'t str, captures: &mut Captures<'t>) {
    let mut all = Vec::new();
    tokens(root, source, &mut all);
    let mut start = 0;
    let mut proof: Option<usize> = None;
    let mut locals = Vec::new();
    let mut context = Vec::new();
    // Sections delimit local binders but deliberately do not qualify symbol names.
    let mut blocks: Vec<(&str, Option<usize>, usize)> = Vec::new();
    let mut names = Vec::new();
    for end in 0..all.len() {
        let terminal = all[end];
        let tail = &source[terminal.end..];
        if terminal.text != "."
            || !(tail.is_empty() || tail.starts_with(char::is_whitespace) || tail.starts_with("(*"))
        {
            continue;
        }
        let sentence = &all[start..end];
        start = end + 1;
        let mut head = 0;
        // Attributes and vernacular locality/universe modifiers are not declarations.
        if sentence.first().is_some_and(|t| t.text == "#") {
            while head < sentence.len() && sentence[head].text != "]" {
                head += 1;
            }
            head += 1;
        }
        while sentence.get(head).is_some_and(|t| {
            matches!(
                t.text,
                "Local"
                    | "Global"
                    | "Polymorphic"
                    | "Monomorphic"
                    | "Program"
                    | "Cumulative"
                    | "NonCumulative"
                    | "Private"
            )
        }) {
            head += 1;
        }
        let Some(command) = sentence.get(head).copied() else {
            continue;
        };
        if command.text == "From" || command.text == "Require" {
            let mut at = head + 1;
            let prefix = if command.text == "From" {
                if at >= sentence.len() {
                    continue;
                }
                let (prefix, next) = qualified(sentence, at, source);
                at = next;
                if sentence.get(at).is_none_or(|t| t.text != "Require") {
                    continue;
                }
                at += 1;
                Some(prefix)
            } else {
                None
            };
            if sentence
                .get(at)
                .is_some_and(|t| matches!(t.text, "Import" | "Export"))
            {
                at += 1;
            }
            while at < sentence.len() {
                if !word(sentence[at].text) {
                    at += 1;
                    continue;
                }
                let (module, next) = qualified(sentence, at, source);
                captures.add_import(sentence[at].node, Some(module), prefix, Vec::new());
                at = next;
            }
            continue;
        }
        if matches!(command.text, "Import" | "Export") {
            let mut at = head + 1;
            while at < sentence.len() {
                if !word(sentence[at].text) {
                    at += 1;
                    continue;
                }
                let (module, next) = qualified(sentence, at, source);
                captures.add_import(
                    sentence[at].node,
                    Some(module),
                    Some(command.text),
                    Vec::new(),
                );
                at = next;
            }
            continue;
        }
        if matches!(command.text, "Section" | "Module") {
            let mut at = head + 1;
            if sentence
                .get(at)
                .is_some_and(|t| matches!(t.text, "Type" | "Import" | "Export"))
            {
                at += 1;
            }
            if let Some(name) = sentence.get(at).copied().filter(|t| word(t.text)) {
                let module = (command.text == "Module")
                    .then(|| declaration(captures, command, name, NodeKind::Module, terminal));
                if command.text == "Section" || !sentence.iter().any(|t| t.text == ":=") {
                    blocks.push((name.text, module, context.len()));
                }
            }
            proof = None;
            continue;
        }
        if command.text == "End" {
            if let Some(name) = sentence.get(head + 1)
                && let Some(at) = blocks.iter().rposition(|(open, _, _)| *open == name.text)
            {
                for (_, module, context_len) in blocks.drain(at..) {
                    if let Some(index) = module {
                        captures.defs[index].end_byte = terminal.end;
                        captures.defs[index].end_line = terminal.line;
                    }
                    context.truncate(context_len);
                }
            }
            proof = None;
            continue;
        }
        if matches!(
            command.text,
            "Variable" | "Variables" | "Hypothesis" | "Hypotheses" | "Context"
        ) {
            binders(sentence, &mut context);
            for token in &sentence[head + 1..] {
                if token.text == ":" {
                    break;
                }
                if word(token.text) {
                    context.push(token.text);
                }
            }
            continue;
        }
        if matches!(command.text, "Qed" | "Defined" | "Admitted" | "Abort") {
            if let Some(index) = proof.take() {
                captures.defs[index].end_byte = terminal.end;
                captures.defs[index].end_line = terminal.line;
            }
            continue;
        }
        let kind = match command.text {
            "Definition" | "Fixpoint" | "CoFixpoint" | "Lemma" | "Theorem" | "Fact" | "Remark"
            | "Corollary" | "Proposition" | "Example" | "Instance" => Some(NodeKind::Function),
            "Inductive" | "CoInductive" | "Variant" | "Record" | "Structure" => {
                Some(NodeKind::Type)
            }
            "Class" => Some(NodeKind::Class),
            "Axiom" | "Axioms" | "Parameter" | "Parameters" | "Conjecture" => {
                Some(NodeKind::Constant)
            }
            "Ltac" => Some(NodeKind::Macro),
            _ => None,
        };
        let mut reference_start = head;
        names.clear();
        if let Some(kind) = kind {
            proof = None;
            locals.clear();
            locals.extend_from_slice(&context);
            let Some(name) = sentence.get(head + 1).copied().filter(|t| word(t.text)) else {
                continue;
            };
            let index = declaration(captures, command, name, kind, terminal);
            names.push(name.start);
            reference_start = head + 2;
            let assigned = sentence.iter().any(|t| t.text == ":=");
            if kind == NodeKind::Function && !assigned {
                proof = Some(index);
            }
            if matches!(command.text, "Axioms" | "Parameters") {
                for token in &sentence[head + 2..] {
                    if !word(token.text) {
                        break;
                    }
                    declaration(captures, *token, *token, kind, terminal);
                    names.push(token.start);
                }
            }
            if matches!(kind, NodeKind::Type | NodeKind::Class) {
                let mut body = false;
                let mut constructor = false;
                for (i, token) in sentence.iter().enumerate().skip(head + 2) {
                    if token.text == ":=" {
                        body = true;
                        constructor = true;
                        continue;
                    }
                    if !body {
                        continue;
                    }
                    if token.text == "|" {
                        constructor = true;
                        continue;
                    }
                    if token.text == "{" {
                        constructor = false;
                    }
                    if constructor && word(token.text) {
                        let mut end = sentence[i + 1..]
                            .iter()
                            .find(|t| matches!(t.text, "|" | "{"))
                            .copied()
                            .unwrap_or(terminal);
                        if matches!(end.text, "|" | "{") {
                            end.end = end.start;
                        }
                        declaration(captures, *token, *token, NodeKind::Constant, end);
                        names.push(token.start);
                        constructor = false;
                    }
                    if matches!(command.text, "Record" | "Structure" | "Class")
                        && matches!(token.text, "{" | ";")
                        && let Some(field) = sentence.get(i + 1).copied().filter(|t| word(t.text))
                        && sentence.get(i + 2).is_some_and(|t| t.text == ":")
                    {
                        let end = sentence[i + 2..]
                            .iter()
                            .find(|t| matches!(t.text, ";" | "}"))
                            .copied()
                            .unwrap_or(terminal);
                        declaration(captures, field, field, NodeKind::Field, end);
                        names.push(field.start);
                    }
                }
            }
        } else if let Some(index) = proof {
            captures.defs[index].end_byte = terminal.end;
            captures.defs[index].end_line = terminal.line;
        } else {
            continue;
        }
        let relevant = &sentence[reference_start..];
        binders(relevant, &mut locals);
        // Untyped declaration parameters are also binders, not references.
        if kind.is_some() {
            for token in relevant {
                if matches!(token.text, ":" | ":=" | "(") {
                    break;
                }
                if word(token.text) && !names.contains(&token.start) {
                    locals.push(token.text);
                }
            }
        }
        let mut at = reference_start;
        while at < sentence.len() {
            let token = sentence[at];
            if !word(token.text) {
                at += 1;
                continue;
            }
            let (target, next) = qualified(sentence, at, source);
            if !keyword(target) && !names.contains(&token.start) && !locals.contains(&target) {
                captures.refs.push(Ref {
                    start: token.start,
                    line: token.line,
                    relation: Relation::References,
                    target,
                });
            }
            at = next;
        }
    }
    for (_, module, _) in blocks {
        if let Some(index) = module {
            captures.defs[index].end_byte = source.len();
            captures.defs[index].end_line = root.end_position().row as u32 + 1;
        }
    }
}
