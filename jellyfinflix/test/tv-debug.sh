#!/bin/bash
# Launch JellyfinFlix on the TV with the web inspector on and print the DevTools websocket URL.
#   test/tv-debug.sh [TV-IP]   (default 192.168.0.236)
set -euo pipefail
export PATH="$HOME/tizen-studio/tools/ide/bin:$HOME/tizen-studio/tools:$PATH"
TV="${1:-192.168.0.236}"
APP=JFlixPkg01.JellyfinFlix
sdb connect "$TV" >/dev/null
DEV="$TV:26101"
sdb -s "$DEV" shell 0 was_kill JFlixPkg01 >/dev/null 2>&1 || true
OUT=$(sdb -s "$DEV" shell 0 debug "$APP" 2>&1)
PORT=$(echo "$OUT" | grep -o 'port: *[0-9]*' | grep -o '[0-9]*' | head -1)
[ -n "$PORT" ] || { echo "no debug port: $OUT" >&2; exit 1; }
sdb -s "$DEV" forward --remove tcp:9333 >/dev/null 2>&1 || true
sdb -s "$DEV" forward tcp:9333 "tcp:$PORT" >/dev/null
for i in 1 2 3 4 5 6 7 8 9 10; do
  WS=$(curl -s http://127.0.0.1:9333/json 2>/dev/null | grep -o '"webSocketDebuggerUrl": *"[^"]*"' | head -1 | sed 's/.*"\(ws[^"]*\)"/\1/') || true
  [ -n "${WS:-}" ] && { echo "$WS"; exit 0; }
  sleep 0.5
done
echo "no websocket" >&2; exit 1
