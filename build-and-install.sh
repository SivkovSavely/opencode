#!/usr/bin/env bash

cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")"

printf '\nBuilding OpenCode...\n'

OPENCODE_CHANNEL=latest \
  OPENCODE_VERSION='1.18.29' \
  bun run --cwd packages/opencode build --single

printf '\nInstalling OpenCode as opencode-fork...\n'

install -m755 \
      packages/opencode/dist/opencode-linux-x64/bin/opencode \
      ~/.local/bin/opencode-fork

printf '\nDone!\n'
