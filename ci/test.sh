#!/usr/bin/env bash
# The full native test lane, run in a delegated cgroup with writable Btrfs HOME and fixtures.
# Ends with plain `bun test`: every discovered test, the Btrfs lane included, with nothing skipped.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
export CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 DO_NOT_TRACK=1

step() { echo "::endgroup::"; echo "::group::$*"; }
echo "::group::Install workspace"
bun install --frozen-lockfile --ignore-scripts

step "Build Junco runtime packages and standard library"
bun run build

step "Build Graft native grammar bindings"
(
  node_prefix=$(node -p 'require("node:path").resolve(process.execPath, "../..")')
  if [ -z "${npm_config_nodedir:-}" ] && [ -f "$node_prefix/include/node/node.h" ]; then
    export npm_config_nodedir="$node_prefix"
  fi
  for grammar in tree-sitter tree-sitter-go tree-sitter-java tree-sitter-javascript \
    tree-sitter-kotlin tree-sitter-php tree-sitter-python tree-sitter-r \
    tree-sitter-typescript; do
    bun run --cwd "node_modules/$grammar" install
  done
)

step "junco-policy: tests and deterministic release oracle"
bun run test:junco-policy

step "Marsh workspace and executable smoke"
bash ci/test-marsh.sh

step "junco-tools Rust: rustfmt, Clippy, unit tests (CopyTree)"
(
  cd packages/junco-tools
  # Older native modules and the marsh path dependency use different existing layouts.
  node scripts/with-junco-build-env.mjs rustfmt --edition 2024 --check src/tool.rs
  # napi exports look unused to Rust; two legacy grep helpers exceed Clippy's argument threshold.
  node scripts/with-junco-build-env.mjs cargo clippy --locked --features test-fs --lib --tests -- \
    -D warnings -A dead_code -A clippy::too_many_arguments
  node scripts/with-junco-build-env.mjs cargo test --locked --features test-fs --lib
)

step "rust-graph: unit and integration tests"
(cd packages/junco-tools/crates/rust-graph && node ../../scripts/with-junco-build-env.mjs cargo test --locked)

step "Typecheck and test dataflow-engine with coverage"
(cd packages/dataflow-engine && bun run typecheck && bun run examples:typecheck && bun run test:coverage)

step "Typecheck and test junco-tools (CopyTree and Btrfs lanes)"
(
  cd packages/junco-tools
  bun run typecheck
  bun run build:native:test
  bun run test
  bun run test:btrfs
)

step "Typecheck and test junco-mcp"
(cd packages/junco-mcp && bun run typecheck && bun run test && bun run test:native)

step "Typecheck and test junco-agent with coverage"
(cd packages/junco-agent && bun run typecheck && bun run test:coverage && bun run test:native)

step "Typecheck and test junco-scheduler with coverage"
(cd packages/junco-scheduler && bun run typecheck && bun run test:coverage)

step "Typecheck and test dataflow-engine-opik and dataflow-profile"
(cd packages/dataflow-engine-opik && bun run typecheck && bun run test)
(cd packages/dataflow-profile && bun run typecheck && bun run test)

step "Typecheck and test junco"
bun run typecheck
bun run smoke:profile-optimizer
bun run test:coverage
bun run smoke
bun run test:integration
bun run test:native
bun run smoke:workflows:bun
bun run smoke:workflows

step "Workspace engine identity"
smoke='
import assert from "node:assert/strict";
import { DataflowDefinitionError, DataflowGraph, NodeId, TriggerRule, UNBOUNDED, Width } from "dataflow-engine";
import { choose, context, parallel } from "junco-scheduler";
const graph = new DataflowGraph(Width.create(1), UNBOUNDED);
graph.addNode({ id: NodeId.create("only"), state: undefined, trigger: TriggerRule.always(), step: async function* () { return 42; } });
const invalid = context({ graph, scheduler: choose({ rank: () => 0, width: () => -1 }) });
await assert.rejects(invalid.step(), (error) => error instanceof DataflowDefinitionError);
assert.equal(graph.results().size, 0);
assert.deepEqual([...await context({ graph, scheduler: parallel() }).run()], [["only", 42]]);
console.log(`consumer-engine-identity-${RUNTIME}: ok`);
'
bun --no-install --eval "const RUNTIME = \"bun\";$smoke"
node --input-type=module --eval "const RUNTIME = \"node\";$smoke"

# The relocated launcher resolves Pi's CLI and the tools extension from the hoisted workspace.
step "junco-agent CLI smoke"
(
  cd packages/junco-agent
  status=0
  usage=$(bun run cli 2>&1) || status=$?
  test "$status" -eq 2
  grep -F 'Usage: bun run cli <dedicated-btrfs-seed> [Pi options or prompt]' <<<"$usage"
  seed=$(mktemp -d)
  home=$(mktemp -d)
  version=$(env -i PATH="$PATH" HOME="$home" PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 bun run cli "$seed" --version)
  echo "$version"
  grep -Fx '0.99.2' <<<"$version"
)

step "Plain bun test: every discovered test, none skipped"
report=$(mktemp)
# `bun run` puts workspace binaries (graft) on PATH; a plain `bun test` needs them there too.
PATH="$PWD/node_modules/.bin:$PATH" bun test 2>&1 | tee "$report"
# Counted skips, plus suites that print `skipping:` and return when an environment feature is missing.
if grep -Eq '^ *[1-9][0-9]* (skip|todo)$|^skipping: ' "$report"; then
  echo "plain bun test skipped tests" >&2
  exit 1
fi
echo "::endgroup::"
