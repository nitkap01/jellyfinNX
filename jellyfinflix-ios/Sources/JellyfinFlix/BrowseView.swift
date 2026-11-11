// Tabs (Home, Shows, Movies, My List, Search), the billboard and the sideways rows.
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import JFKit

struct BrowseView: View {
    @EnvironmentObject var model: AppModel
    @State private var tab = 0

    var body: some View {
        TabView(selection: $tab) {
            stack { RowsScreen(tab: .home) }.tabItem { Label("Home", systemImage: "house.fill") }.tag(0)
            stack { RowsScreen(tab: .shows) }.tabItem { Label("Shows", systemImage: "tv") }.tag(1)
            stack { RowsScreen(tab: .movies) }.tabItem { Label("Movies", systemImage: "film") }.tag(2)
            stack { MyListScreen() }.tabItem { Label("My List", systemImage: "plus") }.tag(3)
            stack { SearchScreen() }.tabItem { Label("Search", systemImage: "magnifyingglass") }.tag(4)
        }
    }

    func stack<V: View>(@ViewBuilder _ v: () -> V) -> some View {
        NavigationStack {
            v()
                .navigationDestination(for: BaseItem.self) { DetailsView(item: $0) }
                .toolbar(.hidden, for: .navigationBar)
        }
    }
}

@MainActor
final class RowsVM: ObservableObject {
    struct Row: Identifiable { var def: RowDef; var items: [BaseItem]; var id: String { def.id } }
    @Published var rows: [Row] = []
    @Published var billboard: BaseItem?
    @Published var error: String?
    @Published var loaded = false

    func load(_ c: JellyfinClient, tab: Tab, userName: String) async {
        var defs = Library.rows(tab, userName: userName)
        do {
            if tab == .home { defs.insert(contentsOf: (try? await Library.latestRows(c)) ?? [], at: min(3, defs.count)) }
            let types = tab == .movies ? "Movie" : tab == .shows ? "Series" : "Movie,Series"
            defs += (try? await Library.genreRows(c, types: types, count: tab == .home ? 6 : 8)) ?? []
            let loadedRows = try await withThrowingTaskGroup(of: (Int, [BaseItem]).self) { g -> [Row] in
                for (i, d) in defs.enumerated() { g.addTask { (i, (try? await d.load(c)) ?? []) } }
                var out = [[BaseItem]](repeating: [], count: defs.count)
                for try await (i, items) in g { out[i] = items }
                return defs.enumerated().map { Row(def: $0.element, items: out[$0.offset]) }.filter { !$0.items.isEmpty }
            }
            rows = loadedRows
            // billboard: the top Continue Watching title, else something from the first rows
            if let cw = loadedRows.first(where: { $0.def.id == "resume" })?.items.first { billboard = cw } else {
                billboard = loadedRows.prefix(3).flatMap(\.items).filter { Art.backdrop($0) != nil }.randomElement() ?? loadedRows.first?.items.first
            }
            error = nil
            if loadedRows.isEmpty { _ = try await c.publicInfo(timeout: 5) }
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        loaded = true
    }
}

struct RowsScreen: View {
    @EnvironmentObject var model: AppModel
    var tab: Tab
    @StateObject private var vm = RowsVM()

    var body: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                if let b = vm.billboard, let s = model.session {
                    Billboard(item: b, client: s.client)
                } else {
                    Color.clear.frame(height: 120)
                }
                if let e = vm.error, vm.rows.isEmpty {
                    ErrorBlock(text: e) { Task { await reload() } }
                }
                if !vm.loaded { ProgressView().tint(.white).frame(maxWidth: .infinity).padding(40) }
                ForEach(vm.rows) { r in RowView(title: r.def.title, kind: r.def.kind, items: r.items) }
                Color.clear.frame(height: 24)
            }
        }
        .background(Theme.bg)
        .ignoresSafeArea(edges: .top)
        .overlay(alignment: .top) { TopBar(title: tab == .home ? nil : tab == .shows ? "Shows" : "Movies") }
        .refreshable { model.session?.client.invalidateAll(); await reload() }
        .task(id: model.refreshTick) { await reload() }
    }

    func reload() async {
        guard let s = model.session else { return }
        await vm.load(s.client, tab: tab, userName: s.user.name)
    }
}

struct ErrorBlock: View {
    var text: String
    var retry: () -> Void
    var body: some View {
        VStack(spacing: 12) {
            Text(text).font(.system(size: 14)).foregroundColor(Theme.muted).multilineTextAlignment(.center)
            Button("Try again", action: retry).buttonStyle(PillStyle(white: true))
        }
        .frame(maxWidth: .infinity).padding(30)
    }
}

/// Brand + profile menu over the top of every browse tab.
struct TopBar: View {
    @EnvironmentObject var model: AppModel
    var title: String?
    @State private var showSettings = false

