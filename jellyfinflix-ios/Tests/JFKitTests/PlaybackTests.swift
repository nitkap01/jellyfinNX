import XCTest
@testable import JFKit

final class PlaybackTests: XCTestCase {
    let client = JellyfinClient(server: URL(string: "http://jellyfin.home")!, info: ClientInfo(deviceId: "dev-1"), token: "TOKEN", userId: "U1")

    func testInfoBodyCarriesMediaSourceWithTrackChoice() {
        var o = PlaybackOptions()
        o.audioIndex = 2; o.subtitleIndex = 4; o.mediaSourceId = "ms1"; o.startTicks = 123
        let b = Playback.infoBody(userId: "U1", o)
        XCTAssertEqual(b["AudioStreamIndex"] as? Int, 2)
        XCTAssertEqual(b["SubtitleStreamIndex"] as? Int, 4)
        XCTAssertEqual(b["MediaSourceId"] as? String, "ms1")
        XCTAssertEqual(b["StartTimeTicks"] as? Int64, 123)
        XCTAssertEqual(b["EnableDirectPlay"] as? Bool, true)
        let none = Playback.infoBody(userId: "U1", PlaybackOptions())
        XCTAssertNil(none["AudioStreamIndex"]); XCTAssertNil(none["MediaSourceId"])
    }

    func testProfileBurnInSwitch() {
        func picMethod(_ burn: Bool) -> String? {
            let p = DeviceProfile.build(maxBitrate: 8_000_000, burnIn: burn)
            let subs = p["SubtitleProfiles"] as! [[String: Any]]
            return subs.first { ($0["Format"] as? String) == "pgssub" }?["Method"] as? String
        }
        XCTAssertEqual(picMethod(false), "Embed")
        XCTAssertEqual(picMethod(true), "Encode")
        let p = DeviceProfile.build(maxBitrate: 8_000_000, burnIn: false)
        let subs = p["SubtitleProfiles"] as! [[String: Any]]
        XCTAssertEqual(subs.first { ($0["Format"] as? String) == "srt" }?["Method"] as? String, "External")
        let tp = (p["TranscodingProfiles"] as! [[String: Any]])[0]
        XCTAssertEqual(tp["Protocol"] as? String, "hls")
        XCTAssertEqual(tp["Container"] as? String, "mp4", "fMP4 HLS so HEVC can be copied")
        XCTAssertEqual(p["MaxStreamingBitrate"] as? Int, 8_000_000)
        XCTAssertTrue(JSONSerialization.isValidJSONObject(p))
    }

    func testChooseDirectPlay() throws {
        var ms = MediaSource(Id: "ms1")
        ms.SupportsDirectPlay = true; ms.Container = "mp4,m4v"; ms.ETag = "et"
        let c = try Playback.choose(client, itemId: "IT", source: ms, playSessionId: "PS", deviceId: "dev-1")
        XCTAssertEqual(c.method, .directPlay)
        XCTAssertFalse(c.isHLS)
        let s = c.url.absoluteString
        XCTAssertTrue(s.hasPrefix("http://jellyfin.home/Videos/IT/stream.mp4?"), s)
        for part in ["static=true", "mediaSourceId=ms1", "PlaySessionId=PS", "DeviceId=dev-1", "Tag=et", "api_key=TOKEN"] { XCTAssertTrue(s.contains(part), part) }
    }

