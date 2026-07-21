#!/usr/bin/env bash
# One-shot installer for pomo — downloads the latest release, installs it to
# /Applications, clears the Gatekeeper quarantine flag (so an unsigned build
# doesn't show up as "damaged"), and launches it.
#
#   curl -fsSL https://raw.githubusercontent.com/910studio/pomo/main/install.sh | bash
#
set -euo pipefail

REPO="910studio/pomo"

echo "🥔 Finding the latest pomo release…"
DMG_URL=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep -o '"browser_download_url": *"[^"]*\.dmg"' | head -1 | cut -d'"' -f4)
if [ -z "$DMG_URL" ]; then
  echo "❌ Couldn't find a .dmg in the latest release. Check https://github.com/$REPO/releases"
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
DMG="$TMP/pomo.dmg"

echo "⬇️  Downloading…"
curl -fsSL "$DMG_URL" -o "$DMG"

echo "📦 Mounting…"
MNT=$(hdiutil attach "$DMG" -nobrowse -readonly | grep -o '/Volumes/[^ ]*pomo[^ ]*' | tail -1)
if [ -z "$MNT" ] || [ ! -d "$MNT/pomo.app" ]; then
  echo "❌ Mounted image didn't contain pomo.app"
  exit 1
fi

echo "🚚 Installing to /Applications…"
rm -rf /Applications/pomo.app
cp -R "$MNT/pomo.app" /Applications/
hdiutil detach "$MNT" >/dev/null

echo "🔓 Clearing quarantine…"
xattr -cr /Applications/pomo.app

echo "🚀 Launching…"
open /Applications/pomo.app
echo "✅ Done — pomo lives in your notch now."
