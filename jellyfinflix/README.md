# JellyfinFlix

A fast Jellyfin app for the Samsung TV (UA55AU7600, Tizen 6, Chrome 76) that looks and behaves like
Netflix on a TV, on our own Jellyfin server. It installs **next to** JellyfinNX (own app id
`JFlixPkg01.JellyfinFlix`, name "JellyfinFlix", own icon); JellyfinNX is not changed.

No Netflix code, logos, fonts, images or sounds are used — only the layout and behaviour patterns,
in our own code and design (`design/samples.html` is the approved look). The accent colour is one
CSS variable (`--acc` in `src/style.css`, Cinema red `#e50914` today).

## What it does

- **Who's watching** — Jellyfin users (public users + logins remembered on the TV). The last
  profile is remembered, so normally the app opens straight on Home. Password entry with an
  on-screen keyboard. "Change server" tile. Red/Blue key on a saved profile = forget it on this TV.
- **Left rail** — Profile, Search, Home, Shows, Movies, My List; icons only, labels slide in when focused.
- **Home / Shows / Movies** — billboard (backdrop, logo or title, facts, overview, Play + More Info),
  then rows: Continue Watching (red progress bars), Next Up, My List, Recently Added per library
  (posters), Top Rated, genres. The billboard follows the focused card. Focus stays at the left and
  the row slides; each row remembers its position. Rows load in parallel and are cached on the TV,
  so the next launch paints the first row at once and refreshes in the background.
- **My List** — Jellyfin favourites as a grid. **Search** — 6-column letter grid, results update while typing
  (movies and shows first, then episodes).
- **More Info** — kept calm: logo/title, S·E line, one meta line (year · rating · runtime · score), the
  overview (3 lines), minutes left, and one row of pill buttons: **Resume/Play, Start Over, My List, More**;
  then seasons + episodes (thumbnails, progress, watched tick; another season starts at its episode 1) and
  More Like This. A small green **Audio fixed** chip sits next to the meta line (amber "Fixing audio N%" while
  a fix runs, even one started elsewhere). **More** (three-dots icon) opens a small popup above the button:
  **Fix Audio** (badge: Audio fixed / Running N% with a bar / Failed) and **Fetch Subtitle** for admins (same
  mediafix-helper calls and messages as JellyfinNX), and a Details block (genres, cast, director, studio,
  subtitles, the reason of a failed fix). Back/Left/Right closes it. Cards of fixed movies/episodes show a
  small green tick (checked quietly in the background, cached on the TV).
- **Player** (Samsung AVPlay, not the HTML5 video element):
  - direct play of the file (`/Videos/{id}/stream?static=true…`); if the TV can't play it (e.g. TrueHD/DTS
    audio) the server's HLS transcode is played in AVPlay; HTML5 video only as a last fallback/desktop testing;
  - **warm start**: while More Info is open the player is already prepared at the resume point, so Play
    starts in ~0.15 s;
  - controls appear on any key and fade after 3.5 s; Left/Right seek 10 s, holding speeds up
    (10 → 20 → 40 → 80 s… every 0.5 s, max 2 % of the runtime, 1–5 min), the bar and time move on every press,
    one real seek 0.4 s after you let go; FF/RW/Play/Pause/Stop media keys; trickplay preview pictures
    while seeking when the server has them;
  - **Audio & Subtitles / settings panel**: audio track, subtitles (Off, embedded, external; picture
    subtitles such as PGS are burned in by the server), subtitle size/position/background, subtitle sync
    (±2 s), quality (Original/direct play, 1080p, 720p, 480p, 360p → server transcode, keeps the position),
    zoom (fit, fill, stretch, original), next-episode autoplay on/off, repeat, playback info (direct play or
    transcode and why, codecs, resolution, bitrates), Fix Audio / Fetch Subtitle with the fixed badge;
  - **Episodes panel** (episodes only, button next to Next Episode): seasons on the left, the season's episodes on the
    right (thumbnail, number + title, runtime or minutes left, watched tick, progress, overview of the focused one,
    "Now playing" on the current one) over the still-playing video; OK on another episode switches to it (resumes if
    half-watched), Back closes it without a restart. Its data is fetched in the background when an episode starts;
  - Skip Intro when Jellyfin has intro segments; "Next episode" card with a 10 s countdown near the end;
  - resume from the last position; start/progress/stop are reported to Jellyfin so Continue Watching is right.
