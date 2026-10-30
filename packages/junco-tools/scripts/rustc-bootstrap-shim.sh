#!/bin/sh
# rustc shim for junco's isolated build environment.
#
# Oh My Pi builds on nightly. `pi-edit` (a pinned Git dependency imported
# unmodified) requires `xutf ^1.5`, currently resolved to `xutf 1.6.0`, whose
# crate root unconditionally enables `#![feature(portable_simd)]` and
# `#![feature(stmt_expr_attributes)]`. That upstream crate cannot build on a
# stable channel without the bootstrap escape hatch.
#
# Rather than moving junco off its pinned stable 1.98.1 toolchain (which would
# let *every* crate, including junco's own, use unstable features), this shim
# exports RUSTC_BOOTSTRAP only for the specific dependency crates that require
# it. Every other compilation unit is compiled by plain stable rustc.
prev=
for arg do
	if [ "$prev" = "--crate-name" ]; then
		case "$arg" in
		xutf) RUSTC_BOOTSTRAP=1; export RUSTC_BOOTSTRAP ;;
		esac
	fi
	prev=$arg
done
exec "$@"
