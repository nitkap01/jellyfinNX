#!/bin/bash
# Build + sign JellyfinFlix (.wgt) for the Samsung TV, and optionally install it.
#   ./build.sh                    bundle (esbuild, chrome76) + sign  -> JellyfinFlix.wgt
#   ./build.sh --install [TV-IP]  also install on the TV (Developer Mode), default 192.168.0.236
#   ./build.sh --dev              bundle only, not minified (dist/ can be opened in a desktop browser)
# Needs: node, npm i (esbuild), Tizen Studio CLI in ~/tizen-studio, the signer in ../.tools (npm i there),
# certificate passwords in ~/.tizen-secrets/cert.env (never committed). Same author certificate as JellyfinNX.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
export PATH="$HOME/tizen-studio/tools/ide/bin:$HOME/tizen-studio/tools:$PATH"
DIST="$HERE/dist"
[ -d "$HERE/node_modules/esbuild" ] || npm --prefix "$HERE" i --no-audit --no-fund
MIN=--minify
[ "${1:-}" = "--dev" ] && MIN=""

rm -rf "$DIST" && mkdir -p "$DIST"
"$HERE/node_modules/.bin/esbuild" "$HERE/src/main.js" --bundle --format=iife --target=chrome76 $MIN \
  --legal-comments=none --outfile="$DIST/app.js" --log-level=warning
"$HERE/node_modules/.bin/esbuild" "$HERE/src/style.css" --target=chrome76 $MIN --outfile="$DIST/style.css" --log-level=warning
# Inline the CSS so the first paint needs only index.html.
node -e '
const fs=require("fs");const [h,c,o]=process.argv.slice(1);
fs.writeFileSync(o, fs.readFileSync(h,"utf8").replace("/*CSS*/", fs.readFileSync(c,"utf8").trim()));' \
  "$HERE/src/index.html" "$DIST/style.css" "$DIST/index.html"
rm "$DIST/style.css"
[ -f "$HERE/tizen/icon.png" ] || python3 "$HERE/tizen/make-icon.py"
cp "$HERE/tizen/config.xml" "$HERE/tizen/icon.png" "$DIST/"
echo "bundle: $(wc -c < "$DIST/app.js") bytes JS, $(wc -c < "$DIST/index.html") bytes HTML+CSS"
[ "${1:-}" = "--dev" ] && exit 0

. ~/.tizen-secrets/cert.env
: "${TIZEN_AUTHOR_P12:=$HOME/tizen-studio-data/keystore/author/jellyfinnx-author.p12}"
: "${TIZEN_DIST_P12:=$HOME/tizen-studio/tools/certificate-generator/certificates/distributor/tizen-distributor-signer.p12}"
: "${TIZEN_DIST_PASSWORD:=tizenpkcs12passfordsigner}"
[ -d "$ROOT/.tools/node_modules" ] || npm --prefix "$ROOT/.tools" i --no-audit --no-fund
(cd "$ROOT/.tools" && TIZEN_AUTHOR_P12="$TIZEN_AUTHOR_P12" TIZEN_CERT_PASSWORD="$TIZEN_CERT_PASSWORD" \
   TIZEN_DIST_P12="$TIZEN_DIST_P12" TIZEN_DIST_PASSWORD="$TIZEN_DIST_PASSWORD" \
   node sign-wgt.js "$DIST" "$HERE/JellyfinFlix.wgt" | grep -v '^\[')

if [ "${1:-}" = "--install" ]; then
  TV="${2:-192.168.0.236}"
  sdb connect "$TV" >/dev/null
  T=$(sdb devices | awk -v tv="$TV" 'NR>1 && index($1,tv)==1 {print $3; exit}')
  [ -n "$T" ] || { echo "TV $TV not connected (Developer Mode on? host IP = this machine?)"; exit 1; }
  tizen install -n JellyfinFlix.wgt -t "$T" -- "$HERE"
fi
