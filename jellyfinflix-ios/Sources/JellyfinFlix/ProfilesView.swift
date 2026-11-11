// "Who's watching?": saved profiles + the server's public users, password sheet, server address sheet.
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import JFKit

struct ProfilesView: View {
    @EnvironmentObject var model: AppModel
    @State private var editing = false
    @State private var askFor: AskUser?
    @State private var showServer = false
    @State private var busyId: String?

    struct AskUser: Identifiable { var id: String; var name: String; var manual: Bool }

    static let colors: [Color] = [Color(red: 0.17, green: 0.44, blue: 0.84), Color(red: 0.84, green: 0.27, blue: 0.17), Color(red: 0.17, green: 0.62, blue: 0.44),
                                  Color(red: 0.55, green: 0.3, blue: 0.8), Color(red: 0.85, green: 0.6, blue: 0.1)]

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()
                if model.profiles.contains(where: { $0.saved }) {
                    Button(editing ? "Done" : "Edit") { editing.toggle() }
                        .font(.system(size: 16, weight: .semibold)).foregroundColor(Theme.text)
                }
            }
            .padding(.horizontal, 22).frame(height: 44)
            Spacer(minLength: 20)
            Brand(size: 30).padding(.bottom, 40)
            content
            Spacer()
            serverLine.padding(.bottom, 20)
        }
        .sheet(item: $askFor) { u in
            PasswordSheet(name: u.name, manual: u.manual).environmentObject(model)
                .presentationDetents([.medium])
        }
        .sheet(isPresented: $showServer) {
            ServerSheet().environmentObject(model).presentationDetents([.large])
        }
    }

    @ViewBuilder var content: some View {
        switch model.serverState {
        case .checking:
            ProgressView().tint(.white).padding(40)
            Text("Looking for your Jellyfin server…").foregroundColor(Theme.muted)
        case .failed(let msg):
            VStack(spacing: 16) {
                Image(systemName: "wifi.exclamationmark").font(.system(size: 40)).foregroundColor(Theme.muted)
                Text("Server not reachable").font(.system(size: 20, weight: .semibold))
                Text(msg).font(.system(size: 14)).foregroundColor(Theme.muted).multilineTextAlignment(.center).padding(.horizontal, 30)
                HStack(spacing: 10) {
                    Button { Task { await model.connect() } } label: { Label("Try again", systemImage: "arrow.clockwise") }.buttonStyle(PillStyle(white: true))
                    Button("Change server") { showServer = true }.buttonStyle(PillStyle())
                }
            }
        case .ok:
            Text("Who's watching?").font(.system(size: 24, weight: .semibold)).padding(.bottom, 32)
            LazyVGrid(columns: [GridItem(.fixed(124), spacing: 34), GridItem(.fixed(124))], spacing: 26) {
                ForEach(Array(model.profiles.enumerated()), id: \.element.id) { i, p in
                    tile(i: i, p: p)
                }
                Button { askFor = AskUser(id: "manual", name: "", manual: true) } label: {
                    VStack(spacing: 10) {
                        RoundedRectangle(cornerRadius: 10).stroke(Color(white: 0.24), lineWidth: 2).frame(width: 124, height: 124)
                            .overlay(Image(systemName: "plus").font(.system(size: 44, weight: .light)).foregroundColor(Color(white: 0.55)))
                        Text("Add profile").font(.system(size: 15)).foregroundColor(Theme.muted)
                    }
                }
            }
        }
    }

    func tile(i: Int, p: (id: String, name: String, imageTag: String?, saved: Bool, hasPassword: Bool)) -> some View {
        Button {
            if editing { if p.saved { model.forget(p.id) }; return }
            Task {
                busyId = p.id
                defer { busyId = nil }
                if p.saved, let s = model.saved.first(where: { $0.id == p.id }), await model.use(s) { return }
                if !p.hasPassword {
                    do { try await model.signIn(name: p.name, password: "") } catch { askFor = AskUser(id: p.id, name: p.name, manual: false) }
                } else {
                    askFor = AskUser(id: p.id, name: p.name, manual: false)
                }
            }
        } label: {
            VStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10).fill(Self.colors[i % Self.colors.count])
                    Text(String(p.name.prefix(1)).uppercased()).font(.system(size: 52, weight: .bold)).foregroundColor(.white)
                    if let u = model.userImageURL(p.id, tag: p.imageTag) { RemoteImage(url: u).clipShape(RoundedRectangle(cornerRadius: 10)) }
                    if busyId == p.id { Color.black.opacity(0.5); ProgressView().tint(.white) }
                    if editing && p.saved {
                        Color.black.opacity(0.55)
                        Image(systemName: "minus.circle.fill").font(.system(size: 36)).foregroundColor(.white)
                    }
                }
                .frame(width: 124, height: 124)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                Text(p.name).font(.system(size: 15)).foregroundColor(Theme.muted).lineLimit(1)
            }
        }
        .buttonStyle(.plain)
        .disabled(busyId != nil)
    }

    var serverLine: some View {
        Button { showServer = true } label: {
            HStack(spacing: 6) {
                Circle().fill(dotColor).frame(width: 7, height: 7)
                Text(serverText).lineLimit(1)
                Text("·")
                Text("Change server")
            }
            .font(.system(size: 13)).foregroundColor(Theme.muted)
        }
    }

    var dotColor: Color {
        switch model.serverState { case .ok: return Theme.ok; case .failed: return Theme.accent; case .checking: return Theme.amber }
    }

    var serverText: String {
        if case .ok(_, _, let url, _) = model.serverState { return url.host ?? url.absoluteString }
        return model.addresses.main
    }
}

