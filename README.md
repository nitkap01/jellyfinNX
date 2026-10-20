# JellyfinNX

A personal, LAN-only customization of Jellyfin's web client and Samsung Tizen TV app,
built to fix a real problem — English movies where dialogue got buried under loud
music/effects, with no easy way to fix it from the couch — and to make a few other
day-to-day improvements along the way.

This repo is a **reference snapshot** of that work: the customized web client, the
customized TV app, and the two pieces of server-side tooling that make the in-app
"Fix Audio" / "Fetch Subtitle" buttons actually do something.

## The problem this solves

Some movies (older rips especially) have a very wide dynamic range — quiet dialogue,
then explosively loud music/effects — or ship with 5.1 audio downmixed badly for a
TV's stereo speakers. Turning the TV up enough to hear dialogue means getting blasted
during action scenes. Re-encoding the audio (loudness-normalizing it, or downmixing it
properly) fixes this, but doing it by hand over SSH for every movie isn't something
you want to do from a couch with a remote.

This project adds a **"Fix Audio" button directly in Jellyfin's own UI** — on the web
client and on a Samsung TV — that runs the fix, shows live progress, and updates the
library when it's done. A matching **"Fetch Subtitle"** button does the same for
missing English subtitles.

## What's in this repo

| Path | What it is |
|---|---|
| [`jellyfin-web/`](jellyfin-web/) | A fork of [jellyfin/jellyfin-web](https://github.com/jellyfin/jellyfin-web) (v10.10.7) with the custom actions and player fixes below added. Used both as the browser/mobile web client and as the source build for the TV app. |
| [`jellyfinnx-tizen/`](jellyfinnx-tizen/) | A fork of [jellyfin/jellyfin-tizen](https://github.com/jellyfin/jellyfin-tizen), rebranded as **JellyfinNX** so it installs on a Samsung TV *alongside* the official Jellyfin app rather than replacing it. Builds `jellyfin-web/` into a signed `.wgt` for sideloading. |
| [`scripts/`](scripts/) | The two server-side scripts the buttons actually run: `fix-movie-audio.sh` (loudness-normalize and/or downmix, with full backup/verify/rollback safety) and `fix-subtitles.sh` (fetch an English subtitle via [subliminal](https://github.com/Diaoul/subliminal)). Also usable directly from the command line. |
| [`mediafix-helper/`](mediafix-helper/) | A small stdlib-only Python HTTP service that the web/TV client calls to start a job, poll its progress, and check whether a given file has already been fixed. It's the only thing standing between "click a button in Jellyfin" and "a shell script runs on the server." |

## What was actually changed in `jellyfin-web`

- **Context menu**: "Fetch Subtitle" and "Fix Audio" entries on movies and TV
  episodes (admin-only), next to the existing "Edit subtitles" action.
- **Item detail page**: an "Audio Fix" row (Yes/No) below the Video/Audio/Subtitles
  info, which turns into a live progress bar while a fix is running - reflects the
  real state even if you didn't start the job from that screen or that device.
- **TV playback**: Left/Right on the remote now seeks the video directly
  (Netflix-style), instead of first requiring the on-screen progress bar to be
  focused. Holding the key accelerates the skip amount instead of repeating the
  same small hop.
- **JellyfinNX-only branding** (kept out of the shared web client on purpose, so the
  phone/browser experience is unaffected): app name, icon, and splash screen.

## How it fits together

```
Jellyfin item context menu ("Fix Audio" / "Fetch Subtitle")
        │  POST /jobs { action, path }
        ▼
mediafix-helper  (Python, stdlib only, LAN-only, no auth by design - see below)
        │  spawns
        ▼
scripts/fix-movie-audio.sh  or  scripts/fix-subtitles.sh
        │  writes the result back over SMB, with backup + verification
        ▼
The NAS  ──────────────────────────────────────────────────────  Jellyfin re-scans
```

The client polls `GET /jobs/{id}` for progress and `GET /status?path=...` to know
whether a given file has already been fixed, independent of who started the job.

## `fix-movie-audio.sh` — what it actually does

1. Measures the source audio (channels, loudness, dynamic range, true peak).
2. Decides: downmix 5.1→stereo, loudness-normalize, both, or nothing.
3. Re-encodes locally, verifies the result (duration, stream count, sample rate,
   true-peak ceiling) before touching anything on the NAS.
4. Uploads and swaps the file in via SMB using an upload-then-two-renames sequence,
   with a crash-recovery journal at every step.
5. Only once the swap is verified does it delete the original - so a failure at any
   point before that leaves the real movie file completely untouched.

Run it directly: `fix-movie-audio.sh [--dry-run] [--lra-threshold N] <movie-file>`
(no path given opens an `fzf` picker over the configured library roots).

## `fix-subtitles.sh` — what it does

Runs `subliminal` against a video file, saves the best-matching English subtitle next
to it as `<video name>.en.srt` (Jellyfin lists it as English), always overwriting an
existing subtitle of that name. If subliminal cannot use the real file name (e.g.
`Title 2013 aka Other SS 1080p BluRay x265 HEV.mkv` gives "0 video collected / 1 error"),
it retries with cleaned-up names: title + year from the file name, then from the folder
(`Title (2014)`), plus resolution/source/codec tags (`The.Borderlands.2013.1080p.BluRay.x265.mkv`).

Run it directly: `fix-subtitles.sh [--dry-run] <video-file>` (`--dry-run` downloads to a temp
folder only; `--names <video-file>` just prints the cleaned-up names it would try).

## Setup notes (for future reference, not a turnkey installer)

- Both scripts expect an SMB credentials file at `~/.audiofix.auth` (`username=` /
  `password=` / `domain=`, mode `600`) and a CIFS-mounted media path they can also
  reach read-only for verification.
- `mediafix-helper/helper.py` hardcodes its two library roots and the two script
  paths near the top of the file - update `LIBRARY_ROOTS` and `ACTIONS` for a
  different setup.
- The two `.service` files are the actual systemd units used to run the helper and
  a second, parallel Jellyfin instance for testing - not enabled at boot, started
  manually, since the original server this ran on had only 4GB RAM.

## Security note

This was built for a home LAN with no outside access. `mediafix-helper` deliberately
has **no authentication and a wildcard CORS policy** - a considered tradeoff for a
trusted home network, not an oversight. Don't expose it to the internet as-is.

## Credits

Built on [jellyfin/jellyfin-web](https://github.com/jellyfin/jellyfin-web) and
[jellyfin/jellyfin-tizen](https://github.com/jellyfin/jellyfin-tizen), both part of
the [Jellyfin](https://jellyfin.org) project. Subtitle fetching via
[subliminal](https://github.com/Diaoul/subliminal).
