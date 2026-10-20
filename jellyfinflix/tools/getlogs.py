#!/usr/bin/env python3
"""Fetch JellyfinFlix logs that the TV uploaded to the Jellyfin server (Dashboard > Logs, files named upload_*).
   python3 tools/getlogs.py            list uploaded JellyfinFlix logs
   python3 tools/getlogs.py last [N]   print the newest N logs (default 1)
   python3 tools/getlogs.py check      check that the server accepts uploads (sends one tiny test log)
Reads the admin login from ~/.secrets/jellyfin_admin.txt at runtime; never prints it."""
import json, sys, urllib.request, urllib.parse

cfg = dict(l.split(': ', 1) for l in open('/home/nitin/.secrets/jellyfin_admin.txt').read().strip().splitlines())
S = cfg['server'].rstrip('/')
A = 'MediaBrowser Client="JellyfinFlix tools", Device="INDIE", DeviceId="indie-jflix-tools", Version="1.0"'

def call(method, path, body=None, token=None, ctype='application/json', raw=False):
    h = {'Content-Type': ctype, 'X-Emby-Authorization': A + (f', Token="{token}"' if token else '')}
    data = None if body is None else (body.encode() if isinstance(body, str) else json.dumps(body).encode())
    with urllib.request.urlopen(urllib.request.Request(S + path, data=data, headers=h, method=method), timeout=60) as r:
        x = r.read()
        return x.decode('utf-8', 'replace') if raw else json.loads(x or b'null')

tok = call('POST', '/Users/AuthenticateByName', {'Username': cfg['user'], 'Pw': cfg['pass']})['AccessToken']
mode = sys.argv[1] if len(sys.argv) > 1 else 'list'
if mode == 'check':
    conf = call('GET', '/System/Configuration', token=tok)
    print('AllowClientLogUpload:', conf.get('AllowClientLogUpload'), '| server', call('GET', '/System/Info', token=tok).get('Version'))
    print('test upload ->', call('POST', '/ClientLog/Document', 'JellyfinFlix log upload test from INDIE\n', token=tok, ctype='text/plain'))
logs = sorted([l for l in call('GET', '/System/Logs', token=tok) if 'upload' in l['Name'].lower() and 'jellyfinflix' in l['Name'].lower()],
              key=lambda l: l.get('DateModified', ''), reverse=True)
if mode in ('list', 'check'):
    for l in logs[:30]:
        print(l.get('DateModified', '')[:19], l['Size'], l['Name'])
    print(len(logs), 'JellyfinFlix logs on the server')
elif mode == 'last':
    for l in logs[:int(sys.argv[2]) if len(sys.argv) > 2 else 1]:
        print('=====', l['Name'])
        print(call('GET', '/System/Logs/Log?name=' + urllib.parse.quote(l['Name']), token=tok, raw=True))
