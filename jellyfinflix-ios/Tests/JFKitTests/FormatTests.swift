import XCTest
@testable import JFKit

final class FormatTests: XCTestCase {
    func testClock() {
        XCTAssertEqual(Fmt.clock(0), "0:00")
        XCTAssertEqual(Fmt.clock(65), "1:05")
        XCTAssertEqual(Fmt.clock(3723), "1:02:03")
        XCTAssertEqual(Fmt.clock(-5), "0:00")
        XCTAssertEqual(Fmt.clock(.nan), "0:00")
    }

    func testRuntimeAndLeft() {
        XCTAssertEqual(Fmt.runtime(nil), "")
        XCTAssertEqual(Fmt.runtime(22 * 600_000_000), "22m")
        XCTAssertEqual(Fmt.runtime(127 * 600_000_000), "2h 7m")
        var it = BaseItem(Id: "x", Name: "Roller Disco", Type: "Episode")
        it.RunTimeTicks = 22 * 600_000_000
        XCTAssertNil(Fmt.timeLeft(it))
        XCTAssertEqual(Fmt.playLabel(it), "Play")
        it.UserData = UserData(PlaybackPositionTicks: 14 * 600_000_000)
        XCTAssertEqual(Fmt.timeLeft(it), "8m")
        XCTAssertEqual(Fmt.playLabel(it), "Resume · 8m left")
        it.UserData = UserData(PlaybackPositionTicks: 22 * 600_000_000 - 1)
        XCTAssertEqual(Fmt.timeLeft(it), "1m", "never says 0m left")
    }

    func testEpisodeLabel() {
        var e = BaseItem(Id: "e", Type: "Episode")
        e.ParentIndexNumber = 3; e.IndexNumber = 5
        XCTAssertEqual(Fmt.episode(e), "S3:E5")
        XCTAssertEqual(Fmt.episode(BaseItem(Id: "m", Type: "Movie")), "")
    }

    func testAired() {
        var e = BaseItem(Id: "e", Type: "Episode")
        e.PremiereDate = "1994-09-22T00:00:00.0000000Z"
        XCTAssertEqual(Fmt.aired(e), "Aired 22nd September 1994")
        var m = BaseItem(Id: "m", Type: "Movie")
        m.PremiereDate = "1975-11-19T00:00:00Z"
        XCTAssertEqual(Fmt.aired(m), "Released 19th November 1975")
        for (d, want) in [(1, "1st"), (2, "2nd"), (3, "3rd"), (11, "11th"), (12, "12th"), (13, "13th"), (21, "21st"), (23, "23rd")] {
            XCTAssertTrue(Fmt.airDate(String(format: "2001-01-%02dT00:00:00Z", d)).hasPrefix(want + " "), "\(d)")
        }
        let now = ISO8601DateFormatter().date(from: "2026-11-11T00:00:00Z")!
        XCTAssertEqual(Fmt.ago(e, now: now), "32 years ago")
        XCTAssertEqual(Fmt.ago(BaseItem(Id: "s", Type: "Series"), now: now), "")
    }

    func testEndsAt() {
        let now = ISO8601DateFormatter().date(from: "2026-11-11T16:11:00Z")!
        let ist = TimeZone(identifier: "Asia/Kolkata")!
        XCTAssertEqual(Fmt.timeOfDay(now, timeZone: ist), "9:41 PM")
        XCTAssertEqual(Fmt.endsAt(remainingSeconds: 492, now: now, timeZone: ist), "Ends at 9:49 PM")
    }

    func testFacts() {
        var s = BaseItem(Id: "s", Type: "Series")
        s.ProductionYear = 1998; s.OfficialRating = "IN-U"; s.ChildCount = 8; s.CommunityRating = 7.921
        XCTAssertEqual(Fmt.facts(s), ["1998", "IN-U", "8 Seasons", "★ 7.9"])
        var m = BaseItem(Id: "m", Type: "Movie")
        m.ProductionYear = 2008; m.RunTimeTicks = 122 * 600_000_000
        XCTAssertEqual(Fmt.facts(m), ["2008", "2h 2m"])
    }
}
