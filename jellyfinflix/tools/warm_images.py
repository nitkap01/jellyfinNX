#!/usr/bin/env python3
"""Pre-make (warm) the Jellyfin image cache in exactly the sizes JellyfinFlix asks for, so every poster and
background is instant on the TV, even the first time. Night batch (owner, 20 Oct 2026): runs from the INDIE timer
jflix-warm-images.timer at 00:05, stops itself after MAX_MIN minutes; images already made return in ~1 ms.
   python3 tools/warm_images.py [max_minutes]
URLs mirror src/api.js (img/cardImg/posterImg/backdropImg/logoImg) and src/ui/rows.js KINDS. The TV asks for WebP,
so we send the same Accept header (the server caches per output format).
Reads the admin login from ~/.secrets/jellyfin_admin.txt at runtime; never prints it."""
import json, sys, time, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor

START_AFTER = '2026-10-22'          # owner: one rest day for the server first
MAX_MIN = float(sys.argv[1]) if len(sys.argv) > 1 else 50
import os
if time.strftime('%Y-%m-%d') < START_AFTER and not os.environ.get('JFLIX_WARM_TEST'):
    print('rest day: not before', START_AFTER); sys.exit(0)

cfg = dict(l.split(': ', 1) for l in open('/home/nitin/.secrets/jellyfin_admin.txt').read().strip().splitlines())
S = cfg['server'].rstrip('/')
A = 'MediaBrowser Client="JellyfinFlix tools", Device="INDIE", DeviceId="indie-jflix-tools", Version="1.0"'
ACCEPT = 'image/webp,image/apng,image/*,*/*;q=0.8'   # what the TV's Chrome 76 sends for <img>

def api(path, body=None):
    h = {'Content-Type': 'application/json', 'X-Emby-Authorization': A + (f', Token="{tok}"' if tok else '')}
    data = None if body is None else json.dumps(body).encode()
    with urllib.request.urlopen(urllib.request.Request(S + path, data=data, headers=h, method='POST' if body is not None else 'GET'), timeout=120) as r:
        return json.loads(r.read() or b'null')

tok = ''
auth = api('/Users/AuthenticateByName', {'Username': cfg['user'], 'Pw': cfg['pass']})
tok, uid = auth['AccessToken'], auth['User']['Id']

def img(iid, typ, tag, w, h=0, q=80):
    if not iid or not tag: return None
    return f"/Items/{iid}/Images/{typ}?fillWidth={w}" + (f"&fillHeight={h}" if h else '') + f"&quality={q}&tag={tag}"

def card(it, w, h):
    T = it.get('ImageTags') or {}
    if it['Type'] == 'Episode' and T.get('Primary'): return img(it['Id'], 'Primary', T['Primary'], w, h)
    if T.get('Thumb'): return img(it['Id'], 'Thumb', T['Thumb'], w, h)
    if it['Type'] == 'Episode' and it.get('ParentThumbItemId') and it.get('ParentThumbImageTag'): return img(it['ParentThumbItemId'], 'Thumb', it['ParentThumbImageTag'], w, h)
    if (it.get('BackdropImageTags') or [None])[0]: return img(it['Id'], 'Backdrop', it['BackdropImageTags'][0], w, h)
    if it.get('ParentBackdropItemId') and (it.get('ParentBackdropImageTags') or [None])[0]: return img(it['ParentBackdropItemId'], 'Backdrop', it['ParentBackdropImageTags'][0], w, h)
    if T.get('Primary'): return img(it['Id'], 'Primary', T['Primary'], w, h)

def poster(it, w, h):
    T = it.get('ImageTags') or {}
    if it['Type'] == 'Episode' and it.get('SeriesId') and it.get('SeriesPrimaryImageTag'): return img(it['SeriesId'], 'Primary', it['SeriesPrimaryImageTag'], w, h)
    if T.get('Primary'): return img(it['Id'], 'Primary', T['Primary'], w, h)
    return card(it, w, h)

def backdrop(it, w=1280):
    T = it.get('ImageTags') or {}
    if (it.get('BackdropImageTags') or [None])[0]: return img(it['Id'], 'Backdrop', it['BackdropImageTags'][0], w, 0, 70)
    if it.get('ParentBackdropItemId') and (it.get('ParentBackdropImageTags') or [None])[0]: return img(it['ParentBackdropItemId'], 'Backdrop', it['ParentBackdropImageTags'][0], w, 0, 70)
    if T.get('Thumb'): return img(it['Id'], 'Thumb', T['Thumb'], w, 0, 70)
    if T.get('Primary'): return img(it['Id'], 'Primary', T['Primary'], w, 0, 70)

def logo(it):
    T = it.get('ImageTags') or {}
    iid, tag = (it['Id'], T['Logo']) if T.get('Logo') else (it.get('ParentLogoItemId'), it.get('ParentLogoImageTag'))
    return f"/Items/{iid}/Images/Logo?maxWidth=640&maxHeight=240&quality=90&tag={tag}" if iid and tag else None

F = 'Fields=Overview&EnableImageTypes=Primary,Backdrop,Thumb,Logo&ImageTypeLimit=1&EnableTotalRecordCount=false'
urls = []
for kind in ('Movie', 'Series'):        # titles first (rows, billboard, search), episodes after
    for it in api(f'/Users/{uid}/Items?IncludeItemTypes={kind}&Recursive=true&{F}')['Items']:
        urls += [poster(it, 220, 330), card(it, 330, 186), card(it, 320, 180), card(it, 240, 135), backdrop(it), logo(it)]
for it in api(f'/Users/{uid}/Items?IncludeItemTypes=Episode&Recursive=true&{F}')['Items']:
    urls += [card(it, 420, 236), card(it, 330, 186)]
urls = list(dict.fromkeys(u for u in urls if u))

def fetch(u):
    t0 = time.perf_counter()
    try:
        req = urllib.request.Request(S + u + '&api_key=' + tok, headers={'Accept': ACCEPT})
        with urllib.request.urlopen(req, timeout=60) as r: r.read()
        return (time.perf_counter() - t0) * 1000
    except Exception:
        return -1

stop = time.time() + MAX_MIN * 60
made = cached = failed = 0
t0 = time.time()
with ThreadPoolExecutor(2) as ex:                       # 2 at a time: gentle on the server
    for i in range(0, len(urls), 40):
        if time.time() > stop: break
        for ms in ex.map(fetch, urls[i:i + 40]):
            if ms < 0: failed += 1
            elif ms > 25: made += 1
            else: cached += 1
done = made + cached + failed
print(f"{time.strftime('%F %H:%M')} images {done}/{len(urls)}: {made} made, {cached} already cached, {failed} failed, {round((time.time() - t0) / 60, 1)} min")
