#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")"

build_only=0
case "${1:-}" in
  "") ;;
  --build-only)
    if [[ $# -ne 1 ]]; then
      printf 'Usage: %s [--build-only]\n' "$0" >&2
      exit 2
    fi
    build_only=1
    ;;
  *)
    printf 'Usage: %s [--build-only]\n' "$0" >&2
    exit 2
    ;;
esac

artifact=packages/opencode/dist/opencode-linux-x64/bin/opencode
rm -f -- "$artifact"

printf '\nBuilding OpenCode...\n'

OPENCODE_CHANNEL=latest \
  OPENCODE_VERSION='1.18.29' \
  bun run --cwd packages/opencode build --single

test -f "$artifact"
test -x "$artifact"
version=$("$artifact" --version)
if [[ "$version" != *'1.18.29'* ]]; then
  printf 'Unexpected OpenCode build version: %s\n' "$version" >&2
  exit 1
fi
architecture=$(file --brief "$artifact")
if [[ "$architecture" != *'ELF 64-bit'* || "$architecture" != *'x86-64'* ]]; then
  printf 'Unexpected OpenCode build target: %s\n' "$architecture" >&2
  exit 1
fi

if [[ "$build_only" -eq 1 ]]; then
  printf '\nBuild verified; installation skipped.\n'
  exit 0
fi

printf '\nInstalling OpenCode as opencode-fork...\n'

destination="$HOME/.local/bin/opencode-fork"
install_dir=$(dirname "$destination")
test -d "$install_dir"
staged=$(mktemp "$install_dir/.opencode-fork.XXXXXX")
trap 'rm -f -- "$staged"' EXIT
install -m755 -- "$artifact" "$staged"
cmp -s -- "$artifact" "$staged"
test "$(stat -c '%a' "$staged")" = 755
mv -fT -- "$staged" "$destination"
trap - EXIT

printf '\nDone!\n'