- **Back** closes the top layer (menu → player → details), then goes to Home, then scrolls Home to the top,
  then asks "Exit JellyfinFlix?".

## Build and install

```
cd jellyfinflix
./build.sh                 # bundle (esbuild, chrome76) + sign -> JellyfinFlix.wgt
./build.sh --install       # … and install on the TV 192.168.0.236 (Developer Mode on, host = this PC)
./build.sh --install <ip>  # another TV
./build.sh --dev           # unminified bundle in dist/ only (can be opened in a desktop browser)
```

Needs node + `npm i` here (esbuild), the Tizen Studio CLI in `~/tizen-studio`, and the same author
certificate and signer as JellyfinNX (`../.tools/sign-wgt.js`, passwords in `~/.tizen-secrets/cert.env`,
never in git). On the TV: Apps → JellyfinFlix.

Code layout: `src/main.js` (start-up), `app.js` (screens/overlays and the key handler), `ui/rows.js`
(rows engine: only cards near the focus exist, one floating focus card), `screens/` (profiles, browse,
details, search, text entry), `player/` (AVPlay/HTML5 engines, device profile, player + settings),
`mediafix.js` (Fix Audio/Fetch Subtitle), `data.js` (which rows each screen shows), `style.css`.

## Testing on the TV

All tests drive the real TV over the Chrome DevTools protocol (no remote needed). Keys are sent like the real
Samsung remote sends them: plain keydowns, and a held key is plain keydowns every ~100 ms then one keyup (the
remote sets no repeat flag; the app's own hold detection is in `src/keys.js` and the player). Shared helpers: `test/lib.mjs`.

```
W=$(test/tv-debug.sh)                     # launch with the inspector, prints the websocket
node test/tv-perf.mjs $W 2                # speed: launch, rows, held key, details, play, seek, back (2 runs)
node test/tv-func-nav.mjs $W <seriesId>   # rail to every screen, series seasons/episodes, My List, search, exit prompt
node test/tv-func-player.mjs $W <movieId> # play, menu, subtitles, audio, seek, pause, Continue Watching
node test/tv-func-settings.mjs $W <movieId> [<pgsMovieId>]   # quality/zoom/subtitle style+sync/burn-in
node test/tv-func-seekhold.mjs $W <movieId>                  # hold Right / FF for seconds
node test/tv-func-next.mjs $W <episodeId>                    # next-episode countdown + autoplay
node test/tv-func-episodes.mjs $W <episodeId>                # Episodes panel: open, moves, seasons, Back, switch episode
node test/tv-func-qa.mjs $W [launch,billboard,rows,details,search]   # 83 PASS/FAIL checks: screens, billboard, rows, details + More menu, search
node test/tv-func-avstress.mjs $W [rounds] [ids]             # fast subtitle/audio changes, also during restarts, on 4 tricky files
node test/tv-func-taps.mjs $W <movieId>                      # 10 s taps (Left/Right/FF/RW), pause/play keys, Back focus, Continue Watching
node test/desktop-shots.mjs /tmp/shots 'wait:3000;keys:Down;shot:home'   # screenshots in desktop Chromium
```
`tv-trace.mjs`, `tv-layers.mjs`, `css-exp.mjs`, `bg-exp.sh` are the profiling tools used to find the slow parts.
Test data: `python3 tools/testdata.py snapall /tmp/before.json` before a round and `restore /tmp/before.json` after
puts back resume points, watched and My List (and the Continue Watching order); `diff` shows what a round changed.
Fix Audio / Fetch Subtitle are never run by the tests: `tv-func-qa` wraps the page's fetch so the helper call is only recorded.
Test hooks in the page: `__jfReset()`, `__jfOpen(id)`, `__jfPlayer()`, `__jfSeek(ms)`, `__jf.marks`.

### Results on the TV (20 Oct 2026, two runs each)

| | JellyfinNX (after quick fixes) | JellyfinFlix |
|---|---|---|
| Launch → first row of posters on screen | 2.4 s (posters 4.4–4.7 s) | 0.12–0.16 s (cached rows) |
| Remote press inside a row (20 presses each way) | small freezes | 0 long tasks, key → screen 16–23 ms avg |
| Up/down between rows (20 presses) | small freezes | 0–3 long tasks (≤ 60 ms), key → screen 36–40 ms avg |
| Holding Right 2 s (auto-repeat) | — | 1–2 long tasks (60–125 ms), 29 moves, no queued moves |
| Holding Right 5 s in the player | — | ~36 min travelled in steps up to 12×, key → screen 7 ms avg |
| More Info open | 1.8 s | 0.055–0.095 s |
| Play → first frame | 2.9 s | 0.14–0.20 s (warm start) / 1.0–1.2 s (cold) |
| Seek press → bar/time update | — | 17–34 ms; video plays again 0.75–0.93 s after the last press |
| Back from player / details → screen | — | 40–72 ms / 40–51 ms |
| Menu (Audio & Subtitles) open | — | 20–35 ms |
| Episodes panel open / move / Back | — | 40–75 ms (first open after app start 70–170 ms) / 21–25 ms avg (0 long tasks) / 27–49 ms |
| Episodes panel: other season (cached / first time) · switch episode → first frame | — | 49–106 ms / 89–426 ms · 1.1–1.85 s |

Long tasks still seen: the TV player's own `seekTo` (~0.3 s) and shutting the player down after Back
(0.2–0.3 s) — both run after the screen has already changed.

Re-measured in the final QA round (20 Oct, after the More menu, held-key and player fixes; plain key presses):
launch (page reload) → first row 163–264 ms, cold app start: JS start → first row 103–178 ms; row presses 16–24 ms avg,
0 long tasks; rows up/down 36–39 ms avg; holding Right 2 s = 21 moves for 21 presses, 0 long tasks; More Info open
56–71 ms (series 56–97 ms); More menu open 37 ms; Play → first frame 0.11–0.19 s warm / 1.27 s cold (Play key on a
card); seek press → bar 13–29 ms avg, video again 0.78–0.88 s; Back from player / details 36–39 ms / 40–45 ms;
Audio & Subtitles menu 18 ms; Episodes panel open 71–101 ms, switch episode → first frame 1.45 s.

## Known limits

- Playback speed: Samsung AVPlay's `setSpeed` is only fast-forward trick play (no sound), so speed choices are
  only offered on the HTML5 fallback; the panel says so.
- Skip Intro needs Jellyfin media segments (an intro-detection plugin); the server has none yet, so the button
  never shows. Trickplay previews show once the server has made the pictures: trickplay is **on for all 4
  libraries** and generated by the "Generate Trickplay Images" scheduled task (`tools/trickplay.py` turns it on
  and starts the task; it reads the login from `~/.secrets` at run time).
- Seeking lands on the file's nearest keyframe (AVPlay), so a 10 s tap can end a few seconds off; the bar itself always
  moves exactly 10 s per tap.
- Audio tracks the TV cannot decode (TrueHD, DTS) are left out of AVPlay's track list; picking one plays through the
  server (audio converted). Picking a playable track then goes back to direct play.
- Picture subtitles (PGS/VobSub) are burned in by the server (a transcode); text subtitles are drawn by the app.
- The first time an external/extracted subtitle is used the server may need time to extract it; embedded text
  subtitles are read by AVPlay directly.
- Audio-fixed ticks are checked one card at a time in the background (the helper has no bulk endpoint).
- Libraries considered: spatial-navigation libraries (@bbc/tv-lrud-spatial, js-spatial-navigation, norigin) — not
  used, our own row/column focus code is simpler and never reads layout on a key press; Shaka Player — not
  needed, AVPlay plays HLS itself. Phase 2 idea if the DOM ever becomes the limit: LightningJS/Blits (WebGL).

## Logs (detailed until 27 Oct 2026, errors only after that)
- `src/log.js` keeps a log on the TV (survives crashes) and uploads it to the Jellyfin server (Dashboard → Logs, files `upload_JellyfinFlix_*`): at start, every 5 min, a few seconds after any error, when the app is hidden and on exit.
- Logged: app start/exit, screens, play/open source (method, container, codecs, direct or HLS), AVPlay events/errors/buffering, audio/subtitle/quality changes and how they were applied, restarts (queued so two never run at once) with timings, playback failures, API errors, JS errors and unhandled promises. Passwords/tokens are masked.
- A launch after a crash adds "previous session ended unexpectedly" with that session's last steps.
- Read on INDIE: `python3 tools/getlogs.py` (list), `python3 tools/getlogs.py last 3` (print newest 3). The detail period ends at `FULL_UNTIL` in `src/log.js`.
