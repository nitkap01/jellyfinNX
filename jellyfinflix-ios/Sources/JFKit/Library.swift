// What each tab shows and how to fetch it (same rows as the TV app, jellyfinflix/src/data.js).
import Foundation

public struct RowDef: Identifiable, Sendable {
    public enum Kind: Sendable { case landscape, poster }
    public var id: String
    public var title: String
    public var kind: Kind = .landscape
    public var load: @Sendable (JellyfinClient) async throws -> [BaseItem]
}

public enum Tab: String, CaseIterable, Sendable { case home, shows, movies, myList }

public enum Library {
    public static let fields = "Overview,Path,PremiereDate,Genres"
    static func common(_ extra: [String: String?]) -> [String: String?] {
        var q: [String: String?] = ["Fields": fields, "EnableImageTypes": "Primary,Backdrop,Thumb,Logo", "ImageTypeLimit": "1", "EnableTotalRecordCount": "false"]
        for (k, v) in extra { q[k] = v }
        return q
    }

    static func items(_ c: JellyfinClient, _ path: String, _ q: [String: String?], ttl: TimeInterval) async throws -> [BaseItem] {
        try await c.get(ItemsResponse.self, path, common(q), ttl: ttl).Items
    }

    public static func resume(_ types: String) -> @Sendable (JellyfinClient) async throws -> [BaseItem] {
        { c in try await items(c, "/Users/{U}/Items/Resume", ["Limit": "24", "MediaTypes": "Video", "IncludeItemTypes": types], ttl: 30) }
    }

    public static let nextUp: @Sendable (JellyfinClient) async throws -> [BaseItem] = { c in
        try await items(c, "/Shows/NextUp", ["UserId": "{U}", "Limit": "24", "EnableResumable": "false", "EnableRewatching": "false"], ttl: 30)
    }

    public static func favourites(_ types: String, limit: Int = 40) -> @Sendable (JellyfinClient) async throws -> [BaseItem] {
        { c in try await items(c, "/Users/{U}/Items", ["Filters": "IsFavorite", "Recursive": "true", "IncludeItemTypes": types, "SortBy": "DateCreated", "SortOrder": "Descending", "Limit": String(limit)], ttl: 30) }
    }

    public static func query(_ q: [String: String?], ttl: TimeInterval = 120) -> @Sendable (JellyfinClient) async throws -> [BaseItem] {
        { c in
            var all: [String: String?] = ["Recursive": "true", "Limit": "30"]
            for (k, v) in q { all[k] = v }
            return try await items(c, "/Users/{U}/Items", all, ttl: ttl)
        }
    }

    public static func latest(_ parentId: String) -> @Sendable (JellyfinClient) async throws -> [BaseItem] {
        { c in try await c.get([BaseItem].self, "/Users/{U}/Items/Latest", common(["ParentId": parentId, "Limit": "30"]), ttl: 60) }
    }

    public static func rows(_ tab: Tab, userName: String) -> [RowDef] {
        let cw = "Continue Watching for \(userName)"
        switch tab {
        case .home:
            return [
                RowDef(id: "resume", title: cw, load: resume("Movie,Episode")),
                RowDef(id: "nextup", title: "Next Up", load: nextUp),
                RowDef(id: "favs", title: "My List", load: favourites("Movie,Series")),
                RowDef(id: "top", title: "Top Rated", load: query(["IncludeItemTypes": "Movie,Series", "SortBy": "CommunityRating", "SortOrder": "Descending", "MinCommunityRating": "7"])),
            ]
        case .movies:
            return [
                RowDef(id: "resume", title: cw, load: resume("Movie")),
                RowDef(id: "new", title: "Recently Added", kind: .poster, load: query(["IncludeItemTypes": "Movie", "SortBy": "DateCreated", "SortOrder": "Descending"])),
                RowDef(id: "favs", title: "My List", load: favourites("Movie")),
                RowDef(id: "top", title: "Top Rated Movies", load: query(["IncludeItemTypes": "Movie", "SortBy": "CommunityRating", "SortOrder": "Descending", "MinCommunityRating": "7"])),
                RowDef(id: "unwatched", title: "Not Watched Yet", load: query(["IncludeItemTypes": "Movie", "Filters": "IsUnplayed", "SortBy": "Random"])),
            ]
        case .shows:
            return [
                RowDef(id: "resume", title: cw, load: resume("Episode")),
                RowDef(id: "nextup", title: "Next Up", load: nextUp),
                RowDef(id: "new", title: "Recently Added Shows", kind: .poster, load: query(["IncludeItemTypes": "Series", "SortBy": "DateLastContentAdded", "SortOrder": "Descending"])),
                RowDef(id: "favs", title: "My List", load: favourites("Series")),
                RowDef(id: "top", title: "Top Rated Shows", load: query(["IncludeItemTypes": "Series", "SortBy": "CommunityRating", "SortOrder": "Descending"])),
                RowDef(id: "all", title: "All Shows", kind: .poster, load: query(["IncludeItemTypes": "Series", "SortBy": "SortName", "Limit": "100"])),
            ]
        case .myList:
            return [RowDef(id: "favs", title: "My List", kind: .poster, load: { c in
                try await items(c, "/Users/{U}/Items", ["Filters": "IsFavorite", "Recursive": "true", "IncludeItemTypes": "Movie,Series,Episode", "SortBy": "SortName", "Limit": "200"], ttl: 0)
            })]
        }
    }

