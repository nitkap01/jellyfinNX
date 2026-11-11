# JellyfinFlix iOS: test matrix

This matrix comes from Apple's and Jellyfin's documentation:
- **Apple:** AVFoundation formats, HLS authoring spec (HEVC needs fMP4 + `hvc1`), App Transport Security, Local Network privacy, background audio (`UIBackgroundModes`), free provisioning (7-day profiles, 3 apps, 10 App IDs a week), Developer Mode on iOS 16+.
- **Jellyfin 10.10 API:** PlaybackInfo + DeviceProfile, HLS transcoding, `/Sessions/Playing*` reports, `/MediaSegments`, token logout.

Status legend:
- **PASS-INDIE**: tested automatically on INDIE against the real server with the hidden test user.
- **PHONE**: needs the real iPhone.
- **TODO**: not built yet.

## Network and server

| # | Scenario | How | Status |
|---|---|---|---|
| N1 | Home Wi-Fi, main address `jellyfin.home` | phone at home | PHONE |
| N2 | Away, Tailscale on mobile data, `jellyfin.home` (split DNS) | phone on 4G/5G, Tailscale on | PHONE |
| N3 | Main address fails, backup used by itself | `testServerFallbackWhenMainAddressFails` | PASS-INDIE (3.5 s) |
| N4 | Server unreachable (Tailscale off, away) | both addresses fail, clear message within 10 s, Try again / Change server | PASS-INDIE (logic) + PHONE (screen) |
| N5 | Leave home Wi-Fi mid-session, app comes back | `cameBack()` finds the working address again | PHONE |
| N6 | iOS "Local Network" permission prompt on first run | answer Allow; check that Deny shows the unreachable message | PHONE |
| N7 | Plain http allowed (ATS exception in Info.plist) | first load over http | PHONE |
| N8 | Mobile-data quality cap (default 8 Mbps) applied | Settings, then play on 4G and look at the server's dashboard | PHONE |

## Sign-in and profiles

| # | Scenario | How | Status |
|---|---|---|---|
| A1 | Right password, login remembered (Keychain) | `testWrongPasswordAndSignOut` + phone relaunch | PASS-INDIE (API) / PHONE |
| A2 | Wrong password shows "Wrong password" | `testWrongPasswordAndSignOut` | PASS-INDIE |
| A3 | Token expired/revoked: app returns to profiles with "Signed out" | `testWrongPasswordAndSignOut` (stale token gives 401 and the callback fires) | PASS-INDIE (logic) / PHONE (screen) |
| A4 | Hidden users never listed | `iphonetest` absent from `/Users/Public` | PASS-INDIE |
| A5 | Edit removes a saved login; Sign out ends the server session | phone | PHONE |
| A6 | Non-admin profile: no Fix Audio / Fetch Subtitle | `testMediaFixHelperStatusReadOnly` (`canFix=false`) | PASS-INDIE |

## Browse, details, search

| # | Scenario | How | Status |
|---|---|---|---|
| B1 | Every row of Home/Shows/Movies/My List loads | `testRowsSearchDetails` | PASS-INDIE |
| B2 | Billboard: Resume · Xm left / Start Over / Info follows top Continue Watching | `FormatTests` + phone | PASS-INDIE (text) / PHONE |
| B3 | Show: seasons, episodes, Up next, next episode after S1E1 | `testRowsSearchDetails` | PASS-INDIE |
| B4 | My List on/off returns to the starting state | `testMyListToggleRestores` | PASS-INDIE |
| B5 | Search "indiana" and "the" (films first) | `testRowsSearchDetails` | PASS-INDIE |
| B6 | Images load with no login | `testRowsSearchDetails` | PASS-INDIE |
| B7 | Fix Audio status chip (Death Race = Audio fixed) | `testMediaFixHelperStatusReadOnly` | PASS-INDIE |
| B8 | Fix Audio / Fetch Subtitle run end to end (admin) | only with the owner's OK; it changes files on the NAS | PHONE (owner) |
| B9 | Pull to refresh; rows refresh after watching | phone | PHONE |

## Playback (codec paths)

| # | File | Expected | Status |
|---|---|---|---|
| P1 | mp4 H.264 + AAC | DirectPlay | PASS-INDIE (server decision + URL answers) / PHONE (picture) |
| P2 | mov H.264 + AAC | DirectPlay | PASS-INDIE / PHONE |
| P3 | mp4 HEVC `hev1` | server HLS (VideoCodecTagNotSupported) | PASS-INDIE / PHONE |
| P4 | mkv HEVC SDR + PGS + SRT | HLS remux, video copied | PASS-INDIE (IsVideoDirect=true) / PHONE |
| P5 | mkv HEVC HDR10 | HLS remux; HDR shows on phone | PASS-INDIE / PHONE |
| P6 | mkv HEVC Dolby Vision + TrueHD | HLS remux video, audio to AAC | PASS-INDIE / PHONE |
| P7 | mkv H.264 + ASS | HLS remux | PASS-INDIE / PHONE |
| P8 | avi Xvid + MP3 | full transcode | PASS-INDIE / PHONE |
| P9 | MPEG-2 + 2x AC3 + DVD subs | full transcode | PASS-INDIE / PHONE |
| P10 | Direct play fails on the phone, retried through the server | `playbackFailed` path | PHONE |
| P11 | Transcode stopped on close (CPU freed on CT 105) | `DELETE /Videos/ActiveEncodings` | PASS-INDIE (call) / PHONE |

## Tracks and subtitles

| # | Scenario | Status |
|---|---|---|
| T1 | Multi-audio (Love Actually: EAC3/TrueHD/AC3): choice reaches the server with MediaSourceId | PASS-INDIE |
| T2 | Audio switch in a direct-played mp4 (inside the file, no restart) | PHONE |
| T3 | External / embedded text subtitle as WebVTT, drawn by the app | PASS-INDIE (cues parsed) / PHONE |
| T4 | Picture subtitle (PGS) burned in only when chosen; Off removes it | PASS-INDIE (server URL) / PHONE |
| T5 | First subtitle pull from a big MKV takes more than 60 s; app waits up to 180 s | found on INDIE / PHONE |

## Player behaviour

| # | Scenario | Status |
|---|---|---|
| R1 | Resume at the saved point; Start Over from 0 | PHONE |
| R2 | Progress reports start / every 10 s / pause / seek / stop; Continue Watching updated; undone | PASS-INDIE (`testProgressReportingAndUndo`) |
| R3 | Next-episode card at the Outro or 30 s before the end; 10 s countdown; Keep watching; autoplay off in Settings | PASS-INDIE (timing) / PHONE |
| R4 | Pause clock: time + "Ends at", refreshed every 15 s | PASS-INDIE (text) / PHONE |
| R5 | Skip Intro / Recap from MediaSegments | PASS-INDIE (logic) / PHONE |
| R6 | Rotation: browsing upright, player sideways, back upright on close | PHONE |
| R7 | Lock screen / app in background: pauses and saves position; lock-screen play/pause/skip | PHONE |
| R8 | AirPlay to a TV | PHONE |
| R9 | Episodes panel: switch episode; old one reports stop | PHONE |
| R10 | Phone call / Siri interrupts audio | PHONE |

## Install

| # | Scenario | Status |
|---|---|---|
| I1 | xtool SDK + build `.ipa` | waiting for the Darwin SDK (Xcode.xip) |
| I2 | First install over cable, Developer Mode, trust the profile | PHONE (owner) |
| I3 | Re-install over Wi-Fi from the Mac (7-day expiry) | PHONE (owner OK first) |
