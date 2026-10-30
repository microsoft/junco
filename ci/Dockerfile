# The CI test toolchain. `ci/btrfs-run.sh` (the entrypoint) mounts a fresh btrfs at /workspace, the
# project root, so the btrfs lane runs alongside everything else. Run with `--privileged` (loop mount).
FROM ubuntu:24.04

ARG NODE_VERSION=22.19.0
ARG BUN_VERSION=1.4.2
ARG RUST_VERSION=1.98.1

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y \
    build-essential pkg-config clang libclang-dev llvm-dev libbtrfsutil-dev zlib1g-dev \
    btrfs-progs ca-certificates curl git mount python3 util-linux unzip xz-utils \
  && rm -rf /var/lib/apt/lists/*

# Bun's temporary node-gyp shim is not found by install scripts that spawn node-gyp themselves
# (tree-sitter-kotlin's node-gyp-build: `spawn node-gyp ENOENT`), so expose npm's bundled copy.
RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
  | tar -xJ -C /usr/local --strip-components=1 \
  && ln -s ../lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js /usr/local/bin/node-gyp

RUN curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" -o /tmp/bun.zip \
  && unzip -j /tmp/bun.zip bun-linux-x64/bun -d /usr/local/bin \
  && rm /tmp/bun.zip

# The tests run as `ci`, never root: `user_subvol_rm_allowed` is what lets the fixture reclaim.
RUN useradd --create-home ci

ENV CARGO_HOME=/opt/cargo RUSTUP_HOME=/opt/rustup PATH=/opt/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
  | sh -s -- -y --no-modify-path --profile minimal --default-toolchain "${RUST_VERSION}" \
    --component rustfmt --component clippy \
  && chown -R ci:ci "$CARGO_HOME" "$RUSTUP_HOME"

COPY btrfs-run.sh /usr/local/bin/btrfs-run
RUN mkdir /workspace /src /artifacts
WORKDIR /workspace
ENTRYPOINT ["btrfs-run"]
CMD ["ci/test.sh"]
