//! Per-language import resolution: an import's module text → root-relative files in the graph.

use std::{
    collections::{BTreeMap, HashMap},
    path::Path,
};

use crate::{lang::ImportResolver, model::FileEntry};

/// Files an import resolves to, and the names it brings in when the resolver knows them better
/// than the query did (`use a::{b, c}`). Empty names mean every name of those files.
#[derive(Default)]
pub struct Resolved {
    pub paths: Vec<String>,
    pub names: Option<Vec<String>>,
}

impl From<Vec<String>> for Resolved {
    fn from(paths: Vec<String>) -> Self {
        Self { paths, names: None }
    }
}

pub fn dir_of(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(d, _)| d)
}

fn file_name(path: &str) -> &str {
    path.rsplit_once('/').map_or(path, |(_, f)| f)
}

/// Join `rel` onto root-relative `dir`, folding `.`/`..`; `None` if it escapes the root.
fn join(dir: &str, rel: &str) -> Option<String> {
    let mut parts: Vec<&str> = dir.split('/').filter(|s| !s.is_empty()).collect();
    for seg in rel.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s),
        }
    }
    Some(parts.join("/"))
}

fn parent(dir: &str) -> Option<&str> {
    (!dir.is_empty()).then(|| dir_of(dir))
}

/// The graph's files plus lookups shared by every import of one build.
pub struct Imports<'a> {
    files: &'a BTreeMap<String, FileEntry>,
    root: &'a Path,
    by_basename: HashMap<&'a str, Vec<&'a str>>,
    dirs: HashMap<&'a str, Vec<&'a str>>,
    /// Nearest `Cargo.toml` dir per source dir.
    cargo_dirs: HashMap<String, Option<String>>,
    /// Nearest `(go.mod dir, module path)` per source dir.
    go_mods: HashMap<String, Option<(String, String)>>,
}

impl<'a> Imports<'a> {
    pub fn new(files: &'a BTreeMap<String, FileEntry>, root: &'a Path) -> Self {
        let mut by_basename: HashMap<&str, Vec<&str>> = HashMap::new();
        let mut dirs: HashMap<&str, Vec<&str>> = HashMap::new();
        for p in files.keys() {
            by_basename.entry(file_name(p)).or_default().push(p);
            dirs.entry(dir_of(p)).or_default().push(p);
        }
        Self {
            files,
            root,
            by_basename,
            dirs,
            cargo_dirs: HashMap::new(),
            go_mods: HashMap::new(),
        }
    }

    /// Files `module`, imported by `file`, refers to.
    pub fn resolve(&mut self, file: &str, module: &str, resolver: ImportResolver) -> Resolved {
        let dir = dir_of(file);
        match resolver {
            ImportResolver::None => Resolved::default(),
            ImportResolver::Js => self.js(dir, module).into(),
            ImportResolver::Python => self.python(dir, module).into(),
            ImportResolver::Rust => self.rust(file, module),
            ImportResolver::Go => self.go(file, module).into(),
            ImportResolver::Java => self.java(module),
            ImportResolver::C => self.c(dir, module).into(),
            ImportResolver::Ruby => match module.strip_prefix("require_relative:") {
                Some(m) if m.ends_with(".rb") => self.first(dir, [m]),
                Some(m) => self.first(dir, [format!("{m}.rb")]),
                None => Vec::new(),
            }
            .into(),
            // `use Ns\Class` names no file; include/require paths do.
            ImportResolver::Php if module.contains('\\') => Resolved::default(),
            ImportResolver::Php => self.first(dir, [module]).into(),
        }
    }

    /// The first of `rels` (joined onto `dir`) that is a graph file.
    fn first<S: AsRef<str>>(&self, dir: &str, rels: impl IntoIterator<Item = S>) -> Vec<String> {
        rels.into_iter()
            .filter_map(|rel| join(dir, rel.as_ref()))
            .find(|p| self.files.contains_key(p))
            .into_iter()
            .collect()
    }

