#!/usr/bin/env python3
"""Jellyfin server tuning for JellyfinFlix (JTV-9, owner OK 20 Oct 2026):
 1) trickplay previews on the Intel GPU (VAAPI decode + hardware MJPEG encode)
 2) conversions: delete old segments while playing + throttle (don't convert far ahead)
   python3 tools/server_tune.py apply      apply both and restart the trickplay task
   python3 tools/server_tune.py cpu-only   undo 1 (previews back on the CPU), if the GPU path fails
   python3 tools/server_tune.py status     show the settings and active conversions
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

if mode in ('apply', 'cpu-only'):
    conf = call('GET', '/System/Configuration', token=tok)
    tp = conf.setdefault('TrickplayOptions', {})
    gpu = mode == 'apply'
    tp['EnableHwAcceleration'] = gpu
    tp['EnableHwEncoding'] = gpu
    call('POST', '/System/Configuration', conf, token=tok)
    if mode == 'apply':
        enc = call('GET', '/System/Configuration/encoding', token=tok)
        enc['EnableSegmentDeletion'] = True
        enc['EnableThrottling'] = True
        call('POST', '/System/Configuration/encoding', enc, token=tok)
    if task.get('State') == 'Running':
        call('DELETE', f"/ScheduledTasks/Running/{task['Id']}", token=tok)
    print('applied:', mode)

conf = call('GET', '/System/Configuration', token=tok)
enc = call('GET', '/System/Configuration/encoding', token=tok)
active = [s for s in call('GET', '/Sessions?ActiveWithinSeconds=600', token=tok) if s.get('TranscodingInfo')]
task = next(x for x in call('GET', '/ScheduledTasks', token=tok) if x['Id'] == task['Id'])
print(json.dumps({
    'trickplay': {k: conf.get('TrickplayOptions', {}).get(k) for k in ('EnableHwAcceleration', 'EnableHwEncoding', 'ProcessThreads', 'ProcessPriority')},
    'encoding': {k: enc.get(k) for k in ('HardwareAccelerationType', 'EnableSegmentDeletion', 'SegmentKeepSeconds', 'EnableThrottling', 'ThrottleDelaySeconds')},
    'active_conversions': len(active), 'trickplay_task': task.get('State')}, indent=1))
