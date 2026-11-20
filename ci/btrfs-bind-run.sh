#!/usr/bin/env bash
# Container entrypoint (root) of the Btrfs test lane over the host's own checkout and builds,
# bind-mounted at its host path: mount a fresh loop-backed btrfs with `user_subvol_rm_allowed` at
# /btrfs and run the command as the host user (HOST_UID:HOST_GID) with HOME and
# JUNCO_BTRFS_TEST_ROOT on it. Host-built addons load only when the image's glibc is no older.
set -euo pipefail

image=/var/tmp/btrfs.img
truncate -s "${BTRFS_SIZE:-8G}" "$image"
mkfs.btrfs -q "$image"
mkdir -p /btrfs
mount -o loop,user_subvol_rm_allowed "$image" /btrfs
install -d --mode=700 --owner="$HOST_UID" --group="$HOST_GID" /btrfs/home /btrfs/fixtures

# Lock identities need a machine id; a container image has none.
[ -s /etc/machine-id ] || tr -d - </proc/sys/kernel/random/uuid >/etc/machine-id

HOME=/btrfs/home JUNCO_BTRFS_TEST_ROOT=/btrfs/fixtures \
  exec setpriv --reuid="$HOST_UID" --regid="$HOST_GID" --clear-groups "$@"