    /// "Recently Added in <library>" rows (one per movie/TV library), shown on Home.
    public static func latestRows(_ c: JellyfinClient) async throws -> [RowDef] {
        let v = try await c.get(ViewsResponse.self, "/Users/{U}/Views", [:], ttl: 3600)
        return v.Items.filter { $0.CollectionType == "movies" || $0.CollectionType == "tvshows" }.map { lib in
            RowDef(id: "latest-\(lib.Id)", title: "Recently Added in " + (lib.Name ?? "").replacingOccurrences(of: "_", with: " "), kind: .poster, load: latest(lib.Id))
        }
    }

    /// Genre rows with at least 6 titles, biggest first.
    public static func genreRows(_ c: JellyfinClient, types: String, count: Int) async throws -> [RowDef] {
        let g = try await c.get(GenresResponse.self, "/Genres", ["UserId": "{U}", "IncludeItemTypes": types, "Recursive": "true", "SortBy": "SortName", "EnableTotalRecordCount": "false"], ttl: 3600)
        return g.Items.filter { ($0.ChildCount ?? 0) >= 6 }.sorted { ($0.ChildCount ?? 0) > ($1.ChildCount ?? 0) }.prefix(count).map { genre in
            RowDef(id: "g-\(types)-\(genre.Id)", title: genre.Name, load: query(["GenreIds": genre.Id, "IncludeItemTypes": types, "SortBy": "Random", "Limit": "30"], ttl: 600))
        }
    }

    /// Movies and shows first, then episodes: two queries, so a common word ("the") can't fill the list with episodes.
    public static func search(_ c: JellyfinClient, _ term: String) async throws -> (titles: [BaseItem], episodes: [BaseItem]) {
        async let titles = items(c, "/Users/{U}/Items", ["SearchTerm": term, "Recursive": "true", "IncludeItemTypes": "Movie,Series", "Limit": "28"], ttl: 300)
        async let eps = items(c, "/Users/{U}/Items", ["SearchTerm": term, "Recursive": "true", "IncludeItemTypes": "Episode", "Limit": "20"], ttl: 300)
        let t = try await titles
        let e = (try? await eps) ?? []
        return (t, e)
    }

    // MARK: details

    public static func item(_ c: JellyfinClient, _ id: String) async throws -> BaseItem {
        try await c.get(BaseItem.self, "/Users/{U}/Items/\(id)", ["Fields": "Overview,Path,Genres,People,Studios,MediaStreams,MediaSources,PremiereDate,ChildCount"], ttl: 0)
    }

    public static func seasons(_ c: JellyfinClient, seriesId: String) async throws -> [BaseItem] {
        try await c.get(ItemsResponse.self, "/Shows/\(seriesId)/Seasons", ["UserId": "{U}", "Fields": "Overview"], ttl: 60).Items
    }

    public static func episodes(_ c: JellyfinClient, seriesId: String, seasonId: String) async throws -> [BaseItem] {
        try await c.get(ItemsResponse.self, "/Shows/\(seriesId)/Episodes", common(["UserId": "{U}", "SeasonId": seasonId]), ttl: 30).Items
    }

    /// The episode Resume/Play should start for a series (next up, else the first).
    public static func nextEpisode(_ c: JellyfinClient, seriesId: String) async throws -> BaseItem? {
        if let e = try await c.get(ItemsResponse.self, "/Shows/NextUp", common(["UserId": "{U}", "SeriesId": seriesId, "Limit": "1", "EnableResumable": "true"]), ttl: 0).Items.first { return e }
        return try await c.get(ItemsResponse.self, "/Shows/\(seriesId)/Episodes", common(["UserId": "{U}", "Limit": "1"]), ttl: 0).Items.first
    }

