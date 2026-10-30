#!/usr/bin/env python3
"""TV Remote (JTV-13): phone page tvremote.home -> this server (INDIE :8496) -> Samsung TV (UA55AU7600, 192.168.0.236).

Snappy by design: the phone keeps one WebSocket open to this server, and this server keeps one WebSocket open to the TV
(Samsung remote API, wss :8002). A press is one tiny message each way - no page loads, no new connections.
First use: the TV asks once to "Allow" this remote; its token is then kept in ~/.secrets/samsung_tv_token.
"""
import asyncio, base64, json, logging, mimetypes, os, ssl, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path
from websockets.asyncio.server import serve
from websockets.asyncio.client import connect
from websockets.datastructures import Headers
from websockets.http11 import Response

TV_IP = os.environ.get("TV_IP", "192.168.0.236")
PORT = int(os.environ.get("PORT", "8496"))
NAME = base64.b64encode(b"Phone Remote (tvremote.home)").decode()
TOKEN_FILE = Path.home() / ".secrets/samsung_tv_token"
JF = os.environ.get("JELLYFIN", "http://192.168.0.154:8097")
JF_KEY_FILE = Path.home() / ".secrets/jellyfin_tvremote_key"   # Jellyfin API key "TVRemote" (owner-approved)
WEB = Path(__file__).resolve().parent / "web"
DESIGNS = Path(__file__).resolve().parent / "designs"
APPS = {  # Samsung Tizen app ids; checked against the TV's installed list at connect (see apps.json)
    "netflix": "3201907018807",
    "prime": "3201910019365",
    "jellyfinflix": "JFlixPkg01.JellyfinFlix",
}
ALLOWED_KEYS = {"KEY_UP", "KEY_DOWN", "KEY_LEFT", "KEY_RIGHT", "KEY_ENTER", "KEY_RETURN", "KEY_HOME", "KEY_VOLUP",
                "KEY_VOLDOWN", "KEY_CHUP", "KEY_CHDOWN", "KEY_MUTE", "KEY_POWER", "KEY_PLAY", "KEY_PAUSE", "KEY_EXIT"}

log = logging.getLogger("tvremote")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")


