# AGENTS.md — JellyfinFlix iOS (JTV-28)

Notes for agents working on the iPhone app. Read the README first.

## Rules
- Tasking task **JTV-28**. Log each step. Owner decisions are in the JTV ledger, JTV-L0038..L0042:
  - free Apple ID (re-install every 7 days)
  - Tailscale away from home
  - no downloads
  - the Mac cable is used later
- Nothing goes on the owner's iPhone until he OKs the designs/app. No launchd job on the Mac without his OK.
- Public repo: no tokens, passwords or `.secrets` contents in code or tests. Live tests read `JF_LIVE_CONFIG`, a file outside the repo.
- Never test with the owner's profiles (`admin`, `nitin`). Use the hidden user **iphonetest**: not admin, IsHidden, password in `~/.secrets/jellyfin_iphonetest.txt`. Undo any progress the tests leave behind; `testProgressReportingAndUndo` does this itself.
- Keep behaviour in step with the TV app (`../jellyfinflix/src`):
  - rows (`data.js`)
  - PlaybackInfo with MediaSourceId on any track choice (`player/pinfo.js`, JTV-11)
  - next-episode timing: Outro segment, else 30 s before the end
  - mediafix wording (`mediafix.js`)
  - billboard buttons
- Commits as `git -c user.name="Nitin Kapoor" -c user.email=officialnitinkapoor@gmail.com commit`, no Co-Authored-By. Push after every change.

## Build facts
- `JFKit` is Foundation-only, so it builds and tests on Linux.
- `JellyfinFlix` (SwiftUI/AVKit) is wrapped in `#if canImport(SwiftUI) && canImport(UIKit)`. On Linux it compiles to nothing. It only really compiles with the Darwin SDK (`xtool dev build`).
- The UI target uses Swift 5 language mode; JFKit uses Swift 6.
- xtool needs exactly **one library product**. Don't add executable products; add test targets instead.
- INDIE resolves no `.home` names (it uses 8.8.8.8), so use `192.168.0.154:8097` there. The phone uses `jellyfin.home`.
- The first time a text subtitle is pulled from a big MKV, the server can take more than 60 s; after that it is cached. The player waits up to 180 s.
- The mediafix helper (`192.168.0.154:8099`) has no login and is LAN-only. Away from home it is reached over the Tailscale subnet route.

## Not done yet / ideas
- Picture in Picture.
- A trickplay thumbnail while scrubbing.
- An "Up next" queue across shows.
- Downloads (the owner said no for now).
