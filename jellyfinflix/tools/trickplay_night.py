#!/usr/bin/env python3
"""Trickplay schedule (owner, 20 Oct 2026): rest the server for a day, then make previews only at night, in batches.
   python3 tools/trickplay_night.py pause   stop the job now and remove its automatic start (no runs until 'night')
   python3 tools/trickplay_night.py night   from now on: run every night 01:00, stop by itself after 5 h; sitcoms included
   python3 tools/trickplay_night.py status  show the job, its schedule and how many movies/episodes have previews
Reads the admin login from ~/.secrets/jellyfin_admin.txt at runtime; never prints it."""
import json, sys, urllib.request

cfg = dict(l.split(': ', 1) for l in open('/home/nitin/.secrets/jellyfin_admin.txt').read().strip().splitlines())
S = cfg['server'].rstrip('/')
A = 'MediaBrowser Client="JellyfinFlix tools", Device="INDIE", DeviceId="indie-jflix-tools", Version="1.0"'
HOUR = 36000000000  # 1 hour in .NET ticks

def call(method, path, body=None, token=None):
    h = {'Content-Type': 'application/json', 'X-Emby-Authorization': A + (f', Token="{token}"' if token else '')}
    data = None if body is None else json.dumps(body).encode()
    with urllib.request.urlopen(urllib.request.Request(S + path, data=data, headers=h, method=method), timeout=120) as r:
        t = r.read()
        return json.loads(t) if t else None

tok = call('POST', '/Users/AuthenticateByName', {'Username': cfg['user'], 'Pw': cfg['pass']})['AccessToken']
mode = sys.argv[1] if len(sys.argv) > 1 else 'status'
task = next(x for x in call('GET', '/ScheduledTasks', token=tok) if x.get('Key') == 'RefreshTrickplayImages')

if mode == 'pause':
    call('POST', f"/ScheduledTasks/{task['Id']}/Triggers", [], token=tok)          # no automatic runs
    if task.get('State') == 'Running':
        call('DELETE', f"/ScheduledTasks/Running/{task['Id']}", token=tok)
    print('paused: job stopped, no automatic runs')
elif mode == 'night':
    for lib in call('GET', '/Library/VirtualFolders', token=tok):                   # sitcoms join the queue too
        o = lib.get('LibraryOptions') or {}
        if not o.get('EnableTrickplayImageExtraction'):
            o['EnableTrickplayImageExtraction'] = True
            o['ExtractTrickplayImagesDuringLibraryScan'] = False
            call('POST', '/Library/VirtualFolders/LibraryOptions', {'Id': lib['ItemId'], 'LibraryOptions': o}, token=tok)
    call('POST', f"/ScheduledTasks/{task['Id']}/Triggers",
         [{'Type': 'DailyTrigger', 'TimeOfDayTicks': 1 * HOUR, 'MaxRuntimeTicks': 5 * HOUR}], token=tok)
    print('night batches on: every night 01:00, stops itself after 5 h; all 4 libraries')

task = next(x for x in call('GET', '/ScheduledTasks', token=tok) if x['Id'] == task['Id'])
uid = call('GET', '/Users/Me', token=tok)['Id']
counts = {}
for kind in ('Movie', 'Episode'):
    items = call('GET', f'/Users/{uid}/Items?IncludeItemTypes={kind}&Recursive=true&Fields=Trickplay&EnableImages=false', token=tok)['Items']
    counts[kind] = f"{sum(1 for i in items if i.get('Trickplay'))}/{len(items)}"
print(json.dumps({'state': task.get('State'), 'triggers': task.get('Triggers'), 'with_previews': counts,
                  'libraries': {l['Name']: (l.get('LibraryOptions') or {}).get('EnableTrickplayImageExtraction') for l in call('GET', '/Library/VirtualFolders', token=tok)}}))
