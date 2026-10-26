# Pinned tree-sitter grammars

The grammar directories here are not committed. `cargo xtask grammars`, run from `packages/junco-tools`, makes each one a shallow, detached checkout of its upstream repository at the commit pinned below; the pins live in `packages/junco-tools/xtask/src/main.rs`. `bun run grammars` runs it, and it is the first step of `build:native`/`build:native:test`, which the workspace `bun install` runs through the root `postinstall` when a Rust toolchain is present. A checkout already at its pin is left alone. Upstream commits its generated `parser.c`, `node-types.json` and `tree_sitter/` headers, so nothing is regenerated locally; `build.rs` compiles them directly. Only this file is tracked, and the rest of `vendor/` is git-ignored. Builds need `git` and network access to GitHub.

| Directory | Upstream | Pinned commit | License |
| --- | --- | --- | --- |
| `tree-sitter-rocq` | https://github.com/lamg/tree-sitter-rocq | `051e6cf9c2c37eadc447551097d6ea9a523e8afd` | MIT, declared in upstream `Cargo.toml`; upstream has no standalone LICENSE file |
| `tree-sitter-lean` | https://github.com/Julian/tree-sitter-lean | `916c44f4d89c970f66dd34a49e7ce848f4d29e72` | MIT; see its `LICENSE` |
| `tree-sitter-verus` | https://github.com/q5438722/tree-sitter-verus | `362a7c607edf1f10cc7b6fc05c9367816aaf37c0` | MIT; see its `LICENSE` |
| `tree-sitter-fstar` | https://github.com/FStarLang/tree-sitter-fstar | `f5aca8ce0122f0ac10eaeb6f3081382d59d294f2` | MIT; see its `LICENSE` |

No upstream files are patched. The Verus fork retains Rust's C entry-point/scanner names, so the crate's `build.rs` namespaces those symbols at compilation to coexist with the ordinary Rust grammar. Rocq's upstream C entry point is named `tree_sitter_coq`; the graph's canonical language name is `rocq`.

To bump a grammar, change its commit in the xtask and in this table, then bump `EXTRACTOR_VERSION`. Run `bun run grammars`, then the library language/query tests and the real-native `code_graph` checks. An outdated checkout is moved to the new pin without being forced, so local edits inside it make the xtask fail rather than vanish.

These are static concrete-syntax grammars, not Rocq/Lean/Verus/F* elaborators or proof checkers. Rocq's deliberately small grammar needs parser-token recovery for practical vernacular declarations and separate proof bodies. Lean notation/macros and ambiguous patterns remain incomplete. The Verus fork does not explicitly cover every modifier (`exec`/`uninterp`); ordinary `fn`, `spec`/`proof` functions, contracts and `verus!` bodies are supported by the integration.

The F* repository includes both its base and Pulse parsers. F* files retain canonical language `fstar`; real Pulse fences and `#lang-pulse` bodies are reparsed with the Pulse grammar using byte-offset-preserving masks, so their declarations, contracts and source spans participate in the same graph. Other opaque extensions stay opaque. This does not execute extensions or elaborate metaprograms, notation or effects. Local dotted module filenames and directory layouts are resolved conservatively, with implementation-first/interface-only fallback and module aliases; arbitrary compiler include paths and selective-import renaming are not elaborated.
