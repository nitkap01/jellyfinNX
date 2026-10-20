#!/usr/bin/env python3
"""Turn off real-time folder watching on all libraries (it does not work over the SMB share from TrueNAS) and show
the scheduled library scan that picks up new files instead. JTV-9, owner OK 20 Oct 2026.
Reads the admin login from ~/.secrets/jellyfin_admin.txt at runtime; never prints it."""
import json, urllib.request
cfg = dict(l.split(': ', 1) for l in open('/home/nitin/.secrets/jellyfin_admin.txt').read().strip().splitlines())
S = cfg['server'].rstrip('/')
A = 'MediaBrowser Client="JellyfinFlix tools", Device="INDIE", DeviceId="indie-jflix-tools", Version="1.0"'

def call(m, p, b=None, t=None):
    h = {'Content-Type': 'application/json', 'X-Emby-Authorization': A + (f', Token="{t}"' if t else '')}
    with urllib.request.urlopen(urllib.request.Request(S + p, data=json.dumps(b).encode() if b is not None else None, headers=h, method=m), timeout=60) as r:
        x = r.read()
        return json.loads(x) if x else None

tok = call('POST', '/Users/AuthenticateByName', {'Username': cfg['user'], 'Pw': cfg['pass']})['AccessToken']
for lib in call('GET', '/Library/VirtualFolders', t=tok):
    o = lib.get('LibraryOptions') or {}
    if o.get('EnableRealtimeMonitor'):
        o['EnableRealtimeMonitor'] = False
        call('POST', '/Library/VirtualFolders/LibraryOptions', {'Id': lib['ItemId'], 'LibraryOptions': o}, t=tok)
        print('real-time watching off:', lib['Name'])
    else:
        print('already off:', lib['Name'])
scan = next(x for x in call('GET', '/ScheduledTasks', t=tok) if x.get('Key') == 'RefreshLibrary')
print('library scan triggers:', json.dumps(scan.get('Triggers')))
