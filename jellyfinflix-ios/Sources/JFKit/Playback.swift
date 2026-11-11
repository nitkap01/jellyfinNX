// Playback: PlaybackInfo request, choosing the stream URL, track lists and progress reports.
// Same rules as the TV app (jellyfinflix/src/player/pinfo.js + player.js), adapted for AVPlayer.
import Foundation

public struct PlaybackOptions: Sendable {
    public var maxBitrate: Int = Quality.original.rawValue
    public var startTicks: Int64 = 0
    public var audioIndex: Int?
    public var subtitleIndex: Int?
    public var mediaSourceId: String?
    public var burnIn = false
    public var noDirect = false
    public init() {}
}

public enum PlayMethod: String, Sendable {
    case directPlay = "DirectPlay"
    case directStream = "DirectStream"
    case transcode = "Transcode"
}

public struct StreamChoice: Sendable, Equatable {
    public var url: URL
    public var method: PlayMethod
    public var isHLS: Bool
}

public enum Playback {
    /// PlaybackInfo POST body. Jellyfin 10.10 only honours AudioStreamIndex / SubtitleStreamIndex when the
    /// body also names the MediaSourceId (learned on the TV, JTV-11), so a track choice always carries it.
    public static func infoBody(userId: String, _ o: PlaybackOptions) -> [String: Any] {
        var b: [String: Any] = [
            "UserId": userId,
            "DeviceProfile": DeviceProfile.build(maxBitrate: o.maxBitrate, burnIn: o.burnIn),
            "MaxStreamingBitrate": o.maxBitrate,
            "StartTimeTicks": o.startTicks,
            "IsPlayback": true,
            "AutoOpenLiveStream": true,
            "EnableDirectPlay": !o.noDirect,
            "EnableDirectStream": !o.noDirect,
            "EnableTranscoding": true,
            "AllowVideoStreamCopy": true,
            "AllowAudioStreamCopy": true,
        ]
        if let a = o.audioIndex { b["AudioStreamIndex"] = a }
        if let s = o.subtitleIndex { b["SubtitleStreamIndex"] = s }
        if let m = o.mediaSourceId { b["MediaSourceId"] = m }
        return b
    }

    public static func fetchInfo(_ c: JellyfinClient, itemId: String, _ o: PlaybackOptions) async throws -> PlaybackInfoResponse {
        let body = infoBody(userId: c.userId ?? "", o)
        let r = try await c.sendDecodable(PlaybackInfoResponse.self, "POST", "/Items/\(itemId)/PlaybackInfo", json: body, query: ["UserId": c.userId])
        if let e = r.ErrorCode { throw JFError.badAnswer("PlaybackInfo: \(e)") }
        return r
    }

    /// Picks direct play when the server allows it, otherwise the server's HLS (remux or transcode) URL.
    public static func choose(_ c: JellyfinClient, itemId: String, source ms: MediaSource, playSessionId: String?, deviceId: String, forceServer: Bool = false) throws -> StreamChoice {
        let direct = (ms.SupportsDirectPlay ?? false) || ((ms.SupportsDirectStream ?? false) && ms.TranscodingUrl == nil)
        if direct && !forceServer {
            let ext = (ms.Container ?? "").split(separator: ",").first.map(String.init) ?? ""
            let path = "/Videos/\(itemId)/stream" + (ext.isEmpty ? "" : "." + ext)
            var q: [String: String?] = ["static": "true", "mediaSourceId": ms.Id, "PlaySessionId": playSessionId, "DeviceId": deviceId]
            if let tag = ms.ETag { q["Tag"] = tag }
            return StreamChoice(url: c.url(path, q, withToken: true), method: .directPlay, isHLS: false)
        }
        guard let t = ms.TranscodingUrl, let u = c.absolute(t) else { throw JFError.badAnswer("the server offered no way to play this file") }
        let copy = t.range(of: "VideoCodec=copy", options: .caseInsensitive) != nil || (ms.SupportsDirectStream ?? false)
        return StreamChoice(url: u, method: copy ? .directStream : .transcode, isHLS: t.contains(".m3u8"))
    }

