#!/usr/bin/env python3
"""Time the Jellyfin API calls JellyfinFlix makes (median of 5 runs, cold first run shown separately).
   python3 tools/apibench.py
Reads the admin login from ~/.secrets/jellyfin_admin.txt at runtime; never prints it."""
import json, statistics, time, urllib.request, urllib.parse

cfg = dict(l.split(': ', 1) for l in open('/home/nitin/.secrets/jellyfin_admin.txt').read().strip().splitlines())
S = cfg['server'].rstrip('/')
A = 'MediaBrowser Client="JellyfinFlix bench", Device="INDIE", DeviceId="indie-jflix-bench", Version="1.0"'

def call(method, path, body=None, token=None, raw=False):
    h = {'Content-Type': 'application/json', 'X-Emby-Authorization': A + (f', Token="{token}"' if token else '')}
    data = None if body is None else json.dumps(body).encode()
    t0 = time.perf_counter()
    with urllib.request.urlopen(urllib.request.Request(S + path, data=data, headers=h, method=method), timeout=120) as r:
        b = r.read()
    return (time.perf_counter() - t0) * 1000, len(b), (None if raw else json.loads(b or b'null'))

_, _, auth = call('POST', '/Users/AuthenticateByName', {'Username': cfg['user'], 'Pw': cfg['pass']})
tok, uid = auth['AccessToken'], auth['User']['Id']
F = 'Fields=Overview,Path&EnableImageTypes=Primary,Backdrop,Thumb,Logo&ImageTypeLimit=1&EnableTotalRecordCount=false'
views = call('GET', f'/Users/{uid}/Views', token=tok)[2]['Items']
movie_lib = next(v['Id'] for v in views if v.get('CollectionType') == 'movies')
series = call('GET', f'/Users/{uid}/Items?IncludeItemTypes=Series&Recursive=true&Limit=1&SortBy=DateCreated&SortOrder=Descending', token=tok)[2]['Items'][0]['Id']
movie = call('GET', f'/Users/{uid}/Items?IncludeItemTypes=Movie&Recursive=true&Limit=1&SortBy=DateCreated&SortOrder=Descending', token=tok)[2]['Items'][0]['Id']
tests = [
    ('Views (rail)', f'/Users/{uid}/Views'),
    ('Continue Watching', f'/Users/{uid}/Items/Resume?Limit=24&MediaTypes=Video&IncludeItemTypes=Movie,Episode&{F}'),
    ('Next Up', f'/Shows/NextUp?UserId={uid}&Limit=24&{F}'),
    ('Recently Added (Latest)', f'/Users/{uid}/Items/Latest?ParentId={movie_lib}&Limit=24&{F}'),
    ('Genre row (Items query)', f'/Users/{uid}/Items?IncludeItemTypes=Movie&Recursive=true&Genres=Comedy&SortBy=Random&Limit=24&{F}'),
    ('My List (favourites)', f'/Users/{uid}/Items?Filters=IsFavorite&Recursive=true&IncludeItemTypes=Movie,Series&Limit=60&{F}'),
    ('Top rated', f'/Users/{uid}/Items?IncludeItemTypes=Movie&Recursive=true&SortBy=CommunityRating&SortOrder=Descending&Limit=24&{F}'),
    ('Search "the"', f'/Users/{uid}/Items?SearchTerm=the&Recursive=true&IncludeItemTypes=Movie,Series&Limit=24&{F}'),
    ('Item details (movie)', f'/Users/{uid}/Items/{movie}'),
    ('Seasons', f'/Shows/{series}/Seasons?UserId={uid}&{F}'),
    ('Episodes', f'/Shows/{series}/Episodes?UserId={uid}&{F}'),
    ('Similar (More like this)', f'/Items/{movie}/Similar?UserId={uid}&Limit=12&{F}'),
    ('PlaybackInfo', None),
    ('Poster image 220x330', f'/Items/{movie}/Images/Primary?fillWidth=220&fillHeight=330&quality=80'),
]
print(f"{'call':28} {'first ms':>9} {'median ms':>10} {'KB':>6}")
for name, path in tests:
    runs = []
    for i in range(6):
        if path is None:
            ms, n, _ = call('POST', f'/Items/{movie}/PlaybackInfo?UserId={uid}&StartTimeTicks=0&IsPlayback=false&AutoOpenLiveStream=false&MaxStreamingBitrate=120000000', {}, token=tok)
        else:
            ms, n, _ = call('GET', path + ('&' if '?' in path else '?') + 'api_key=' + tok, raw=True)
        runs.append(ms)
    print(f"{name:28} {runs[0]:9.0f} {statistics.median(runs[1:]):10.0f} {n/1024:6.0f}")