    /// Paths ending with `suffix` at a segment boundary.
    fn by_suffix(&self, suffix: &str) -> Vec<&'a str> {
        let Some(candidates) = self.by_basename.get(file_name(suffix)) else {
            return Vec::new();
        };
        candidates
            .iter()
            .copied()
            .filter(|p| {
                p.strip_suffix(suffix)
                    .is_some_and(|head| head.is_empty() || head.ends_with('/'))
            })
            .collect()
    }

    /// Nearest ancestor dir (root-relative) of `file` containing `marker`.
    fn ancestor_with(&self, file: &str, marker: &str) -> Option<String> {
        let mut dir = dir_of(file);
        loop {
            if self.root.join(dir).join(marker).is_file() {
                return Some(dir.to_string());
            }
            dir = parent(dir)?;
        }
    }

    fn js(&self, dir: &str, module: &str) -> Vec<String> {
        if !(module.starts_with("./") || module.starts_with("../")) {
            return Vec::new(); // bare specifier: a package, not a repo file
        }
        let exts = [
            "",
            ".ts",
            ".tsx",
            ".js",
            ".jsx",
            ".mjs",
            ".cjs",
            ".d.ts",
            "/index.ts",
            "/index.tsx",
            "/index.js",
        ];
        let mut candidates: Vec<String> = exts.iter().map(|ext| format!("{module}{ext}")).collect();
        // TS sources imported by their emitted `.js` name.
        if let Some(stem) = [".js", ".mjs", ".cjs"]
            .iter()
            .find_map(|e| module.strip_suffix(e))
        {
            candidates.extend([format!("{stem}.ts"), format!("{stem}.tsx")]);
        }
        self.first(dir, candidates)
    }

    fn python(&self, dir: &str, module: &str) -> Vec<String> {
        let dots = module.chars().take_while(|&c| c == '.').count();
        let segs: Vec<&str> = module[dots..]
            .split('.')
            .filter(|s| !s.is_empty())
            .collect();
        let full = segs.join("/");
        let mut rels = vec![format!("{full}.py"), format!("{full}/__init__.py")];
        // `a.b.c` may name `c` inside module `a.b`.
        if let [head @ .., _] = segs.as_slice()
            && !head.is_empty()
        {
            let head = head.join("/");
            rels.extend([format!("{head}.py"), format!("{head}/__init__.py")]);
        }
        if dots == 0 {
            // Absolute: the first ancestor of the importer that holds the module.
            return std::iter::successors(Some(dir), |d| parent(d))
                .map(|d| self.first(d, &rels))
                .find(|hit| !hit.is_empty())
                .unwrap_or_default();
        }
        let Some(base) = (1..dots).try_fold(dir, |d, _| parent(d)) else {
            return Vec::new();
        };
        if segs.is_empty() {
            self.first(base, ["__init__.py"])
        } else {
            self.first(base, &rels)
        }
    }

    fn rust(&mut self, file: &str, module: &str) -> Resolved {
        if let Some(m) = module.strip_prefix("mod:") {
            return self
                .first(
                    &rust_mod_dir(file),
                    [format!("{m}.rs"), format!("{m}/mod.rs")],
                )
                .into();
        }
        let module = module.trim().trim_end_matches(';');
        let (prefix, braced) = match module.split_once('{') {
            Some((p, rest)) => (p, Some(rest.trim_end().trim_end_matches('}'))),
            None => (module, None),
        };
        let segs: Vec<&str> = strip_alias(prefix)
            .split("::")
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != "*")
            .collect();
        let Some((&first, mut rest)) = segs.split_first() else {
            return Resolved::default();
        };
        let base = match first {
            "crate" => self.cargo_dir(file).and_then(|d| join(&d, "src")),
            "self" => Some(rust_mod_dir(file)),
            "super" => {
                let supers = 1 + rest.iter().take_while(|s| **s == "super").count();
                rest = &rest[supers - 1..];
                let mod_dir = rust_mod_dir(file);
                (0..supers)
                    .try_fold(mod_dir.as_str(), |d, _| parent(d))
                    .map(str::to_string)
            }
            _ => None, // external crate
        };
        let Some(base) = base else {
            return Resolved::default();
        };
        // Longest module prefix that is a file; the rest are items inside it.
        for k in (1..=rest.len()).rev() {
            let stem = rest[..k].join("/");
            let paths = self.first(&base, [format!("{stem}.rs"), format!("{stem}/mod.rs")]);
            if paths.is_empty() {
                continue;
            }
            let names = match braced {
                Some(inner) => inner
                    .split(',')
                    .map(|n| strip_alias(n).rsplit("::").next().unwrap_or("").trim())
                    .filter(|n| {
                        !n.is_empty() && !matches!(*n, "self" | "*") && !n.contains(['{', '}'])
                    })
                    .map(str::to_string)
                    .collect(),
                // `use crate::util;` imports the module itself → any name in it.
                None if k == rest.len() => Vec::new(),
                None => vec![rest[rest.len() - 1].to_string()],
            };
            return Resolved {
                paths,
                names: Some(names),
            };
        }
        Resolved::default()
    }

    fn cargo_dir(&mut self, file: &str) -> Option<String> {
        let key = dir_of(file);
        if let Some(v) = self.cargo_dirs.get(key) {
            return v.clone();
        }
        let v = self.ancestor_with(file, "Cargo.toml");
        self.cargo_dirs.insert(key.to_string(), v.clone());
        v
    }

    /// Every non-test `.go` file of the in-module package `module` names.
    fn go(&mut self, file: &str, module: &str) -> Vec<String> {
        let Some((mod_dir, mod_path)) = self.go_mod(file) else {
            return Vec::new();
        };
        let rest = match module.strip_prefix(mod_path.as_str()) {
            Some("") => "",
            Some(r) if r.starts_with('/') => r,
            _ => return Vec::new(), // another module
        };
        let Some(pkg) = join(&mod_dir, rest) else {
            return Vec::new();
        };
        self.dirs
            .get(pkg.as_str())
            .into_iter()
            .flatten()
            .filter(|p| p.ends_with(".go") && !p.ends_with("_test.go"))
            .map(|p| p.to_string())
            .collect()
    }

    fn go_mod(&mut self, file: &str) -> Option<(String, String)> {
        let key = dir_of(file);
        if let Some(v) = self.go_mods.get(key) {
            return v.clone();
        }
        let v = self.ancestor_with(file, "go.mod").and_then(|dir| {
            let text = std::fs::read_to_string(self.root.join(&dir).join("go.mod")).ok()?;
            let module = text
                .lines()
                .find_map(|l| l.trim().strip_prefix("module "))?;
            Some((dir, module.trim().trim_matches('"').to_string()))
        });
        self.go_mods.insert(key.to_string(), v.clone());
        v
    }

    /// `a.b.C` → the unique `a/b/C.java`/`.kt`; otherwise a package import: every source file
    /// directly in a dir ending with `a/b/C`.
    fn java(&self, module: &str) -> Resolved {
        let rel = module.trim_end_matches(".*").replace('.', "/");
        let class: Vec<&str> = ["java", "kt"]
            .iter()
            .flat_map(|ext| self.by_suffix(&format!("{rel}.{ext}")))
            .collect();
        if let [one] = class.as_slice() {
            let name = file_name(&rel).to_string();
            return Resolved {
                paths: vec![one.to_string()],
                names: Some(vec![name]),
            };
        }
        let mut paths: Vec<String> = self
            .dirs
            .iter()
            .filter(|(d, _)| {
                d.strip_suffix(rel.as_str())
                    .is_some_and(|head| head.is_empty() || head.ends_with('/'))
            })
            .flat_map(|(_, v)| {
                v.iter()
                    .filter(|p| p.ends_with(".java") || p.ends_with(".kt"))
            })
            .map(|p| p.to_string())
            .collect();
        paths.sort();
        Resolved {
            paths,
            names: Some(Vec::new()),
        }
    }

    /// `"x.h"` next to the includer, else the unique file ending with `x.h`.
    fn c(&self, dir: &str, module: &str) -> Vec<String> {
        let local = self.first(dir, [module]);
        if !local.is_empty() {
            return local;
        }
        match self.by_suffix(module).as_slice() {
            [one] => vec![one.to_string()],
            _ => Vec::new(),
        }
    }
}

/// Rust module dir that `mod`/`self` paths of `file` are relative to.
fn rust_mod_dir(file: &str) -> String {
    let name = file_name(file);
    if matches!(name, "mod.rs" | "lib.rs" | "main.rs") {
        dir_of(file).to_string()
    } else {
        join(dir_of(file), name.strip_suffix(".rs").unwrap_or(name)).unwrap_or_default()
    }
}

fn strip_alias(s: &str) -> &str {
    s.split(" as ").next().unwrap_or(s).trim()
}
