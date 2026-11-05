#!/usr/bin/env bash
set -euo pipefail

if [[ $# -gt 1 || ($# -eq 1 && "${1-}" != --build-only) ]]; then
  printf 'Usage: %s [--build-only]\n' "$0" >&2
  exit 2
fi
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  printf 'This helper requires Linux x86-64 and GNU installation tools.\n' >&2
  exit 1
fi

root=$(dirname "$(realpath "${BASH_SOURCE[0]}")")
release=$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).version)' "$root/packages/cli/package.json")
if [[ ! $release =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  printf 'Expected a semantic release version, got: %s\n' "$release" >&2
  exit 1
fi
commit=$(git -C "$root" rev-parse --short=8 HEAD)
version="$release+$commit"
build_dir=$(mktemp -d "${TMPDIR:-/tmp}/opencode-build.XXXXXXXX")
artifact="$build_dir/cli-linux-x64/bin/opencode"
printf 'Building OpenCode %s in %s\n' "$version" "$build_dir"

OPENCODE_CHANNEL=local \
  OPENCODE_VERSION="$version" \
  OPENCODE_TARGET=linux-x64 \
  bun run "$root/packages/cli/script/build.ts" --single --skip-install --outdir="$build_dir"

test -f "$artifact"
test -x "$artifact"
architecture=$(file --brief -- "$artifact")
if [[ $architecture != ELF\ 64-bit* || $architecture != *x86-64* ]]; then
  printf 'Unexpected OpenCode build target: %s\n' "$architecture" >&2
  exit 1
fi
if ! actual=$("$artifact" --version); then
  printf 'Built executable failed --version: %s\n' "$artifact" >&2
  exit 1
fi
if [[ $actual != "opencode v$version" ]]; then
  printf 'Unexpected OpenCode build version: %s (expected opencode v%s)\n' "$actual" "$version" >&2
  exit 1
fi

if [[ ${1-} == --build-only ]]; then
  printf 'Build verified; installation skipped. Artifact: %s\n' "$artifact"
  exit 0
fi

destination="$HOME/.local/bin/opencode-fork"
install_dir=$(dirname "$destination")
test -d "$install_dir"
staged=""
trap 'if [[ -n "$staged" ]]; then rm -f -- "$staged"; fi' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
staged=$(mktemp "$install_dir/.opencode-fork.XXXXXXXX")
install -m755 -- "$artifact" "$staged"
cmp -- "$artifact" "$staged"
test "$(stat -c '%a' -- "$staged")" = 755
mv -fT -- "$staged" "$destination"
staged=""
printf 'Installed OpenCode %s as %s\n' "$version" "$destination"