    var body: some View {
        HStack {
            if let title { Text(title).font(.system(size: 26, weight: .heavy)) } else { Brand() }
            Spacer()
            Menu {
                if let s = model.session { Text("Signed in as \(s.user.name)") }
                Button { model.switchProfile() } label: { Label("Switch profile", systemImage: "person.2") }
                Button { showSettings = true } label: { Label("Settings", systemImage: "gearshape") }
                Button(role: .destructive) { Task { await model.signOut() } } label: { Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right") }
            } label: {
                RoundedRectangle(cornerRadius: 6).fill(ProfilesView.colors[0]).frame(width: 30, height: 30)
                    .overlay(Text(String(model.session?.user.name.prefix(1) ?? "?").uppercased()).font(.system(size: 15, weight: .bold)).foregroundColor(.white))
            }
        }
        .padding(.horizontal, 18)
        .padding(.top, 4)
        .frame(height: 52)
        .background(LinearGradient(colors: [Color.black.opacity(0.75), .clear], startPoint: .top, endPoint: .bottom).ignoresSafeArea(edges: .top))
        .sheet(isPresented: $showSettings) { SettingsSheet().environmentObject(model) }
    }
}

struct SettingsSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var showServer = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("On Wi-Fi", selection: Binding(get: { model.quality }, set: { model.setQuality($0, cellular: false) })) {
                        ForEach(Quality.allCases, id: \.self) { Text($0.label).tag($0) }
                    }
                    Picker("On mobile data", selection: Binding(get: { model.cellularQuality }, set: { model.setQuality($0, cellular: true) })) {
                        ForEach(Quality.allCases, id: \.self) { Text($0.label).tag($0) }
                    }
                } header: { Text("Picture quality") } footer: { Text("Lower quality on mobile data saves data and starts faster away from home.") }
                Section {
                    Toggle("Play next episode by itself", isOn: Binding(get: { model.autoplayNext }, set: { model.setAutoplay($0) }))
                }
                Section {
                    Button("Server address") { showServer = true }
                } footer: {
                    Text("JellyfinFlix \(AppModel.appVersion) · device \(String(model.deviceId.suffix(8)))")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .sheet(isPresented: $showServer) { ServerSheet().environmentObject(model) }
        }
    }
}

/// Big picture at the top: Resume · Xm left / Start Over / Info (or Play / My List / Info).
struct Billboard: View {
    @EnvironmentObject var model: AppModel
    var item: BaseItem
    var client: JellyfinClient
    @State private var fav: Bool?

    var body: some View {
        ZStack(alignment: .bottom) {
            RemoteImage(url: Art.url(client, Art.backdrop(item), width: 1100, quality: 75))
                .frame(height: 560)
                .frame(maxWidth: .infinity)
            LinearGradient(stops: [.init(color: Theme.bg, location: 0.0), .init(color: Theme.bg.opacity(0.55), location: 0.35),
                                   .init(color: Theme.bg.opacity(0.1), location: 0.65), .init(color: Theme.bg.opacity(0.6), location: 1)],
                           startPoint: .bottom, endPoint: .top)
            VStack(spacing: 10) {
                if let logo = Art.url(client, Art.logo(item), width: 500) {
                    AsyncImage(url: logo) { p in
                        if let img = p.image { img.resizable().scaledToFit() } else { title }
                    }
                    .frame(maxWidth: 250, maxHeight: 96)
                } else { title }
                Text(meta).font(.system(size: 13)).foregroundColor(Color(white: 0.87)).lineLimit(1).padding(.horizontal, 20)
                HStack(spacing: 7) {
                    if item.progress > 0 {
                        Button { model.play(item) } label: { Label(Fmt.playLabel(item), systemImage: "play.fill") }.buttonStyle(PillStyle(white: true))
                        Button { model.play(item, fromStart: true) } label: { Label("Start Over", systemImage: "arrow.counterclockwise") }.buttonStyle(PillStyle())
                    } else {
                        Button { model.play(item) } label: { Label("Play", systemImage: "play.fill") }.buttonStyle(PillStyle(white: true))
                        Button { toggleFav() } label: { Label("My List", systemImage: (fav ?? item.isFavorite) ? "checkmark" : "plus") }.buttonStyle(PillStyle())
                    }
                    NavigationLink(value: item) { Label("Info", systemImage: "info.circle") }.buttonStyle(PillStyle())
                }
                .padding(.horizontal, 12)
                if item.progress > 0 { ProgressLine(value: item.progress).frame(width: 170).clipShape(Capsule()).padding(.top, 4) }
            }
            .padding(.bottom, 16)
        }
        .frame(height: 560)
        .clipped()
    }

    var title: some View {
        Text(item.SeriesName ?? item.Name ?? "").font(.system(size: 32, weight: .heavy)).multilineTextAlignment(.center).lineLimit(2).padding(.horizontal, 20)
    }

