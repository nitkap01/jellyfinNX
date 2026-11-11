// Runs against the real home Jellyfin with the hidden test user "iphonetest" (never the owner's profiles).
// Skipped unless JF_LIVE_CONFIG points at a file with lines "server: ...", "user: ...", "pass: ..." (kept outside the repo).
// Run: JF_LIVE_CONFIG=~/.secrets/jellyfin_iphonetest.txt swift test --filter LiveServerTests
import XCTest
@testable import JFKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class LiveServerTests: XCTestCase {
    struct Cfg { var server: String; var user: String; var pass: String }
    static let deviceId = "jfx-ios-livetest"

    // One file per kind of stream (found by a library survey; ids are not secret).
    static let samples: [(id: String, what: String)] = [
        ("0042e7b099cc12cc0e6cdf8db0b76d93", "mp4 H.264 + AAC"),
        ("55e50602cca671588b23a5aa9918f1c7", "mov H.264 + AAC"),
        ("680489a2b2abf053763bf702b3a60b7d", "mp4 HEVC tagged hev1"),
        ("00433a7b829b469ac4126368a65ce695", "mkv HEVC SDR + PGS + SRT"),
        ("024056d70967a451ebd10fe5531cd87b", "mkv HEVC HDR10 + PGS"),
        ("138a33a983cebc7e94bc70e6882a21ea", "mkv HEVC Dolby Vision + TrueHD"),
        ("00083be4d054ea86daa7022e1337cc16", "mkv H.264 + ASS"),
        ("0018ea0fc75adf23ba2e13246bc0d969", "avi MPEG-4 Xvid + MP3"),
        ("0e11ff27bcd23769c471a105789fb776", "mpeg MPEG-2 + 2x AC3 + DVD subs"),
        ("02adb852b13e0acf2e9d8f8dda2dd583", "Love Actually: 3 audio (EAC3/TrueHD/AC3) + PGS"),
    ]

    func cfg() throws -> Cfg {
        guard let p = ProcessInfo.processInfo.environment["JF_LIVE_CONFIG"], let s = try? String(contentsOfFile: (p as NSString).expandingTildeInPath, encoding: .utf8) else {
            throw XCTSkip("JF_LIVE_CONFIG not set")
        }
        var d: [String: String] = [:]
        for line in s.split(separator: "\n") {
            let parts = line.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            if parts.count == 2 { d[parts[0]] = parts[1] }
        }
        return Cfg(server: d["server"] ?? "", user: d["user"] ?? "", pass: d["pass"] ?? "")
    }

    func signedIn() async throws -> JellyfinClient {
        let c = try cfg()
        let client = JellyfinClient(server: ServerAddresses.normalize(c.server)!, info: ClientInfo(deviceId: Self.deviceId, device: "INDIE test"))
        _ = try await client.signIn(user: c.user, password: c.pass)
        return client
    }

    func testServerFallbackWhenMainAddressFails() async throws {
        let c = try cfg()
        // main address that cannot resolve -> backup must be used
        let r = await ServerFinder.find(ServerAddresses(main: "http://no-such-host.invalid", backup: c.server), info: ClientInfo(deviceId: Self.deviceId))
        guard case .success(let p) = r else { return XCTFail("backup not used: \(r)") }
        XCTAssertEqual(p.url, ServerAddresses.normalize(c.server))
        XCTAssertEqual(p.version?.hasPrefix("10."), true)
        // both unreachable -> clear error, quickly
        let t0 = Date()
        let bad = await ServerFinder.find(ServerAddresses(main: "http://no-such-host.invalid", backup: "http://192.0.2.1:8097"), info: ClientInfo(deviceId: Self.deviceId), timeout: 3)
        if case .success = bad { XCTFail("should fail") }
        XCTAssertLessThan(Date().timeIntervalSince(t0), 10)
    }

    func testWrongPasswordAndSignOut() async throws {
        let c = try cfg()
        let client = JellyfinClient(server: ServerAddresses.normalize(c.server)!, info: ClientInfo(deviceId: Self.deviceId))
        do { _ = try await client.signIn(user: c.user, password: "definitely-wrong"); XCTFail("signed in with a wrong password") }
        catch let e as JFError { XCTAssertEqual(e, .wrongPassword) }
        let ok = try await signedIn()
        let flag = Flag()
        ok.onSignedOut = { flag.set() }
        _ = try await ok.get(ItemsResponse.self, "/Users/{U}/Items/Resume", ["Limit": "1"])
        // token expiry / revoked: the server forgets the token -> next call reports "signed out"
        await ok.signOut()
        let stale = JellyfinClient(server: ok.server, info: ok.info, token: "0000000000000000000000000000dead", userId: "x")
        stale.onSignedOut = { flag.set() }
        do { _ = try await stale.get(ItemsResponse.self, "/Users/{U}/Items/Resume", [:]); XCTFail("stale token worked") }
        catch let e as JFError { XCTAssertEqual(e, .signedOut) }
        XCTAssertTrue(flag.isSet)
    }

    func testRowsSearchDetails() async throws {
        let c = try await signedIn()
        for tab in Tab.allCases {
            for row in Library.rows(tab, userName: "iphonetest") {
                _ = try await row.load(c) // every row loads without error (can be empty for the test user)
            }
        }
        let latest = try await Library.latestRows(c)
        XCTAssertFalse(latest.isEmpty)
        let firstLatest = try await latest[0].load(c)
        XCTAssertFalse(firstLatest.isEmpty)
        let genres = try await Library.genreRows(c, types: "Movie,Series", count: 6)
        XCTAssertFalse(genres.isEmpty)
        let s = try await Library.search(c, "indiana")
        XCTAssertTrue(s.titles.contains { $0.Name?.contains("Last Crusade") == true })
        let common = try await Library.search(c, "the")
        XCTAssertFalse(common.titles.isEmpty, "common word still returns films/shows first")
        // series details: seasons + episodes + next episode
        let show = try await Library.item(c, "c19aeb79962eb8c4fe08da74ea4a3396")
        XCTAssertEqual(show.Type, "Series")
        let seasons = try await Library.seasons(c, seriesId: show.Id)
        XCTAssertGreaterThanOrEqual(seasons.count, 8)
        let eps = try await Library.episodes(c, seriesId: show.Id, seasonId: seasons[0].Id)
        XCTAssertFalse(eps.isEmpty)
        let after = try await Library.episodeAfter(c, eps[0])
        XCTAssertEqual(after?.IndexNumber, (eps[0].IndexNumber ?? 0) + 1)
        let first = try await Library.nextEpisode(c, seriesId: show.Id)
        XCTAssertNotNil(first)
        XCTAssertNotNil(Art.url(c, Art.card(eps[0]), width: 300))
        // images load without a login
        let (d, r) = try await URLSession.shared.data(from: Art.url(c, Art.backdrop(show), width: 400)!)
        XCTAssertEqual((r as? HTTPURLResponse)?.statusCode, 200); XCTAssertGreaterThan(d.count, 1000)
    }

    func testMyListToggleRestores() async throws {
        let c = try await signedIn()
        let id = "02adb852b13e0acf2e9d8f8dda2dd583"
        let before = try await Library.item(c, id).isFavorite
        _ = try await Library.setFavourite(c, id, !before)
        let mid = try await Library.item(c, id).isFavorite
        XCTAssertEqual(mid, !before)
        _ = try await Library.setFavourite(c, id, before)
        let after = try await Library.item(c, id).isFavorite
        XCTAssertEqual(after, before)
    }

    /// Each sample: what the server decides for the iPhone profile, and that the chosen URL answers.
    func testPlaybackDecisionsForEveryKindOfFile() async throws {
        let c = try await signedIn()
        var report: [String] = []
        for s in Self.samples {
            let info = try await Playback.fetchInfo(c, itemId: s.id, PlaybackOptions())
            let ms = try XCTUnwrap(info.MediaSources?.first, s.what)
            let pick = try Playback.choose(c, itemId: s.id, source: ms, playSessionId: info.PlaySessionId, deviceId: Self.deviceId)
            var req = URLRequest(url: pick.url)
            req.httpMethod = pick.isHLS ? "GET" : "HEAD"
            if !pick.isHLS { req.setValue("bytes=0-1023", forHTTPHeaderField: "Range") }
            let (body, resp) = try await URLSession.shared.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            XCTAssertTrue((200..<300).contains(code), "\(s.what): HTTP \(code)")
            if pick.isHLS { XCTAssertTrue(String(decoding: body, as: UTF8.self).hasPrefix("#EXTM3U"), s.what) }
            let reasons = ms.TranscodingUrl.flatMap { URLComponents(string: "http://x" + $0)?.queryItems?.first { $0.name == "TranscodeReasons" }?.value } ?? "-"
            let vcodec = ms.TranscodingUrl.flatMap { URLComponents(string: "http://x" + $0)?.queryItems?.first { $0.name == "VideoCodec" }?.value } ?? "-"
            report.append("\(s.what): \(pick.method.rawValue) hls=\(pick.isHLS) video=\(vcodec) reasons=\(reasons)")
            await Playback.stopEncoding(c, deviceId: Self.deviceId, playSessionId: info.PlaySessionId)
            // expectations from the iPhone profile
            switch s.what {
            case "mp4 H.264 + AAC", "mov H.264 + AAC": XCTAssertEqual(pick.method, .directPlay, s.what)
            case "mp4 HEVC tagged hev1": XCTAssertNotEqual(pick.method, .directPlay, "hev1 must not be direct played on iOS")
            case "avi MPEG-4 Xvid + MP3", "mpeg MPEG-2 + 2x AC3 + DVD subs": XCTAssertEqual(pick.method, .transcode, s.what)
            default: XCTAssertNotEqual(pick.method, .directPlay, "\(s.what): AVPlayer cannot open this container directly")
            }
        }
        print("PLAYBACK MATRIX\n" + report.joined(separator: "\n"))
    }

    /// Audio choice, picture-subtitle burn-in, text subtitle as WebVTT.
    func testTrackChoices() async throws {
        let c = try await signedIn()
        let id = "02adb852b13e0acf2e9d8f8dda2dd583" // Love Actually
        let first = try await Playback.fetchInfo(c, itemId: id, PlaybackOptions())
        let ms = try XCTUnwrap(first.MediaSources?.first)
        await Playback.stopEncoding(c, deviceId: Self.deviceId, playSessionId: first.PlaySessionId)
        let audio = Tracks.audio(ms)
        XCTAssertGreaterThanOrEqual(audio.count, 3)
        // pick the last audio track: the server URL must carry that index
        var o = PlaybackOptions(); o.audioIndex = audio.last!.Index; o.mediaSourceId = ms.Id
        let a = try await Playback.fetchInfo(c, itemId: id, o)
        let aurl = try XCTUnwrap(a.MediaSources?.first?.TranscodingUrl)
        XCTAssertTrue(aurl.contains("AudioStreamIndex=\(audio.last!.Index)"), aurl)
        await Playback.stopEncoding(c, deviceId: Self.deviceId, playSessionId: a.PlaySessionId)
        // picture subtitle burned in
        if let pgs = Tracks.subtitles(ms).first(where: Tracks.isPicture) {
            var b = PlaybackOptions(); b.subtitleIndex = pgs.Index; b.mediaSourceId = ms.Id; b.burnIn = true
            let r = try await Playback.fetchInfo(c, itemId: id, b)
            let u = try XCTUnwrap(r.MediaSources?.first?.TranscodingUrl)
            XCTAssertTrue(u.contains("SubtitleMethod=Encode") && u.contains("SubtitleStreamIndex=\(pgs.Index)"), u)
            await Playback.stopEncoding(c, deviceId: Self.deviceId, playSessionId: r.PlaySessionId)
        }
        // a text subtitle somewhere in the samples comes back as WebVTT cues
        let srtItem = "00433a7b829b469ac4126368a65ce695"
        let si = try await Playback.fetchInfo(c, itemId: srtItem, PlaybackOptions())
        let sms = try XCTUnwrap(si.MediaSources?.first)
        await Playback.stopEncoding(c, deviceId: Self.deviceId, playSessionId: si.PlaySessionId)
        let text = try XCTUnwrap(Tracks.subtitles(sms).first { !Tracks.isPicture($0) })
        let vurl = try XCTUnwrap(Playback.subtitleURL(c, itemId: srtItem, mediaSourceId: sms.Id, stream: text))
        let (vtt, vr) = try await URLSession.shared.data(from: vurl)
        XCTAssertEqual((vr as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertGreaterThan(VTT.parse(String(decoding: vtt, as: UTF8.self)).count, 10)
    }

    /// Start / progress / stop reports move the resume point; then it is put back exactly as before.
    func testProgressReportingAndUndo() async throws {
        let c = try await signedIn()
        let id = "e511a1cb5321f1478baad895149cf0b9" // That '70s Show S3E2 (test user only)
        let before = try await Library.item(c, id)
        let info = try await Playback.fetchInfo(c, itemId: id, PlaybackOptions())
        let ms = try XCTUnwrap(info.MediaSources?.first)
        let pick = try Playback.choose(c, itemId: id, source: ms, playSessionId: info.PlaySessionId, deviceId: Self.deviceId)
        func body(_ secs: Double, paused: Bool = false) -> [String: Any] {
            Playback.reportBody(itemId: id, mediaSourceId: ms.Id, playSessionId: info.PlaySessionId, positionTicks: Ticks.from(seconds: secs), paused: paused, method: pick.method, audio: ms.DefaultAudioStreamIndex, subtitle: nil)
        }
        await Playback.report(c, .start, body(0))
        await Playback.report(c, .progress, body(300))
        await Playback.report(c, .progress, body(320, paused: true))
        await Playback.report(c, .stop, body(330))
        await Playback.stopEncoding(c, deviceId: Self.deviceId, playSessionId: info.PlaySessionId)
        c.invalidateAll()
        let mid = try await Library.item(c, id)
        XCTAssertEqual(Ticks.seconds(mid.positionTicks), 330, accuracy: 1, "resume point saved")
        let resume = try await Library.resume("Episode")(c)
        XCTAssertTrue(resume.contains { $0.Id == id }, "shows in Continue Watching")
        // undo: put the user data back
        let restore: [String: Any] = ["PlaybackPositionTicks": before.positionTicks, "Played": before.played]
        try await c.send("POST", "/UserItems/\(id)/UserData", json: restore, query: ["userId": c.userId])
        c.invalidateAll()
        let after = try await Library.item(c, id)
        XCTAssertEqual(after.positionTicks, before.positionTicks)
        XCTAssertEqual(after.played, before.played)
    }

    /// MKV with HEVC/H.264: the server must only repackage (copy the picture), not re-encode it.
    func testRemuxCopiesVideo() async throws {
        let c = try await signedIn()
        struct Sess: Decodable { var DeviceId: String?; var TranscodingInfo: TI? }
        struct TI: Decodable { var IsVideoDirect: Bool?; var IsAudioDirect: Bool?; var VideoCodec: String?; var AudioCodec: String?; var Container: String? }
        var lines: [String] = []
        for (id, what, wantCopy) in [("00433a7b829b469ac4126368a65ce695", "mkv HEVC SDR", true), ("138a33a983cebc7e94bc70e6882a21ea", "mkv HEVC DV + TrueHD", true),
                                     ("00083be4d054ea86daa7022e1337cc16", "mkv H.264", true), ("0018ea0fc75adf23ba2e13246bc0d969", "avi Xvid", false)] {
            let info = try await Playback.fetchInfo(c, itemId: id, PlaybackOptions())
            let ms = try XCTUnwrap(info.MediaSources?.first)
            let pick = try Playback.choose(c, itemId: id, source: ms, playSessionId: info.PlaySessionId, deviceId: Self.deviceId)
            let master = String(decoding: try await URLSession.shared.data(from: pick.url).0, as: UTF8.self)
            let variant = try XCTUnwrap(master.split(separator: "\n").first { !$0.hasPrefix("#") && !$0.isEmpty }.map(String.init))
            let vurl = URL(string: variant, relativeTo: pick.url)!.absoluteURL
            let vpl = String(decoding: try await URLSession.shared.data(from: vurl).0, as: UTF8.self)
            if let seg = vpl.split(separator: "\n").first(where: { !$0.hasPrefix("#") && !$0.isEmpty }) {
                var r = URLRequest(url: URL(string: String(seg), relativeTo: vurl)!.absoluteURL); r.timeoutInterval = 120
                _ = try? await URLSession.shared.data(for: r)
            }
            let sessions = try await c.get([Sess].self, "/Sessions", ["DeviceId": Self.deviceId])
            let ti = sessions.compactMap(\.TranscodingInfo).first
            lines.append("\(what): videoDirect=\(String(describing: ti?.IsVideoDirect)) audioDirect=\(String(describing: ti?.IsAudioDirect)) v=\(ti?.VideoCodec ?? "-") a=\(ti?.AudioCodec ?? "-")")
            if let ti { XCTAssertEqual(ti.IsVideoDirect, wantCopy, what) }
            await Playback.stopEncoding(c, deviceId: Self.deviceId, playSessionId: info.PlaySessionId)
        }
        print("REMUX CHECK\n" + lines.joined(separator: "\n"))
    }

    func testMediaFixHelperStatusReadOnly() async throws {
        _ = try cfg()
        let c = try await signedIn()
        let it = try await Library.item(c, "10afc9b9da49c570dfe11dc2a92d3b37") // Death Race (audio fixed on the TV)
        let p = try XCTUnwrap(it.Path)
        let st = await MediaFixClient().status(path: p)
        XCTAssertNotNil(st, "helper answered /status")
        print("MEDIAFIX status for Death Race: \(String(describing: st)) badge=\(String(describing: st?.badge?.text))")
        XCTAssertFalse(MediaFixClient.canFix(it, isAdmin: false), "test user is not admin: no Fix Audio button")
    }
}

final class Flag: @unchecked Sendable {
    private var v = false
    private let l = NSLock()
    func set() { l.lock(); v = true; l.unlock() }
    var isSet: Bool { l.lock(); defer { l.unlock() }; return v }
}
