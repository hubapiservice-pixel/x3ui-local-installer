#!/usr/bin/env bash
set -euo pipefail

readonly ROOT="$(cd "$(dirname "$0")/.." && pwd)"
readonly VERSION="1.0.0"
readonly APP_NAME="X3-UI Local Installer.app"
readonly DIST_DIR="$ROOT/dist"
readonly STAGING_DIR="$DIST_DIR/staging"
readonly APP_DIR="$STAGING_DIR/$APP_NAME"
readonly ZIP_PATH="$DIST_DIR/X3-UI-Local-Installer-macOS-v${VERSION}.zip"

rm -rf "$STAGING_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources/app"

cat >"$APP_DIR/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>X3-UI Local Installer</string>
  <key>CFBundleExecutable</key>
  <string>launch</string>
  <key>CFBundleIdentifier</key>
  <string>com.liulixiao.x3ui-local-installer</string>
  <key>CFBundleName</key>
  <string>X3-UI Local Installer</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
</dict>
</plist>
PLIST

cat >"$APP_DIR/Contents/MacOS/launch" <<'LAUNCHER'
#!/bin/zsh
set -euo pipefail

APP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RESOURCE_APP="$APP_ROOT/Resources/app"
PORT="${X3UI_LOCAL_PORT:-4178}"
URL="http://127.0.0.1:${PORT}"
LOG_DIR="$HOME/Library/Logs/X3-UI-Local-Installer"
LOG_FILE="$LOG_DIR/server.log"
NODE_BIN="$(command -v node || true)"

if [[ -z "$NODE_BIN" ]]; then
  osascript -e 'display alert "X3-UI Local Installer" message "未检测到 Node.js 18 或更高版本。请先安装 Node.js，再重新打开本应用。" as critical'
  exit 1
fi

mkdir -p "$LOG_DIR"
if ! curl -fsS --max-time 1 "$URL/" >/dev/null 2>&1; then
  (
    cd "$RESOURCE_APP"
    nohup env PORT="$PORT" "$NODE_BIN" server.mjs >>"$LOG_FILE" 2>&1 &
  )
  for _ in {1..20}; do
    if curl -fsS --max-time 1 "$URL/" >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done
fi

if ! curl -fsS --max-time 1 "$URL/" >/dev/null 2>&1; then
  osascript -e 'display alert "X3-UI Local Installer" message "本地服务未能启动。请查看 ~/Library/Logs/X3-UI-Local-Installer/server.log。" as critical'
  exit 1
fi

open "$URL"
LAUNCHER

chmod 755 "$APP_DIR/Contents/MacOS/launch"

ditto --rsrc --extattr --exclude '.git' --exclude 'dist' --exclude '.DS_Store' \
  "$ROOT" "$APP_DIR/Contents/Resources/app"
rm -rf "$APP_DIR/Contents/Resources/app/dist"

cat >"$APP_DIR/Contents/Resources/README.txt" <<'README'
X3-UI Local Installer

Double-click this application to open the local installer in your browser.
It runs only on 127.0.0.1 and uses the fixed self-hosted 3X-UI release mirror.

Requirements: macOS 13+ and Node.js 18+.
README

rm -f "$ZIP_PATH" "$ZIP_PATH.sha256"
mkdir -p "$DIST_DIR"
ditto -c -k --sequesterRsrc --keepParent "$APP_DIR" "$ZIP_PATH"
shasum -a 256 "$ZIP_PATH" >"$ZIP_PATH.sha256"

printf 'ZIP=%s\n' "$ZIP_PATH"
printf 'SHA256=%s\n' "$(cut -d ' ' -f 1 "$ZIP_PATH.sha256")"