class TV:
    def __init__(self):
        self.ws = None
        self.status = "connecting"  # connected | allow | off | denied | connecting
        self.phones = set()
        self.apps = {}
        self.ime = False  # the TV's own on-screen keyboard is open (e.g. Netflix search)
        self.app_ws = None   # JellyfinFlix on the TV keeps a WebSocket to /app; commands for it go there
        self.pending = None  # (time, command) waiting for JellyfinFlix to start and connect

    def token(self):
        try:
            return TOKEN_FILE.read_text().strip()
        except FileNotFoundError:
            return ""

    async def tell_phones(self):
        msg = json.dumps({"tv": self.status})
        for p in list(self.phones):
            try:
                await p.send(msg)
            except Exception:
                self.phones.discard(p)

    async def set(self, status):
        if status != self.status:
            self.status = status
            log.info("tv %s", status)
            await self.tell_phones()

    async def run(self):
        ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
        while True:
            url = f"wss://{TV_IP}:8002/api/v2/channels/samsung.remote.control?name={NAME}"
            if self.token():
                url += "&token=" + self.token()
            else:
                # no token yet: only ask the TV ("Allow?") while someone has the page open
                if not self.phones:
                    await asyncio.sleep(1); continue
                await self.set("allow")
            try:
                async with connect(url, ssl=ctx, open_timeout=6, ping_interval=15, ping_timeout=10,
                                   max_size=2**22, compression=None) as ws:
                    async for raw in ws:
                        m = json.loads(raw)
                        ev = m.get("event")
                        if ev == "ms.channel.connect":
                            tok = (m.get("data") or {}).get("token")
                            if tok and tok != self.token():
                                TOKEN_FILE.parent.mkdir(exist_ok=True)
                                TOKEN_FILE.write_text(tok); os.chmod(TOKEN_FILE, 0o600)
                                log.info("tv token saved")
                            self.ws = ws
                            await self.set("connected")
                            await ws.send(json.dumps({"method": "ms.channel.emit", "params": {
                                "event": "ed.installedApp.get", "to": "host"}}))
                        elif ev in ("ms.remote.imeStart", "ms.remote.imeUpdate"):
                            self.ime = True
                        elif ev == "ms.remote.imeEnd":
                            self.ime = False
                        elif ev == "ms.channel.unauthorized":
                            await self.set("denied")
                        elif ev == "ed.installedApp.get":
                            self.apps = {a.get("name"): a.get("appId") for a in (m.get("data") or {}).get("data", [])}
                            (Path(__file__).resolve().parent / "apps.json").write_text(json.dumps(self.apps, indent=1))
            except Exception as e:
                log.info("tv link: %s", type(e).__name__)
            self.ws = None
            if self.status == "denied":
                await asyncio.sleep(30); continue   # don't keep asking after a refusal
            await self.set("off")
            await asyncio.sleep(2)

    async def key(self, key, cmd="Click"):
        if not self.ws:
            return False
        await self.ws.send(json.dumps({"method": "ms.remote.control", "params": {
            "Cmd": cmd, "DataOfCmd": key, "Option": "false", "TypeOfRemote": "SendRemoteKey"}}))
        return True

    async def move(self, dx, dy):
        if not self.ws:
            return False
        await self.ws.send(json.dumps({"method": "ms.remote.control", "params": {
            "Cmd": "Move", "Position": {"x": int(dx), "y": int(dy), "Time": str(int(time.time() * 1000))},
            "TypeOfRemote": "ProcessMouseDevice"}}))
        return True

    async def click(self):
        if not self.ws:
            return False
        await self.ws.send(json.dumps({"method": "ms.remote.control", "params": {
            "Cmd": "LeftClick", "TypeOfRemote": "ProcessMouseDevice"}}))
        return True

    async def search(self, text):
        """TV keyboard open -> type the words into it; otherwise open JellyfinFlix with its search filled in."""
        if not self.ws:
            return False
        if self.ime:
            await self.ws.send(json.dumps({"method": "ms.remote.control", "params": {
                "Cmd": base64.b64encode(text.encode()).decode(), "DataOfCmd": "base64", "TypeOfRemote": "SendInputString"}}))
            await self.ws.send(json.dumps({"method": "ms.remote.control", "params": {"TypeOfRemote": "SendInputEnd"}}))
            return True
        return await self.to_app({"search": text})

    async def to_app(self, cmd):
        """Give JellyfinFlix a command; start it first if it is not running (it connects within a few seconds)."""
        if self.app_ws:
            try:
                await self.app_ws.send(json.dumps(cmd))
                await self.launch("jellyfinflix")  # bring it to the front if another app is showing
                return True
            except Exception:
                self.app_ws = None
        self.pending = (time.time(), cmd)
        return await self.launch("jellyfinflix")

    async def launch(self, name):
        """Open an app. This TV (2021 AU7600) ignores the WebSocket launch event, so use its plain launch call."""
        app = APPS.get(name)
        if not app:
            return False
        def post():
            urllib.request.urlopen(urllib.request.Request(f"http://{TV_IP}:8001/api/v2/applications/{app}", method="POST"), timeout=4).read()
        try:
            await asyncio.to_thread(post); return True
        except Exception as e:
            log.info("launch %s: %s", name, type(e).__name__); return False


tv = TV()


def jf_key():
    try:
        return JF_KEY_FILE.read_text().strip()
    except FileNotFoundError:
        return ""


def jf_scan_state():
    """The 'Scan Media Library' task: ("Running", 42.0) / ("Idle", None)."""
    req = urllib.request.Request(JF + "/ScheduledTasks?isHidden=false", headers={"X-Emby-Token": jf_key()})
    with urllib.request.urlopen(req, timeout=5) as r:
        t = next((t for t in json.load(r) if t.get("Key") == "RefreshLibrary"), {})
    return t.get("State", "Idle"), t.get("CurrentProgressPercentage")


def jf_rescan():
    """Start a full library scan (same as Dashboard > Libraries > Scan All Libraries)."""
    req = urllib.request.Request(JF + "/Library/Refresh", method="POST", headers={"X-Emby-Token": jf_key()})
    urllib.request.urlopen(req, timeout=5).read()


