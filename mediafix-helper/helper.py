#!/usr/bin/env python3
import json
import os
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HOST = "0.0.0.0"
PORT = 8099

HOME = os.path.expanduser("~")
ACTIONS = {
    "fix-audio": os.path.join(HOME, "jellyfin_audio_fix", "fix-movie-audio.sh"),
    "fix-subtitle": os.path.join(HOME, "jellyfin_audio_fix", "fix-subtitles.sh"),
}
AUDIOFIX_LOG = os.path.join(HOME, "jellyfin_audio_fix", "logs", "audiofix.log")
PROGRESS_FILE = os.path.join(HOME, "jellyfin_audio_fix", "work", "progress.status")

LIBRARY_ROOTS = ["/MEDIA/Eng_Movies", "/MEDIA/Hin_Movies", "/MEDIA/Eng_Sitcoms", "/MEDIA/Hin_Sitcoms"]
MAX_BODY_BYTES = 8192
JOB_RETENTION_SECONDS = 30 * 60
OUTPUT_CAP_BYTES = 8000

jobs = {}
jobs_lock = threading.Lock()


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sweep_jobs_locked():
    cutoff = time.time() - JOB_RETENTION_SECONDS
    dead = [
        jid for jid, j in jobs.items()
        if j["state"] != "running" and j.get("finished_at_epoch", 0) < cutoff
    ]
    for jid in dead:
        del jobs[jid]


def any_job_running_locked():
    return any(j["state"] == "running" for j in jobs.values())


def read_progress():
    try:
        with open(PROGRESS_FILE, "r", errors="replace") as f:
            content = f.read()
    except OSError:
        return None, None
    phase = None
    pct = None
    for line in content.splitlines():
        if line.startswith("phase="):
            phase = line[len("phase="):]
        elif line.startswith("pct="):
            try:
                pct = int(line[len("pct="):])
            except ValueError:
                pct = None
    return phase, pct


def latest_result_for_path(resolved_path):
    try:
        with open(AUDIOFIX_LOG, "r", errors="replace") as f:
            lines = f.readlines()
    except OSError:
        return None, None

    for line in reversed(lines):
        if not line.startswith("RESULT|"):
            continue
        fields = line.rstrip("\n").split("|")
        if len(fields) < 4:
            continue
        ts_str, status, src = fields[1], fields[2], fields[3]
        if src != resolved_path:
            continue
        return status, ts_str
    return None, None


def resolve_result_status(action, resolved_path, job_started_epoch):
    if action != "fix-audio":
        return None
    try:
        with open(AUDIOFIX_LOG, "r", errors="replace") as f:
            lines = f.readlines()
    except OSError:
        return None

    for line in reversed(lines):
        if not line.startswith("RESULT|"):
            continue
        fields = line.rstrip("\n").split("|")
        if len(fields) < 4:
            continue
        ts_str, status, src = fields[1], fields[2], fields[3]
        if src != resolved_path:
            continue
        try:
            ts = datetime.strptime(ts_str, "%Y-%m-%dT%H:%M:%S%z").timestamp()
        except ValueError:
            continue
        if ts >= job_started_epoch - 2:
            return status
        return None
    return None


def run_job(job_id, action, resolved_path):
    script = ACTIONS[action]
    env = {
        "HOME": HOME,
        "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "LC_ALL": "C",
    }
    started_epoch = time.time()
    try:
        proc = subprocess.run(
            [script, resolved_path],
            shell=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=HOME,
            env=env,
        )
        exit_code = proc.returncode
        output = proc.stdout.decode("utf-8", errors="replace")
    except Exception as exc:  # noqa: BLE001 - report any launch failure as a failed job
        exit_code = -1
        output = f"helper failed to launch script: {exc}"

    result_status = None
    try:
        result_status = resolve_result_status(action, resolved_path, started_epoch)
    except Exception:  # noqa: BLE001 - resultStatus is best-effort
        result_status = None

    with jobs_lock:
        job = jobs.get(job_id)
        if job is None:
            return
        job["state"] = "succeeded" if exit_code == 0 else "failed"
        job["exitCode"] = exit_code
        job["finishedAt"] = now_iso()
        job["finished_at_epoch"] = time.time()
        job["output"] = output[-OUTPUT_CAP_BYTES:]
        job["resultStatus"] = result_status


def validate_and_resolve(path):
    if not isinstance(path, str) or not path or len(path) > 4096 or "\x00" in path:
        return None, (400, "bad_request", "path must be a non-empty string under 4096 bytes with no NUL byte")

    real = os.path.realpath(path)

    allowed_root = None
    for root in LIBRARY_ROOTS:
        real_root = os.path.realpath(root)
        if real == real_root:
            return None, (403, "path_not_allowed", "path must be inside a library, not the library root itself")
        try:
            if os.path.commonpath([real, real_root]) == real_root:
                allowed_root = real_root
                break
        except ValueError:
            continue

    if allowed_root is None:
        return None, (403, "path_not_allowed", "path must be under /MEDIA/Eng_Movies or /MEDIA/Hin_Movies")

    if not os.path.exists(real):
        return None, (404, "path_not_found", None)

    return real, None


