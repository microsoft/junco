//! `cargo xtask grammars`: checks out the pinned upstream tree-sitter grammar repositories that
//! rust-graph's build script compiles, generated parsers included, under its git-ignored `vendor/`.
//! A checkout already at its pinned commit is left alone, so `bun install` stays cheap.

use std::{path::Path, process::Command, process::ExitCode, thread};

/// Each `vendor/` directory, its upstream repository and the pinned commit (see vendor/README.md).
const GRAMMARS: [(&str, &str, &str); 4] = [
    (
        "tree-sitter-rocq",
        "https://github.com/lamg/tree-sitter-rocq",
        "051e6cf9c2c37eadc447551097d6ea9a523e8afd",
    ),
    (
        "tree-sitter-lean",
        "https://github.com/Julian/tree-sitter-lean",
        "916c44f4d89c970f66dd34a49e7ce848f4d29e72",
    ),
    (
        "tree-sitter-verus",
        "https://github.com/q5438722/tree-sitter-verus",
        "362a7c607edf1f10cc7b6fc05c9367816aaf37c0",
    ),
    (
        "tree-sitter-fstar",
        "https://github.com/FStarLang/tree-sitter-fstar",
        "f5aca8ce0122f0ac10eaeb6f3081382d59d294f2",
    ),
];

fn main() -> ExitCode {
    if std::env::args().skip(1).collect::<Vec<_>>() != ["grammars"] {
        eprintln!("usage: cargo xtask grammars");
        return ExitCode::from(2);
    }
    let vendor = Path::new(env!("CARGO_MANIFEST_DIR")).join("../crates/rust-graph/vendor");
    let failures = thread::scope(|scope| {
        let jobs: Vec<_> = GRAMMARS
            .iter()
            .map(|&(dir, url, commit)| {
                let checkout = vendor.join(dir);
                scope.spawn(move || {
                    checkout_pinned(&checkout, url, commit).map_err(|e| format!("{dir}: {e}"))
                })
            })
            .collect();
        jobs.into_iter()
            .filter_map(|job| job.join().expect("grammar checkout panicked").err())
            .inspect(|error| eprintln!("error: {error}"))
            .count()
    });
    if failures == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

/// Makes `dir` a detached shallow checkout of `url` at `commit`, unless it already is one. A
/// directory that is not a git checkout (e.g. an older vendored snapshot) is replaced.
fn checkout_pinned(dir: &Path, url: &str, commit: &str) -> Result<(), String> {
    if dir.join(".git").exists() {
        if git(dir, &["rev-parse", "HEAD"]).is_ok_and(|head| head == commit) {
            return Ok(());
        }
    } else {
        if dir.exists() {
            std::fs::remove_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        git(dir, &["init", "--quiet"])?;
        git(dir, &["remote", "add", "origin", url])?;
    }
    git(dir, &["fetch", "--quiet", "--depth", "1", "origin", commit])?;
    // Not forced: local edits in an outdated checkout fail here instead of being discarded.
    git(
        dir,
        &[
            "-c",
            "advice.detachedHead=false",
            "checkout",
            "--quiet",
            "--detach",
            commit,
        ],
    )?;
    println!(
        "checked out {} at {commit}",
        dir.file_name().unwrap_or_default().display()
    );
    Ok(())
}

/// Runs `git args` in `dir`, returning its trimmed stdout or its stderr as the error.
fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| format!("git: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
    } else {
        Err(format!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}
