#!/usr/bin/env bash
# Regression: an unsafe later destination must stop the updater before any crate is synchronized;
# once safe, the vendored updater must mirror into the Regorus checkout beside the Junco monorepo.
set -euo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT

ws="$tmp/workspace with spaces"
src="$ws/junco/crates/junco-policy"
dest="$ws/regorus"
mkdir -p "$src/scripts" "$dest/src" "$ws/protected" "$tmp/bin" "$tmp/elsewhere"
cp -- "$here/update_regorus.sh" "$src/scripts/"
printf '[package]\nname = "regorus"\n' >"$dest/Cargo.toml"
for crate in history-syntax junco-core history-store history-semantics; do
    mkdir -p "$src/crates/$crate"
    printf '[package]\nname = "%s"\n' "$crate" >"$src/crates/$crate/Cargo.toml"
    echo source >"$src/crates/$crate/synced"
    [[ $crate == history-store ]] && continue
    mkdir -p "$dest/src/$crate"
    printf '[package]\nname = "%s"\n' "$crate" >"$dest/src/$crate/Cargo.toml"
done
printf '[package]\nname = "history-store"\n' >"$ws/protected/Cargo.toml"
echo protected >"$ws/protected/sentinel"
ln -s ../../protected "$dest/src/history-store"
echo earlier >"$dest/src/history-syntax/sentinel"

# Succeeding tool doubles: a nonzero exit must come from the boundary check, not a missing tool.
for tool in cargo cargo-verus verus rustup z3; do
    printf '#!/bin/sh\nexit 0\n' >"$tmp/bin/$tool"
    chmod +x "$tmp/bin/$tool"
done

update() {
    (cd "$tmp/elsewhere" && PATH="$tmp/bin:$PATH" env -u VERUS_Z3_PATH "$src/scripts/update_regorus.sh")
}

status=0
update || status=$?

failed=0
check() {
    if ! "$@"; then
        echo "FAIL: $*" >&2
        failed=1
    fi
}
check test "$status" -ne 0
check test "$(cat "$ws/protected/sentinel")" = protected
check test ! -e "$ws/protected/synced"
check test "$(cat "$dest/src/history-syntax/sentinel")" = earlier
check test ! -e "$dest/src/history-syntax/synced"
((failed)) && exit 1
echo "ok: symlinked destination rejected before any crate was synchronized"

# Make the third mapping safe; real rsync now runs against the rejected run's fixture.
rm -- "$dest/src/history-store"
mkdir -p "$dest/src/history-store" "$dest/src/unrelated" "$dest/src/junco-core/target"
printf '[package]\nname = "history-store"\n' >"$dest/src/history-store/Cargo.toml"
echo unrelated >"$dest/src/unrelated/keep"
echo build >"$dest/src/junco-core/target/keep"
# Same size and mtime: only a checksum comparison notices the destination is stale.
printf aaaa >"$src/crates/history-semantics/marker"
printf bbbb >"$dest/src/history-semantics/marker"
touch -r "$src/crates/history-semantics/marker" "$dest/src/history-semantics/marker"

snapshot() { (cd "$dest" && find . -type f -print0 | sort -z | xargs -0 sha256sum); }

status=0
update || status=$?
check test "$status" -eq 0
for crate in history-syntax junco-core history-store history-semantics; do
    check test "$(cat "$dest/src/$crate/synced")" = source
done
check test ! -e "$dest/src/history-syntax/sentinel"
check test "$(cat "$dest/src/history-semantics/marker")" = aaaa
check test "$(cat "$ws/protected/sentinel")" = protected
check test ! -e "$ws/protected/synced"
check test "$(cat "$dest/src/unrelated/keep")" = unrelated
check test "$(cat "$dest/src/junco-core/target/keep")" = build
check test ! -e "$ws/junco/crates/regorus"
first=$(snapshot)
status=0
update || status=$?
check test "$status" -eq 0
check test "$(snapshot)" = "$first"
((failed)) && exit 1
echo "ok: nested vendored updater mirrored into the sibling Regorus checkout idempotently"
