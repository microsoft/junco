#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 || ( $1 != gnu && $1 != musl ) ]]; then
  echo 'usage: package-runtime.sh gnu|musl' >&2
  exit 2
fi
exec python3 - "$1" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


def fail(message):
    raise SystemExit(f'package-runtime: {message}')


def run(*args):
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        fail(f'{args[0]} failed for {args[-1]}: {result.stderr.strip()}')
    return result.stdout.strip()


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


libc = sys.argv[1]
source = Path('/src')
root = Path('/opt/junco-runtime')
app = root / 'app'
native_target = f'x86_64-unknown-linux-{libc}'
addon = Path(f'packages/junco-tools/native/junco_tools.linux-x64-{libc}.node')
required = [Path(p) for p in (
    'package.json', 'bun.lock', 'dist/index.js', 'src/index.ts',
    'examples/cooperbench/wf.ts', 'examples/cooperbench/wf.yml',
    'packages/junco-tools/native/index.js', 'packages/junco-tools/dist/index.js',
)] + [addon]
for path in required:
    if not (source / path).is_file():
        fail(f'missing build artifact: {path}')
if not (source / 'node_modules').is_dir():
    fail('missing installed node_modules')
for command in ('patchelf', 'lddtree', 'readelf', 'bun', 'btrfs', 'rustc', 'node',
                'dpkg-query' if libc == 'gnu' else 'apk'):
    if not shutil.which(command):
        fail(f'missing packaging tool: {command}')
versions = {
    'bun_version': run('bun', '--version'),
    'rust_version': run('rustc', '--version').split()[1],
    'node_version': run('node', '--version').removeprefix('v'),
}
for key, expected in (('bun_version', '1.4.2'), ('rust_version', '1.98.1'),
                      ('node_version', '22.19.0')):
    if versions[key] != expected:
        fail(f'{key}: expected {expected}, found {versions[key]}')
if root.exists() or root.is_symlink():
    fail(f'refusing to overwrite existing {root}')

# Keep the installed workspace, not a dereferenced node_modules snapshot.
# Build targets, caches and credentials must never become runtime assets.
excluded = {'.git', 'target', '.cache', '.cargo', '.rustup', '.junco',
            '.pi', 'logs', 'graphify-out', '__pycache__'}


def ignore(directory, names):
    return [name for name in names if name in excluded or name == '.env'
            or name.startswith(('.env.', '.napi-rs-filesystem-'))
            or name in ('auth.json', 'models-store.json')
            or (Path(directory) == source / 'packages/junco-tools' and name == 'vendor')]


root.mkdir(parents=True)
shutil.copytree(source, app, symlinks=True, ignore=ignore)
(root / 'bin').mkdir()
(root / 'lib').mkdir()
for command in ('bun', 'btrfs'):
    shutil.copy2(Path(shutil.which(command)).resolve(strict=True), root / 'bin' / command)

# Absolute checkout links are the only links we rewrite; all other escapes fail.
for directory, dirs, files in os.walk(app, followlinks=False):
    for name in dirs + files:
        path = Path(directory) / name
        if not path.is_symlink():
            continue
        target = os.readlink(path)
        if os.path.isabs(target):
            try:
                relative = Path(target).relative_to(source)
            except ValueError:
                fail(f'external absolute symlink: {path.relative_to(app)} -> {target}')
            path.unlink()
            path.symlink_to(os.path.relpath(app / relative, path.parent))

# Resolve only after every absolute link has been converted, including chains.
for directory, dirs, files in os.walk(app, followlinks=False):
    for name in dirs + files:
        path = Path(directory) / name
        if not path.is_symlink():
            continue
        try:
            resolved = path.resolve(strict=True)
        except (OSError, RuntimeError) as error:
            fail(f'unresolved symlink {path.relative_to(app)}: {error}')
        if not resolved.is_relative_to(app):
            fail(f'escaping symlink: {path.relative_to(app)}')


def elf(path):
    with path.open('rb') as stream:
        return stream.read(4) == b'\x7fELF'


def libc_owned(path):
    candidates = {str(path), str(path.resolve(strict=True))}
    # Debian's merged-/usr aliases are not always in the dpkg file database.
    for candidate in tuple(candidates):
        if candidate.startswith('/usr/'):
            candidates.add(candidate[4:])
        elif candidate.startswith(('/lib/', '/lib64/')):
            candidates.add('/usr' + candidate)
    for candidate in candidates:
        command = ('dpkg-query', '-S', candidate) if libc == 'gnu' else ('apk', 'info', '--who-owns', candidate)
        result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode == 0:
            if libc == 'gnu' and any(re.match(r'^libc6(?::[^: ]+)?: ', line)
                                     for line in result.stdout.splitlines()):
                return True
            if libc == 'musl' and re.search(r' is owned by musl-[0-9]', result.stdout):
                return True
    return False


def closure(path):
    tree = run('lddtree', str(path))
    if re.search(r'=>\s*(?:None|not found)\b', tree):
        fail(f'unresolved ELF dependency for {path}: {tree}')
    result = []
    for line in run('lddtree', '-l', str(path)).splitlines():
        entry = Path(line.strip())
        if not entry.is_absolute() or not entry.is_file():
            fail(f'unresolved ELF dependency for {path}: {line}')
        result.append(entry)
    return result


