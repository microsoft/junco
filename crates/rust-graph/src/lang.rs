use std::{path::Path, sync::OnceLock};

use ast_grep_core::tree_sitter::LanguageExt;
use pi_ast::SupportLang;
use tree_sitter::Query;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Family {
    Js,
    Python,
    Rust,
    Go,
    Jvm,
    C,
    CSharp,
    Ruby,
    Php,
    Swift,
    Dart,
    Elixir,
    Lua,
    Ocaml,
    Nix,
    Solidity,
    R,
    Elisp,
    Fortran,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportResolver {
    None,
    Js,
    Python,
    Rust,
    Go,
    Java,
    C,
    Ruby,
    Php,
}

pub struct LangSpec {
    pub lang: SupportLang,
    pub family: Family,
    /// Vendored `queries/<lang>.scm` text.
    pub scm: &'static str,
    pub imports: ImportResolver,
}

macro_rules! spec {
    ($lang:ident, $family:ident, $file:literal, $imports:ident) => {
        LangSpec {
            lang: SupportLang::$lang,
            family: Family::$family,
            scm: include_str!(concat!("../queries/", $file, ".scm")),
            imports: ImportResolver::$imports,
        }
    };
}

pub const SPECS: &[LangSpec] = &[
    spec!(JavaScript, Js, "javascript", Js),
    spec!(TypeScript, Js, "typescript", Js),
    spec!(Tsx, Js, "typescript", Js),
    spec!(Python, Python, "python", Python),
    spec!(Rust, Rust, "rust", Rust),
    spec!(Go, Go, "go", Go),
    spec!(Java, Jvm, "java", Java),
    spec!(Kotlin, Jvm, "kotlin", Java),
    spec!(Scala, Jvm, "scala", None),
    spec!(C, C, "c", C),
    spec!(Cpp, C, "cpp", C),
    spec!(CSharp, CSharp, "c_sharp", None),
    spec!(Ruby, Ruby, "ruby", Ruby),
    spec!(Php, Php, "php", Php),
    spec!(Swift, Swift, "swift", None),
    spec!(Dart, Dart, "dart", None),
    spec!(Elixir, Elixir, "elixir", None),
    spec!(Lua, Lua, "lua", None),
    spec!(Ocaml, Ocaml, "ocaml", None),
    spec!(Nix, Nix, "nix", None),
    spec!(Solidity, Solidity, "solidity", None),
    spec!(R, R, "r", None),
    spec!(EmacsLisp, Elisp, "elisp", None),
    spec!(Fortran, Fortran, "fortran", None),
];

/// Compiled on first use per language, so a TS-only repo never compiles the other grammars' queries.
static QUERIES: [OnceLock<Query>; SPECS.len()] = [const { OnceLock::new() }; SPECS.len()];

pub fn spec_for(lang: SupportLang) -> Option<&'static LangSpec> {
    SPECS.iter().find(|s| s.lang == lang)
}

pub fn spec_for_path(path: &Path) -> Option<&'static LangSpec> {
    spec_for(SupportLang::from_path(path)?)
}

/// Spec for a stored `FileEntry::lang` (`SupportLang::canonical_name`).
pub fn spec_for_name(name: &str) -> Option<&'static LangSpec> {
    SPECS.iter().find(|s| s.lang.canonical_name() == name)
}

impl LangSpec {
    /// This language's compiled graph query.
    ///
    /// # Panics
    /// If the vendored query does not compile against the grammar (caught by
    /// `queries_compile_for_every_language`).
    pub fn query(&self) -> &'static Query {
        let i = SPECS
            .iter()
            .position(|s| s.lang == self.lang)
            .expect("spec comes from SPECS");
        QUERIES[i].get_or_init(|| {
            Query::new(&self.lang.get_ts_language(), self.scm).unwrap_or_else(|e| {
                panic!(
                    "graph query for {} failed to compile: {e}",
                    self.lang.canonical_name()
                )
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queries_compile_for_every_language() {
        let errors: Vec<String> = SPECS
            .iter()
            .filter_map(|spec| {
                Query::new(&spec.lang.get_ts_language(), spec.scm)
                    .err()
                    .map(|e| format!("{}: {e}", spec.lang.canonical_name()))
            })
            .collect();
        assert!(errors.is_empty(), "{}", errors.join("\n"));
    }
}
