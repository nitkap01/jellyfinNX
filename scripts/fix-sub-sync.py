#!/opt/mediafix/venv/bin/python
"""Fix Sync Sub (JTV-19): re-time a movie's English subtitles to what is actually said, automatically.

Does by itself what was done by hand for The Dyatlov Pass Incident (JTV-17) and Gonjiam (JTV-14):
1. Whisper (small, CPU) transcribes ~14 short clips spread over the film; non-English audio is translated to English.
2. Each transcribed sentence is matched to a subtitle line by its words -> "anchors" (subtitle time, how far off).
3. Anchors are grouped into sections with one shift each (a subtitle made for another cut jumps in steps; a frame-rate
   mismatch drifts slowly, so a section may also stretch). Where the shift jumps, that stretch of audio is transcribed
   in full to place the joint exactly.
4. The corrected file replaces the old one only if the check passes (most lines within a second); the old file is kept
   as <name>.before-sync-fix.bak. Otherwise nothing changes and the reason is printed.

    fix-sub-sync.py [--dry-run] [--sub FILE.srt] VIDEO
Progress lines "PROGRESS <0-100> <text>" are read by mediafix-helper / the TV remote.
"""
from __future__ import annotations

import argparse, difflib, json, os, re, shutil, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path

FFMPEG = os.environ.get("MEDIAFIX_FFMPEG", "/usr/lib/jellyfin-ffmpeg/ffmpeg")
FFPROBE = os.environ.get("MEDIAFIX_FFPROBE", "/usr/lib/jellyfin-ffmpeg/ffprobe")
MODELS = os.environ.get("MEDIAFIX_MODELS", "/opt/mediafix/models")
WORK = Path(os.environ.get("AUDIOFIX_WORK_DIR", "/var/lib/mediafix/work"))
AUTHFILE = os.environ.get("AUDIOFIX_AUTHFILE", os.path.expanduser("~/.audiofix.auth"))
JF_AUTHFILE = os.environ.get("AUDIOFIX_JELLYFIN_AUTHFILE", os.path.expanduser("~/.audiofix.jellyfin"))
SR = 16000
CLIP = 50            # seconds per sample clip
MAX_SHIFT = 900      # a match further off than this is taken as a repeated phrase, not a real anchor
SAME = 1.5           # seconds: anchors this close in shift belong to one section
DENSE_MAX = 12 * 60  # longest stretch transcribed in full around one joint


def progress(pct, text):
    print(f"PROGRESS {int(pct)} {text}", flush=True)


def say(text):
    print(text, flush=True)


# ---------------------------------------------------------------- subtitles

TIME = re.compile(r"(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)")


def secs(h, m, s, ms):
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms.ljust(3, "0")[:3]) / 1000


def fmt(v):
    v = max(0.0, v)
    ms = int(round(v * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def norm(text):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>|\{[^}]*\}|[^\w\s]", " ", text.lower())).strip()


def read_srt(path):
    raw = Path(path).read_bytes()
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    lines = []
    for block in re.split(r"\n\s*\n", text.replace("\r", "").strip()):
        rows = block.split("\n")
        k = next((i for i, r in enumerate(rows) if TIME.search(r)), None)
        if k is None:
            continue
        g = TIME.search(rows[k]).groups()
        lines.append({"start": secs(*g[:4]), "end": secs(*g[4:]), "text": "\n".join(rows[k + 1:]).strip()})
    lines.sort(key=lambda x: x["start"])
    for x in lines:
        x["norm"] = norm(x["text"])
    return lines


def write_srt(lines, shift_at, path):
    out = []
    for n, x in enumerate(lines, 1):
        d = shift_at(x["start"])
        out.append(f"{n}\n{fmt(x['start'] + d)} --> {fmt(x['end'] + d)}\n{x['text']}")
    Path(path).write_text("\n\n".join(out) + "\n", encoding="utf-8")


# ---------------------------------------------------------------- audio + Whisper

def duration(video):
    out = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video],
                         capture_output=True, text=True, check=True).stdout
    return float(out.strip())


