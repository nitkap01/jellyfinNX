#!/bin/bash
# Experiment: long tasks while browsing with different backdrop CSS tweaks (live, via CDP).
W=$(cat /tmp/claude-1000/jf/ws)
D=$(dirname "$0")
run() {
  timeout 20 node "$D/cdp.mjs" "$W" eval "(()=>{let s=document.getElementById('xp');if(!s){s=document.createElement('style');s.id='xp';document.head.appendChild(s)}s.textContent=$1;return 1})()" >/dev/null
  timeout 30 node "$D/cdp.mjs" "$W" keys 'Left*8' 120 >/dev/null
  sleep 1
  echo "== $2"
  timeout 60 node "$D/tv-keys.mjs" "$W" "${KEYS:-Right*6,Left*6}" 600 | python3 -c "import sys,json;d=json.load(sys.stdin);print('long',len(d['long']),'ms',sum(int(x.split(': ')[1][:-2]) for x in d['long']),'frames',d['frames'])"
}
run "''" "baseline"
run "'.bgi{transition:none!important}'" "no crossfade"
run "'.bgshade{display:none}'" "no shade"
run "'.bgi{transition:none!important;will-change:auto!important}'" "no crossfade, not composited"
run "'.bgi{transition:none!important}.bgshade{display:none}'" "no crossfade, no shade"
run "''" "baseline again"
