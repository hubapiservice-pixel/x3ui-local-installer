#!/usr/bin/env bash
set -euo pipefail

readonly ROOT="$(cd "$(dirname "$0")/.." && pwd)"
readonly VERSION="1.4.0"
readonly APP_NAME="X3-UI Offline Installer.app"
readonly DIST_DIR="$ROOT/dist"
readonly ZIP_PATH="$DIST_DIR/X3-UI-Offline-Installer-macOS-arm64-v${VERSION}.zip"
readonly NODE_BIN="$(command -v node)"

[[ "$(uname -m)" == "arm64" ]] || { echo "This build supports Apple Silicon only." >&2; exit 1; }
[[ ! -e "$ZIP_PATH" ]] || { echo "Output already exists: $ZIP_PATH" >&2; exit 1; }
node "$ROOT/scripts/fetch-offline-assets.mjs" --verify-only
printf '%s  %s\n' '5d9dd24c0aba4b6cfcc6a33a5d67f854816ee17f392bf932ec8176da46f7e404' "$ROOT/offline-assets/tools/xray-macos-arm64" | shasum -a 256 -c -

mkdir -p "$DIST_DIR"
STAGING_DIR="$(mktemp -d "$DIST_DIR/.offline-build.XXXXXXXX")"
trap 'rm -rf "$STAGING_DIR"' EXIT
APP_DIR="$STAGING_DIR/$APP_NAME"
RESOURCE_DIR="$APP_DIR/Contents/Resources"
mkdir -p "$APP_DIR/Contents/MacOS" "$RESOURCE_DIR/app/release" "$RESOURCE_DIR/runtime"

cp "$ROOT/packaging/Info.plist" "$APP_DIR/Contents/Info.plist"
cp "$ROOT/packaging/launch" "$APP_DIR/Contents/MacOS/launch"
cp "$NODE_BIN" "$RESOURCE_DIR/runtime/node"
chmod 755 "$APP_DIR/Contents/MacOS/launch" "$RESOURCE_DIR/runtime/node"

cp "$ROOT/server.mjs" "$RESOURCE_DIR/app/server.mjs"
cp "$ROOT/container.mjs" "$RESOURCE_DIR/app/container.mjs"
cp "$ROOT/security.mjs" "$RESOURCE_DIR/app/security.mjs"
cp "$ROOT/remove.mjs" "$RESOURCE_DIR/app/remove.mjs"
cp "$ROOT/probe.mjs" "$RESOURCE_DIR/app/probe.mjs"
cp "$ROOT/package.json" "$RESOURCE_DIR/app/package.json"
ditto "$ROOT/node_modules" "$RESOURCE_DIR/app/node_modules"
ditto "$ROOT/public" "$RESOURCE_DIR/app/public"
ditto "$ROOT/offline-assets" "$RESOURCE_DIR/app/offline-assets"
ditto "$ROOT/release/offline-v3.9.0-xray-26.3.27" "$RESOURCE_DIR/app/release/offline-v3.9.0-xray-26.3.27"
cp "$ROOT/packaging/README.txt" "$RESOURCE_DIR/README.txt"
cp "$ROOT/packaging/FIRST-OPEN-README.txt" "$STAGING_DIR/FIRST-OPEN-README.txt"

xattr -rc "$APP_DIR"
codesign --force --deep --sign - "$APP_DIR"
codesign --verify --deep "$APP_DIR"
ditto -c -k --sequesterRsrc "$STAGING_DIR" "$ZIP_PATH"
( cd "$DIST_DIR" && shasum -a 256 "$(basename "$ZIP_PATH")" >"$(basename "$ZIP_PATH").sha256" )

printf 'ZIP=%s\n' "$ZIP_PATH"
printf 'SHA256=%s\n' "$(cut -d ' ' -f 1 "$ZIP_PATH.sha256")"
