#!/usr/bin/env bash
# Builds the files to publish, into dist/:
#   yoink-store-upload.zip  the extension, for the Chrome Web Store
#   yoink-helper.zip        the helper, for people who install from the store
#   yoink-full.zip          everything, for loading the extension unpacked
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
VERSION="$(node -p "require('$ROOT/extension/manifest.json').version")"

rm -rf "$DIST" && mkdir -p "$DIST"

# 1. Store upload. The store gives the extension its own ID, and refuses a
#    manifest that carries a "key", so drop it.
cp -R "$ROOT/extension" "$WORK/store"
node -e "
  const fs = require('fs'), file = process.argv[1]
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete manifest.key
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
" "$WORK/store/manifest.json"
(cd "$WORK/store" && zip -qrX "$DIST/yoink-store-upload.zip" . -x '.*')

# 2. Helper download.
H="$WORK/yoink-helper"
mkdir -p "$H/host" "$H/scripts"
cp "$ROOT/host/host.js" "$ROOT/host/package.json" "$ROOT/host/package-lock.json" "$H/host/"
cp "$ROOT/scripts/install.sh" "$ROOT/scripts/install.ps1" "$H/scripts/"
cp "$ROOT/LICENSE" "$H/"
cat > "$H/README.txt" <<TXT
Yoink helper $VERSION

The Yoink extension uses this small helper to download videos on your computer.
You need Node.js 18 or newer: https://nodejs.org
On a Mac you also need Homebrew: https://brew.sh

Mac or Linux:
  1. Open Terminal in this folder.
  2. Run: ./scripts/install.sh

Windows:
  1. Open PowerShell in this folder.
  2. Run: powershell -ExecutionPolicy Bypass -File scripts\\install.ps1

Then open the Yoink popup in Chrome and press "Check again".
To remove the helper, run the same script with --uninstall (Mac, Linux) or -Uninstall (Windows).
TXT
(cd "$WORK" && zip -qrX "$DIST/yoink-helper.zip" yoink-helper)

# 3. Everything, for loading unpacked.
(cd "$(dirname "$ROOT")" && zip -qrX "$DIST/yoink-full.zip" "$(basename "$ROOT")" \
  -x "$(basename "$ROOT")/.git/*" "$(basename "$ROOT")/dist/*" '*/node_modules/*' \
     '*/run-helper.sh' '*/run-helper.bat' '*/.DS_Store')

echo "Built Yoink $VERSION:"
ls -lh "$DIST" | tail -n +2
