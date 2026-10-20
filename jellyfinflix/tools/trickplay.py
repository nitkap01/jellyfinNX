#!/usr/bin/env python3
"""Turn on Jellyfin trickplay for every library and start the generator task. Never prints the login or token."""
import json, sys, urllib.request

cfg = dict(l.split(': ', 1) for l in open('/home/nitin/.secrets/jellyfin_admin.txt').read().strip().splitlines())
S = cfg['server'].rstrip('/')
AUTH = 'MediaBrowser Client="JellyfinFlix setup", Device="INDIE", DeviceId="indie-claude-setup", Version="1.0"'

def call(method, path, body=None, token=None):
    h = {'Content-Type': 'application/json', 'X-Emby-Authorization': AUTH + (f', Token="{token}"' if token else '')}
    req = urllib.request.Request(S + path, data=json.dumps(body).encode() if body is not None else None, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=60) as r:
        t = r.read()
        return json.loads(t) if t else None

tok = call('POST', '/Users/AuthenticateByName', {'Username': cfg['user'], 'Pw': cfg['pass']})['AccessToken']
mode = sys.argv[1] if len(sys.argv) > 1 else 'turnon'

if mode == 'turnon':
    for lib in call('GET', '/Library/VirtualFolders', token=tok):
        o = lib.get('LibraryOptions') or {}
        before = o.get('EnableTrickplayImageExtraction')
        if lib.get('CollectionType') in ('movies', 'tvshows', 'homevideos', 'musicvideos', None, 'mixed'):
            o['EnableTrickplayImageExtraction'] = True
            o['ExtractTrickplayImagesDuringLibraryScan'] = False   # keep library scans fast; the scheduled task does the work
            call('POST', '/Library/VirtualFolders/LibraryOptions', {'Id': lib['ItemId'], 'LibraryOptions': o}, token=tok)
            print(f"library {lib['Name']!r} ({lib.get('CollectionType')}): trickplay {before} -> True")
        else:
            print(f"library {lib['Name']!r} ({lib.get('CollectionType')}): skipped")
    conf = call('GET', '/System/Configuration', token=tok)
    print('server trickplay options:', json.dumps({k: v for k, v in (conf.get('TrickplayOptions') or {}).items() if k in ('EnableHwAcceleration', 'Interval', 'WidthResolutions', 'ProcessThreads', 'ProcessPriority', 'Qscale')}))

tasks = call('GET', '/ScheduledTasks', token=tok)
t = next((x for x in tasks if x.get('Key') == 'RefreshTrickplayImages' or 'rickplay' in x.get('Name', '')), None)
if not t:
    sys.exit('trickplay task not found')
if mode == 'turnon' and t.get('State') != 'Running':
    call('POST', f"/ScheduledTasks/Running/{t['Id']}", token=tok)
    print('started task', t['Name'])
t = next(x for x in call('GET', '/ScheduledTasks', token=tok) if x['Id'] == t['Id'])
last = t.get('LastExecutionResult') or {}
print(json.dumps({'task': t['Name'], 'state': t.get('State'), 'progress': round(t.get('CurrentProgressPercentage') or 0, 1), 'lastResult': last.get('Status'), 'lastEnd': last.get('EndTimeUtc')}))
