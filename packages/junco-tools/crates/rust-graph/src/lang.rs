use std::{path::Path, sync::OnceLock};

use ast_grep_core::tree_sitter::LanguageExt;
use pi_ast::SupportLang;
use tree_sitter::{Language as TsLanguage, Query};
use tree_sitter_language::LanguageFn;

unsafe extern "C" {
    fn tree_sitter_coq() -> *const ();
    fn tree_sitter_lean() -> *const ();
    fn tree_sitter_verus() -> *const ();
    fn tree_sitter_fstar() -> *const ();
    fn tree_sitter_pulse() -> *const ();
}

/// Built-in grammars plus the proof-language snapshots compiled from `vendor/`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Language {
    Builtin(SupportLang),
    Rocq,
    Lean,
    Verus,
    Fstar,
}

impl Language {
    pub fn canonical_name(self) -> &'static str {
        match self {
            Self::Builtin(lang) => lang.canonical_name(),
            Self::Rocq => "rocq",
            Self::Lean => "lean",
            Self::Verus => "verus",
            Self::Fstar => "fstar",
        }
    }

    pub fn from_alias(name: &str) -> Option<Self> {
        let name = name.trim();
        if name.eq_ignore_ascii_case("rocq") || name.eq_ignore_ascii_case("coq") {
            Some(Self::Rocq)
        } else if name.eq_ignore_ascii_case("lean") || name.eq_ignore_ascii_case("lean4") {
            Some(Self::Lean)
        } else if name.eq_ignore_ascii_case("verus") {
            Some(Self::Verus)
        } else if ["fstar", "f*", "fst", "fsti"]
            .iter()
            .any(|alias| name.eq_ignore_ascii_case(alias))
        {
            Some(Self::Fstar)
        } else {
            SupportLang::from_alias(name).map(Self::Builtin)
        }
    }

    pub fn get_ts_language(self) -> TsLanguage {
        let entry: unsafe extern "C" fn() -> *const () = match self {
            Self::Builtin(lang) => return lang.get_ts_language(),
            Self::Rocq => tree_sitter_coq,
            Self::Lean => tree_sitter_lean,
            Self::Verus => tree_sitter_verus,
            Self::Fstar => tree_sitter_fstar,
        };
        // SAFETY: build.rs links each pinned generated grammar's static TSLanguage entry point.
        TsLanguage::new(unsafe { LanguageFn::from_raw(entry) })
    }
}

/// Pulse is an injected syntax inside F* files, not a separate graph language.
pub(super) fn pulse_language() -> TsLanguage {
    // SAFETY: build.rs links the pinned Pulse grammar's static TSLanguage entry point.
    TsLanguage::new(unsafe { LanguageFn::from_raw(tree_sitter_pulse) })
}

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
    Rocq,
    Lean,
    Fstar,
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
    Rocq,
    Lean,
    Fstar,
}

pub struct LangSpec {
    pub lang: Language,
    pub family: Family,
    /// Vendored `queries/<lang>.scm` text.
    pub scm: &'static str,
    pub imports: ImportResolver,
}

macro_rules! spec {
    ($lang:ident, $family:ident, $file:literal, $imports:ident) => {
        LangSpec {
            lang: Language::Builtin(SupportLang::$lang),
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
    LangSpec {
        lang: Language::Rocq,
        family: Family::Rocq,
        scm: include_str!("../queries/rocq.scm"),
        imports: ImportResolver::Rocq,
    },
    LangSpec {
        lang: Language::Lean,
        family: Family::Lean,
        scm: include_str!("../queries/lean.scm"),
        imports: ImportResolver::Lean,
    },
    LangSpec {
        lang: Language::Verus,
        family: Family::Rust,
        scm: include_str!("../queries/verus.scm"),
        imports: ImportResolver::Rust,
    },
    LangSpec {
        lang: Language::Fstar,
        family: Family::Fstar,
        scm: include_str!("../queries/fstar.scm"),
        imports: ImportResolver::Fstar,
    },
];

/// Compiled on first use per language, so a TS-only repo never compiles the other grammars' queries.
static QUERIES: [OnceLock<Query>; SPECS.len()] = [const { OnceLock::new() }; SPECS.len()];

pub fn spec_for(lang: SupportLang) -> Option<&'static LangSpec> {
    SPECS.iter().find(|s| s.lang == Language::Builtin(lang))
}

pub fn spec_for_path(path: &Path) -> Option<&'static LangSpec> {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("v") => spec_for_name("rocq"),
        Some(ext) if ext.eq_ignore_ascii_case("lean") => spec_for_name("lean"),
        Some(ext) if ext.eq_ignore_ascii_case("fst") || ext.eq_ignore_ascii_case("fsti") => {
            spec_for_name("fstar")
        }
        _ => spec_for(SupportLang::from_path(path)?),
    }
}

/// Spec for a stored canonical language name or a supported search alias.
pub fn spec_for_name(name: &str) -> Option<&'static LangSpec> {
    let lang = Language::from_alias(name)?;
    SPECS.iter().find(|s| s.lang == lang)
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