def interpreter(path):
    return run('patchelf', '--print-interpreter', str(path))


executables = [root / 'bin' / command for command in ('bun', 'btrfs')]
addons = []
for path in sorted(app.rglob('*.node')):
    if not path.is_file() or path.is_symlink():
        continue
    compatible = elf(path) and 'Advanced Micro Devices X86-64' in run('readelf', '-h', str(path))
    if compatible:
        needed = run('readelf', '-d', str(path))
        compatible = ('[libc.so.6]' not in needed if libc == 'musl'
                      else '[libc.so]' not in needed and 'libc.musl-' not in needed)
    if not compatible:
        if path == app / addon:
            fail(f'wrong native addon ABI: {path}')
        path.unlink()
        continue
    addons.append(path)
if app / addon not in addons:
    fail('native addon missing from payload')
for path in executables + addons:
    if not elf(path):
        fail(f'expected ELF binary: {path}')
    if 'Advanced Micro Devices X86-64' not in run('readelf', '-h', str(path)):
        fail(f'not an amd64 ELF binary: {path}')
interpreters = {Path(interpreter(path)) for path in executables}
loaders = {path.resolve(strict=True) for path in interpreters}
expected_loader = 'ld-linux' if libc == 'gnu' else 'ld-musl'
if any(expected_loader not in path.name for path in interpreters):
    fail(f'executables do not match requested {libc} ABI')

libraries = {}
for path in executables + addons:
    for dependency in closure(path):
        actual = dependency.resolve(strict=True)
        if actual == path.resolve() or actual in loaders or libc_owned(dependency):
            continue
        names = {actual.name, dependency.name}
        dynamic = run('readelf', '-d', str(actual))
        soname = re.search(r'\(SONAME\).*\[([^\]]+)\]', dynamic)
        if soname:
            names.add(soname.group(1))
        for name in names:
            if '/' in name or name in ('.', '..'):
                fail(f'invalid library name: {name}')
            previous = libraries.get(name)
            if previous and digest(previous) != digest(actual):
                fail(f'conflicting ELF libraries named {name}')
            libraries[name] = actual

for actual in set(libraries.values()):
    shutil.copy2(actual, root / 'lib' / actual.name)
for name, actual in libraries.items():
    destination = root / 'lib' / name
    if name != actual.name:
        if destination.exists() or destination.is_symlink():
            fail(f'conflicting library alias: {name}')
        destination.symlink_to(actual.name)
for path in executables:
    run('patchelf', '--set-rpath', '$ORIGIN/../lib', str(path))
for path in (root / 'lib').iterdir():
    if not path.is_symlink():
        run('patchelf', '--set-rpath', '$ORIGIN', str(path))
for path in addons:
    relative = os.path.relpath(root / 'lib', path.parent)
    run('patchelf', '--set-rpath', f'$ORIGIN/{relative}', str(path))

# Check the finished RUNPATH closure without relying on the builder's libraries.
for path in executables + addons + [p for p in (root / 'lib').iterdir() if not p.is_symlink()]:
    for dependency in closure(path):
        resolved = dependency.resolve(strict=True)
        if resolved == path.resolve() or resolved in loaders or libc_owned(dependency):
            continue
        if not resolved.is_relative_to(root):
            fail(f'payload still depends on builder library: {dependency}')
for path in (root / 'lib').iterdir():
    if path.resolve() in loaders or libc_owned(path.resolve()):
        fail(f'libc/loader unexpectedly bundled: {path}')

hashes = {key: digest(source / value) for key, value in {
    'wf_ts': 'examples/cooperbench/wf.ts',
    'wf_yml': 'examples/cooperbench/wf.yml', 'bun_lock': 'bun.lock',
}.items()}
build_hash = os.environ.get('RUNTIME_BUILD_HASH', '')
if not build_hash:
    recipe = hashlib.sha256()
    for name in ('examples/cooperbench/Dockerfile.runtime',
                 'examples/cooperbench/Dockerfile.runtime.dockerignore',
                 'examples/cooperbench/package-runtime.sh',
                 'examples/cooperbench/wf.ts', 'examples/cooperbench/wf.yml', 'bun.lock'):
        recipe.update(name.encode() + b'\0' + bytes.fromhex(digest(source / name)))
    build_hash = recipe.hexdigest()
if not re.fullmatch(r'[0-9a-f]{64}', build_hash):
    fail('RUNTIME_BUILD_HASH must be a lowercase SHA-256 digest')
manifest = {'version': 1, 'libc': libc, **versions, 'native_target': native_target,
            'native_version': json.loads((source / 'packages/junco-tools/package.json').read_text())['version'],
            'builder_image_digest': 'sha256:' + ({
                'gnu': 'bf4ef0c41a3224fa8602a77e5ad02e67f81114fab5c61bd1fa9df47cb45e6c2f',
                'musl': 'd4760191131171132bb788c4fd0014ef07a5e4e79e5155e26068f3cc9fdffea4',
            }[libc]),
            'source_hashes': hashes, 'runtime_build_hash': build_hash}
(root / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
run(str(root / 'bin' / 'bun'), '-e',
    'await import("/opt/junco-runtime/app/examples/cooperbench/wf.ts"); '
    'await import("/opt/junco-runtime/app/packages/junco-tools/native/index.js"); '
    'console.log("runtime imports ready")')
PY
