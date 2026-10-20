#!/usr/bin/env python3
"""Test-data helper for TV test rounds: find items, and save/restore a user's watch state so tests leave no trace.
   python3 tools/testdata.py find <text> [types]        id, type, name, resume %, favourite, played
   python3 tools/testdata.py item <id>                  short facts: streams (audio/subtitle), path, user data
   python3 tools/testdata.py snap <file> <id>|series:<id> ..  save resume point / played / favourite (series: all its episodes)
   python3 tools/testdata.py snapall <file>             save the watch state of every movie/episode/series (one call)
   python3 tools/testdata.py diff <file>                what changed since that snapshot
   python3 tools/testdata.py restore <file>             put them back exactly as saved
   python3 tools/testdata.py resume                     the user's Continue Watching list
Works on the account in ~/.secrets/jellyfin_admin.txt (the TV's 'admin' profile), read at run time, never printed."""
import json, sys, urllib.request, urllib.parse

cfg = dict(l.split(': ', 1) for l in open('/home/nitin/.secrets/jellyfin_admin.txt').read().strip().splitlines())
S = cfg['server'].rstrip('/')
A = 'MediaBrowser Client="JellyfinFlix tools", Device="INDIE", DeviceId="indie-jflix-tools", Version="1.0"'
TOK = None


def call(method, path, body=None, q=None):
    h = {'Content-Type': 'application/json', 'X-Emby-Authorization': A + (f', Token="{TOK}"' if TOK else '')}
    url = S + path + ('?' + urllib.parse.urlencode(q) if q else '')
    data = None if body is None else json.dumps(body).encode()
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h, method=method), timeout=60) as r:
        x = r.read()
        return json.loads(x) if x else None


auth = call('POST', '/Users/AuthenticateByName', {'Username': cfg['user'], 'Pw': cfg['pass']})
TOK, U = auth['AccessToken'], auth['User']['Id']


def ud(i):
    d = i.get('UserData') or {}
    return {'pos': d.get('PlaybackPositionTicks', 0), 'played': d.get('Played', False), 'fav': d.get('IsFavorite', False), 'last': d.get('LastPlayedDate')}


def everything():
    # every movie, episode and series with its user data, in one call
    return call('GET', f'/Users/{U}/Items', q={'Recursive': 'true', 'IncludeItemTypes': 'Movie,Episode,Series', 'Fields': 'ParentId', 'EnableImageTypes': 'None', 'EnableTotalRecordCount': 'false'})['Items']


def get(i):
    return call('GET', f'/Users/{U}/Items/{i}')


def line(i):
    d = i.get('UserData') or {}
    pct = d.get('PlayedPercentage') or 0
    ep = f" S{i.get('ParentIndexNumber')}E{i.get('IndexNumber')} of {i.get('SeriesName')}" if i['Type'] == 'Episode' else ''
    return f"{i['Id']}  {i['Type']:8} {i['Name'][:50]}{ep}  resume={pct:.0f}% fav={d.get('IsFavorite')} played={d.get('Played')}"


cmd = sys.argv[1] if len(sys.argv) > 1 else ''
if cmd == 'find':
    types = sys.argv[3] if len(sys.argv) > 3 else 'Movie,Series,Episode'
    r = call('GET', f'/Users/{U}/Items', q={'SearchTerm': sys.argv[2], 'Recursive': 'true', 'IncludeItemTypes': types, 'Limit': 25})
    for i in r['Items']:
        print(line(i))
elif cmd == 'item':
    i = get(sys.argv[2])
    print(line(i))
    print('path', i.get('Path'))
    for s in (i.get('MediaStreams') or []):
        if s['Type'] in ('Audio', 'Subtitle'):
            print(f"  {s['Type']:8} #{s['Index']} {s.get('Codec')} {s.get('Language')} {s.get('Title') or ''} ext={s.get('IsExternal')} text={s.get('IsTextSubtitleStream')} default={s.get('IsDefault')}")
elif cmd == 'snap':
    out = {}
    for x in sys.argv[3:]:
        if x.startswith('series:'):   # every episode of a series
            for e in call('GET', f'/Shows/{x[7:]}/Episodes', q={'UserId': U})['Items']:
                out[e['Id']] = ud(e)
            x = x[7:]
        out[x] = ud(get(x))
    json.dump(out, open(sys.argv[2], 'w'), indent=1)
    print('saved', len(out), 'items to', sys.argv[2])
elif cmd == 'snapall':
    out = {i['Id']: ud(i) for i in everything()}
    json.dump(out, open(sys.argv[2], 'w'))
    print('saved', len(out), 'items to', sys.argv[2])
elif cmd == 'diff':
    saved = json.load(open(sys.argv[2]))
    for i in everything():
        if i['Id'] in saved and ud(i) != saved[i['Id']]:
            print('changed', line(i), 'was', saved[i['Id']], 'now', ud(i))
elif cmd == 'restore':
    saved = json.load(open(sys.argv[2]))
    cur = {i['Id']: ud(i) for i in everything()} if len(saved) > 50 else {x: ud(get(x)) for x in saved}
    for x, want in saved.items():
        now = cur.get(x)
        if now is None or now == want:
            continue
        # played flag first (marking unplayed also clears the position), then the exact position, then favourite
        if now['played'] != want['played']:
            call('POST' if want['played'] else 'DELETE', f'/Users/{U}/PlayedItems/{x}')
        body = {'PlaybackPositionTicks': want['pos'], 'Played': want['played']}
        if want.get('last'):
            body['LastPlayedDate'] = want['last']   # keeps the Continue Watching order as it was
        call('POST', f'/UserItems/{x}/UserData', body, q={'userId': U})
        if now['fav'] != want['fav']:
            call('POST' if want['fav'] else 'DELETE', f'/Users/{U}/FavoriteItems/{x}')
        after = ud(get(x))
        print(('restored ' if after == want else 'MISMATCH ') + x, 'was', now, 'now', after)
    print('restore checked', len(saved), 'items')
elif cmd == 'resume':
    r = call('GET', f'/Users/{U}/Items/Resume', q={'Limit': 30, 'MediaTypes': 'Video'})
    for i in r['Items']:
        print(line(i))
else:
    print(__doc__)
