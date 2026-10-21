#!/usr/bin/env python3
"""Fetch real English subtitles for a list of videos, one at a time, through the mediafix-helper
(the same "Fetch Subtitle" the TV uses). JTV-9, owner OK 21 Oct 2026.
   python3 tools/fetch_subs_batch.py <list-file>     one video path per line (as seen inside CT 105, /MEDIA/...)
Prints one line per video: ok / failed (+ helper message) and a summary."""
import json, sys, time, urllib.request

HELPER = 'http://192.168.0.154:8099'

def post(path, body):
    req = urllib.request.Request(HELPER + path, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'{}')

def get(path):
    with urllib.request.urlopen(HELPER + path, timeout=30) as r:
        return json.loads(r.read() or b'{}')

paths = [l.strip() for l in open(sys.argv[1]) if l.strip()]
ok = failed = 0
for i, p in enumerate(paths, 1):
    name = p.rsplit('/', 1)[-1][:70]
    for _ in range(60):                     # wait if another fix is running (helper runs one job at a time)
        code, body = post('/jobs', {'action': 'fix-subtitle', 'path': p})
        if code != 409: break
        time.sleep(20)
    if code != 202:
        failed += 1; print(f'{i}/{len(paths)} failed to start ({code} {body.get("error")} {body.get("detail", "")}): {name}', flush=True); continue
    job_id = body.get('jobId') or body.get('id')
    t0 = time.time()
    while True:
        time.sleep(5)
        try: job = get('/jobs/' + job_id)
        except Exception: continue
        if job.get('state') != 'running' or time.time() - t0 > 600: break
    good = job.get('state') in ('done', 'succeeded', 'success', 'ok') or job.get('exitCode') == 0
    ok += good; failed += not good
    msg = (job.get('message') or job.get('error') or job.get('state') or '')
    print(f"{i}/{len(paths)} {'ok' if good else 'failed'} ({int(time.time() - t0)} s) {name}" + ('' if good else f' — {str(msg)[:120]}'), flush=True)
    time.sleep(3)                           # gentle on the subtitle sites
print(f'SUMMARY: {ok} fetched, {failed} failed, of {len(paths)}', flush=True)
