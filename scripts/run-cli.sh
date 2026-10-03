#!/usr/bin/env bash
set -euo pipefail

if (( $# == 0 )); then
  printf '%s\n' 'Usage: bun run cli <dedicated-btrfs-seed> [Pi options or prompt]' >&2
  exit 2
fi

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
seed=$1
shift
cd -- "$seed"

exec node "$root/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" \
  --extension "$root/node_modules/junco-tools/dist/extension.js" "$@"
