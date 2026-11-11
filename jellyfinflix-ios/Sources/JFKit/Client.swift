// Small Jellyfin HTTP client: auth header, JSON GET/POST, a short in-memory cache, and image URLs.
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum JFError: Error, Equatable, LocalizedError {
    case unreachable(String)
    case signedOut
    case wrongPassword
    case http(Int)
    case badAnswer(String)

    public var errorDescription: String? {
        switch self {
        case .unreachable(let s): return "Can't reach the Jellyfin server (\(s)). At home check Wi-Fi; away from home turn Tailscale on."
        case .signedOut: return "You were signed out. Please sign in again."
        case .wrongPassword: return "Wrong password."
        case .http(let c): return "The server said no (HTTP \(c))."
        case .badAnswer(let s): return "The server sent something unexpected (\(s))."
        }
    }
}

public struct ClientInfo: Sendable {
    public var client = "JellyfinFlix iOS"
    public var device = "iPhone"
    public var deviceId: String
    public var version = "0.1.0"
    public init(deviceId: String, device: String = "iPhone", version: String = "0.1.0") {
        self.deviceId = deviceId
        self.device = device
        self.version = version
    }

    public func authHeader(token: String?) -> String {
        func q(_ s: String) -> String { s.replacingOccurrences(of: "\"", with: "'") }
        var h = "MediaBrowser Client=\"\(q(client))\", Device=\"\(q(device))\", DeviceId=\"\(q(deviceId))\", Version=\"\(q(version))\""
        if let t = token, !t.isEmpty { h += ", Token=\"\(t)\"" }
        return h
    }
}

/// One signed-in session against one server address.
public final class JellyfinClient: @unchecked Sendable {
    public let server: URL
    public let info: ClientInfo
    public private(set) var token: String?
    public private(set) var userId: String?
    public var onSignedOut: (@Sendable () -> Void)?

    private let session: URLSession
    private let lock = NSLock()
    private var cache: [String: (Date, Data)] = [:]

    public init(server: URL, info: ClientInfo, token: String? = nil, userId: String? = nil, session: URLSession? = nil) {
        self.server = server
        self.info = info
        self.token = token
        self.userId = userId
        if let session { self.session = session } else {
            let cfg = URLSessionConfiguration.default
            cfg.timeoutIntervalForRequest = 15
            self.session = URLSession(configuration: cfg)
        }
    }

    // MARK: URLs

    /// Builds server URL for a path; "{U}" in the path or a value becomes the user id.
    public func url(_ path: String, _ query: [String: String?] = [:], withToken: Bool = false) -> URL {
        let uid = userId ?? ""
        var comps = URLComponents(url: server, resolvingAgainstBaseURL: false)!
        let base = comps.path.hasSuffix("/") ? String(comps.path.dropLast()) : comps.path
        comps.path = base + path.replacingOccurrences(of: "{U}", with: uid)
        var items: [URLQueryItem] = []
        for (k, v) in query.sorted(by: { $0.key < $1.key }) {
            guard let v, !v.isEmpty else { continue }
            items.append(URLQueryItem(name: k, value: v == "{U}" ? uid : v))
        }
        if withToken, let t = token { items.append(URLQueryItem(name: "api_key", value: t)) }
        comps.queryItems = items.isEmpty ? nil : items
        // '+' must be escaped or the server reads it as a space
        comps.percentEncodedQuery = comps.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return comps.url!
    }

    /// Absolute URL for a server-relative path that may already carry a query (e.g. TranscodingUrl).
    public func absolute(_ relative: String, addToken: Bool = true) -> URL? {
        var s = server.absoluteString
        if s.hasSuffix("/") { s.removeLast() }
        var full = s + (relative.hasPrefix("/") ? relative : "/" + relative)
        if addToken, let t = token, full.range(of: "api_key=", options: .caseInsensitive) == nil, full.range(of: "ApiKey=", options: .caseInsensitive) == nil {
            full += (full.contains("?") ? "&" : "?") + "api_key=" + t
        }
        return URL(string: full)
    }

    // MARK: requests

