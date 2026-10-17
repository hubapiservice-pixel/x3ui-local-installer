#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${GUIDE_RENDER_PORT:-4184}"
PWCLI="${CODEX_HOME:-$HOME/.codex}/skills/playwright/scripts/playwright_cli.sh"
SESSION="x3-guide-render-$$"

python3 -m http.server "$PORT" --directory "$ROOT/public" >/dev/null 2>&1 &
SERVER_PID=$!
trap '"$PWCLI" --session "$SESSION" close >/dev/null 2>&1 || true; kill "$SERVER_PID" 2>/dev/null || true' EXIT
sleep 1

for id in \
  v2rayn-7.25.6-macos-main \
  v2rayng-2.2.6-android-import \
  clash-verge-2.5.8-macos-local \
  clash-meta-2.11.35-android-home \
  clash-meta-2.11.35-android-add \
  shadowrocket-2.2.92-macos-add \
  shadowrocket-ios-flow \
  hiddify-ios-flow; do
  "$PWCLI" --session "$SESSION" open "http://127.0.0.1:$PORT/guides/tutorial-cards.html?id=$id" >/dev/null
  "$PWCLI" --session "$SESSION" screenshot '.sheet' --filename "$ROOT/public/guides/$id.png" >/dev/null
  printf 'Rendered %s\n' "$id"
done
