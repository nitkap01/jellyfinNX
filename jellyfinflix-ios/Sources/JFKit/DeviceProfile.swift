// What the iPhone's own player (AVPlayer) can play. Jellyfin uses this to choose:
//  - Direct play: the file as is (mp4/m4v/mov with H.264/HEVC + AAC/AC3/EAC3/...).
//  - Direct stream / remux: e.g. an MKV with H.264/HEVC is repackaged into HLS without re-encoding the picture.
//  - Transcode: anything else, or when the bitrate cap is lower than the file.
// Text subtitles are fetched as WebVTT and drawn by the app (same as the TV app); picture subtitles
// (PGS/VobSub) are burned in by the server only when chosen.
import Foundation

public enum DeviceProfile {
    public static let directAudio = ["aac", "mp3", "ac3", "eac3", "alac", "flac"]
    public static let hlsAudio = ["aac", "ac3", "eac3"]
    public static let videoCodecs = ["h264", "hevc"]
    public static let textSubs = ["srt", "subrip", "ass", "ssa", "vtt", "webvtt", "mov_text", "sub", "smi", "ttml"]
    public static let pictureSubs = ["pgssub", "pgs", "dvdsub", "dvbsub", "vobsub"]

    public static func build(maxBitrate: Int, burnIn: Bool) -> [String: Any] {
        let hevcConditions: [[String: Any]] = [
            // AVPlayer only plays HEVC tagged hvc1/dvh1 inside mp4/mov; hev1 files get remuxed by the server.
            ["Condition": "EqualsAny", "Property": "VideoCodecTag", "Value": "hvc1|dvh1", "IsRequired": false],
            ["Condition": "EqualsAny", "Property": "VideoProfile", "Value": "main|main 10", "IsRequired": false],
            ["Condition": "EqualsAny", "Property": "VideoRangeType", "Value": "SDR|HDR10|HLG|DOVI|DOVIWithHDR10|DOVIWithHLG|DOVIWithSDR", "IsRequired": false],
        ]
        let h264Conditions: [[String: Any]] = [
            ["Condition": "LessThanEqual", "Property": "VideoLevel", "Value": "52", "IsRequired": false],
            ["Condition": "EqualsAny", "Property": "VideoProfile", "Value": "high|main|baseline|constrained baseline", "IsRequired": false],
            ["Condition": "LessThanEqual", "Property": "VideoBitDepth", "Value": "8", "IsRequired": false],
        ]
        var subs: [[String: Any]] = textSubs.map { ["Format": $0, "Method": "External"] }
        subs += pictureSubs.map { ["Format": $0, "Method": burnIn ? "Encode" : "Embed"] }
        return [
            "Name": "JellyfinFlix iOS",
            "MaxStreamingBitrate": maxBitrate,
            "MaxStaticBitrate": max(maxBitrate, 200_000_000),
            "MusicStreamingTranscodingBitrate": 384_000,
            "DirectPlayProfiles": [
                ["Container": "mp4,m4v,mov", "Type": "Video", "VideoCodec": videoCodecs.joined(separator: ","), "AudioCodec": directAudio.joined(separator: ",")],
                ["Container": "mp3,aac,m4a,flac,alac,wav", "Type": "Audio"],
            ],
            "TranscodingProfiles": [
                // fMP4 HLS so HEVC can be copied (TS cannot carry HEVC for AVPlayer).
                ["Container": "mp4", "Type": "Video", "VideoCodec": "hevc,h264", "AudioCodec": hlsAudio.joined(separator: ","), "Context": "Streaming",
                 "Protocol": "hls", "MaxAudioChannels": "6", "MinSegments": "2", "BreakOnNonKeyFrames": true],
                ["Container": "aac", "Type": "Audio", "AudioCodec": "aac", "Context": "Streaming", "Protocol": "http", "MaxAudioChannels": "2"],
            ],
            "ContainerProfiles": [] as [Any],
            "CodecProfiles": [
                ["Type": "Video", "Codec": "h264", "Conditions": h264Conditions],
                ["Type": "Video", "Codec": "hevc", "Conditions": hevcConditions],
            ],
            "SubtitleProfiles": subs,
            "ResponseProfiles": [] as [Any],
        ]
    }
}

/// Streaming quality choices. Original = no cap (home Wi-Fi). Lower caps help on mobile data over Tailscale.
public enum Quality: Int, CaseIterable, Codable, Sendable {
    case original = 120_000_000
    case q20 = 20_000_000
    case q8 = 8_000_000
    case q4 = 4_000_000
    case q2 = 2_000_000

    public var label: String {
        switch self {
        case .original: return "Original"
        case .q20: return "1080p · 20 Mbps"
        case .q8: return "1080p · 8 Mbps"
        case .q4: return "720p · 4 Mbps"
        case .q2: return "480p · 2 Mbps"
        }
    }
}
