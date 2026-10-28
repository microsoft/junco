#!/usr/bin/env bash
# Real Btrfs and resource-enforcement tests; an environment skip is a lane failure.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

report=$(mktemp)
trap 'rm -f -- "$report"' EXIT

node packages/junco-tools/scripts/with-junco-build-env.mjs cargo test \
  --manifest-path crates/marsh/Cargo.toml --workspace --locked -- \
  --test-threads=1 --nocapture 2>&1 | tee "$report"
if grep -Eq 'skipping resource_limits_tests:|skipping: cgroup delegation unavailable' "$report"; then
  echo "Marsh workspace tests skipped required resource enforcement" >&2
  exit 1
fi

env -u RMUX -u TMUX node packages/junco-tools/scripts/with-junco-build-env.mjs cargo run \
  --manifest-path crates/marsh/Cargo.toml --locked -p marsh --example rmux_smoke \
  2>&1 | tee "$report"
if grep -Eq 'skipping resource_limits_tests:|skipping: cgroup delegation unavailable|falling back to CopyTree' "$report"; then
  echo "Marsh executable smoke skipped required Btrfs or resource enforcement" >&2
  exit 1
fi
