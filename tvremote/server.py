#!/usr/bin/env python3
"""TV Remote (JTV-13): phone page tvremote.home -> this server (INDIE :8496) -> Samsung TV (UA55AU7600, 192.168.0.236).

Snappy by design: the phone keeps one WebSocket open to this server, and this server keeps one WebSocket open to the TV
(Samsung remote API, wss :8002). A press is one tiny message each way - no page loads, no new connections.
First use: the TV asks once to "Allow" this remote; its token is then kept in ~/.secrets/samsung_tv_token.
"""
import asyncio, base64, json, logging, mimetypes, os, ssl, time, urllib.request
from pathlib import Path
from websockets.asyncio.server import serve
from websockets.asyncio.client import connect
from websockets.datastructures import Headers
from websockets.http11 import Response

TV_IP = os.environ.get("TV_IP", "192.168.0.236")
PORT = int(os.environ.get("PORT", "8496"))
NAME = base64.b64encode(b"Phone Remote (tvremote.home)").decode()
TOKEN_FILE = Path.home() / ".secrets/samsung_tv_token"
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
        return await self.launch("jellyfinflix", "search=" + text)

    async def launch(self, name, meta=None):
        app = APPS.get(name)
        if not app:
            return False
        if self.ws:
            await self.ws.send(json.dumps({"method": "ms.channel.emit", "params": {
                "event": "ed.apps.launch", "to": "host", "data": dict({"appId": app, "action_type": "DEEP_LINK"},
                                                                      **({"metaTag": meta} if meta else {}))}}))
            return True
        # TV link down: try the plain launch call once
        def post():
            urllib.request.urlopen(urllib.request.Request(f"http://{TV_IP}:8001/api/v2/applications/{app}", method="POST"), timeout=3)
        try:
            await asyncio.to_thread(post); return True
        except Exception:
            return False


tv = TV()


async def phone(ws):
    tv.phones.add(ws)
    await ws.send(json.dumps({"tv": tv.status}))
    try:
        async for raw in ws:
            t0 = time.perf_counter()
            m = json.loads(raw)
            if "k" in m and m["k"] in ALLOWED_KEYS:
                ok = await tv.key(m["k"], m.get("c", "Click") if m.get("c") in ("Click", "Press", "Release") else "Click")
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
    if req.path.startswith("/ws"):
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
    async with serve(phone, "0.0.0.0", PORT, process_request=http, compression=None, ping_interval=20):
        log.info("tvremote on :%d -> TV %s", PORT, TV_IP)
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
