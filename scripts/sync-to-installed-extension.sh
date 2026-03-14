#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
resolve_target_dir() {
  if [[ -n "${OPENCLAW_FEISHU_PLUGIN_DIR:-}" ]]; then
    printf '%s\n' "$OPENCLAW_FEISHU_PLUGIN_DIR"
    return 0
  fi

  if command -v npm >/dev/null 2>&1; then
    local global_root=""
    global_root="$(npm root -g 2>/dev/null || true)"
    if [[ -n "$global_root" && -d "$global_root/openclaw/extensions/feishu" ]]; then
      printf '%s\n' "$global_root/openclaw/extensions/feishu"
      return 0
    fi
  fi

  local candidate=""
  candidate="$(cd "$repo_dir" && node -e 'import { createRequire } from "node:module"; import { dirname, join } from "node:path"; import { existsSync } from "node:fs"; const require = createRequire(import.meta.url); const candidates = []; try { const pkg = require.resolve("openclaw/package.json"); candidates.push(join(dirname(pkg), "extensions", "feishu")); } catch {} try { const pkg = require.resolve("@openclaw/feishu/package.json"); candidates.push(dirname(pkg)); } catch {} const found = candidates.find((value) => existsSync(value)); if (found) process.stdout.write(found);' 2>/dev/null || true)"
  if [[ -n "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  return 1
}

target_dir="$(resolve_target_dir || true)"

if [[ -z "$target_dir" || ! -d "$target_dir" ]]; then
  printf 'failed to resolve installed OpenClaw Feishu plugin directory; set OPENCLAW_FEISHU_PLUGIN_DIR explicitly\n' >&2
  exit 1
fi

rsync -a \
  --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude coverage \
  "$repo_dir"/ "$target_dir"/

printf 'synced to %s\n' "$target_dir"
