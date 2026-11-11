// Details page: Play/Resume, Start Over, My List · Watched · More, seasons + episodes.
// More menu = the TV app's: Fix Audio (with Audio fixed / Fixing N% / failed badge), Fetch Subtitle, Details.
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import JFKit

@MainActor
final class DetailsVM: ObservableObject {
    @Published var item: BaseItem
    @Published var series: BaseItem?
    @Published var seasons: [BaseItem] = []
    @Published var seasonId: String?
    @Published var episodes: [BaseItem] = []
    @Published var target: BaseItem?          // what Play/Resume starts (next episode for a show)
    @Published var fix: FixStatus?
    @Published var error: String?
    @Published var fixRunning: FixAction?

    init(item: BaseItem) { self.item = item }

    /// The show this page is about (episode pages show their series' seasons too).
    var showId: String? { item.isSeries ? item.Id : item.SeriesId }

    func load(_ c: JellyfinClient, fixClient: MediaFixClient) async {
        do {
            let full = try await Library.item(c, item.Id)
            item = full
            if let sid = showId {
                if item.isEpisode { series = try? await Library.item(c, sid) }
                seasons = try await Library.seasons(c, seriesId: sid)
                if item.isSeries {
                    target = try await Library.nextEpisode(c, seriesId: sid)
                } else {
                    target = item
                }
                let wantSeason = target?.SeasonId ?? item.SeasonId ?? seasons.first?.Id
                if seasonId == nil || !seasons.contains(where: { $0.Id == seasonId }) { seasonId = wantSeason }
                await loadEpisodes(c)
            } else {
                target = item
            }
            error = nil
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        if let p = (target ?? item).Path { fix = await fixClient.status(path: p) }
    }

    func loadEpisodes(_ c: JellyfinClient) async {
        guard let sid = showId, let season = seasonId else { return }
        episodes = (try? await Library.episodes(c, seriesId: sid, seasonId: season)) ?? []
    }

    /// Re-reads the helper status every 4 s while a fix runs (also when it was started from the TV).
    func watchFix(_ fixClient: MediaFixClient) async {
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard let p = (target ?? item).Path, fix?.state == "running" || fixRunning != nil else { continue }
            fix = await fixClient.status(path: p)
        }
    }
}

