// App state: server addresses, saved profile logins (tokens in the Keychain), the signed-in session,
// what is playing, and small messages (toasts / alerts).
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import UIKit
import Network
import Security
import JFKit

struct SavedLogin: Codable, Identifiable, Hashable {
    var id: String          // Jellyfin user id
    var name: String
    var imageTag: String?
    var admin: Bool
    var serverId: String?
}

struct Session {
    var client: JellyfinClient
    var user: SavedLogin
}

struct PlayRequest: Identifiable {
    let id = UUID()
    var item: BaseItem
    var fromStart: Bool
}

struct AppAlert: Identifiable {
    let id = UUID()
    var title: String
    var message: String
}

enum ServerState: Equatable {
    case checking
    case ok(name: String, version: String, url: URL, millis: Int)
    case failed(String)
}

@MainActor
final class AppModel: ObservableObject {
    @Published var addresses: ServerAddresses
    @Published var serverState: ServerState = .checking
    @Published var publicUsers: [PublicUser] = []
    @Published var saved: [SavedLogin] = []
    @Published var session: Session?
    @Published var playRequest: PlayRequest?
    @Published var alert: AppAlert?
    @Published var toast: String?
    /// Bumped after playback / My List changes so rows reload.
    @Published var refreshTick = 0
    @Published var quality: Quality
    @Published var cellularQuality: Quality
    @Published var autoplayNext: Bool
    @Published var mediaFixURL: String
    @Published var onCellular = false

    let deviceId: String
    private let defaults = UserDefaults.standard
    private var serverURL: URL?
    private var serverId: String?
    private let pathMonitor = NWPathMonitor()
    private var toastTask: Task<Void, Never>?