    /// The episode after this one (for the next-episode card), nil at the end of the show.
    public static func episodeAfter(_ c: JellyfinClient, _ ep: BaseItem) async throws -> BaseItem? {
        guard let sid = ep.SeriesId else { return nil }
        let r = try await c.get(ItemsResponse.self, "/Shows/\(sid)/Episodes", common(["UserId": "{U}", "StartItemId": ep.Id, "Limit": "2"]), ttl: 30)
        return r.Items.count > 1 ? r.Items[1] : nil
    }

    public static func setFavourite(_ c: JellyfinClient, _ id: String, _ on: Bool) async throws -> UserData {
        let d = try await c.send(on ? "POST" : "DELETE", "/Users/{U}/FavoriteItems/\(id)")
        c.invalidate("IsFavorite", "/Items/\(id)")
        return (try? JSONDecoder().decode(UserData.self, from: d)) ?? UserData(IsFavorite: on)
    }

    public static func setPlayed(_ c: JellyfinClient, _ id: String, _ on: Bool) async throws {
        try await c.send(on ? "POST" : "DELETE", "/Users/{U}/PlayedItems/\(id)")
        c.invalidate("Resume", "NextUp", "/Items/\(id)")
    }

    public static func segments(_ c: JellyfinClient, _ id: String) async -> [Segment] {
        guard let r = try? await c.get(MediaSegmentsResponse.self, "/MediaSegments/\(id)", [:], ttl: 600) else { return [] }
        return Segments.from(r)
    }
}

// MARK: artwork choice (same order as the TV app)

public enum Art {
    public struct Pick: Sendable, Equatable { public var id: String; public var type: String; public var tag: String; public var hasTitle: Bool }

    /// Landscape card art.
    public static func card(_ it: BaseItem) -> Pick? {
        let T = it.ImageTags ?? [:]
        if it.isEpisode, let p = T["Primary"] { return Pick(id: it.Id, type: "Primary", tag: p, hasTitle: false) }
        if let t = T["Thumb"] { return Pick(id: it.Id, type: "Thumb", tag: t, hasTitle: true) }
        if it.isEpisode, let pid = it.ParentThumbItemId, let tag = it.ParentThumbImageTag { return Pick(id: pid, type: "Thumb", tag: tag, hasTitle: true) }
        if let b = it.BackdropImageTags?.first { return Pick(id: it.Id, type: "Backdrop", tag: b, hasTitle: false) }
        if let pid = it.ParentBackdropItemId, let b = it.ParentBackdropImageTags?.first { return Pick(id: pid, type: "Backdrop", tag: b, hasTitle: false) }
        if let p = T["Primary"] { return Pick(id: it.Id, type: "Primary", tag: p, hasTitle: false) }
        return nil
    }

    /// Portrait poster art.
    public static func poster(_ it: BaseItem) -> Pick? {
        if it.isEpisode, let sid = it.SeriesId, let tag = it.SeriesPrimaryImageTag { return Pick(id: sid, type: "Primary", tag: tag, hasTitle: true) }
        if let p = it.ImageTags?["Primary"] { return Pick(id: it.Id, type: "Primary", tag: p, hasTitle: true) }
        return card(it)
    }

    public static func backdrop(_ it: BaseItem) -> Pick? {
        if let b = it.BackdropImageTags?.first { return Pick(id: it.Id, type: "Backdrop", tag: b, hasTitle: false) }
        if let pid = it.ParentBackdropItemId, let b = it.ParentBackdropImageTags?.first { return Pick(id: pid, type: "Backdrop", tag: b, hasTitle: false) }
        if let t = it.ImageTags?["Thumb"] { return Pick(id: it.Id, type: "Thumb", tag: t, hasTitle: true) }
        if it.isEpisode, let p = it.ImageTags?["Primary"] { return Pick(id: it.Id, type: "Primary", tag: p, hasTitle: false) }
        return nil
    }

    public static func logo(_ it: BaseItem) -> Pick? {
        if let l = it.ImageTags?["Logo"] { return Pick(id: it.Id, type: "Logo", tag: l, hasTitle: true) }
        if let pid = it.ParentLogoItemId, let tag = it.ParentLogoImageTag { return Pick(id: pid, type: "Logo", tag: tag, hasTitle: true) }
        return nil
    }

    public static func url(_ c: JellyfinClient, _ p: Pick?, width: Int, height: Int? = nil, quality: Int = 80) -> URL? {
        guard let p else { return nil }
        return c.imageURL(p.id, p.type, tag: p.tag, width: width, height: height, quality: quality)
    }
}
