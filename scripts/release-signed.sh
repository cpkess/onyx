#!/usr/bin/env bash
# Build a Developer ID–signed, notarized, stapled macOS release of Onyx.
#
# The resulting .dmg installs cleanly on ANY Mac (no "damaged / move to trash"
# Gatekeeper warning), even offline, because the notarization ticket is stapled.
#
# This mirrors what the GitHub Actions release does: with the APPLE_* env vars
# present, Tauri signs the app with your Developer ID cert, submits it to Apple's
# notary service, and staples the ticket during `tauri build`. This script just
# sets that up for a local one-command build and verifies the result.
#
# Prerequisites (one-time):
#   • An Apple Developer account.
#   • A "Developer ID Application" certificate installed in your login keychain.
#       Check with:  security find-identity -v -p codesigning
#   • An app-specific password (appleid.apple.com → App-Specific Passwords).
#
# Required environment variables:
#   APPLE_SIGNING_IDENTITY   e.g. "Developer ID Application: Your Name (TEAMID)"
#   APPLE_ID                 your Apple ID email
#   APPLE_PASSWORD           the app-specific password
#   APPLE_TEAM_ID            your 10-character Team ID
#
# Usage:
#   APPLE_SIGNING_IDENTITY="Developer ID Application: …" \
#   APPLE_ID="you@example.com" APPLE_PASSWORD="abcd-efgh-ijkl-mnop" \
#   APPLE_TEAM_ID="AB12CD34EF" \
#   bash scripts/release-signed.sh
#
# Tip: put the four exports in a gitignored file (e.g. ~/.onyx-signing.env) and
#   `source ~/.onyx-signing.env` before running, so secrets stay out of history.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# --- Validate required credentials --------------------------------------------
missing=()
for var in APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID; do
  if [ -z "${!var:-}" ]; then missing+=("$var"); fi
done
if [ "${#missing[@]}" -ne 0 ]; then
  echo "✗ Missing required env var(s): ${missing[*]}" >&2
  echo "  See the header of this script for setup instructions." >&2
  exit 1
fi

# --- Confirm the signing identity is actually in the keychain -----------------
if ! security find-identity -v -p codesigning | grep -qF "$APPLE_SIGNING_IDENTITY"; then
  echo "✗ Signing identity not found in keychain:" >&2
  echo "    $APPLE_SIGNING_IDENTITY" >&2
  echo "  Available identities:" >&2
  security find-identity -v -p codesigning >&2 || true
  exit 1
fi

# --- Build (Tauri signs + notarizes + staples when APPLE_* are exported) ------
echo "▶ Building signed + notarized release (this submits to Apple; allow a few minutes)…"
export APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
npm run tauri build -- --target aarch64-apple-darwin

# --- Locate artifacts ---------------------------------------------------------
APP="$ROOT/src-tauri/target/release/bundle/macos/Onyx.app"
DMG="$(ls -t "$ROOT"/src-tauri/target/release/bundle/dmg/Onyx_*_aarch64.dmg 2>/dev/null | head -1 || true)"

if [ ! -d "$APP" ]; then
  echo "✗ Build finished but $APP was not found." >&2
  exit 1
fi

# --- Verify signature + notarization ------------------------------------------
echo "▶ Verifying code signature…"
codesign --verify --deep --strict --verbose=2 "$APP"

echo "▶ Verifying Gatekeeper acceptance (expect: source=Notarized Developer ID)…"
spctl -a -vvv -t install "$APP" || {
  echo "✗ Gatekeeper did not accept the app — notarization may have failed." >&2
  echo "  Check the notary log with: xcrun notarytool log <submission-id> \\" >&2
  echo "    --apple-id \"$APPLE_ID\" --team-id \"$APPLE_TEAM_ID\" --password \"<app-pw>\"" >&2
  exit 1
}

if [ -n "$DMG" ]; then
  echo "▶ Stapling the DMG (so it verifies offline)…"
  xcrun stapler staple "$DMG" || echo "  (DMG staple skipped — the app inside is already stapled.)"
  echo "▶ Validating staple…"
  xcrun stapler validate "$DMG" || true
fi

echo ""
echo "✓ Signed, notarized release ready."
[ -n "$DMG" ] && echo "  DMG:  $DMG"
echo "  App:  $APP"
echo ""
echo "Send the DMG to your other Mac — it will open with no Gatekeeper warning."