struct DetailsView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @StateObject private var vm: DetailsVM
    @State private var showMore = false
    @State private var fav: Bool?
    @State private var expanded = false
    @State private var confirmFix: FixAction?

    init(item: BaseItem) { _vm = StateObject(wrappedValue: DetailsVM(item: item)) }

    var client: JellyfinClient? { model.session?.client }
    var it: BaseItem { vm.item }
    var playTarget: BaseItem { vm.target ?? it }

    var body: some View {
        ScrollView(showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                hero
                VStack(alignment: .leading, spacing: 10) {
                    header
                    buttons
                    overview
                    actions
                    if vm.showId != nil { seasonsBlock }
                    if let e = vm.error { ErrorBlock(text: e) { Task { await reload() } } }
                }
                .padding(.horizontal, 18)
                .offset(y: -50)
            }
        }
        .background(Theme.bg)
        .ignoresSafeArea(edges: .top)
        .overlay(alignment: .topLeading) {
            Button { dismiss() } label: {
                Image(systemName: "chevron.left").font(.system(size: 17, weight: .bold)).frame(width: 36, height: 36).background(Circle().fill(Color.black.opacity(0.55)))
            }
            .padding(.leading, 14).padding(.top, 6)
        }
        .toolbar(.hidden, for: .navigationBar)
        .sheet(isPresented: $showMore) { moreSheet.presentationDetents([.medium, .large]) }
        .alert(item: $confirmFix) { a in
            Alert(title: Text(a.title),
                  message: Text(a == .audio ? "Re-encode this movie's audio so dialogue is easier to hear? This runs on the server and can take a while. The original is kept until the fixed file is verified." : "Look for an English subtitle for this video?"),
                  primaryButton: .default(Text("Start")) { runFix(a) }, secondaryButton: .cancel())
        }
        .task(id: model.refreshTick) { await reload() }
        .task { await vm.watchFix(model.mediaFix) }
    }

    func reload() async {
        guard let c = client else { return }
        await vm.load(c, fixClient: model.mediaFix)
    }

    // MARK: parts

    var hero: some View {
        ZStack(alignment: .bottom) {
            RemoteImage(url: client.flatMap { Art.url($0, Art.backdrop(vm.series ?? it), width: 900, quality: 75) })
                .frame(height: 300).frame(maxWidth: .infinity)
            LinearGradient(colors: [Theme.bg, .clear, Theme.bg.opacity(0.5)], startPoint: .bottom, endPoint: .top)
        }
        .frame(height: 300)
        .clipped()
    }

    var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let c = client, let logo = Art.url(c, Art.logo(vm.series ?? it), width: 440) {
                AsyncImage(url: logo) { p in
                    if let img = p.image { img.resizable().scaledToFit() } else { titleText }
                }
                .frame(maxWidth: 220, maxHeight: 70, alignment: .leading)
            } else { titleText }
            if it.isEpisode {
                Text("\(Fmt.episode(it))  \(it.Name ?? "")").font(.system(size: 16, weight: .semibold))
            }
            HStack(spacing: 8) {
                ForEach(Fmt.facts(it), id: \.self) { f in
                    if f == it.OfficialRating { Text(f).font(.system(size: 11)).padding(.horizontal, 5).overlay(RoundedRectangle(cornerRadius: 3).stroke(Color(white: 0.47))) }
                    else { Text(f) }
                }
                if let b = vm.fix?.badge { Chip(text: b.text, kind: b.kind) }
            }
            .font(.system(size: 13)).foregroundColor(Color(white: 0.8))
            let aired = [Fmt.aired(it), Fmt.ago(it)].filter { !$0.isEmpty }.joined(separator: " · ")
            if !aired.isEmpty { Text(aired).font(.system(size: 12)).foregroundColor(Theme.muted) }
        }
    }

    var titleText: some View {
        Text(vm.series?.Name ?? it.SeriesName ?? it.Name ?? "").font(.system(size: 26, weight: .heavy)).lineLimit(2)
    }

    var buttons: some View {
        VStack(spacing: 8) {
            Button { model.play(playTarget) } label: {
                Label(playLabel, systemImage: "play.fill").frame(maxWidth: .infinity)
            }
            .buttonStyle(PillStyle(white: true, height: 44, fill: true))
            .disabled(vm.target == nil && it.isSeries)
            if playTarget.progress > 0 {
                HStack(spacing: 8) {
                    ProgressLine(value: playTarget.progress).clipShape(Capsule())
                    Text("\(Fmt.timeLeft(playTarget) ?? "") left").font(.system(size: 12)).foregroundColor(Theme.muted)
                }
                Button { model.play(playTarget, fromStart: true) } label: {
                    Label("Start Over", systemImage: "arrow.counterclockwise").frame(maxWidth: .infinity)
                }
                .buttonStyle(PillStyle(height: 44, fill: true))
            }
        }
    }

    var playLabel: String {
        let t = playTarget
        let resume = t.progress > 0
        if it.isSeries, t.isEpisode { return (resume ? "Resume " : "Play ") + Fmt.episode(t) }
        return resume ? "Resume" : "Play"
    }

    @ViewBuilder var overview: some View {
        if let o = (it.isSeries ? it.Overview : (it.Overview ?? vm.series?.Overview)), !o.isEmpty {
            Text(o).font(.system(size: 13.5)).foregroundColor(Color(white: 0.87)).lineLimit(expanded ? nil : 3)
                .onTapGesture { withAnimation { expanded.toggle() } }
        }
    }

    var actions: some View {
        HStack {
            action(icon: (fav ?? favTarget.isFavorite) ? "checkmark" : "plus", text: "My List") { toggleFav() }
            if playTarget.isPlayable {
                action(icon: playTarget.played ? "checkmark.circle.fill" : "checkmark.circle", text: playTarget.played ? "Watched" : "Mark watched") { togglePlayed() }
            }
            action(icon: "ellipsis", text: "More") { showMore = true }
        }
        .padding(.vertical, 6)
    }

    /// My List holds the show (not single episodes) on show/episode pages.
    var favTarget: BaseItem { vm.series ?? it }

    func action(icon: String, text: String, _ f: @escaping () -> Void) -> some View {
        Button(action: f) {
            VStack(spacing: 5) {
                Image(systemName: icon).font(.system(size: 21)).frame(height: 24)
                Text(text).font(.system(size: 11)).foregroundColor(Theme.muted)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
    }

    func toggleFav() {
        guard let c = client else { return }
        let on = !(fav ?? favTarget.isFavorite)
        fav = on
        Task {
            do { _ = try await Library.setFavourite(c, favTarget.Id, on); model.show(on ? "Added to My List" : "Removed from My List"); model.refreshTick += 1 }
            catch { fav = !on; model.fail("My List", error) }
        }
    }

    func togglePlayed() {
        guard let c = client else { return }
        let t = playTarget
        Task {
            do { try await Library.setPlayed(c, t.Id, !t.played); model.playbackEnded() } catch { model.fail("Watched", error) }
        }
    }

    var seasonsBlock: some View {
        VStack(alignment: .leading, spacing: 12) {
            Menu {
                ForEach(vm.seasons) { s in
                    Button(s.Name ?? "Season") {
                        vm.seasonId = s.Id
                        Task { if let c = client { await vm.loadEpisodes(c) } }
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    Text(vm.seasons.first { $0.Id == vm.seasonId }?.Name ?? "Season").font(.system(size: 15, weight: .bold))
                    Image(systemName: "chevron.down").font(.system(size: 11, weight: .bold))
                }
                .foregroundColor(Theme.text)
                .padding(.top, 10)
                .overlay(alignment: .top) { Rectangle().fill(Theme.accent).frame(height: 3) }
            }
            ForEach(vm.episodes) { ep in EpisodeRow(ep: ep, current: ep.Id == vm.target?.Id) }
        }
        .padding(.top, 6)
    }

    // MARK: More

    var canFix: Bool { MediaFixClient.canFix(playTarget, isAdmin: model.session?.user.admin ?? false) }

    var moreSheet: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text(playTarget.isEpisode ? "\(Fmt.episode(playTarget)) \(playTarget.Name ?? "")" : (it.Name ?? "")).font(.system(size: 17, weight: .bold)).padding(.top, 22)
                Text(Fmt.facts(playTarget).joined(separator: " · ")).font(.system(size: 13)).foregroundColor(Theme.muted).padding(.bottom, 10)
                if canFix {
                    moreRow(icon: "speaker.wave.2", title: "Fix Audio", sub: "Make dialogue easier to hear", badge: vm.fix?.badge) { showMore = false; confirmFix = .audio }
                    moreRow(icon: "captions.bubble", title: "Fetch Subtitle", sub: "Find an English subtitle", badge: vm.fixRunning == .subtitle ? ("Looking…", "run") : nil) { showMore = false; confirmFix = .subtitle }
                }
                if playTarget.isPlayable {
                    moreRow(icon: "checkmark.circle", title: playTarget.played ? "Mark as not watched" : "Mark as watched", sub: nil, badge: nil) { showMore = false; togglePlayed() }
                }
                detailsBlock.padding(.top, 14)
            }
            .padding(.horizontal, 20)
        }
        .background(Theme.sheet.ignoresSafeArea())
    }

    func moreRow(icon: String, title: String, sub: String?, badge: (text: String, kind: String)?, _ f: @escaping () -> Void) -> some View {
        Button(action: f) {
            HStack(spacing: 14) {
                Image(systemName: icon).font(.system(size: 19)).frame(width: 26)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 16))
                    if let sub { Text(sub).font(.system(size: 12)).foregroundColor(Theme.muted) }
                }
                Spacer()
                if let b = badge { Chip(text: b.text, kind: b.kind) }
            }
            .padding(.vertical, 13)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .bottom) { Rectangle().fill(Color(white: 0.17)).frame(height: 1) }
    }

    var detailsBlock: some View {
        let src = vm.series ?? it
        let cast = (src.People ?? []).filter { $0.Type == "Actor" }.prefix(6).compactMap(\.Name).joined(separator: ", ")
        let director = (it.People ?? []).filter { $0.Type == "Director" }.compactMap(\.Name).joined(separator: ", ")
        let streams = playTarget.MediaStreams ?? it.MediaStreams ?? []
        let subs = streams.filter { $0.Type == "Subtitle" }.compactMap { $0.Language ?? $0.DisplayTitle }
        let audio = streams.filter { $0.Type == "Audio" }.map { Tracks.label($0) }
        return VStack(alignment: .leading, spacing: 8) {
            line("Genres", (src.Genres ?? []).joined(separator: ", "))
            line("Cast", cast)
            line("Director", director)
            line("Studio", (src.Studios ?? []).compactMap(\.Name).joined(separator: ", "))
            line("Audio", audio.joined(separator: "\n"))
            line("Subtitles", Array(Set(subs)).sorted().joined(separator: ", "))
        }
    }

    @ViewBuilder func line(_ k: String, _ v: String) -> some View {
        if !v.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                Text(k).font(.system(size: 12, weight: .semibold)).foregroundColor(Theme.muted)
                Text(v).font(.system(size: 13))
            }
        }
    }

    func runFix(_ a: FixAction) {
        guard let path = playTarget.Path, let c = client else { return }
        let fixClient = model.mediaFix
        let itemId = playTarget.Id
        vm.fixRunning = a
        Task {
            defer { vm.fixRunning = nil }
            do {
                let job = try await fixClient.start(a, path: path)
                model.show(a == .audio ? "Audio fix started — you can keep watching." : "Looking for an English subtitle…", seconds: 4)
                if a == .audio { vm.fix = await fixClient.status(path: path) }
                switch await fixClient.wait(a, jobId: job) {
                case .done(let msg):
                    model.alert = AppAlert(title: a.title, message: msg)
                    await MediaFixClient.refresh(c, itemId: itemId)
                case .failed(let t, let msg):
                    model.alert = AppAlert(title: t, message: msg)
                }
                vm.fix = await fixClient.status(path: path)
            } catch {
                model.fail(a.title, error)
            }
        }
    }
}

