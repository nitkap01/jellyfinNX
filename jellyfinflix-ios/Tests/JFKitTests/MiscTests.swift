import XCTest
@testable import JFKit

final class MiscTests: XCTestCase {
    func testServerNormalize() {
        XCTAssertEqual(ServerAddresses.normalize(" jellyfin.home/ ")?.absoluteString, "http://jellyfin.home")
        XCTAssertEqual(ServerAddresses.normalize("https://x.ts.net:8920//")?.absoluteString, "https://x.ts.net:8920")
        XCTAssertEqual(ServerAddresses.normalize("192.168.0.154:8097")?.absoluteString, "http://192.168.0.154:8097")
        XCTAssertNil(ServerAddresses.normalize(""))
        XCTAssertNil(ServerAddresses.normalize("http://"))
        let a = ServerAddresses(main: "jellyfin.home", backup: "http://jellyfin.home/")
        XCTAssertEqual(a.candidates.count, 1, "duplicates removed")
        XCTAssertEqual(ServerAddresses.defaults.candidates.map(\.absoluteString), ["http://jellyfin.home", "http://192.168.0.154:8097"])
    }

    func testClientURL() {
        let c = JellyfinClient(server: URL(string: "http://h:8097")!, info: ClientInfo(deviceId: "d"), token: "T", userId: "U9")
        let u = c.url("/Users/{U}/Items", ["UserId": "{U}", "SearchTerm": "a+b c", "Empty": "", "Nil": nil])
        XCTAssertEqual(u.absoluteString, "http://h:8097/Users/U9/Items?SearchTerm=a%2Bb%20c&UserId=U9")
        XCTAssertTrue(c.url("/x", [:], withToken: true).absoluteString.hasSuffix("?api_key=T"))
        XCTAssertTrue(c.info.authHeader(token: "T").contains("Token=\"T\""))
        XCTAssertFalse(c.info.authHeader(token: nil).contains("Token"))
    }

    func testVTT() {
        let s = """
        WEBVTT

        1
        00:00:01.000 --> 00:00:03.500 line:90%
        <i>Hello</i> &amp; welcome

        00:02.000 --> 00:04.000
        Second

        00:01:00,000 --> 00:01:02,000
        Third
        """
        let cues = VTT.parse(s)
        XCTAssertEqual(cues.count, 3)
        XCTAssertEqual(cues[0].text, "Hello & welcome")
        XCTAssertEqual(cues[2].start, 60)
        XCTAssertEqual(VTT.text(at: 2.5, in: cues), "Hello & welcome\nSecond")
        XCTAssertEqual(VTT.text(at: 3.9, in: cues), "Second")
        XCTAssertNil(VTT.text(at: 0.5, in: cues))
        XCTAssertNil(VTT.text(at: 30, in: cues))
    }

    func testFixOutcomeWording() {
        XCTAssertEqual(MediaFixClient.outcome(.audio, FixJob(state: "succeeded", exitCode: 0, resultStatus: "OK_NOFIX", output: nil)), .done("Audio is already fine — nothing was changed."))
        if case .failed(let t, let m) = MediaFixClient.outcome(.audio, FixJob(state: "failed", exitCode: 8, resultStatus: nil, output: nil)) {
            XCTAssertEqual(t, "Needs a human"); XCTAssertTrue(m.contains("Do not retry"))
        } else { XCTFail() }
        if case .failed(_, let m) = MediaFixClient.outcome(.audio, FixJob(state: "failed", exitCode: 2, resultStatus: nil, output: "x\nAnother run is already in progress")) {
            XCTAssertEqual(m, "Another audio fix is already running.")
        } else { XCTFail() }
        if case .failed(let t, let m) = MediaFixClient.outcome(.subtitle, FixJob(state: "failed", exitCode: 3, resultStatus: nil, output: nil)) {
            XCTAssertEqual(t, "Fetch Subtitle"); XCTAssertTrue(m.contains("No matching English subtitle"))
        } else { XCTFail() }
        XCTAssertEqual(FixStatus(state: "running", fixed: false, progressPhase: nil, progressPercent: 42, lastResultStatus: nil).badge?.text, "Fixing 42%")
        XCTAssertEqual(FixStatus(state: "idle", fixed: true).badge?.text, "Audio fixed")
        XCTAssertNil(FixStatus(state: "idle", fixed: false, lastResultStatus: "OK_NOFIX").badge)
    }

    func testCanFix() {
        var m = BaseItem(Id: "m", Type: "Movie"); m.Path = "/MEDIA/Eng_Movies/x.mkv"
        XCTAssertTrue(MediaFixClient.canFix(m, isAdmin: true))
        XCTAssertFalse(MediaFixClient.canFix(m, isAdmin: false))
        m.Path = "/other/x.mkv"
        XCTAssertFalse(MediaFixClient.canFix(m, isAdmin: true))
        XCTAssertFalse(MediaFixClient.canFix(BaseItem(Id: "s", Type: "Series"), isAdmin: true))
    }

    func testArtOrder() {
        var e = BaseItem(Id: "E", Type: "Episode")
        e.ImageTags = ["Primary": "p"]; e.SeriesId = "S"; e.SeriesPrimaryImageTag = "sp"
        XCTAssertEqual(Art.card(e)?.type, "Primary")
        XCTAssertEqual(Art.poster(e)?.id, "S")
        var m = BaseItem(Id: "M", Type: "Movie")
        m.ImageTags = ["Primary": "p", "Thumb": "t"]; m.BackdropImageTags = ["b"]
        XCTAssertEqual(Art.card(m)?.type, "Thumb")
        XCTAssertEqual(Art.backdrop(m)?.type, "Backdrop")
        XCTAssertNil(Art.logo(m))
    }
}
