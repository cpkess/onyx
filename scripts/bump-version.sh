#!/usr/bin/env bash
# Bump Onyx's version across the three source-of-truth files, commit, tag, and
# push the tag — which triggers the GitHub Actions release workflow.
#
#   scripts/bump-version.sh 0.2.0
set -euo pipefail

VER="${1:-}"
if [[ ! "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: scripts/bump-version.sh <x.y.z>" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# package.json
node -e "const f='package.json';const j=require('./'+f);j.version='$VER';require('fs').writeFileSync(f,JSON.stringify(j,null,2)+'\n')"
# tauri.conf.json
node -e "const f='src-tauri/tauri.conf.json';const j=require('./'+f);j.version='$VER';require('fs').writeFileSync(f,JSON.stringify(j,null,2)+'\n')"
# Cargo.toml (first version = line under [package])
perl -0pi -e 's/^version = "[0-9]+\.[0-9]+\.[0-9]+"/version = "'"$VER"'"/m' src-tauri/Cargo.toml

echo "▶ Bumped to $VER. Updating Cargo.lock…"
(cd src-tauri && cargo update -p onyx --precise "$VER" >/dev/null 2>&1 || true)

git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "Release v$VER"
git tag "v$VER"

echo "✓ Committed and tagged v$VER."
echo "  Push to publish:  git push && git push origin v$VER"
