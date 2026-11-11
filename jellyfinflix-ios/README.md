# JellyfinFlix for iPhone

The phone version of **JellyfinFlix**, the Netflix-style Jellyfin app on the Samsung TV
([`../jellyfinflix`](../jellyfinflix)). Native SwiftUI app, built as a Swift package with
[xtool](https://github.com/xtool-org/xtool) (no Xcode project). Tasking: **JTV-28**.

- Same look as the TV: near-black, red accent, white rounded buttons.
- Upright for browsing, sideways for watching.
- Home server only, at home or away from home over **Tailscale**.

## What it does

| Area | What you get |
|---|---|
| Profiles | "Who's watching?" with the server's profiles. You type the password once, then the iPhone remembers the login in the Keychain. Edit removes a saved login. |
| Server | Main address `http://jellyfin.home` and backup `http://192.168.0.154:8097`. The app tries them in order (Settings → Server address). Both work over Tailscale: split DNS for `.home` and the subnet route `192.168.0.0/24` (NET-17). |
| Home / Shows / Movies | A billboard showing the top Continue Watching title (**Resume · Xm left / Start Over / Info**), then Continue Watching, Next Up, My List, Recently Added per library, Top Rated and genre rows. These are the same rows as the TV. Long-press a card for Play, Start Over, My List and Watched. |
| Details | Play/Resume, a time-left bar, Start Over, My List, Watched and **More**. More holds Fix Audio and Fetch Subtitle (admin profiles only, files under `/MEDIA/`, the same mediafix helper the TV uses), with Audio fixed / Fixing N% / failed chips. It also has a details block: genres, cast, director, audio tracks and subtitles. Shows have a season picker and episodes with progress. |
| Search | Results appear as you type. Films and shows come first, then episodes, using the same two-query rule as the TV. |
| Player | Uses AVPlayer. If a file can't be played directly, it retries once through the server. You can pick audio and subtitles. Text subtitles are drawn by the app. Picture subtitles are burned in by the server, only when chosen. Other features: Skip Intro/Recap, a next-episode card (**Play now · 10** countdown / **Keep watching**), an Episodes panel, and a pause clock (**time + Ends at**). Double-tap left or right skips 10 s. Pinch or the button switches between Fill and Fit. AirPlay works. Lock-screen controls work. Progress is reported to Jellyfin (start, every 10 s, pause, seek, stop). |
| Quality | You can set separate caps for Wi-Fi and for mobile data (Settings). |

There are no offline downloads. The owner decided that (JTV-L0041).

## How a file plays (iPhone device profile, checked against the real server)

| File | What happens |
|---|---|
| mp4 / mov with H.264, AAC, AC3 or EAC3 | Plays the file directly |
| mp4 with HEVC tagged `hev1` | The server repackages it into HLS. iOS only plays `hvc1`/`dvh1` directly. |
| mkv with H.264 or HEVC (SDR, HDR10, Dolby Vision) | The server repackages it into fMP4 HLS. The picture is copied, not re-encoded. TrueHD/DTS audio is turned into AAC. |
| avi (Xvid), MPEG-2, VC-1 … | The server converts it (full transcode) |

See `Tests/JFKitTests/LiveServerTests.swift` (`testPlaybackDecisionsForEveryKindOfFile`, `testRemuxCopiesVideo`).

## Layout

```
Package.swift          SwiftPM: JFKit (logic) + JellyfinFlix (SwiftUI app, the one library product xtool packs)
xtool.yml              bundle id com.nitkap01.jellyfinflix, Info.plist, icon
Resources/Info.plist   plain-http server allowed (ATS), local network text, background audio, orientations
Sources/JFKit/         Jellyfin client, rows, device profile, playback/report rules, VTT, mediafix helper (Foundation only)
Sources/JellyfinFlix/  App, AppModel (servers, logins, settings), Profiles, Browse, Details, Search, Player
Tests/JFKitTests/      unit tests (run anywhere) + LiveServerTests (real Jellyfin, hidden test user)
design/                phone-mockups.html (9 screens; preview PNGs are local only: they hold real film artwork)
scripts/               build-ipa.sh (INDIE or Mac), mac-install.sh + launchd plist (weekly re-install from the Mac)
```

## Build

On INDIE: Swift 6.4.1 is in `~/tools/swift` and the xtool 1.24.0 launcher is in `~/.local/bin/xtool`.

```bash
cd jellyfinflix-ios
export PATH=~/tools/swift/usr/bin:$PATH
swift test --filter 'FormatTests|PlaybackTests|MiscTests'               # logic, no server needed
JF_LIVE_CONFIG=~/.secrets/jellyfin_iphonetest.txt swift test --filter LiveServerTests   # real server, test user
scripts/build-ipa.sh                                                     # needs the Darwin SDK (below)
```

**Darwin SDK (one time).** xtool needs Apple's iOS SDK, taken from Xcode. Use one of these:
- `xtool sdk install ~/Downloads/Xcode_27.1.xip` (download from developer.apple.com with any Apple ID), or
- `xtool sdk build /Applications/Xcode.app out/` on a Mac that has Xcode, then `xtool sdk install out/darwin.xtoolsdk` on INDIE.

## Install on the iPhone (free Apple ID)

1. On the Mac: `brew install xtool-org/tap/xtool`, then `xtool auth login` (Apple ID + password + 2FA code, typed by the owner).
2. Plug the iPhone in once and tap **Trust**. Then turn on **Settings → Privacy & Security → Developer Mode** and restart.
3. `xtool install dist/JellyfinFlix.ipa`. On the iPhone: **Settings → General → VPN & Device Management → trust your Apple ID**.
4. Free Apple ID apps stop opening after **7 days**. `scripts/mac-install.sh` re-installs over Wi-Fi. The launchd job runs it every 6 days. Only turn it on after the owner's OK.

## Testing

See [TESTING.md](TESTING.md) for the full matrix. It shows what has been tested on INDIE and what needs the phone.
