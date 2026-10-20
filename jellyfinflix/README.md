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
- **More Info** — backdrop, year · rating · runtime · score, overview, genres/cast, minutes left,
  Play/Resume (+ Start Over), My List toggle, seasons + episodes (thumbnails, progress, watched tick)
  for series, More Like This. Admins get **Fix Audio** and **Fetch Subtitle** (same mediafix-helper
  calls and messages as JellyfinNX) and an **Audio fixed** line: green tick when fixed, live progress
  bar while a fix runs (even if started elsewhere), red note if the last fix failed. Cards of fixed
  movies/episodes show a small green tick (checked quietly in the background, cached on the TV).
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

All tests drive the real TV over the Chrome DevTools protocol (no remote needed):

```
W=$(test/tv-debug.sh)                     # launch with the inspector, prints the websocket
node test/tv-perf.mjs $W 2                # speed: launch, rows, held key, details, play, seek, back (2 runs)
node test/tv-func-nav.mjs $W <seriesId>   # rail to every screen, series seasons/episodes, My List, search, exit prompt
node test/tv-func-player.mjs $W <movieId> # play, menu, subtitles, audio, seek, pause, Continue Watching
node test/tv-func-settings.mjs $W <movieId> [<pgsMovieId>]   # quality/zoom/subtitle style+sync/burn-in
node test/tv-func-seekhold.mjs $W <movieId>                  # hold Right / FF for seconds
node test/tv-func-next.mjs $W <episodeId>                    # next-episode countdown + autoplay
node test/desktop-shots.mjs /tmp/shots 'wait:3000;keys:Down;shot:home'   # screenshots in desktop Chromium
```
`tv-trace.mjs`, `tv-layers.mjs`, `css-exp.mjs`, `bg-exp.sh` are the profiling tools used to find the slow parts.
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

Long tasks still seen: the TV player's own `seekTo` (~0.3 s) and shutting the player down after Back
(0.2–0.3 s) — both run after the screen has already changed.

## Known limits

- Playback speed: Samsung AVPlay's `setSpeed` is only fast-forward trick play (no sound), so speed choices are
  only offered on the HTML5 fallback; the panel says so.
- Skip Intro needs Jellyfin media segments (an intro-detection plugin); the server has none yet, so the button
  never shows. Trickplay previews show once the server has made the pictures: trickplay is **on for all 4
  libraries** and generated by the "Generate Trickplay Images" scheduled task (`tools/trickplay.py` turns it on
  and starts the task; it reads the login from `~/.secrets` at run time).
- Picture subtitles (PGS/VobSub) are burned in by the server (a transcode); text subtitles are drawn by the app.
- The first time an external/extracted subtitle is used the server may need time to extract it; embedded text
  subtitles are read by AVPlay directly.
- Audio-fixed ticks are checked one card at a time in the background (the helper has no bulk endpoint).
- Libraries considered: spatial-navigation libraries (@bbc/tv-lrud-spatial, js-spatial-navigation, norigin) — not
  used, our own row/column focus code is simpler and never reads layout on a key press; Shaka Player — not
  needed, AVPlay plays HLS itself. Phase 2 idea if the DOM ever becomes the limit: LightningJS/Blits (WebGL).