def clip(video, start, length):
    """Mono 16 kHz samples of one stretch (seeks straight there, so only that part is read from the NAS)."""
    import numpy as np
    raw = subprocess.run([FFMPEG, "-v", "error", "-ss", f"{max(0, start):.2f}", "-t", f"{length:.2f}", "-i", video,
                          "-vn", "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768


class Ears:
    def __init__(self):
        from faster_whisper import WhisperModel
        self.model = WhisperModel("small", device="cpu", compute_type="int8", download_root=MODELS, local_files_only=True,
                                  cpu_threads=int(os.environ.get("MEDIAFIX_THREADS", "4")))
        self.task = None  # "transcribe" for English audio, "translate" otherwise

    def hear(self, video, start, length):
        audio = clip(video, start, length)
        if self.task is None:
            _, info = self.model.transcribe(audio, beam_size=1, vad_filter=True)
            self.task = "transcribe" if info.language == "en" else "translate"
            say(f"Audio language: {info.language} ({'matching words directly' if self.task == 'transcribe' else 'translated to English for matching'})")
        segs, _ = self.model.transcribe(audio, language=None if self.task == "translate" else "en", task=self.task,
                                        beam_size=1, vad_filter=True)
        return [(start + s.start, norm(s.text)) for s in segs]


def anchors_from(heard, subs, translated):
    """(subtitle time, shift) for every heard sentence that clearly matches a subtitle line (or two lines together)."""
    need = 0.55 if translated else 0.68
    out = []
    starts = [x["start"] for x in subs]
    import bisect
    for at, text in heard:
        if len(text.split()) < 3:
            continue
        lo, hi = bisect.bisect_left(starts, at - MAX_SHIFT), bisect.bisect_right(starts, at + MAX_SHIFT)
        best, best_r = None, 0.0
        for i in range(lo, hi):
            for cand in (subs[i]["norm"], subs[i]["norm"] + " " + subs[i + 1]["norm"] if i + 1 < len(subs) else None):
                if not cand:
                    continue
                r = difflib.SequenceMatcher(None, text, cand, autojunk=False).ratio()
                if r > best_r:
                    best, best_r = i, r
        if best is not None and best_r >= need:
            out.append((subs[best]["start"], at - subs[best]["start"]))
    return out


# ---------------------------------------------------------------- sections

def clean(anchors):
    """Drop lone anchors that no neighbour agrees with (a phrase said twice, a wrong match)."""
    a = sorted(set(anchors))
    keep = []
    for i, (t, d) in enumerate(a):
        near = a[max(0, i - 4):i] + a[i + 1:i + 5]
        if sum(1 for _, e in near if abs(e - d) <= SAME) >= 2:
            keep.append((t, d))
    return keep


def sections(anchors):
    """Consecutive anchors (in subtitle time) with about the same shift; a new section starts when two in a row agree on
    a different shift. Each section: dict(first, last, points)."""
    out = []
    for t, d in anchors:
        if out and abs(d - median([e for _, e in out[-1]["points"][-4:]])) <= SAME:
            out[-1]["points"].append((t, d)); out[-1]["last"] = t
            continue
        out.append({"first": t, "last": t, "points": [(t, d)]})
    # a single anchor between two sections that agree with each other was noise
    merged = []
    for s in out:
        if merged and len(s["points"]) == 1 and len(merged[-1]["points"]) > 1:
            continue
        if merged and abs(median([e for _, e in s["points"]]) - median([e for _, e in merged[-1]["points"]])) <= SAME:
            merged[-1]["points"] += s["points"]; merged[-1]["last"] = s["last"]
        else:
            merged.append(s)
    # a small group right next to a bigger one with almost the same shift is the joint area, not a section of its own
    final = []
    for s in [s for s in merged if len(s["points"]) >= 2] or merged:
        if final and min(len(s["points"]), len(final[-1]["points"])) < 4 and \
                abs(median([e for _, e in s["points"]]) - median([e for _, e in final[-1]["points"]])) <= 3:
            final[-1]["points"] += s["points"]; final[-1]["last"] = s["last"]
        else:
            final.append(s)
    return final


def median(v):
    v = sorted(v)
    n = len(v)
    return 0.0 if not n else v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2


def fit(points):
    """Shift for one section: a constant, or a slow stretch (frame-rate mismatch) when the points clearly drift."""
    ts = [t for t, _ in points]; ds = [d for _, d in points]
    c = median(ds)
    if len(points) >= 6 and max(ts) - min(ts) > 15 * 60:
        mt, md = sum(ts) / len(ts), sum(ds) / len(ds)
        var = sum((t - mt) ** 2 for t in ts)
        slope = sum((t - mt) * (d - md) for t, d in points) / var if var else 0.0
        if 0.0002 < abs(slope) < 0.005:
            lin = lambda t, a=md - slope * mt, b=slope: a + b * t
            if median([abs(d - lin(t)) for t, d in points]) < median([abs(d - c) for d in ds]) * 0.8:
                return lin
    return lambda t, c=c: c


# ---------------------------------------------------------------- writing back (same SMB path as fix-subtitles.sh)

def smb_put(local, target):
    """Upload local -> target through the NAS share the folder is mounted from (the mount itself may be read-only)."""
    folder = os.path.dirname(target)
    mnt = subprocess.run(["findmnt", "-rn", "-o", "TARGET,SOURCE", "-T", folder], capture_output=True, text=True).stdout.split()
    if len(mnt) < 2 or not mnt[1].startswith("//"):
        shutil.copyfile(local, target)  # a plain local folder
        return
    point, source = mnt[0].replace("\\x20", " "), mnt[1]
    server, share = source[2:].split("/", 1)
    rel = os.path.relpath(folder, point)
    cmd = f'put "{local}" "{os.path.basename(target)}"'
    r = subprocess.run(["smbclient", f"//{server}/{share}", "-A", AUTHFILE, "-m", "SMB3", "-D", "" if rel == "." else rel, "-c", cmd],
                       capture_output=True, text=True, timeout=120)
    if r.returncode != 0 or "NT_STATUS" in r.stdout + r.stderr:
        raise RuntimeError(f"upload failed: {(r.stdout + r.stderr).strip()[-300:]}")


def tell_jellyfin(path):
    try:
        for line in open(JF_AUTHFILE):
            parts = line.split()
            if len(parts) != 2 or line.lstrip().startswith("#"):
                continue
            req = urllib.request.Request(parts[0].rstrip("/") + "/Library/Media/Updated", method="POST",
                                         data=json.dumps({"Updates": [{"Path": path, "UpdateType": "Modified"}]}).encode(),
                                         headers={"X-Emby-Token": parts[1], "Content-Type": "application/json"})
            try:
                urllib.request.urlopen(req, timeout=5).read()
            except Exception:
                pass
    except FileNotFoundError:
        pass


# ---------------------------------------------------------------- main

def find_sub(video):
    v = Path(video)
    for cand in (v.with_suffix(".en.srt"), v.with_suffix(".eng.srt"), v.with_suffix(".srt")):
        if cand.exists():
            return str(cand)
    found = sorted(p for p in v.parent.glob("*.srt") if re.search(r"\.(en|eng|english)\.srt$", p.name, re.I))
    return str(found[0]) if found else None


def main():
    ap = argparse.ArgumentParser(description="Re-time a movie's English subtitles to the speech.")
    ap.add_argument("video")
    ap.add_argument("--sub", help="subtitle file (default: <video>.en.srt)")
    ap.add_argument("--dry-run", action="store_true", help="work it out and save the result in the work folder only")
    a = ap.parse_args()
    video = os.path.realpath(a.video)
    if not os.path.isfile(video):
        say(f"ERROR: not a video file: {video}"); return 2
    sub = a.sub or find_sub(video)
    if not sub or not os.path.isfile(sub):
        say("ERROR: no English subtitle next to the video. Use Fetch Subtitle first."); return 3
    if os.path.getsize(sub) > 5 * 1024 * 1024:  # a subtitle is a few hundred KB; never read a video by mistake
        say(f"ERROR: {os.path.basename(sub)} is too big to be a subtitle file"); return 3
    say(f"Video: {os.path.basename(video)}\nSubtitle: {os.path.basename(sub)}")
    subs = read_srt(sub)
    if len(subs) < 30:
        say(f"ERROR: the subtitle has only {len(subs)} lines; too few to sync"); return 3
    length = duration(video)
    t0 = time.time()

    progress(2, "Loading the speech model")
    ears = Ears()
    # a clip every 4 minutes (at least 14), the first near the very start: short sections (Dyatlov had one of 4 min)
    # must get a clip of their own to be seen at all
    n = max(14, int((length - 90) // 240) + 1)
    starts = [20 + i * (length - 110) / (n - 1) for i in range(n)]
    heard = []
    for i, s in enumerate(starts):
        progress(5 + 55 * i / n, f"Listening {i + 1} of {n} ({int(s // 60)} min)")
        heard += ears.hear(video, s, CLIP)
    translated = ears.task == "translate"
    anchors = clean(anchors_from(heard, subs, translated))
    if len(anchors) < 6:
        say(f"ERROR: could match only {len(anchors)} spoken lines to the subtitle - it may be for a different film or "
            "language. Nothing changed."); return 4
    secs_ = sections(anchors)
    say("First look: " + "; ".join(f"from {fmt(s['first'])[:8]} off by {median([d for _, d in s['points']]):+.1f} s" for s in secs_))

    # place every joint exactly: transcribe the stretch between the two sections in full
    for k in range(len(secs_) - 1):
        a_, b_ = secs_[k], secs_[k + 1]
        lo = a_["last"] + median([d for _, d in a_["points"]])
        hi = b_["first"] + median([d for _, d in b_["points"]])
        lo, hi = max(0, lo - 30), min(length, hi + 30)
        if hi - lo > DENSE_MAX:
            lo, hi = (lo + hi) / 2 - DENSE_MAX / 2, (lo + hi) / 2 + DENSE_MAX / 2
        progress(60 + 30 * k / max(1, len(secs_) - 1), f"Finding joint {k + 1} of {len(secs_) - 1}")
        for s in range(int(lo), int(hi), 120):
            heard += ears.hear(video, s, min(125, hi - s))
    anchors = clean(anchors_from(heard, subs, translated))
    secs_ = sections(anchors)

    # one shift function per section; the joint sits in the largest pause between the last line of one section and
    # the first line of the next
    funcs, cuts = [fit(s["points"]) for s in secs_], []
    sub_starts = [x["start"] for x in subs]
    for k in range(len(secs_) - 1):
        lo, hi = secs_[k]["last"], secs_[k + 1]["first"]
        between = [t for t in sub_starts if lo <= t <= hi]
        gaps = [(between[i + 1] - between[i], (between[i] + between[i + 1]) / 2) for i in range(len(between) - 1)]
        cuts.append(max(gaps)[1] if gaps else (lo + hi) / 2)

    def shift_at(t):
        k = sum(1 for c in cuts if t >= c)
        return funcs[k](t)

    before = [abs(d) for _, d in anchors]
    after = [abs(d - shift_at(t)) for t, d in anchors]
    good_before = sum(x <= 1.0 for x in before) / len(before)
    good_after = sum(x <= 1.0 for x in after) / len(after)
    say(f"Sections: " + "; ".join(f"from {fmt(c if i else 0)[:8]} shift {funcs[i](c if i else 0):+.1f} s"
                                   for i, c in enumerate([0] + cuts)))
    say(f"Lines within 1 s of the speech: before {good_before:.0%}, after {good_after:.0%} ({len(anchors)} lines checked, "
        f"median error after {median(after):.2f} s)")

    if good_before >= 0.8 and median(before) < 0.5:
        progress(100, "Already in sync"); say("RESULT: already in sync - nothing changed."); return 0
    if good_after < 0.6 or median(after) > 1.0 or good_after <= good_before:
        progress(100, "Could not sync safely")
        say("RESULT: could not find a reliable timing - the subtitle may be for a different version. Nothing changed."); return 5

    WORK.mkdir(parents=True, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="subsync-", dir=WORK)
    fixed = os.path.join(tmp, os.path.basename(sub))
    write_srt(subs, shift_at, fixed)
    if a.dry_run:
        progress(100, "Done (dry run)"); say(f"RESULT: dry run - corrected file saved as {fixed} (the real one is unchanged)"); return 0

    progress(94, "Saving")
    backup = sub + ".before-sync-fix.bak"
    if os.path.exists(backup):
        backup = sub + time.strftime(".before-sync-fix-%Y%m%d-%H%M.bak")
    keep = os.path.join(tmp, "original.srt")
    shutil.copyfile(sub, keep)
    smb_put(keep, backup)
    smb_put(fixed, sub)
    time.sleep(1)
    if Path(sub).read_bytes() != Path(fixed).read_bytes():
        say("ERROR: the saved subtitle does not read back the same - check the file"); return 6
    shutil.rmtree(tmp, ignore_errors=True)
    tell_jellyfin(sub)
    progress(100, "Subtitles synced")
    say(f"RESULT: synced in {int(time.time() - t0)} s. Old file kept as {os.path.basename(backup)}. "
        "On the TV: turn subtitles off and on again (or restart the film) to load the new timing.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except subprocess.CalledProcessError as e:
        say(f"ERROR: {e.cmd[0]} failed: {(e.stderr or b'')[-300:].decode(errors='replace') if isinstance(e.stderr, bytes) else e.stderr}")
        sys.exit(7)