    var meta: String {
        var parts: [String] = []
        if item.isEpisode { parts.append(Fmt.episode(item) + " " + (item.Name ?? "")) }
        parts += (item.Genres ?? []).prefix(2)
        if parts.isEmpty, let y = item.ProductionYear { parts.append(String(y)) }
        return parts.joined(separator: "  •  ")
    }

    func toggleFav() {
        let on = !(fav ?? item.isFavorite)
        fav = on
        Task {
            do { _ = try await Library.setFavourite(client, item.SeriesId ?? item.Id, on); model.show(on ? "Added to My List" : "Removed from My List") }
            catch { fav = !on; model.fail("My List", error) }
        }
    }
}

struct RowView: View {
    @EnvironmentObject var model: AppModel
    var title: String
    var kind: RowDef.Kind
    var items: [BaseItem]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.system(size: 17, weight: .bold)).padding(.leading, 18)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 8) {
                    ForEach(items) { it in
                        NavigationLink(value: it) {
                            if kind == .poster { PosterCard(item: it) } else { LandscapeCard(item: it) }
                        }
                        .buttonStyle(.plain)
                        .contextMenu { CardMenu(item: it) }
                    }
                }
                .padding(.horizontal, 18)
            }
        }
        .padding(.bottom, 18)
    }
}

struct CardMenu: View {
    @EnvironmentObject var model: AppModel
    var item: BaseItem
    var body: some View {
        Button { model.play(item) } label: { Label(item.progress > 0 ? Fmt.playLabel(item) : "Play", systemImage: "play.fill") }
        if item.progress > 0 { Button { model.play(item, fromStart: true) } label: { Label("Start Over", systemImage: "arrow.counterclockwise") } }
        Button {
            guard let c = model.session?.client else { return }
            Task {
                do { _ = try await Library.setFavourite(c, item.Id, !item.isFavorite); model.playbackEnded() } catch { model.fail("My List", error) }
            }
        } label: { Label(item.isFavorite ? "Remove from My List" : "Add to My List", systemImage: item.isFavorite ? "minus" : "plus") }
        if item.isPlayable {
            Button {
                guard let c = model.session?.client else { return }
                Task {
                    do { try await Library.setPlayed(c, item.Id, !item.played); model.playbackEnded() } catch { model.fail("Watched", error) }
                }
            } label: { Label(item.played ? "Mark as not watched" : "Mark as watched", systemImage: "checkmark.circle") }
        }
    }
}

struct LandscapeCard: View {
    @EnvironmentObject var model: AppModel
    var item: BaseItem
    var width: CGFloat = 168

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            ZStack(alignment: .bottom) {
                RemoteImage(url: model.session.flatMap { Art.url($0.client, Art.card(item), width: 340, height: 191) }, label: item.cardTitle)
                if item.progress > 0 { ProgressLine(value: item.progress) }
            }
            .frame(width: width, height: width * 9 / 16)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            Text(item.cardTitle).font(.system(size: 12)).foregroundColor(Theme.muted).lineLimit(1).frame(width: width, alignment: .leading)
        }
    }
}

struct PosterCard: View {
    @EnvironmentObject var model: AppModel
    var item: BaseItem
    var width: CGFloat = 108

    var body: some View {
        RemoteImage(url: model.session.flatMap { Art.url($0.client, Art.poster(item), width: 220, height: 330) }, label: item.Name ?? "")
            .frame(width: width, height: width * 1.48)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .overlay(alignment: .bottom) { if item.progress > 0 { ProgressLine(value: item.progress) } }
    }
}

struct MyListScreen: View {
    @EnvironmentObject var model: AppModel
    @State private var items: [BaseItem] = []
    @State private var loaded = false
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading) {
                Color.clear.frame(height: 56)
                if let error { ErrorBlock(text: error) { Task { await load() } } }
                if loaded && items.isEmpty && error == nil {
                    Text("Nothing here yet. Use My List on any film or show to keep it here.").foregroundColor(Theme.muted).padding(30)
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: 8)], spacing: 10) {
                    ForEach(items) { it in
                        NavigationLink(value: it) { PosterCard(item: it, width: 112) }.buttonStyle(.plain).contextMenu { CardMenu(item: it) }
                    }
                }
                .padding(.horizontal, 16)
            }
        }
        .background(Theme.bg)
        .overlay(alignment: .top) { TopBar(title: "My List") }
        .refreshable { await load() }
        .task(id: model.refreshTick) { await load() }
    }

    func load() async {
        guard let c = model.session?.client else { return }
        do {
            items = try await Library.rows(.myList, userName: "")[0].load(c)
            error = nil
        } catch { self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription }
        loaded = true
    }
}
#endif
