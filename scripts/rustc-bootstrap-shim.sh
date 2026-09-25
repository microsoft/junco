#!/bin/sh
# rustc shim for junco's isolated build environment.
#
# Oh My Pi builds on nightly. `pi-edit` (a pinned Git dependency imported
# unmodified) depends on `xutf 1.5.0`, whose crate root unconditionally enables
# `#![feature(portable_simd)]` / `#![feature(stmt_expr_attributes)]`. `xutf
# 1.5.0` is the only published version satisfying pi-edit's `^1.5` requirement,
# and upstream crates are not modified here, so that crate cannot build on a
# stable channel without the bootstrap escape hatch.
#
# Rather than moving junco off its pinned stable 1.95.0 toolchain (which would
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
