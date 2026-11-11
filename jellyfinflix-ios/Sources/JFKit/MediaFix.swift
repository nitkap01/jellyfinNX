// "Fix Audio" / "Fetch Subtitle" (admin only): the same mediafix-helper calls as the TV app
// (jellyfinflix/src/mediafix.js). Helper API: POST /jobs {action, path} -> 202 {jobId};
// GET /jobs/{id} -> {state, exitCode, resultStatus, output}; GET /status?path= -> {state, fixed, progressPercent, ...}.
// The helper is on the home network (CT 105 :8099); away from home it is reached over the Tailscale subnet route.
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum FixAction: String, Sendable {
    case audio = "fix-audio"
    case subtitle = "fix-subtitle"

    public var title: String { self == .audio ? "Fix Audio" : "Fetch Subtitle" }
    var pollSeconds: Double { self == .audio ? 10 : 2 }
    var capSeconds: Double { self == .audio ? 45 * 60 : 5 * 60 }
}

public struct FixStatus: Codable, Sendable, Equatable {
    public var state: String?
    public var fixed: Bool?
    public var progressPhase: String?
    public var progressPercent: Int?
    public var lastResultStatus: String?

    public init(state: String? = nil, fixed: Bool? = nil, progressPhase: String? = nil, progressPercent: Int? = nil, lastResultStatus: String? = nil) {
        self.state = state; self.fixed = fixed; self.progressPhase = progressPhase; self.progressPercent = progressPercent; self.lastResultStatus = lastResultStatus
    }

    /// Chip text for the details page / More menu: "Audio fixed", "Fixing 42%", "Last fix failed", or nil.
    public var badge: (text: String, kind: String)? {
        if state == "running" { return ("Fixing " + (progressPercent.map { "\($0)%" } ?? "…"), "run") }
        if fixed == true { return ("Audio fixed", "ok") }
        if let l = lastResultStatus, !l.hasPrefix("OK"), !l.hasPrefix("DRYRUN") { return ("Last fix failed", "bad") }
        return nil
    }
}

public struct FixJob: Codable, Sendable {
    public var state: String
    public var exitCode: Int?
    public var resultStatus: String?
    public var output: String?

    public init(state: String, exitCode: Int? = nil, resultStatus: String? = nil, output: String? = nil) {
        self.state = state; self.exitCode = exitCode; self.resultStatus = resultStatus; self.output = output
    }
}

public enum FixOutcome: Sendable, Equatable {
    case done(String)          // success message
    case failed(String, String) // title, message
}

public final class MediaFixClient: @unchecked Sendable {
    public static let defaultURL = "http://192.168.0.154:8099"
    public let base: URL
    let session: URLSession

    public init(base: URL = URL(string: MediaFixClient.defaultURL)!, session: URLSession = .shared) {
        self.base = base
        self.session = session
    }

    public static func canFix(_ it: BaseItem, isAdmin: Bool) -> Bool {
        guard isAdmin, it.isMovie || it.isEpisode, it.LocationType != "Virtual", let p = it.Path else { return false }
        return p.hasPrefix("/MEDIA/")
    }

    public func status(path: String) async -> FixStatus? {
        guard path.hasPrefix("/MEDIA/") else { return nil }
        var c = URLComponents(url: base.appendingPathComponent("status"), resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "path", value: path)]
        var r = URLRequest(url: c.url!)
        r.cachePolicy = .reloadIgnoringLocalCacheData
        r.timeoutInterval = 8
        guard let (d, resp) = try? await session.data(for: r), (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONDecoder().decode(FixStatus.self, from: d)
    }

    public func start(_ action: FixAction, path: String) async throws -> String {
        var r = URLRequest(url: base.appendingPathComponent("jobs"))
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = try JSONSerialization.data(withJSONObject: ["action": action.rawValue, "path": path])
        r.timeoutInterval = 10
        let d: Data, resp: URLResponse
        do { (d, resp) = try await session.data(for: r) } catch {
            throw JFError.badAnswer("The media fix helper is not reachable (\(base.absoluteString)).")
        }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 202, let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let id = j["jobId"] as? String { return id }
        if code == 409 { throw JFError.badAnswer("A fix is already running for this file.") }
        let j = (try? JSONSerialization.jsonObject(with: d) as? [String: Any]) ?? [:]
        throw JFError.badAnswer((j["detail"] as? String) ?? (j["error"] as? String) ?? "HTTP \(code)")
    }