    /// Body for /Sessions/Playing, /Progress and /Stopped.
    public static func reportBody(itemId: String, mediaSourceId: String, playSessionId: String?, positionTicks: Int64, paused: Bool,
                                  method: PlayMethod, audio: Int?, subtitle: Int?, event: String? = nil) -> [String: Any] {
        var b: [String: Any] = [
            "ItemId": itemId, "MediaSourceId": mediaSourceId, "PositionTicks": max(0, positionTicks), "IsPaused": paused,
            "IsMuted": false, "VolumeLevel": 100, "PlayMethod": method.rawValue, "CanSeek": true, "RepeatMode": "RepeatNone",
        ]
        if let p = playSessionId { b["PlaySessionId"] = p }
        if let a = audio { b["AudioStreamIndex"] = a }
        b["SubtitleStreamIndex"] = subtitle ?? -1
        if let e = event { b["EventName"] = e }
        return b
    }

    public enum ReportKind { case start, progress, stop }

    public static func report(_ c: JellyfinClient, _ kind: ReportKind, _ body: [String: Any]) async {
        let path: String
        switch kind {
        case .start: path = "/Sessions/Playing"
        case .progress: path = "/Sessions/Playing/Progress"
        case .stop: path = "/Sessions/Playing/Stopped"
        }
        _ = try? await c.send("POST", path, json: body)
    }

    /// Tells the server to stop a running transcode (saves CPU on CT 105).
    public static func stopEncoding(_ c: JellyfinClient, deviceId: String, playSessionId: String?) async {
        guard let p = playSessionId else { return }
        _ = try? await c.send("DELETE", "/Videos/ActiveEncodings", query: ["DeviceId": deviceId, "PlaySessionId": p])
    }

    /// WebVTT URL for a subtitle stream (external file or extracted from the container).
    public static func subtitleURL(_ c: JellyfinClient, itemId: String, mediaSourceId: String, stream s: MediaStream) -> URL? {
        var path: String
        if let d = s.DeliveryUrl, s.DeliveryMethod == "External" { path = d } else {
            path = "/Videos/\(itemId)/\(mediaSourceId)/Subtitles/\(s.Index)/0/Stream.vtt"
        }
        if let r = path.range(of: #"/Stream\.\w+"#, options: .regularExpression) { path.replaceSubrange(r, with: "/Stream.vtt") }
        return c.absolute(path)
    }
}

// MARK: tracks

public enum Tracks {
    public static func audio(_ ms: MediaSource) -> [MediaStream] { (ms.MediaStreams ?? []).filter { $0.Type == "Audio" } }
    public static func subtitles(_ ms: MediaSource) -> [MediaStream] { (ms.MediaStreams ?? []).filter { $0.Type == "Subtitle" } }
    public static func video(_ ms: MediaSource) -> MediaStream? { (ms.MediaStreams ?? []).first { $0.Type == "Video" } }

    public static func isPicture(_ s: MediaStream) -> Bool {
        if let t = s.IsTextSubtitleStream { return !t }
        return DeviceProfile.pictureSubs.contains((s.Codec ?? "").lowercased())
    }

    /// "English · EAC3 5.1" style label.
    public static func label(_ s: MediaStream) -> String {
        if let d = s.DisplayTitle, !d.isEmpty { return d }
        var parts: [String] = []
        if let l = s.Language, !l.isEmpty { parts.append(Locale(identifier: "en").localizedString(forLanguageCode: l) ?? l) }
        if let t = s.Title, !t.isEmpty { parts.append(t) }
        if let c = s.Codec { parts.append(c.uppercased()) }
        if let ch = s.Channels, s.Type == "Audio" { parts.append(ch == 6 ? "5.1" : ch == 8 ? "7.1" : ch == 2 ? "Stereo" : "\(ch) ch") }
        return parts.isEmpty ? "Track \(s.Index)" : parts.joined(separator: " · ")
    }
}

// MARK: skip intro / next episode timing

public struct Segment: Sendable, Equatable {
    public var type: String
    public var start: Double
    public var end: Double
}

public enum Segments {
    public static func from(_ r: MediaSegmentsResponse) -> [Segment] {
        r.Items.map { Segment(type: $0.Type ?? "", start: Ticks.seconds($0.StartTicks), end: Ticks.seconds($0.EndTicks)) }
    }

    /// The intro/recap segment the playhead is in (shows "Skip Intro").
    public static func skippable(at t: Double, in segs: [Segment]) -> Segment? {
        segs.first { ($0.type == "Intro" || $0.type == "Recap" || $0.type == "Preview") && t >= $0.start && t < $0.end - 1 }
    }

    /// When to show the next-episode card (same rule as the TV): at the Outro segment if the server knows it,
    /// else 30 s before the end.
    public static func nextCardTime(duration: Double, segs: [Segment]) -> Double {
        if let o = segs.first(where: { $0.type == "Outro" }) { return o.start }
        return max(0, duration - 30)
    }
}
