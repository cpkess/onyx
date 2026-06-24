#!/usr/bin/env bash
# Build Onyx as a standalone macOS app, install it to /Applications, and clear
# the Gatekeeper quarantine flag so it opens on a normal double-click.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_SRC="$ROOT/src-tauri/target/release/bundle/macos/Onyx.app"
APP_DEST="/Applications/Onyx.app"

echo "▶ Building Onyx (release)…"
npm --prefix "$ROOT" run tauri build

if [ ! -d "$APP_SRC" ]; then
  echo "✗ Build finished but $APP_SRC was not found." >&2
  exit 1
fi

echo "▶ Installing to $APP_DEST…"
rm -rf "$APP_DEST"
cp -R "$APP_SRC" "$APP_DEST"

echo "▶ Clearing quarantine flag…"
xattr -dr com.apple.quarantine "$APP_DEST" 2>/dev/null || true

echo "✓ Onyx installed. Launch it from Spotlight (⌘-Space → \"Onyx\") or /Applications."