    func request(_ method: String, _ url: URL, body: Data? = nil, timeout: TimeInterval? = nil) -> URLRequest {
        var r = URLRequest(url: url)
        r.httpMethod = method
        r.setValue(info.authHeader(token: token), forHTTPHeaderField: "Authorization")
        r.setValue(info.authHeader(token: token), forHTTPHeaderField: "X-Emby-Authorization")
        if let body {
            r.httpBody = body
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let timeout { r.timeoutInterval = timeout }
        return r
    }

    func perform(_ req: URLRequest) async throws -> Data {
        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await session.data(for: req)
        } catch {
            throw JFError.unreachable(server.host ?? server.absoluteString)
        }
        guard let http = resp as? HTTPURLResponse else { throw JFError.badAnswer("no HTTP") }
        if http.statusCode == 401 {
            if token != nil { onSignedOut?() }
            throw JFError.signedOut
        }
        guard (200..<300).contains(http.statusCode) else { throw JFError.http(http.statusCode) }
        return data
    }

    /// GET JSON with an optional cache lifetime in seconds (0 = no cache).
    public func get<T: Decodable>(_ type: T.Type, _ path: String, _ query: [String: String?] = [:], ttl: TimeInterval = 0) async throws -> T {
        let u = url(path, query)
        let key = u.absoluteString
        if ttl > 0 {
            let hit: Data? = lock.synced {
                if let (t, d) = cache[key], Date().timeIntervalSince(t) < ttl { return d }
                return nil
            }
            if let hit { return try decode(type, hit) }
        }
        let d = try await perform(request("GET", u))
        if ttl > 0 { lock.synced { cache[key] = (Date(), d) } }
        return try decode(type, d)
    }

    @discardableResult
    public func send(_ method: String, _ path: String, json: [String: Any]? = nil, query: [String: String?] = [:]) async throws -> Data {
        let body = try json.map { try JSONSerialization.data(withJSONObject: $0) }
        return try await perform(request(method, url(path, query), body: body))
    }

    public func sendDecodable<T: Decodable>(_ type: T.Type, _ method: String, _ path: String, json: [String: Any]? = nil, query: [String: String?] = [:]) async throws -> T {
        try decode(type, try await send(method, path, json: json, query: query))
    }

    /// Drops cached answers whose URL contains any of the given fragments.
    public func invalidate(_ parts: String...) {
        lock.synced {
            for k in cache.keys where parts.contains(where: { k.contains($0) }) { cache.removeValue(forKey: k) }
        }
    }

    public func invalidateAll() { lock.synced { cache.removeAll() } }

    func decode<T: Decodable>(_ type: T.Type, _ d: Data) throws -> T {
        do { return try JSONDecoder().decode(type, from: d) } catch { throw JFError.badAnswer(String(describing: type)) }
    }

    // MARK: sign-in

    public func publicInfo(timeout: TimeInterval = 5) async throws -> PublicSystemInfo {
        let d = try await perform(request("GET", url("/System/Info/Public"), timeout: timeout))
        return try decode(PublicSystemInfo.self, d)
    }

    public func publicUsers() async throws -> [PublicUser] {
        try await get([PublicUser].self, "/Users/Public")
    }

    /// Signs in; on success this client carries the token and user id.
    public func signIn(user: String, password: String) async throws -> AuthResult {
        let body = try JSONSerialization.data(withJSONObject: ["Username": user, "Pw": password])
        var req = request("POST", url("/Users/AuthenticateByName"), body: body)
        req.setValue(info.authHeader(token: nil), forHTTPHeaderField: "Authorization")
        req.setValue(info.authHeader(token: nil), forHTTPHeaderField: "X-Emby-Authorization")
        do {
            let d = try await perform(req)
            let r = try decode(AuthResult.self, d)
            token = r.AccessToken
            userId = r.User.Id
            invalidateAll()
            return r
        } catch JFError.signedOut {
            throw JFError.wrongPassword
        }
    }

    /// Ends the session on the server (token stops working).
    public func signOut() async {
        _ = try? await send("POST", "/Sessions/Logout")
        token = nil
    }

    // MARK: images (Jellyfin serves images without a login)

    public func imageURL(_ id: String, _ type: String, tag: String?, width: Int, height: Int? = nil, quality: Int = 80) -> URL? {
        guard let tag, !tag.isEmpty else { return nil }
        return url("/Items/\(id)/Images/\(type)", ["fillWidth": String(width), "fillHeight": height.map(String.init), "quality": String(quality), "tag": tag])
    }

    public func userImageURL(_ userId: String, tag: String?, size: Int) -> URL? {
        guard let tag, !tag.isEmpty else { return nil }
        return url("/Users/\(userId)/Images/Primary", ["fillWidth": String(size), "fillHeight": String(size), "quality": "85", "tag": tag])
    }
}

extension NSLock {
    func synced<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}
