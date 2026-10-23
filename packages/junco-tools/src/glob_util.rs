//! Shared glob-pattern helpers used by both [`crate::glob`] and
//! [`crate::grep`].

use napi::bindgen_prelude::*;

/// Normalize a raw glob string: fix path separators, optionally prepend `**/`
/// for recursive matching, and close any unclosed `{` alternation groups.
pub fn build_glob_pattern(glob: &str, recursive: bool) -> String {
    let normalized = glob.replace('\\', "/");
    let pattern = if !recursive
        || normalized.contains('/')
        || normalized.starts_with("**")
        || is_exact_brace_union(&normalized)
    {
        normalized
    } else {
        format!("**/{normalized}")
    };
    fix_unclosed_braces(pattern)
}

/// Compile an already-built walk pattern into a [`pi_walker::CompiledWalkGlob`],
/// carrying the glob-error message shared by every walk-filter caller.
pub fn compile_walk_glob(pattern: String) -> Result<pi_walker::CompiledWalkGlob> {
    pi_walker::CompiledWalkGlob::new([pattern])
        .map_err(|err| Error::from_reason(format!("Invalid glob pattern: {err}")))
}

/// Maximum walk depth (path components) a normalized glob pattern can match,
/// or `usize::MAX` when unbounded.
///
/// Walk-relative globs compile with `literal_separator(true)`, so `*`, `?`,
/// and `[...]` never cross `/` — a pattern with N literal segments can only
/// match entries at most N components deep. Bounding the walk to that depth
/// keeps non-recursive patterns (`*`, `dir/*.json`) from traversing an entire
/// subtree they can never match into (the source of "narrow glob timed out on
/// a populated directory" failures).
///
/// `**` matches any number of components and `{...}` alternations may contain
/// `/`, so both disable the bound.
pub fn walk_depth_bound(pattern: &str) -> usize {
    if pattern.contains("**") || pattern.contains('{') {
        return usize::MAX;
    }
    pattern
        .split('/')
        .filter(|seg| !seg.is_empty())
        .count()
        .max(1)
}

/// Close unclosed `{` alternation groups in a glob pattern.
///
/// LLMs occasionally produce patterns like `*.{ts,js` without the closing `}`.
/// Rather than failing, we append the missing braces.
fn fix_unclosed_braces(pattern: String) -> String {
    let opens = pattern.chars().filter(|&c| c == '{').count();
    let closes = pattern.chars().filter(|&c| c == '}').count();
    if opens > closes {
        let mut fixed = pattern;
        for _ in 0..(opens - closes) {
            fixed.push('}');
        }
        fixed
    } else {
        pattern
    }
}

fn is_exact_brace_union(pattern: &str) -> bool {
    if !(pattern.starts_with('{') && pattern.ends_with('}')) {
        return false;
    }
    let inner = &pattern[1..pattern.len() - 1];
    !inner.is_empty()
        && !inner
            .chars()
            .any(|ch| matches!(ch, '*' | '?' | '[' | ']' | '{' | '}'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_pattern_gets_recursive_prefix() {
        assert_eq!(build_glob_pattern("*.ts", true), "**/*.ts");
    }

    #[test]
    fn pattern_with_path_stays_as_is() {
        assert_eq!(build_glob_pattern("src/*.ts", true), "src/*.ts");
    }

    #[test]
    fn already_recursive_pattern_unchanged() {
        assert_eq!(build_glob_pattern("**/*.rs", true), "**/*.rs");
    }

    #[test]
    fn non_recursive_keeps_simple_pattern() {
        assert_eq!(build_glob_pattern("*.ts", false), "*.ts");
    }

    #[test]
    fn walk_depth_bound_counts_segments_for_bounded_patterns() {
        assert_eq!(walk_depth_bound("*"), 1);
        assert_eq!(walk_depth_bound("*.json"), 1);
        assert_eq!(walk_depth_bound("dir/*.ts"), 2);
        assert_eq!(walk_depth_bound("a/*/c.txt"), 3);
    }

    #[test]
    fn walk_depth_bound_unbounded_for_recursive_and_brace_patterns() {
        assert_eq!(walk_depth_bound("**/*"), usize::MAX);
        assert_eq!(walk_depth_bound("src/**/*.ts"), usize::MAX);
        // `{}` groups may contain `/`, so segment counting is unsound for them.
        assert_eq!(walk_depth_bound("{a/b,c}/d.txt"), usize::MAX);
    }

    #[test]
    fn backslashes_normalized() {
        assert_eq!(build_glob_pattern("src\\**\\*.ts", true), "src/**/*.ts");
    }

    #[test]
    fn unclosed_brace_gets_closed() {
        assert_eq!(build_glob_pattern("*.{ts,tsx,js", true), "**/*.{ts,tsx,js}");
    }

    #[test]
    fn deeply_unclosed_braces_all_closed() {
        assert_eq!(build_glob_pattern("{a,{b,c}", true), "**/{a,{b,c}}");
    }

    #[test]
    fn balanced_braces_unchanged() {
        assert_eq!(build_glob_pattern("*.{ts,js}", true), "**/*.{ts,js}");
    }

    #[test]
    fn exact_brace_union_stays_non_recursive() {
        assert_eq!(
            build_glob_pattern("{alpha.txt,beta.txt}", true),
            "{alpha.txt,beta.txt}"
        );
    }

    #[test]
    fn glob_brace_union_still_gets_recursive_prefix() {
        assert_eq!(build_glob_pattern("{*.ts,*.tsx}", true), "**/{*.ts,*.tsx}");
    }
}
