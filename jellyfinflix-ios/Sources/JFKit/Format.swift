// Text helpers shared by the screens (same wording as the TV app, jellyfinflix/src/util.js).
import Foundation

public enum Fmt {
    /// 1:02:03 or 4:05
    public static func clock(_ seconds: Double) -> String {
        let s = max(0, Int(seconds.isFinite ? seconds : 0))
        let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
    }

    /// "42m" / "2h 7m" from ticks; "" when unknown.
    public static func runtime(_ ticks: Int64?) -> String {
        guard let t = ticks, t > 0 else { return "" }
        return minutes(Int((Double(t) / 6e8).rounded()))
    }

    static func minutes(_ min: Int) -> String { min < 60 ? "\(min)m" : "\(min / 60)h \(min % 60)m" }

    /// "8m" left for a started item (at least 1m), nil when not started.
    public static func timeLeft(_ it: BaseItem) -> String? {
        guard let rt = it.RunTimeTicks, rt > 0, it.positionTicks > 0 else { return nil }
        let left = max(1, Int((Double(rt - it.positionTicks) / 6e8).rounded()))
        return minutes(left)
    }

    /// "S3:E5"
    public static func episode(_ it: BaseItem) -> String {
        guard it.isEpisode else { return "" }
        var s = ""
        if let p = it.ParentIndexNumber { s += "S\(p)" }
        if let e = it.IndexNumber { s += ":E\(e)" }
        return s
    }

    static let months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]

    static func parseDate(_ iso: String?) -> Date? {
        guard let iso, !iso.isEmpty else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: iso) { return d }
        f.formatOptions = [.withInternetDateTime]
        if let d = f.date(from: iso) { return d }
        // Jellyfin sometimes sends 7 fraction digits; cut to 3
        if let r = iso.range(of: #"\.\d+"#, options: .regularExpression) {
            var s = iso
            let frac = String(iso[r].prefix(4))
            s.replaceSubrange(r, with: frac)
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return f.date(from: s)
        }
        return nil
    }

    /// "22nd September 1994" (Jellyfin's PremiereDate is UTC midnight).
    public static func airDate(_ iso: String?) -> String {
        guard let d = parseDate(iso) else { return "" }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let c = cal.dateComponents([.day, .month, .year], from: d)
        guard let day = c.day, let mo = c.month, let y = c.year else { return "" }
        let t = day % 100
        let sfx = (11...13).contains(t) ? "th" : [1: "st", 2: "nd", 3: "rd"][day % 10] ?? "th"
        return "\(day)\(sfx) \(months[mo - 1]) \(y)"
    }

    /// "Aired 22nd September 1994" / "Released 19th November 1975" / "".
    public static func aired(_ it: BaseItem) -> String {
        guard it.isEpisode || it.isMovie else { return "" }
        let s = airDate(it.PremiereDate)
        return s.isEmpty ? "" : (it.isMovie ? "Released " : "Aired ") + s
    }

    /// "32 years ago"
    public static func ago(_ it: BaseItem, now: Date = Date()) -> String {
        guard it.isEpisode || it.isMovie, let d = parseDate(it.PremiereDate), d <= now else { return "" }
        let y = Int(now.timeIntervalSince(d) / (365.2425 * 86400))
        return y < 1 ? "Less than a year ago" : y == 1 ? "1 year ago" : "\(y) years ago"
    }

    /// "Resume · 8m left" / "Play"
    public static func playLabel(_ it: BaseItem) -> String {
        if let l = timeLeft(it) { return "Resume · \(l) left" }
        return "Play"
    }

    /// "Ends at 9:50 PM" if playback resumed now.
    public static func endsAt(remainingSeconds: Double, now: Date = Date(), timeZone: TimeZone = .current) -> String {
        "Ends at " + timeOfDay(now.addingTimeInterval(max(0, remainingSeconds)), timeZone: timeZone)
    }

    public static func timeOfDay(_ d: Date, timeZone: TimeZone = .current) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = timeZone
        f.dateFormat = "h:mm a"
        return f.string(from: d)
    }

    /// "1998 · IN-U · 8 Seasons · ★ 7.9" pieces for the details page.
    public static func facts(_ it: BaseItem) -> [String] {
        var out: [String] = []
        if let y = it.ProductionYear { out.append(String(y)) }
        if let r = it.OfficialRating, !r.isEmpty { out.append(r) }
        if it.isSeries, let n = it.ChildCount { out.append(n == 1 ? "1 Season" : "\(n) Seasons") }
        else if !it.isSeries { let r = runtime(it.RunTimeTicks); if !r.isEmpty { out.append(r) } }
        if let c = it.CommunityRating, c > 0 { out.append(String(format: "★ %.1f", c)) }
        return out
    }
}