    init() {
        let d = UserDefaults.standard
        if let id = d.string(forKey: "deviceId") { deviceId = id } else {
            let id = "jfx-ios-" + UUID().uuidString.lowercased()
            d.set(id, forKey: "deviceId")
            deviceId = id
        }
        if let data = d.data(forKey: "addresses"), let a = try? JSONDecoder().decode(ServerAddresses.self, from: data) { addresses = a } else { addresses = .defaults }
        quality = Quality(rawValue: d.integer(forKey: "quality")) ?? .original
        cellularQuality = Quality(rawValue: d.integer(forKey: "cellularQuality")) ?? .q8
        autoplayNext = d.object(forKey: "autoplayNext") as? Bool ?? true
        mediaFixURL = d.string(forKey: "mediaFixURL") ?? MediaFixClient.defaultURL
        if let data = d.data(forKey: "saved"), let s = try? JSONDecoder().decode([SavedLogin].self, from: data) { saved = s }
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let cell = path.usesInterfaceType(.cellular) && !path.usesInterfaceType(.wifi)
            Task { @MainActor in self?.onCellular = cell }
        }
        pathMonitor.start(queue: DispatchQueue(label: "jfx.path"))
    }

    var clientInfo: ClientInfo {
        ClientInfo(deviceId: deviceId, device: UIDevice.current.name.isEmpty ? "iPhone" : UIDevice.current.name, version: Self.appVersion)
    }

    static var appVersion: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0" }

    /// Bitrate cap in use right now (mobile data has its own setting).
    var activeQuality: Quality { onCellular ? cellularQuality : quality }

    var mediaFix: MediaFixClient { MediaFixClient(base: URL(string: mediaFixURL) ?? URL(string: MediaFixClient.defaultURL)!) }

    // MARK: start-up

    func start() async {
        await connect()
        // one saved login on this server: go straight in (like the TV app's last profile)
        if session == nil, let last = defaults.string(forKey: "lastUser"), let s = saved.first(where: { $0.id == last }), Keychain.get(s.id) != nil, serverURL != nil {
            await use(s, quiet: true)
        }
    }

    /// Back from the background: if the server address stopped answering (left home Wi-Fi), find it again.
    func cameBack() async {
        guard let s = session else { return }
        do { _ = try await s.client.publicInfo(timeout: 3) } catch {
            await connect()
            if let url = serverURL, url != s.client.server, let token = Keychain.get(s.user.id) {
                let c = makeClient(url: url, token: token, userId: s.user.id)
                session = Session(client: c, user: s.user)
                refreshTick += 1
            }
        }
    }

    func connect() async {
        serverState = .checking
        switch await ServerFinder.find(addresses, info: clientInfo) {
        case .success(let p):
            serverURL = p.url
            serverId = p.serverId
            serverState = .ok(name: p.name ?? "Jellyfin", version: p.version ?? "", url: p.url, millis: p.millis)
            let c = JellyfinClient(server: p.url, info: clientInfo)
            publicUsers = (try? await c.publicUsers()) ?? []
        case .failure(let e):
            serverURL = nil
            serverState = .failed(e.localizedDescription)
            publicUsers = []
        }
    }

    func saveAddresses(_ a: ServerAddresses) async {
        addresses = a
        if let d = try? JSONEncoder().encode(a) { defaults.set(d, forKey: "addresses") }
        await connect()
    }

    // MARK: profiles

    /// Profiles to show: saved logins first, then the server's public users not yet saved.
    var profiles: [(id: String, name: String, imageTag: String?, saved: Bool, hasPassword: Bool)] {
        var out: [(String, String, String?, Bool, Bool)] = []
        var seen = Set<String>()
        for s in saved where serverId == nil || s.serverId == nil || s.serverId == serverId {
            out.append((s.id, s.name, s.imageTag, true, true)); seen.insert(s.id)
        }
        for u in publicUsers where !seen.contains(u.Id) {
            out.append((u.Id, u.Name, u.PrimaryImageTag, false, u.HasPassword ?? true))
        }
        return out.map { (id: $0.0, name: $0.1, imageTag: $0.2, saved: $0.3, hasPassword: $0.4) }
    }

    func userImageURL(_ id: String, tag: String?) -> URL? {
        guard let url = serverURL else { return nil }
        return JellyfinClient(server: url, info: clientInfo).userImageURL(id, tag: tag, size: 240)
    }

    private func makeClient(url: URL, token: String?, userId: String?) -> JellyfinClient {
        let c = JellyfinClient(server: url, info: clientInfo, token: token, userId: userId)
        c.onSignedOut = { [weak self] in
            Task { @MainActor in self?.signedOutByServer() }
        }
        return c
    }

    func signIn(name: String, password: String) async throws {
        guard let url = serverURL else { throw JFError.unreachable(addresses.main) }
        let c = makeClient(url: url, token: nil, userId: nil)
        let r = try await c.signIn(user: name, password: password)
        let login = SavedLogin(id: r.User.Id, name: r.User.Name, imageTag: r.User.PrimaryImageTag, admin: r.User.Policy?.IsAdministrator ?? false, serverId: serverId)
        Keychain.set(r.AccessToken, for: login.id)
        saved.removeAll { $0.id == login.id }
        saved.insert(login, at: 0)
        persistSaved()
        defaults.set(login.id, forKey: "lastUser")
        session = Session(client: c, user: login)
    }

    /// Opens a saved profile with its stored token. Returns false if a password is needed again.
    @discardableResult
    func use(_ s: SavedLogin, quiet: Bool = false) async -> Bool {
        guard let url = serverURL else {
            if !quiet { alert = AppAlert(title: "Server not reachable", message: serverMessage) }
            return false
        }
        guard let token = Keychain.get(s.id) else { return false }
        let c = makeClient(url: url, token: token, userId: s.id)
        do {
            _ = try await c.get(UserDto.self, "/Users/{U}")
            defaults.set(s.id, forKey: "lastUser")
            session = Session(client: c, user: s)
            return true
        } catch JFError.signedOut {
            Keychain.delete(s.id)
            if !quiet { show("Please sign in again") }
            return false
        } catch {
            if !quiet { alert = AppAlert(title: "Could not open \(s.name)", message: error.localizedDescription) }
            return false
        }
    }

    var serverMessage: String {
        if case .failed(let m) = serverState { return m }
        return "Can't reach the Jellyfin server. At home check Wi-Fi; away from home turn Tailscale on."
    }

    func forget(_ id: String) {
        Keychain.delete(id)
        saved.removeAll { $0.id == id }
        persistSaved()
    }

    func switchProfile() {
        playRequest = nil
        session = nil
        defaults.removeObject(forKey: "lastUser")
    }

    func signOut() async {
        guard let s = session else { return }
        await s.client.signOut()
        forget(s.user.id)
        switchProfile()
    }

    private func signedOutByServer() {
        guard let s = session else { return }
        Keychain.delete(s.user.id)
        playRequest = nil
        session = nil
        alert = AppAlert(title: "Signed out", message: "The server ended this login (for example after a password change). Please sign in again.")
    }

    private func persistSaved() {
        if let d = try? JSONEncoder().encode(saved) { defaults.set(d, forKey: "saved") }
    }

    // MARK: settings

    func setQuality(_ q: Quality, cellular: Bool) {
        if cellular { cellularQuality = q; defaults.set(q.rawValue, forKey: "cellularQuality") } else { quality = q; defaults.set(q.rawValue, forKey: "quality") }
    }

    func setAutoplay(_ on: Bool) { autoplayNext = on; defaults.set(on, forKey: "autoplayNext") }

    func setMediaFixURL(_ s: String) { mediaFixURL = s; defaults.set(s, forKey: "mediaFixURL") }

    // MARK: playback + messages

    func play(_ item: BaseItem, fromStart: Bool = false) {
        playRequest = PlayRequest(item: item, fromStart: fromStart)
    }

    func playbackEnded() {
        session?.client.invalidate("Resume", "NextUp", "/Items/", "/Episodes")
        refreshTick += 1
    }

    func show(_ text: String, seconds: Double = 2.5) {
        toast = text
        toastTask?.cancel()
        toastTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1e9))
            if !Task.isCancelled { self?.toast = nil }
        }
    }

    func fail(_ title: String, _ e: Error) {
        alert = AppAlert(title: title, message: (e as? LocalizedError)?.errorDescription ?? e.localizedDescription)
    }
}

/// Tokens live in the Keychain (this device only), never in plain settings.
enum Keychain {
    static let service = "jellyfinflix.tokens"

    static func set(_ value: String, for account: String) {
        delete(account)
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account,
                                kSecValueData as String: Data(value.utf8), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        SecItemAdd(q as CFDictionary, nil)
    }

    static func get(_ account: String) -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account,
                                kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }

    static func delete(_ account: String) {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(q as CFDictionary)
    }
}
#endif