scan_watch = None  # task that reports scan progress to every open phone


async def watch_scan():
    """Tell the phones how far the scan is, every 2 s, until Jellyfin says it is done."""
    seen_running = False
    for i in range(1800):  # at most 1 h
        await asyncio.sleep(2)
        try:
            state, pct = await asyncio.to_thread(jf_scan_state)
        except Exception as e:
            log.info("scan state: %s", type(e).__name__); continue
        if state != "Idle":
            seen_running = True
        elif seen_running or i >= 5:  # finished (or so quick it was never seen running)
            await tell({"scan": "done"}); return
        await tell({"scan": "running", "pct": round(pct or 0)})


# ---------------------------------------------------------------- now playing + Fix Sync Sub (JTV-19)

MEDIAFIX = os.environ.get("MEDIAFIX", "http://192.168.0.154:8099")   # mediafix-helper on the Jellyfin box
now_playing = None      # what the TV plays, as sent to the phones (None = nothing)
sync = {"state": None}  # the current / last Fix Sync Sub job, as sent to the phones


def jf_get(path):
    req = urllib.request.Request(JF + path, headers={"X-Emby-Token": jf_key()})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)


def jf_now():
    """The film or episode playing on the TV (the session from the TV's address, else any playing session)."""
    sessions = [x for x in jf_get("/Sessions?activeWithinSeconds=120") if x.get("NowPlayingItem")]
    if not sessions:
        return None
    s = next((x for x in sessions if x.get("RemoteEndPoint", "").split(":")[0] == TV_IP), sessions[0])
    it, ps = s["NowPlayingItem"], s.get("PlayState") or {}
    subs = [m for m in it.get("MediaStreams") or [] if m.get("Type") == "Subtitle"]
    idx = ps.get("SubtitleStreamIndex")
    cur = next((m for m in subs if m.get("Index") == idx), None)
    name = it.get("Name", "")
    if it.get("Type") == "Episode":
        name = f"{it.get('SeriesName', '')} · S{it.get('ParentIndexNumber', 0)}E{it.get('IndexNumber', 0)} {name}"
    return {
        "id": it["Id"], "sid": s.get("Id"), "name": name, "year": it.get("ProductionYear"),
        "img": (f"{JF}/Items/{it['Id']}/Images/Primary?fillHeight=180&quality=80" if (it.get("ImageTags") or {}).get("Primary")
                else f"{JF}/Items/{it.get('SeriesId')}/Images/Primary?fillHeight=180&quality=80" if it.get("SeriesId") else None),
        "pos": round((ps.get("PositionTicks") or 0) / 1e7), "dur": round((it.get("RunTimeTicks") or 0) / 1e7),
        "paused": bool(ps.get("IsPaused")),
        "sub": (cur.get("DisplayTitle") or cur.get("Language") or "On") if cur else ("Off" if subs else "None"),
        "hasSub": any((m.get("Language") or "").lower() in ("en", "eng", "english") or m.get("IsExternal") for m in subs),
    }