extension FixAction: Identifiable { public var id: String { rawValue } }

struct EpisodeRow: View {
    @EnvironmentObject var model: AppModel
    var ep: BaseItem
    var current: Bool

    var body: some View {
        Button { model.play(ep) } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 10) {
                    ZStack {
                        RemoteImage(url: model.session.flatMap { Art.url($0.client, Art.card(ep), width: 280, height: 158) }, label: ep.Name ?? "")
                        Circle().fill(Color.black.opacity(0.45)).frame(width: 30, height: 30).overlay(Circle().stroke(.white, lineWidth: 1.5))
                            .overlay(Image(systemName: "play.fill").font(.system(size: 12)))
                        if ep.progress > 0 { VStack { Spacer(); ProgressLine(value: ep.progress) } }
                    }
                    .frame(width: 130, height: 73)
                    .clipShape(RoundedRectangle(cornerRadius: 5))
                    VStack(alignment: .leading, spacing: 3) {
                        Text("\(ep.IndexNumber.map { "\($0). " } ?? "")\(ep.Name ?? "")").font(.system(size: 14, weight: .semibold)).lineLimit(2)
                        HStack(spacing: 4) {
                            Text(Fmt.timeLeft(ep).map { "\($0) left" } ?? Fmt.runtime(ep.RunTimeTicks))
                            if ep.played { Image(systemName: "checkmark.circle.fill").foregroundColor(Theme.muted) }
                            if current { Text("· Up next").foregroundColor(Theme.accent).fontWeight(.bold) }
                        }
                        .font(.system(size: 12)).foregroundColor(Theme.muted)
                    }
                    Spacer(minLength: 0)
                }
                if let o = ep.Overview, !o.isEmpty {
                    Text(o).font(.system(size: 12)).foregroundColor(Theme.muted).lineLimit(3)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu { CardMenu(item: ep) }
        .padding(.bottom, 8)
    }
}