class Handler(BaseHTTPRequestHandler):
    server_version = "mediafix-helper"
    sys_version = ""

    def _send_json(self, status, body):
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/status":
            qs = parse_qs(parsed.query)
            path_param = qs.get("path", [None])[0]
            if not path_param:
                self._send_json(400, {"error": "bad_request", "detail": "path query param required"})
                return
            resolved, err = validate_and_resolve(path_param)
            if err is not None:
                status, error_code, detail = err
                payload = {"error": error_code}
                if detail:
                    payload["detail"] = detail
                self._send_json(status, payload)
                return

            with jobs_lock:
                sweep_jobs_locked()
                running = next(
                    ((jid, j) for jid, j in jobs.items()
                     if j["state"] == "running" and j["action"] == "fix-audio" and j["path"] == resolved),
                    None,
                )
            if running is not None:
                job_id, _job = running
                phase, pct = read_progress()
                self._send_json(200, {
                    "state": "running",
                    "jobId": job_id,
                    "progressPhase": phase,
                    "progressPercent": pct,
                })
                return

            result_status, result_at = latest_result_for_path(resolved)
            self._send_json(200, {
                "state": "idle",
                "fixed": result_status == "OK_FIXED",
                "lastResultStatus": result_status,
                "lastResultAt": result_at,
            })
            return

        if self.path == "/health":
            with jobs_lock:
                sweep_jobs_locked()
                running = sum(1 for j in jobs.values() if j["state"] == "running")
                audio_running = any(
                    j["state"] == "running" and j["action"] == "fix-audio" for j in jobs.values()
                )
            self._send_json(200, {
                "ok": True,
                "runningJobs": running,
                "audioJobRunning": audio_running,
                "startedAt": SERVER_STARTED_AT,
            })
            return

        if self.path.startswith("/jobs/"):
            job_id = self.path[len("/jobs/"):]
            with jobs_lock:
                sweep_jobs_locked()
                job = jobs.get(job_id)
                if job is None:
                    self._send_json(404, {"error": "unknown_job"})
                    return
                elapsed = (job.get("finished_at_epoch") or time.time()) - job["started_at_epoch"]
                self._send_json(200, {
                    "jobId": job_id,
                    "action": job["action"],
                    "path": job["path"],
                    "state": job["state"],
                    "exitCode": job.get("exitCode"),
                    "startedAt": job["startedAt"],
                    "finishedAt": job.get("finishedAt"),
                    "elapsedSeconds": int(elapsed),
                    "resultStatus": job.get("resultStatus"),
                    "output": job.get("output", ""),
                })
            return

        self._send_json(404, {"error": "not_found"})

    def do_POST(self):
        if self.path != "/jobs":
            self._send_json(404, {"error": "not_found"})
            return

        length_header = self.headers.get("Content-Length", "")
        try:
            length = int(length_header)
        except ValueError:
            self._send_json(400, {"error": "bad_request", "detail": "missing or invalid Content-Length"})
            return
        if length > MAX_BODY_BYTES:
            self._send_json(413, {"error": "payload_too_large"})
            return

        raw = self.rfile.read(length)
        try:
            body = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            self._send_json(400, {"error": "bad_request", "detail": "body must be valid JSON"})
            return

        if not isinstance(body, dict):
            self._send_json(400, {"error": "bad_request", "detail": "body must be a JSON object"})
            return

        action = body.get("action")
        path = body.get("path")

        if action not in ACTIONS:
            self._send_json(400, {"error": "bad_request", "detail": "action must be fix-audio or fix-subtitle"})
            return

        resolved, err = validate_and_resolve(path)
        if err is not None:
            status, error_code, detail = err
            payload = {"error": error_code}
            if detail:
                payload["detail"] = detail
            self._send_json(status, payload)
            return

        with jobs_lock:
            sweep_jobs_locked()
            if any_job_running_locked():
                running_id = next(jid for jid, j in jobs.items() if j["state"] == "running")
                self._send_json(409, {"error": "job_in_progress", "jobId": running_id})
                return

            job_id = str(uuid.uuid4())
            started_at = now_iso()
            jobs[job_id] = {
                "action": action,
                "path": resolved,
                "state": "running",
                "exitCode": None,
                "startedAt": started_at,
                "started_at_epoch": time.time(),
                "finishedAt": None,
                "resultStatus": None,
                "output": "",
            }

        thread = threading.Thread(target=run_job, args=(job_id, action, resolved), daemon=True)
        thread.start()

        self._send_json(202, {
            "jobId": job_id,
            "action": action,
            "path": resolved,
            "state": "running",
            "startedAt": started_at,
        })


SERVER_STARTED_AT = now_iso()

if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"mediafix-helper listening on {HOST}:{PORT}")
    server.serve_forever()
