use std::path::{Path, PathBuf};

/// Upstream's generated parser in `src`; `cargo xtask grammars` (run by `bun install`) checks it out.
fn parser(src: &Path) -> PathBuf {
    let parser = src.join("parser.c");
    assert!(
        parser.is_file(),
        "{} is missing: run `cargo xtask grammars` from packages/junco-tools (`bun install` runs it)",
        parser.display()
    );
    parser
}

fn main() {
    for name in ["rocq", "lean", "verus", "fstar"] {
        let dir = format!("vendor/tree-sitter-{name}/src");
        let dir = Path::new(&dir);
        let mut build = cc::Build::new();
        build.std("c11").include(dir).file(parser(dir));
        if dir.join("scanner.c").is_file() {
            build.file(dir.join("scanner.c"));
        }
        if name == "fstar" {
            let pulse = Path::new("vendor/tree-sitter-fstar/pulse/src");
            build
                .include(pulse)
                .file(parser(pulse))
                .file(pulse.join("scanner.c"));
            println!("cargo:rerun-if-changed={}", pulse.display());
            if build.get_compiler().is_like_msvc() {
                build.flag("/utf-8");
            }
        }
        if name == "verus" {
            // The requested Verus fork still exports Rust's symbols. Namespace it so both
            // grammars can be linked without modifying the vendored upstream snapshot.
            for suffix in [
                "",
                "_external_scanner_create",
                "_external_scanner_destroy",
                "_external_scanner_scan",
                "_external_scanner_serialize",
                "_external_scanner_deserialize",
            ] {
                build.define(
                    &format!("tree_sitter_rust{suffix}"),
                    Some(format!("tree_sitter_verus{suffix}").as_str()),
                );
            }
        }
        build.compile(&format!("junco_tree_sitter_{name}"));
        println!("cargo:rerun-if-changed={}", dir.display());
    }
}