struct SearchScreen: View {
    @EnvironmentObject var model: AppModel
    @State private var text = ""
    @State private var titles: [BaseItem] = []
    @State private var episodes: [BaseItem] = []
    @State private var busy = false
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Search").font(.system(size: 28, weight: .heavy)).padding(.horizontal, 16).padding(.top, 8)
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundColor(Theme.muted)
                TextField("Films, shows, episodes", text: $text)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.search).focused($focused)
                if !text.isEmpty { Button { text = "" } label: { Image(systemName: "xmark.circle.fill").foregroundColor(Theme.muted) } }
            }
            .padding(.horizontal, 12).frame(height: 40)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color(white: 0.17)))
            .padding(.horizontal, 16)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if busy { ProgressView().tint(.white).frame(maxWidth: .infinity).padding(10) }
                    if let error { Text(error).foregroundColor(Theme.muted).padding(16) }
                    if !text.isEmpty && !busy && titles.isEmpty && episodes.isEmpty && error == nil {
                        Text("Nothing found for \"\(text)\".").foregroundColor(Theme.muted).padding(16)
                    }
                    if !titles.isEmpty {
                        Text("Movies & Shows").font(.system(size: 17, weight: .bold)).padding(.horizontal, 16)
                        LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8), GridItem(.flexible())], spacing: 8) {
                            ForEach(titles) { it in
                                NavigationLink(value: it) {
                                    RemoteImage(url: model.session.flatMap { Art.url($0.client, Art.poster(it), width: 240, height: 356) }, label: it.Name ?? "")
                                        .aspectRatio(0.67, contentMode: .fit)
                                        .clipShape(RoundedRectangle(cornerRadius: 5))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 16)
                    }
                    if !episodes.isEmpty {
                        Text("Episodes").font(.system(size: 17, weight: .bold)).padding(.horizontal, 16).padding(.top, 8)
                        ForEach(episodes) { ep in
                            HStack(spacing: 10) {
                                NavigationLink(value: ep) {
                                    HStack(spacing: 10) {
                                        RemoteImage(url: model.session.flatMap { Art.url($0.client, Art.card(ep), width: 280, height: 158) }, label: ep.Name ?? "")
                                            .frame(width: 130, height: 73).clipShape(RoundedRectangle(cornerRadius: 5))
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(ep.Name ?? "").font(.system(size: 14, weight: .semibold)).lineLimit(2)
                                            Text("\(ep.SeriesName ?? "") \(Fmt.episode(ep))").font(.system(size: 12)).foregroundColor(Theme.muted)
                                        }
                                        Spacer(minLength: 0)
                                    }
                                }
                                .buttonStyle(.plain)
                                Button { model.play(ep) } label: {
                                    Image(systemName: "play.fill").font(.system(size: 12)).frame(width: 32, height: 32).overlay(Circle().stroke(.white, lineWidth: 1.5))
                                }
                                .buttonStyle(.plain)
                            }
                            .padding(.horizontal, 16)
                        }
                    }
                }
                .padding(.bottom, 20)
            }
            .scrollDismissesKeyboard(.immediately)
        }
        .background(Theme.bg)
        .task(id: text) {
            let q = text.trimmingCharacters(in: .whitespaces)
            guard q.count >= 2, let c = model.session?.client else { titles = []; episodes = []; error = nil; return }
            try? await Task.sleep(nanoseconds: 300_000_000) // wait for typing to pause
            if Task.isCancelled { return }
            busy = true
            defer { busy = false }
            do {
                let r = try await Library.search(c, q)
                if Task.isCancelled { return }
                titles = r.titles
                episodes = r.episodes
                error = nil
            } catch {
                if !Task.isCancelled { self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription }
            }
        }
    }
}
#endif
