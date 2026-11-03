#!/usr/bin/env bash
# Installs the Yoink helper and registers it with Chrome (macOS and Linux).
# Usage: ./scripts/install.sh            install
#        ./scripts/install.sh --uninstall
set -euo pipefail

HOST_NAME="com.yoink.helper"
# The unpacked (developer) copy: fixed by the "key" in extension/manifest.json.
EXTENSION_ID="dkeiibggiepjfgldgpjnlliajcpnbkma"
# The Chrome Web Store copy gets its own ID. Paste it here once the store shows it.
STORE_EXTENSION_ID=""
# Earlier name of this helper, cleaned up on install.
OLD_HOST_NAME="com.videodownloader.host"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT/host"
# The helper runs from here, not from the project folder. macOS can block Chrome's
# helpers from reading Documents, Desktop and Downloads.
HOST_DIR="$HOME/.yoink/helper"
WRAPPER="$HOST_DIR/run-helper.sh"
LOG="$HOME/.yoink/helper.log"

case "$(uname -s)" in
  Darwin)
    BASES=(
      "$HOME/Library/Application Support/Google/Chrome"
      "$HOME/Library/Application Support/Chromium"
      "$HOME/Library/Application Support/BraveSoftware/Brave-Browser"
      "$HOME/Library/Application Support/Microsoft Edge"
    ) ;;
  Linux)
    BASES=(
      "$HOME/.config/google-chrome"
      "$HOME/.config/chromium"
      "$HOME/.config/BraveSoftware/Brave-Browser"
      "$HOME/.config/microsoft-edge"
    ) ;;
  *) echo "This script supports macOS and Linux. On Windows, run scripts/install.ps1." >&2; exit 1 ;;
esac

if [[ "${1:-}" == "--uninstall" ]]; then
  for base in "${BASES[@]}"; do rm -f "$base/NativeMessagingHosts/$HOST_NAME.json"; done
  rm -rf "$HOST_DIR"
  echo "Removed the Yoink helper. You can delete this folder now."
  exit 0
fi

# 1. Node 18+
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is missing. Install Node 18 or newer from https://nodejs.org and run this again." >&2
  exit 1
fi
NODE_BIN="$(command -v node)"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 18 )); then
  echo "Node $NODE_MAJOR is too old. Install Node 18 or newer and run this again." >&2
  exit 1
fi

# 1b. On a Mac, yt-dlp must come from Homebrew. The downloadable copy is blocked by macOS
#     when Chrome starts it ("Python.framework is damaged").
if [[ "$(uname -s)" == "Darwin" ]]; then
  for brew_dir in /opt/homebrew/bin /usr/local/bin; do [[ -x "$brew_dir/brew" ]] && export PATH="$brew_dir:$PATH"; done
  if ! command -v yt-dlp >/dev/null 2>&1; then
    if command -v brew >/dev/null 2>&1; then
      echo "Installing yt-dlp with Homebrew…"
      brew install yt-dlp
    else
      echo "Homebrew is missing. Install it from https://brew.sh, then run this script again." >&2
      exit 1
    fi
  fi
  if ! command -v ffmpeg >/dev/null 2>&1 && command -v brew >/dev/null 2>&1; then
    echo "Installing ffmpeg with Homebrew…"
    brew install ffmpeg || true
  fi
fi

# 2. Copy the helper to its own folder (and drop the old one, if any).
for base in "${BASES[@]}"; do rm -f "$base/NativeMessagingHosts/$OLD_HOST_NAME.json"; done
rm -rf "$HOME/.video-downloader/host"
mkdir -p "$HOST_DIR"
cp "$SRC_DIR/host.js" "$SRC_DIR/package.json" "$HOST_DIR/"
[[ -f "$SRC_DIR/package-lock.json" ]] && cp "$SRC_DIR/package-lock.json" "$HOST_DIR/"

# 3. ffmpeg: needed to merge high-resolution video and audio, and for mp3.
#    Skip the bundled copy if the system already has one.
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg not found on PATH. Fetching a bundled copy…"
  (cd "$HOST_DIR" && npm install --omit=dev --no-audit --no-fund) \
    || echo "Could not fetch ffmpeg. Basic downloads still work; install ffmpeg yourself for high resolutions and mp3."
fi

# 4. Wrapper script. Chrome starts hosts with a bare PATH, so pin the full node path.
cat > "$WRAPPER" <<WRAP
#!/bin/sh
export PATH="$PATH"
exec "$NODE_BIN" "$HOST_DIR/host.js" 2>>"$LOG"
WRAP
chmod +x "$WRAPPER"

# 5. Tell each browser about the helper.
ORIGINS="\"chrome-extension://$EXTENSION_ID/\""
[[ -n "$STORE_EXTENSION_ID" ]] && ORIGINS="$ORIGINS, \"chrome-extension://$STORE_EXTENSION_ID/\""
MANIFEST="$(cat <<JSON
{
  "name": "$HOST_NAME",
  "description": "Yoink helper (runs yt-dlp)",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": [$ORIGINS]
}
JSON
)"
for base in "${BASES[@]}"; do
  # Always set up Chrome (the first entry); the others only if that browser exists.
  if [[ "$base" == "${BASES[0]}" || -d "$base" ]]; then
    mkdir -p "$base/NativeMessagingHosts"
    printf '%s\n' "$MANIFEST" > "$base/NativeMessagingHosts/$HOST_NAME.json"
    echo "Registered for: $base"
  fi
done

echo
echo "Done. Now open the Yoink popup and press \"Check again\"."
