#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
target_dir="/home/oppo/.nvm/versions/node/v22.22.0/lib/node_modules/openclaw/extensions/feishu"

test -d "$target_dir"

rsync -a \
  --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude coverage \
  "$repo_dir"/ "$target_dir"/

printf 'synced to %s\n' "$target_dir"
