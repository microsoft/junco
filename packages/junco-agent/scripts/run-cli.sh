#!/usr/bin/env bash
set -euo pipefail

if (( $# == 0 )); then
  printf '%s\n' 'Usage: bun run cli <dedicated-btrfs-seed> [Pi options or prompt]' >&2
  exit 2
fi

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
seed=$1
shift
pi_cli=$(cd -- "$root" && node --input-type=module -e '
import { fileURLToPath } from "node:url";
console.log(fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent"))));
')
extension=$(cd -- "$root" && node --input-type=module -e '
import { fileURLToPath } from "node:url";
console.log(fileURLToPath(import.meta.resolve("junco-tools/extension")));
')
cd -- "$seed"
exec node "$pi_cli" --extension "$extension" "$@"