    func testChooseServerStream() throws {
        var ms = MediaSource(Id: "ms1")
        ms.SupportsDirectPlay = false; ms.SupportsDirectStream = false
        ms.TranscodingUrl = "/videos/IT/master.m3u8?DeviceId=dev-1&MediaSourceId=ms1&VideoCodec=hevc,h264&AudioCodec=aac&TranscodeReasons=ContainerNotSupported"
        let c = try Playback.choose(client, itemId: "IT", source: ms, playSessionId: "PS", deviceId: "dev-1")
        XCTAssertEqual(c.method, .transcode)
        XCTAssertTrue(c.isHLS)
        XCTAssertTrue(c.url.absoluteString.hasSuffix("&api_key=TOKEN"))
        // a token already in the URL is not added twice
        ms.TranscodingUrl = "/videos/IT/master.m3u8?ApiKey=X&VideoCodec=copy"
        let c2 = try Playback.choose(client, itemId: "IT", source: ms, playSessionId: "PS", deviceId: "dev-1")
        XCTAssertFalse(c2.url.absoluteString.contains("api_key"))
        XCTAssertEqual(c2.method, .directStream)
        // direct play forbidden after a failure -> server stream
        ms.SupportsDirectPlay = true
        XCTAssertEqual(try Playback.choose(client, itemId: "IT", source: ms, playSessionId: nil, deviceId: "d", forceServer: true).method, .directStream)
        // nothing offered
        XCTAssertThrowsError(try Playback.choose(client, itemId: "IT", source: MediaSource(Id: "z"), playSessionId: nil, deviceId: "d"))
    }

    func testReportBody() {
        let b = Playback.reportBody(itemId: "IT", mediaSourceId: "ms", playSessionId: "PS", positionTicks: -5, paused: true, method: .transcode, audio: 1, subtitle: nil, event: "Pause")
        XCTAssertEqual(b["PositionTicks"] as? Int64, 0)
        XCTAssertEqual(b["PlayMethod"] as? String, "Transcode")
        XCTAssertEqual(b["SubtitleStreamIndex"] as? Int, -1)
        XCTAssertEqual(b["EventName"] as? String, "Pause")
        XCTAssertEqual(b["IsPaused"] as? Bool, true)
    }

    func testSubtitleURL() {
        var ext = MediaStream(Index: 3, Type: "Subtitle")
        ext.DeliveryMethod = "External"; ext.DeliveryUrl = "/Videos/IT/ms/Subtitles/3/0/Stream.srt?x=1"
        XCTAssertEqual(Playback.subtitleURL(client, itemId: "IT", mediaSourceId: "ms", stream: ext)?.absoluteString,
                       "http://jellyfin.home/Videos/IT/ms/Subtitles/3/0/Stream.vtt?x=1&api_key=TOKEN")
        let emb = MediaStream(Index: 5, Type: "Subtitle")
        XCTAssertEqual(Playback.subtitleURL(client, itemId: "IT", mediaSourceId: "ms", stream: emb)?.absoluteString,
                       "http://jellyfin.home/Videos/IT/ms/Subtitles/5/0/Stream.vtt?api_key=TOKEN")
    }

    func testSegmentsAndNextCard() {
        let segs = [Segment(type: "Intro", start: 30, end: 90), Segment(type: "Outro", start: 1250, end: 1320)]
        XCTAssertEqual(Segments.skippable(at: 45, in: segs)?.type, "Intro")
        XCTAssertNil(Segments.skippable(at: 89.5, in: segs), "no button in the last second")
        XCTAssertNil(Segments.skippable(at: 100, in: segs))
        XCTAssertEqual(Segments.nextCardTime(duration: 1320, segs: segs), 1250)
        XCTAssertEqual(Segments.nextCardTime(duration: 1320, segs: []), 1290)
        XCTAssertEqual(Segments.nextCardTime(duration: 10, segs: []), 0)
    }

    func testTrackLabels() {
        var a = MediaStream(Index: 1, Type: "Audio")
        a.DisplayTitle = "English - EAC3 - 5.1 - Default"
        XCTAssertEqual(Tracks.label(a), "English - EAC3 - 5.1 - Default")
        var b = MediaStream(Index: 2, Type: "Audio")
        b.Language = "eng"; b.Codec = "ac3"; b.Channels = 2
        XCTAssertEqual(Tracks.label(b), "English · AC3 · Stereo")
        var p = MediaStream(Index: 4, Type: "Subtitle"); p.Codec = "PGSSUB"
        XCTAssertTrue(Tracks.isPicture(p))
        var t = MediaStream(Index: 5, Type: "Subtitle"); t.Codec = "subrip"; t.IsTextSubtitleStream = true
        XCTAssertFalse(Tracks.isPicture(t))
    }
}
