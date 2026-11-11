#!/bin/bash
# On the owner's Mac: fetch the latest JellyfinFlix.ipa from INDIE and install it on the iPhone.
# Free Apple ID signing: the app stops opening after 7 days, so this runs again every 6 days
# (launchd job, see scripts/com.jellyfinflix.reinstall.plist). The iPhone must be on the home Wi-Fi
# (paired once by cable, "Show this iPhone when on Wi-Fi" on) and unlocked is not required.
# Needs: xtool on the Mac (brew install xtool-org/tap/xtool) and `xtool auth login` done once by the owner.
set -euo pipefail
LOG="$HOME/Library/Logs/jellyfinflix-reinstall.log"
exec >>"$LOG" 2>&1
echo "== $(date) =="
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
dst="$HOME/Library/Caches/JellyfinFlix.ipa"
scp -q nitin@192.168.0.198:projects/jellyfinNX/jellyfinflix-ios/dist/JellyfinFlix.ipa "$dst"
xtool install --all "$dst"
echo "installed OK"