async def watch_now():
    """Every 3 s: tell the phones when what plays (or its pause state) changes; the position moves on the phone itself."""
    global now_playing
    while True:
        try:
            n = await asyncio.to_thread(jf_now)
        except Exception as e:
            log.debug("now: %s", type(e).__name__); n = now_playing
        key = lambda x: x and (x["id"], x["paused"], x["sub"], x["pos"] // 15)
        if key(n) != key(now_playing):
            now_playing = n
            await tell({"now": n})
        await asyncio.sleep(3)


def jf_control(sid, what):
    """JTV-20: play / pause what plays on the TV, through Jellyfin (works for any Jellyfin player)."""
    cmd = {"playpause": "PlayPause", "play": "Unpause", "pause": "Pause"}[what]
    req = urllib.request.Request(f"{JF}/Sessions/{sid}/Playing/{cmd}", method="POST", data=b"", headers={"X-Emby-Token": jf_key()})
    urllib.request.urlopen(req, timeout=5).read()


def item_path(item_id):
    r = jf_get("/Items?" + urllib.parse.urlencode({"Ids": item_id, "Fields": "Path", "Recursive": "true"}))
    items = r.get("Items") or []
    return items[0].get("Path") if items else None


def helper(method, path, body=None):
    req = urllib.request.Request(MEDIAFIX + path, method=method, data=json.dumps(body).encode() if body else None,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return json.loads(e.read() or b"{}") | {"httpStatus": e.code}


async def run_sync(item_id, name):
    """Start Fix Sync Sub for the film on the TV and report its progress to every phone until it ends."""
    global sync
    try:
        path = await asyncio.to_thread(item_path, item_id)
        if not path:
            raise RuntimeError("Jellyfin did not give the file")
        r = await asyncio.to_thread(helper, "POST", "/jobs", {"action": "fix-sub-sync", "path": path})
        if not r.get("jobId"):
            busy = r.get("error") == "busy" or r.get("httpStatus") == 409
            raise RuntimeError("Another fix is still running - try again in a few minutes" if busy else r.get("detail") or r.get("error") or "helper said no")
        job = r["jobId"]
        log.info("fix-sub-sync %s started for %s", job, name)
        while True:
            j = await asyncio.to_thread(helper, "GET", f"/jobs/{job}")
            out = j.get("output") or ""
            result = next((l[len("RESULT: "):] for l in reversed(out.splitlines()) if l.startswith("RESULT: ")), None)
            error = next((l[len("ERROR: "):] for l in reversed(out.splitlines()) if l.startswith("ERROR: ")), None)
            check = next((l for l in reversed(out.splitlines()) if l.startswith("Lines within 1 s")), None)
            if j.get("state") == "running":
                sync = {"state": "running", "id": item_id, "name": name, "pct": j.get("progressPercent") or 0,
                        "phase": j.get("progressPhase") or "Starting"}
                await tell({"sync": sync})
                await asyncio.sleep(3)
                continue
            ok = j.get("state") == "succeeded"
            sync = {"state": "done" if ok else "error", "id": item_id, "name": name,
                    "text": (result or error or ("Finished" if ok else "It did not work")) + (f"\n{check}" if check else "")}
            log.info("fix-sub-sync %s %s: %s", job, j.get("state"), sync["text"][:200])
            await tell({"sync": sync})
            return
    except Exception as e:
        sync = {"state": "error", "id": item_id, "name": name, "text": str(e)[:200]}
        await tell({"sync": sync})


sync_task = None


async def tell(m):
    msg = json.dumps(m)
    for p in list(tv.phones):
        try:
            await p.send(msg)
        except Exception:
            tv.phones.discard(p)


def jf_find(q):
    """Library search for the phone: movies and shows whose name contains the letters typed."""
    key = jf_key()
    if not key:
        return {"need_key": True}
    url = JF + "/Items?" + urllib.parse.urlencode({
        "SearchTerm": q, "Recursive": "true", "IncludeItemTypes": "Movie,Series", "Limit": "40",
        "Fields": "ProductionYear", "EnableTotalRecordCount": "false", "ImageTypeLimit": "1", "EnableImageTypes": "Primary"})
    req = urllib.request.Request(url, headers={"X-Emby-Token": key})
    with urllib.request.urlopen(req, timeout=5) as r:
        items = json.load(r).get("Items", [])
    return {"results": [{
        "id": i["Id"], "name": i.get("Name", ""), "year": i.get("ProductionYear"), "type": i.get("Type"),
        "img": (f"{JF}/Items/{i['Id']}/Images/Primary?fillHeight=240&quality=80&tag={i['ImageTags']['Primary']}"
                if (i.get("ImageTags") or {}).get("Primary") else None)} for i in items]}


async def jflix(ws):
    """JellyfinFlix (TV app) link: receives open/search commands."""
    tv.app_ws = ws
    log.info("jellyfinflix connected")
    if tv.pending and time.time() - tv.pending[0] < 30:
        await ws.send(json.dumps(tv.pending[1]))
    tv.pending = None
    try:
        async for _ in ws:
            pass
    finally:
        if tv.app_ws is ws:
            tv.app_ws = None
        log.info("jellyfinflix left")


async def phone(ws):
    global now_playing  # JTV-20: play/pause refreshes it straight away
    if ws.request.path.startswith("/app"):
        return await jflix(ws)
    tv.phones.add(ws)
    await ws.send(json.dumps({"tv": tv.status, "now": now_playing, "sync": sync}))
    try:
        async for raw in ws:
            t0 = time.perf_counter()
            m = json.loads(raw)
            if "k" in m and m["k"] in ALLOWED_KEYS:
                ok = await tv.key(m["k"], m.get("c", "Click") if m.get("c") in ("Click", "Press", "Release") else "Click")
            elif isinstance(m.get("find"), str):
                q = m["find"].strip()[:60]
                try:
                    res = await asyncio.to_thread(jf_find, q) if q else {"results": []}
                except Exception as e:
                    res = {"error": "Jellyfin did not answer"}
                    log.info("find: %s", type(e).__name__)
                res["find"] = m.get("n")
                await ws.send(json.dumps(res)); continue
            elif m.get("rescan"):
                global scan_watch
                if not (scan_watch and not scan_watch.done()):
                    try:
                        await asyncio.to_thread(jf_rescan)
                        log.info("library rescan started")
                        await tell({"scan": "running", "pct": 0})
                        scan_watch = asyncio.create_task(watch_scan())
                    except Exception as e:
                        log.info("rescan: %s", type(e).__name__)
                        await ws.send(json.dumps({"scan": "error"}))
                continue
            elif m.get("np") in ("playpause", "play", "pause"):
                n = now_playing
                if n and n.get("sid"):
                    try:
                        await asyncio.to_thread(jf_control, n["sid"], m["np"])
                        await asyncio.sleep(0.4)
                        now_playing = await asyncio.to_thread(jf_now)  # show the new state at once, not after the 3 s check
                        await tell({"now": now_playing})
                    except Exception as e:
                        log.info("np: %s", type(e).__name__)
                        await ws.send(json.dumps({"now": now_playing, "nperr": 1}))
                continue
            elif m.get("syncsub"):
                global sync_task
                n = now_playing
                if n and not (sync_task and not sync_task.done()):
                    sync_task = asyncio.create_task(run_sync(n["id"], n["name"]))
                continue
            elif isinstance(m.get("open"), str) and m["open"].isalnum():
                ok = await tv.to_app({"open": m["open"]})
            elif isinstance(m.get("search"), str) and m["search"].strip():
                ok = await tv.search(m["search"].strip()[:80])
            elif "app" in m:
                ok = await tv.launch(m["app"])
            elif "m" in m:
                ok = await tv.move(*m["m"][:2])
            elif m.get("click"):
                ok = await tv.click()
            elif m.get("ping"):
                await ws.send(json.dumps({"pong": m["ping"]})); continue
            else:
                continue
            if not ok:
                await ws.send(json.dumps({"tv": tv.status}))
            log.debug("%s %.1f ms", raw, (time.perf_counter() - t0) * 1000)
    finally:
        tv.phones.discard(ws)


def http(conn, req):
    if req.path.startswith("/ws") or req.path.startswith("/app"):
        return None  # WebSocket upgrade
    path = req.path.split("?")[0]
    base = WEB
    if path.startswith("/designs"):
        base, path = DESIGNS, path[len("/designs"):] or "/"
    f = (base / (path.lstrip("/") or "index.html")).resolve()
    if f.is_dir():
        f = f / "index.html"
    if not str(f).startswith(str(base)) or not f.is_file():
        return Response(404, "Not Found", Headers([("Content-Type", "text/plain")]), b"not found")
    ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
    if f.suffix == ".webmanifest":
        ctype = "application/manifest+json"
    return Response(200, "OK", Headers([("Content-Type", ctype), ("Cache-Control", "no-cache")]), f.read_bytes())


async def main():
    asyncio.create_task(tv.run())
    asyncio.create_task(watch_now())
    async with serve(phone, "0.0.0.0", PORT, process_request=http, compression=None, ping_interval=20):
        log.info("tvremote on :%d -> TV %s", PORT, TV_IP)
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
