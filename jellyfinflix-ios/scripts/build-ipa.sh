#!/bin/bash
# Build JellyfinFlix.ipa (unsigned; xtool signs it with the owner's free Apple ID at install time).
# Runs on INDIE (Linux, Swift 6.4.1 in ~/tools/swift, xtool in ~/.local/bin) or on the Mac.
# Needs the Darwin SDK once: `xtool sdk install <Xcode.xip | Xcode.app | darwin.xtoolsdk>` (see README).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/tools/swift/usr/bin:$HOME/.local/bin:$PATH"
xtool sdk status
swift test --filter 'FormatTests|PlaybackTests|MiscTests'          # logic tests first (Linux or Mac)
xtool dev build --ipa -c release
mkdir -p dist
ipa=$(ls -t xtool/*.ipa 2>/dev/null | head -1 || true)
[ -n "$ipa" ] || ipa=$(find . -name '*.ipa' -newer Package.swift -not -path './dist/*' | head -1)
cp "$ipa" dist/JellyfinFlix.ipa
echo "IPA: $(pwd)/dist/JellyfinFlix.ipa ($(du -h dist/JellyfinFlix.ipa | cut -f1))"
