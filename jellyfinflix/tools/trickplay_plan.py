#!/usr/bin/env python3
"""Trickplay plan (20 Oct 2026, owner OK): movies first with 3 worker threads; sitcom libraries paused for now.
   python3 tools/trickplay_plan.py movies-first   apply the plan and restart the generator task
   python3 tools/trickplay_plan.py sitcoms-on     later: turn trickplay back on for the sitcom libraries
   python3 tools/trickplay_plan.py status         show settings and task progress
Reads the admin login from ~/.secrets/jellyfin_admin.txt at runtime; never prints it."""
import json, sys, urllib.request

cfg = dict(l.split(': ', 1) for l in open('/home/nitin/.secrets/jellyfin_admin.txt').read().strip().splitlines())
S = cfg['server'].rstrip('/')
A = 'MediaBrowser Client="JellyfinFlix tools", Device="INDIE", DeviceId="indie-jflix-tools", Version="1.0"'

def call(method, path, body=None, token=None):
    h = {'Content-Type': 'application/json', 'X-Emby-Authorization': A + (f', Token="{token}"' if token else '')}
    data = None if body is None else json.dumps(body).encode()
    with urllib.request.urlopen(urllib.request.Request(S + path, data=data, headers=h, method=method), timeout=60) as r:
        t = r.read()
        return json.loads(t) if t else None

tok = call('POST', '/Users/AuthenticateByName', {'Username': cfg['user'], 'Pw': cfg['pass']})['AccessToken']
mode = sys.argv[1] if len(sys.argv) > 1 else 'status'
task = next(x for x in call('GET', '/ScheduledTasks', token=tok) if x.get('Key') == 'RefreshTrickplayImages')

if mode in ('movies-first', 'sitcoms-on'):
    for lib in call('GET', '/Library/VirtualFolders', token=tok):
        o = lib.get('LibraryOptions') or {}
        want = True if lib.get('CollectionType') == 'movies' else (mode == 'sitcoms-on')
        if o.get('EnableTrickplayImageExtraction') != want:
            o['EnableTrickplayImageExtraction'] = want
            call('POST', '/Library/VirtualFolders/LibraryOptions', {'Id': lib['ItemId'], 'LibraryOptions': o}, token=tok)
        print(f"{lib['Name']}: trickplay {'on' if want else 'paused'}")
    conf = call('GET', '/System/Configuration', token=tok)
    tp = conf.setdefault('TrickplayOptions', {})
    if tp.get('ProcessThreads') != 3:
        tp['ProcessThreads'] = 3
        call('POST', '/System/Configuration', conf, token=tok)
    print('worker threads:', tp['ProcessThreads'], '| priority:', tp.get('ProcessPriority'))
    if task.get('State') == 'Running':   # restart so the new settings are used
        call('DELETE', f"/ScheduledTasks/Running/{task['Id']}", token=tok)
    call('POST', f"/ScheduledTasks/Running/{task['Id']}", token=tok)
    print('generator restarted')

task = next(x for x in call('GET', '/ScheduledTasks', token=tok) if x['Id'] == task['Id'])
libs = {l['Name']: (l.get('LibraryOptions') or {}).get('EnableTrickplayImageExtraction') for l in call('GET', '/Library/VirtualFolders', token=tok)}
if mode == 'start' and task.get('State') == 'Idle':
    call('POST', f"/ScheduledTasks/Running/{task['Id']}", token=tok); task = next(x for x in call('GET', '/ScheduledTasks', token=tok) if x['Id'] == task['Id'])
print(json.dumps({'task': task.get('State'), 'progress': round(task.get('CurrentProgressPercentage') or 0, 1), 'libraries': libs,
                  'threads': call('GET', '/System/Configuration', token=tok).get('TrickplayOptions', {}).get('ProcessThreads')}))
