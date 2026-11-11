// Server addresses: a main one and a backup. The app tries them in order and uses the first that answers.
// Defaults (owner decision JTV-L0039): jellyfin.home works at home and away from home over Tailscale
// (split DNS for .home, NET-17); 192.168.0.154:8097 is reachable over the Tailscale subnet route too.
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct ServerAddresses: Codable, Equatable, Sendable {
    public var main: String
    public var backup: String

    public static let defaults = ServerAddresses(main: "http://jellyfin.home", backup: "http://192.168.0.154:8097")

    public init(main: String, backup: String) {
        self.main = main
        self.backup = backup
    }

    /// Valid, de-duplicated URLs in the order to try.
    public var candidates: [URL] {
        var out: [URL] = []
        for s in [main, backup] {
            guard let u = ServerAddresses.normalize(s), !out.contains(u) else { continue }
            out.append(u)
        }
        return out
    }

    /// "jellyfin.home" -> http://jellyfin.home ; trims spaces and trailing slashes; nil if not a usable URL.
    public static func normalize(_ raw: String) -> URL? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return nil }
        if !s.lowercased().hasPrefix("http://") && !s.lowercased().hasPrefix("https://") { s = "http://" + s }
        while s.hasSuffix("/") { s.removeLast() }
        guard let u = URL(string: s), let host = u.host, !host.isEmpty, !host.contains(" ") else { return nil }
        return u
    }
}

public struct ServerProbe: Sendable {
    public var url: URL
    public var name: String?
    public var version: String?
    public var serverId: String?
    public var millis: Int
}

public enum ServerFinder {
    /// Asks /System/Info/Public on each candidate (main first) and returns the first that answers.
    public static func find(_ addrs: ServerAddresses, info: ClientInfo, timeout: TimeInterval = 4) async -> Result<ServerProbe, JFError> {
        var last: JFError = .unreachable(addrs.main)
        for u in addrs.candidates {
            let t0 = Date()
            let c = JellyfinClient(server: u, info: info)
            do {
                let i = try await c.publicInfo(timeout: timeout)
                return .success(ServerProbe(url: u, name: i.ServerName, version: i.Version, serverId: i.Id, millis: Int(Date().timeIntervalSince(t0) * 1000)))
            } catch let e as JFError {
                last = e
            } catch {
                last = .unreachable(u.host ?? u.absoluteString)
            }
        }
        if addrs.candidates.isEmpty { return .failure(.badAnswer("no valid address")) }
        return .failure(last)
    }
}