struct PasswordSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    var name: String
    var manual: Bool
    @State private var user = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focus: Field?
    enum Field { case user, pass }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(manual ? "Add profile" : "Sign in as \(name)").font(.system(size: 20, weight: .semibold))
            Text("Your password is asked once; this iPhone then remembers the login.").font(.system(size: 13)).foregroundColor(Theme.muted)
            if manual {
                TextField("User name", text: $user)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .focused($focus, equals: .user)
                    .padding(.horizontal, 14).frame(height: 46).background(RoundedRectangle(cornerRadius: 10).fill(Color(white: 0.17)))
            }
            SecureField("Password", text: $password)
                .focused($focus, equals: .pass)
                .submitLabel(.go)
                .onSubmit { go() }
                .padding(.horizontal, 14).frame(height: 46).background(RoundedRectangle(cornerRadius: 10).fill(Color(white: 0.17)))
            if let error { Text(error).font(.system(size: 13)).foregroundColor(Theme.accent) }
            Button { go() } label: {
                if busy { ProgressView().tint(.black) } else { Text("Sign in") }
            }
            .buttonStyle(PillStyle(white: true, height: 46, fill: true))
            .disabled(busy || (manual && user.isEmpty))
            Spacer()
        }
        .padding(22)
        .background(Theme.sheet.ignoresSafeArea())
        .onAppear { focus = manual ? .user : .pass }
    }

    func go() {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                try await model.signIn(name: manual ? user.trimmingCharacters(in: .whitespaces) : name, password: password)
                dismiss()
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }
}

/// Main + backup server address, quality and helper settings.
struct ServerSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var main = ""
    @State private var backup = ""
    @State private var fix = ""
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("http://jellyfin.home", text: $main).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                } header: { Text("Main address") } footer: { Text("Works at home and away from home with Tailscale on.") }
                Section {
                    TextField("http://192.168.0.154:8097", text: $backup).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                } header: { Text("Backup address") } footer: { Text("Tried by itself when the main address does not answer.") }
                Section("Status") {
                    switch model.serverState {
                    case .checking: HStack { ProgressView(); Text("Checking…") }
                    case .ok(let n, let v, let u, let ms): Label("\(n) \(v) at \(u.host ?? "") · \(ms) ms", systemImage: "checkmark.circle.fill").foregroundColor(Theme.ok)
                    case .failed(let m): Label(m, systemImage: "xmark.octagon.fill").foregroundColor(Theme.accent)
                    }
                }
                Section {
                    Button("Use the home defaults") { main = ServerAddresses.defaults.main; backup = ServerAddresses.defaults.backup }
                }
                Section {
                    TextField(MediaFixClient.defaultURL, text: $fix).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                } header: { Text("Fix Audio helper") } footer: { Text("Used by Fix Audio and Fetch Subtitle (admin profiles).") }
            }
            .navigationTitle("Jellyfin server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Checking…" : "Save") {
                        busy = true
                        Task {
                            model.setMediaFixURL(fix.isEmpty ? MediaFixClient.defaultURL : fix)
                            await model.saveAddresses(ServerAddresses(main: main, backup: backup))
                            busy = false
                            if case .ok = model.serverState { dismiss() }
                        }
                    }
                    .disabled(busy || ServerAddresses.normalize(main) == nil)
                }
            }
        }
        .onAppear {
            main = model.addresses.main
            backup = model.addresses.backup
            fix = model.mediaFixURL
        }
    }
}
#endif
