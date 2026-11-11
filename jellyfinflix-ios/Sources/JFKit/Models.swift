// Jellyfin API shapes the app uses (subset of Jellyfin 10.10). Unknown fields are ignored.
import Foundation

public struct UserData: Codable, Hashable, Sendable {
    public var PlaybackPositionTicks: Int64?
    public var PlayedPercentage: Double?
    public var IsFavorite: Bool?
    public var Played: Bool?
    public var UnplayedItemCount: Int?

    public init(PlaybackPositionTicks: Int64? = nil, PlayedPercentage: Double? = nil, IsFavorite: Bool? = nil, Played: Bool? = nil, UnplayedItemCount: Int? = nil) {
        self.PlaybackPositionTicks = PlaybackPositionTicks
        self.PlayedPercentage = PlayedPercentage
        self.IsFavorite = IsFavorite
        self.Played = Played
        self.UnplayedItemCount = UnplayedItemCount
    }
}

public struct NameId: Codable, Hashable, Sendable {
    public var Name: String?
    public var Id: String?
}

public struct Person: Codable, Hashable, Sendable {
    public var Name: String?
    public var Id: String?
    public var Role: String?
    public var `Type`: String?
}

public struct BaseItem: Codable, Hashable, Identifiable, Sendable {
    public var Id: String
    public var Name: String?
    public var `Type`: String?
    public var Overview: String?
    public var Path: String?
    public var SeriesId: String?
    public var SeriesName: String?
    public var SeasonId: String?
    public var SeasonName: String?
    public var ParentIndexNumber: Int?
    public var IndexNumber: Int?
    public var ProductionYear: Int?
    public var PremiereDate: String?
    public var OfficialRating: String?
    public var CommunityRating: Double?
    public var RunTimeTicks: Int64?
    public var ChildCount: Int?
    public var LocationType: String?
    public var ImageTags: [String: String]?
    public var BackdropImageTags: [String]?
    public var ParentBackdropItemId: String?
    public var ParentBackdropImageTags: [String]?
    public var ParentThumbItemId: String?
    public var ParentThumbImageTag: String?
    public var ParentLogoItemId: String?
    public var ParentLogoImageTag: String?
    public var SeriesPrimaryImageTag: String?
    public var UserData: UserData?
    public var Genres: [String]?
    public var People: [Person]?
    public var Studios: [NameId]?
    public var MediaStreams: [MediaStream]?
    public var MediaSources: [MediaSource]?
    public var Width: Int?
    public var Height: Int?

    public var id: String { Id }

    public init(Id: String, Name: String? = nil, Type: String? = nil) {
        self.Id = Id
        self.Name = Name
        self.Type = Type
    }

    public var isEpisode: Bool { Type == "Episode" }
    public var isSeries: Bool { Type == "Series" }
    public var isMovie: Bool { Type == "Movie" }
    public var isPlayable: Bool { Type == "Movie" || Type == "Episode" || Type == "Video" }
    public var positionTicks: Int64 { UserData?.PlaybackPositionTicks ?? 0 }
    public var isFavorite: Bool { UserData?.IsFavorite ?? false }
    public var played: Bool { UserData?.Played ?? false }
    /// Fraction 0...1 of the item already watched (0 when not started).
    public var progress: Double {
        guard let rt = RunTimeTicks, rt > 0, positionTicks > 0 else { return 0 }
        return min(1, Double(positionTicks) / Double(rt))
    }
}

public struct ItemsResponse: Codable, Sendable {
    public var Items: [BaseItem]
    public var TotalRecordCount: Int?
}

public struct PublicUser: Codable, Hashable, Identifiable, Sendable {
    public var Id: String
    public var Name: String
    public var PrimaryImageTag: String?
    public var HasPassword: Bool?
    public var id: String { Id }
}

public struct UserPolicy: Codable, Hashable, Sendable {
    public var IsAdministrator: Bool?
}

public struct UserDto: Codable, Hashable, Sendable {
    public var Id: String
    public var Name: String
    public var PrimaryImageTag: String?
    public var Policy: UserPolicy?
}

public struct AuthResult: Codable, Sendable {
    public var User: UserDto
    public var AccessToken: String
}

public struct PublicSystemInfo: Codable, Sendable {
    public var ServerName: String?
    public var Version: String?
    public var Id: String?
}

public struct MediaStream: Codable, Hashable, Sendable {
    public var Index: Int
    public var `Type`: String?
    public var Codec: String?
    public var CodecTag: String?
    public var Language: String?
    public var Title: String?
    public var DisplayTitle: String?
    public var Channels: Int?
    public var ChannelLayout: String?
    public var IsExternal: Bool?
    public var IsDefault: Bool?
    public var IsForced: Bool?
    public var IsTextSubtitleStream: Bool?
    public var DeliveryMethod: String?
    public var DeliveryUrl: String?
    public var Width: Int?
    public var Height: Int?
    public var VideoRange: String?
    public var VideoRangeType: String?
    public var Profile: String?

    public init(Index: Int, Type: String?) {
        self.Index = Index
        self.Type = Type
    }
}

public struct MediaSource: Codable, Hashable, Sendable {
    public var Id: String
    public var Path: String?
    public var Container: String?
    public var Size: Int64?
    public var ETag: String?
    public var RunTimeTicks: Int64?
    public var SupportsDirectPlay: Bool?
    public var SupportsDirectStream: Bool?
    public var SupportsTranscoding: Bool?
    public var TranscodingUrl: String?
    public var TranscodingSubProtocol: String?
    public var MediaStreams: [MediaStream]?
    public var DefaultAudioStreamIndex: Int?
    public var DefaultSubtitleStreamIndex: Int?

    public init(Id: String) { self.Id = Id }
}

public struct PlaybackInfoResponse: Codable, Sendable {
    public var MediaSources: [MediaSource]?
    public var PlaySessionId: String?
    public var ErrorCode: String?
}

public struct MediaSegment: Codable, Hashable, Sendable {
    public var `Type`: String?
    public var StartTicks: Int64
    public var EndTicks: Int64
}

public struct MediaSegmentsResponse: Codable, Sendable {
    public var Items: [MediaSegment]
}

public struct Genre: Codable, Hashable, Sendable {
    public var Id: String
    public var Name: String
    public var ChildCount: Int?
}

public struct LibraryView: Codable, Hashable, Sendable {
    public var Id: String
    public var Name: String?
    public var CollectionType: String?
}

public struct ViewsResponse: Codable, Sendable {
    public var Items: [LibraryView]
}

public struct GenresResponse: Codable, Sendable {
    public var Items: [Genre]
}

public enum Ticks {
    public static let perSecond: Int64 = 10_000_000
    public static func seconds(_ t: Int64) -> Double { Double(t) / Double(perSecond) }
    public static func from(seconds s: Double) -> Int64 { Int64((s * Double(perSecond)).rounded()) }
}