    public func job(_ id: String) async throws -> FixJob {
        var r = URLRequest(url: base.appendingPathComponent("jobs").appendingPathComponent(id))
        r.cachePolicy = .reloadIgnoringLocalCacheData
        r.timeoutInterval = 10
        let (d, resp) = try await session.data(for: r)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw JFError.http((resp as? HTTPURLResponse)?.statusCode ?? 0) }
        return try JSONDecoder().decode(FixJob.self, from: d)
    }

    /// Polls until the job ends (or the time cap), then turns the result into the TV app's wording.
    public func wait(_ action: FixAction, jobId: String, sleep: @Sendable (Double) async -> Void = { try? await Task.sleep(nanoseconds: UInt64($0 * 1e9)) }) async -> FixOutcome {
        let t0 = Date()
        var fails = 0
        while Date().timeIntervalSince(t0) < action.capSeconds {
            await sleep(action.pollSeconds)
            if Task.isCancelled { return .failed(action.title, "Still running on the server (job \(jobId)). Check again later.") }
            guard let j = try? await job(jobId) else {
                fails += 1
                if fails >= 3 { return .failed(action.title, "Lost contact with the helper (job \(jobId)).") }
                continue
            }
            fails = 0
            if j.state != "running" { return MediaFixClient.outcome(action, j) }
        }
        return .failed(action.title, "Still running on the server (job \(jobId)). Check again later.")
    }

    static let subMsg: [Int: String] = [
        1: "The subtitle tool isn't set up on the server (subliminal is missing).",
        2: "Couldn't work out which video file to use for this movie.",
        3: "No matching English subtitle was found for this movie.",
        4: "Found a subtitle but couldn't save it to the NAS.",
        6: "The NAS credentials file on the server is missing or has the wrong permissions.",
    ]
    static let audioMsg: [Int: String] = [
        1: "A tool the audio fixer needs is missing on the server.",
        3: "Couldn't read the audio track to measure it.",
        4: "The re-encode failed. Nothing on the NAS was changed.",
        5: "The new file failed its safety checks and was thrown away. Your movie is untouched.",
        6: "NAS login problem. Nothing was changed.",
        7: "Couldn't write to the NAS. Your movie is untouched — safe to retry.",
        8: "The movie may not be at its expected filename. Do not retry — every future Fix Audio will also fail this way until the leftover journal file on the server is cleared by hand.",
    ]

    static func tail(_ s: String?) -> String { (s ?? "").split(separator: "\n").suffix(6).joined(separator: "\n") }

    public static func outcome(_ action: FixAction, _ j: FixJob) -> FixOutcome {
        let code = j.exitCode ?? -1
        if action == .subtitle {
            if j.state == "succeeded" { return .done("Subtitle downloaded and saved next to the movie. Jellyfin has been asked to re-check this item.") }
            return .failed("Fetch Subtitle", subMsg[code] ?? "The subtitle tool failed (exit \(code)).\n" + tail(j.output))
        }
        switch j.resultStatus {
        case "OK_NOFIX": return .done("Audio is already fine — nothing was changed.")
        case "OK_FIXED": return .done("Audio fixed and verified. The original has been deleted automatically. Jellyfin has been asked to re-check this item.")
        case "OK_LOCAL_ONLY": return .done("Audio was fixed but the file isn't on the NAS, so the new copy was left on the server.")
        default: break
        }
        if code == 0 && j.resultStatus == nil { return .done("Audio fixed and verified. The original has been deleted automatically. Jellyfin has been asked to re-check this item.") }
        let o = j.output ?? ""
        var msg = audioMsg[code]
        if code == 2 {
            if o.contains("Another run is already in progress") { msg = "Another audio fix is already running." }
            else if o.contains("Already processed") { msg = "A leftover .pre-audiofix backup exists, likely from a previous fix whose auto-cleanup failed. Remove it by hand on the server before fixing this movie again." }
            else if o.contains("Ambiguous") { msg = "That folder has more than one video file. Open the exact file and try again." }
            else if o.contains("Not enough") { msg = "Not enough free space." }
            else { msg = "Couldn't start the audio fix.\n" + tail(o) }
        }
        return .failed(code == 8 ? "Needs a human" : "Fix Audio", msg ?? "The audio fixer failed (exit \(code)).")
    }

    /// Asks Jellyfin to re-read the item after a fix (new audio / new subtitle file).
    public static func refresh(_ c: JellyfinClient, itemId: String) async {
        _ = try? await c.send("POST", "/Items/\(itemId)/Refresh", query: ["Recursive": "false", "ImageRefreshMode": "Default", "MetadataRefreshMode": "Default", "ReplaceAllImages": "false", "ReplaceAllMetadata": "false"])
    }
}
