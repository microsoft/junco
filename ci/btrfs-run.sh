#!/usr/bin/env bash
# Container entrypoint (root): mount a fresh loop-backed btrfs with `user_subvol_rm_allowed` at
# /workspace, copy the checkout bind-mounted at /src into it, delegate a cgroup v2 subtree, and run
# the command there as `ci`. Coverage reports (`**/coverage/lcov.info`) are copied to /artifacts,
# if mounted, afterwards.
set -euo pipefail

image=/var/tmp/workspace.btrfs
truncate -s "${BTRFS_SIZE:-32G}" "$image"
mkfs.btrfs -q "$image"
mount -o loop,user_subvol_rm_allowed,compress=zstd:1 "$image" /workspace
chown ci:ci /workspace
cd /workspace

# Tracked plus untracked-but-not-ignored files: host builds and node_modules never cross over.
git -C /src -c safe.directory='*' ls-files -z --cached --others --exclude-standard \
  | while IFS= read -r -d '' path; do
      if [ -e "/src/$path" ] || [ -L "/src/$path" ]; then printf '%s\0' "$path"; fi
    done \
  | tar -C /src --null --files-from=- -c \
  | setpriv --reuid=ci --regid=ci --init-groups tar -x

# Lock identities need a machine id; a container image has none.
[ -s /etc/machine-id ] || tr -d - </proc/sys/kernel/random/uuid >/etc/machine-id

# Delegate a cgroup subtree to `ci`, as systemd's Delegate= would, so marsh's per-pipeline resource
# limits run instead of failing closed. Processes leave the namespace root first: a cgroup with
# member processes cannot enable controllers for its children.
cg=/sys/fs/cgroup
mkdir "$cg/entrypoint"
while read -r pid; do echo "$pid" >"$cg/entrypoint/cgroup.procs" || true; done <"$cg/cgroup.procs"
echo "+cpu +memory +pids" >"$cg/cgroup.subtree_control"
mkdir "$cg/ci"
chown ci:ci "$cg/ci" "$cg/ci/cgroup.procs" "$cg/ci/cgroup.subtree_control" "$cg/ci/cgroup.threads"

install -d --mode=700 --owner=ci --group=ci /workspace/.ci-home /workspace/.ci-fixtures

status=0
(
  echo "$BASHPID" >"$cg/ci/cgroup.procs"
  HOME=/workspace/.ci-home JUNCO_BTRFS_TEST_ROOT=/workspace/.ci-fixtures JUNCO_TEST_CONTAINER=1 \
    exec setpriv --reuid=ci --regid=ci --init-groups "$@"
) || status=$?

if [ -w /artifacts ]; then
  find . -path ./node_modules -prune -o -path '*/coverage/lcov.info' -print \
    | while read -r report; do install -D --mode=644 "$report" "/artifacts/$report"; done
  chown -R --reference=/artifacts /artifacts
fi
exit "$status"
