// Full-screen sideways player: video, subtitles, controls (tap to show, double-tap sides = 10 s),
// pause clock with "Ends at", Skip Intro, next-episode card, Audio & Subtitles and Episodes panels.
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import AVKit
import JFKit

struct PlayerView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.scenePhase) private var phase
    let request: PlayRequest
    @StateObject private var holder = Holder()

    final class Holder: ObservableObject { @Published var pm: PlayerModel? }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let pm = holder.pm { PlayerScreen(pm: pm) } else { ProgressView().tint(.white) }
        }
        .statusBarHidden(true)
        .persistentSystemOverlays(.hidden)
        .onAppear {
            Orientation.set(.landscape)
            UIApplication.shared.isIdleTimerDisabled = true
            if holder.pm == nil, let s = model.session {
                let pm = PlayerModel(model: model, client: s.client, item: request.item)
                holder.pm = pm
                Task { await pm.start(fromStart: request.fromStart) }
            }
        }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
            Orientation.set(.portrait)
            if let pm = holder.pm { Task { await pm.close() } }
        }
        .onChange(of: phase) { _, p in
            if p == .background { holder.pm?.wentToBackground() }
        }
    }
}

/// AVPlayerLayer in a UIView (fit or fill).
struct VideoSurface: UIViewRepresentable {
    let player: AVPlayer
    var fill: Bool

    final class V: UIView {
        override static var layerClass: AnyClass { AVPlayerLayer.self }
        var pl: AVPlayerLayer { layer as! AVPlayerLayer }
    }

    func makeUIView(context: Context) -> V {
        let v = V()
        v.backgroundColor = .black
        v.pl.player = player
        v.pl.videoGravity = fill ? .resizeAspectFill : .resizeAspect
        return v
    }

    func updateUIView(_ v: V, context: Context) {
        v.pl.videoGravity = fill ? .resizeAspectFill : .resizeAspect
    }
}

struct PlayerScreen: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var pm: PlayerModel

    var body: some View {
        ZStack {
            VideoSurface(player: pm.player, fill: pm.fill).ignoresSafeArea()
            // tap areas: single tap = controls, double tap left/right third = -10 / +10 s
            HStack(spacing: 0) {
                tapZone { pm.skip(-10); model.show("-10 s", seconds: 0.8) }
                Color.clear.contentShape(Rectangle()).onTapGesture { pm.toggleControls() }
                tapZone { pm.skip(10); model.show("+10 s", seconds: 0.8) }
            }
            .gesture(MagnificationGesture().onEnded { v in withAnimation { pm.fill = v > 1 } })
            subtitles
            if pm.controls || pm.phase != .ready { controls.transition(.opacity) }
            if pm.paused && pm.phase == .ready { pauseClock }
            if let s = pm.skipSegment, pm.countdown == nil {
                Button { pm.skipIntro() } label: {
                    Text(s.type == "Recap" ? "Skip Recap" : "Skip Intro").font(.system(size: 14, weight: .bold)).padding(.horizontal, 16).padding(.vertical, 9)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Color(white: 0.12).opacity(0.85))).overlay(RoundedRectangle(cornerRadius: 6).stroke(Color(white: 0.35)))
                }
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                .padding(.trailing, 30).padding(.bottom, 84)
            }
            if let n = pm.nextEp, let c = pm.countdown { nextCard(n, c) }
            if pm.panel == .tracks { tracksPanel.transition(.move(edge: .trailing)) }
            if pm.panel == .episodes { episodesPanel.transition(.move(edge: .trailing)) }
            if pm.buffering || pm.phase == .loading { ProgressView().tint(.white).scaleEffect(1.4).allowsHitTesting(false) }
            if case .failed(let msg) = pm.phase { failure(msg) }
        }
        .animation(.easeOut(duration: 0.2), value: pm.panel)
        .ignoresSafeArea(edges: .horizontal)
    }

    func tapZone(_ double: @escaping () -> Void) -> some View {
        Color.clear.contentShape(Rectangle())
            .onTapGesture(count: 2, perform: double)
            .onTapGesture { pm.toggleControls() }
            .frame(maxWidth: .infinity)
    }

    @ViewBuilder var subtitles: some View {
        if let t = pm.subtitleText {
            Text(t)
                .font(.system(size: 19, weight: .semibold))
                .multilineTextAlignment(.center)
                .foregroundColor(.white)
                .shadow(color: .black, radius: 2, x: 0, y: 1)
                .padding(.horizontal, 10).padding(.vertical, 4)
                .background(RoundedRectangle(cornerRadius: 4).fill(Color.black.opacity(0.45)))
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                .padding(.bottom, pm.controls ? 96 : 22)
                .padding(.horizontal, 60)
                .allowsHitTesting(false)
        }
    }

    var title: String {
        let it = pm.item
        return it.isEpisode ? "\(it.SeriesName ?? "")  \(Fmt.episode(it)) \(it.Name ?? "")" : (it.Name ?? "")
    }

    var controls: some View {
        ZStack {
            LinearGradient(stops: [.init(color: .black.opacity(0.7), location: 0), .init(color: .black.opacity(0.15), location: 0.3),
                                   .init(color: .black.opacity(0.15), location: 0.65), .init(color: .black.opacity(0.85), location: 1)],
                           startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
                .allowsHitTesting(false)
            VStack {
                HStack(spacing: 14) {
                    Button { Task { await pm.close() } } label: { Image(systemName: "xmark").font(.system(size: 20, weight: .semibold)).frame(width: 40, height: 40) }
                    Spacer()
                    Text(title).font(.system(size: 14, weight: .semibold)).lineLimit(1)
                    Spacer()
                    AirPlayButton().frame(width: 40, height: 40)
                }
                .padding(.horizontal, 44).padding(.top, 14)
                Spacer()
                HStack(spacing: 76) {
                    Button { pm.skip(-10) } label: { Image(systemName: "gobackward.10").font(.system(size: 34)) }
                    Button { pm.togglePlay() } label: { Image(systemName: pm.paused ? "play.fill" : "pause.fill").font(.system(size: 50)).frame(width: 60) }
                    Button { pm.skip(10) } label: { Image(systemName: "goforward.10").font(.system(size: 34)) }
                }
                .opacity(pm.phase == .ready ? 1 : 0)
                Spacer()
                VStack(spacing: 10) {
                    HStack(spacing: 12) {
                        Text(Fmt.clock(pm.scrubbing ? pm.scrubValue : pm.position)).font(.system(size: 12).monospacedDigit())
                        Slider(value: Binding(get: { pm.scrubbing ? pm.scrubValue : pm.position }, set: { pm.scrubValue = $0 }),
                               in: 0...max(1, pm.duration)) { editing in
                            if editing { pm.scrubValue = pm.position; pm.scrubbing = true; pm.poke() } else { pm.scrubbing = false; pm.seek(to: pm.scrubValue) }
                        }
                        .tint(Theme.accent)
                        Text("-" + Fmt.clock(max(0, pm.duration - (pm.scrubbing ? pm.scrubValue : pm.position)))).font(.system(size: 12).monospacedDigit())
                    }
                    HStack(spacing: 28) {
                        if pm.item.isEpisode { bottomButton("Episodes", "rectangle.stack") { pm.openEpisodes() } }
                        bottomButton("Audio & Subtitles", "captions.bubble") { pm.panel = .tracks }
                        if let n = pm.nextEp { bottomButton("Next Episode", "forward.end.fill") { Task { await pm.play(n, fromStart: false) } } }
                        bottomButton(pm.fill ? "Fit" : "Fill", pm.fill ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right") { withAnimation { pm.fill.toggle() } }
                    }
                }
                .padding(.horizontal, 44).padding(.bottom, 14)
                .opacity(pm.phase == .ready ? 1 : 0.4)
            }
            .foregroundColor(.white)
            .buttonStyle(.plain)
        }
    }

    func bottomButton(_ t: String, _ icon: String, _ f: @escaping () -> Void) -> some View {
        Button(action: f) { Label(t, systemImage: icon).font(.system(size: 12, weight: .semibold)) }.buttonStyle(.plain)
    }

    var pauseClock: some View {
        VStack(alignment: .trailing, spacing: 2) {
            Text(Fmt.timeOfDay(pm.clock)).font(.system(size: 22, weight: .semibold))
            Text(pm.endsAt).font(.system(size: 12)).foregroundColor(Color(white: 0.8))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
        .padding(.top, 56).padding(.trailing, 48)
        .allowsHitTesting(false)
    }

    func nextCard(_ n: BaseItem, _ c: Int) -> some View {
        HStack(alignment: .top, spacing: 12) {
            RemoteImage(url: pm.imageURL(n, width: 320)).frame(width: 150, height: 84).clipShape(RoundedRectangle(cornerRadius: 6))
            VStack(alignment: .leading, spacing: 2) {
                Text("NEXT EPISODE").font(.system(size: 10, weight: .bold)).kerning(1.2).foregroundColor(Theme.muted)
                Text("\(Fmt.episode(n)) · \(n.Name ?? "")").font(.system(size: 14, weight: .bold)).lineLimit(1)
                Text(Fmt.runtime(n.RunTimeTicks)).font(.system(size: 12)).foregroundColor(Theme.muted)
                HStack(spacing: 8) {
                    Button { Task { await pm.playNext() } } label: {
                        ZStack(alignment: .leading) {
                            GeometryReader { g in
                                Rectangle().fill(Theme.accent.opacity(0.28)).frame(width: g.size.width * CGFloat(10 - c) / 10)
                                    .animation(.linear(duration: 1), value: c)
                            }
                            Label("Play now · \(c)", systemImage: "play.fill").font(.system(size: 13, weight: .bold)).frame(maxWidth: .infinity)
                        }
                        .foregroundColor(.black).frame(height: 32).background(Theme.text).clipShape(Capsule())
                    }
                    Button { pm.keepWatching() } label: {
                        Text("Keep watching").font(.system(size: 13, weight: .bold)).frame(maxWidth: .infinity).frame(height: 32)
                            .background(Capsule().fill(Color.white.opacity(0.2)))
                    }
                }
                .buttonStyle(.plain)
                .padding(.top, 6)
            }
        }
        .padding(12)
        .frame(width: 440)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color(white: 0.08).opacity(0.94)))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color(white: 0.2)))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
        .padding(.trailing, 34).padding(.bottom, 24)
        .transition(.move(edge: .trailing).combined(with: .opacity))
    }

    var tracksPanel: some View {
        HStack(spacing: 0) {
            Color.black.opacity(0.35).contentShape(Rectangle()).onTapGesture { pm.panel = nil }
            HStack(alignment: .top, spacing: 22) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("AUDIO").font(.system(size: 12, weight: .bold)).foregroundColor(Theme.muted).padding(.bottom, 4)
                        ForEach(pm.audioStreams, id: \.Index) { s in
                            option(Tracks.label(s), on: s.Index == pm.audioIndex) { pm.chooseAudio(s) }
                        }
                    }
                }
                ScrollView {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("SUBTITLES").font(.system(size: 12, weight: .bold)).foregroundColor(Theme.muted).padding(.bottom, 4)
                        option("Off", on: pm.subIndex < 0) { pm.chooseSubtitle(-1) }
                        ForEach(pm.subStreams, id: \.Index) { s in
                            option(Tracks.label(s) + (Tracks.isPicture(s) ? " (picture)" : ""), on: s.Index == pm.subIndex) { pm.chooseSubtitle(s.Index) }
                        }
                    }
                }
            }
            .padding(.horizontal, 22).padding(.vertical, 20)
            .frame(width: 400)
            .background(Color(white: 0.09).opacity(0.97))
        }
        .ignoresSafeArea()
    }

    func option(_ t: String, on: Bool, _ f: @escaping () -> Void) -> some View {
        Button(action: f) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)).foregroundColor(Theme.accent).opacity(on ? 1 : 0)
                Text(t).font(.system(size: 14, weight: on ? .bold : .regular)).multilineTextAlignment(.leading)
            }
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    var episodesPanel: some View {
        HStack(spacing: 0) {
            Color.black.opacity(0.35).contentShape(Rectangle()).onTapGesture { pm.panel = nil }
            VStack(alignment: .leading, spacing: 10) {
                Menu {
                    ForEach(pm.panelSeasons) { s in
                        Button(s.Name ?? "Season") { pm.panelSeasonId = s.Id; Task { await pm.loadPanelEpisodes() } }
                    }
                } label: {
                    HStack(spacing: 6) {
                        Text(pm.panelSeasons.first { $0.Id == pm.panelSeasonId }?.Name ?? "Season").font(.system(size: 16, weight: .bold))
                        Image(systemName: "chevron.down").font(.system(size: 11, weight: .bold))
                    }
                    .foregroundColor(.white)
                }
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 10) {
                            ForEach(pm.panelEpisodes) { ep in
                                Button { Task { await pm.play(ep, fromStart: false) } } label: {
                                    HStack(spacing: 10) {
                                        ZStack(alignment: .bottom) {
                                            RemoteImage(url: pm.imageURL(ep, width: 240), label: ep.Name ?? "")
                                            if ep.progress > 0.05 { ProgressLine(value: ep.progress) }
                                        }
                                        .frame(width: 120, height: 67).clipShape(RoundedRectangle(cornerRadius: 5))
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text("\(ep.IndexNumber.map { "\($0). " } ?? "")\(ep.Name ?? "")").font(.system(size: 13, weight: .semibold)).lineLimit(2)
                                            if ep.Id == pm.item.Id { Text("Now playing").font(.system(size: 11, weight: .bold)).foregroundColor(Theme.accent) }
                                            else { Text(Fmt.timeLeft(ep).map { "\($0) left" } ?? Fmt.runtime(ep.RunTimeTicks)).font(.system(size: 11)).foregroundColor(Theme.muted) }
                                        }
                                        Spacer(minLength: 0)
                                    }
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .id(ep.Id)
                            }
                        }
                    }
                    .onChange(of: pm.panelEpisodes.count) { _, _ in proxy.scrollTo(pm.item.Id, anchor: .center) }
                }
            }
            .padding(18)
            .frame(width: 400)
            .background(Color(white: 0.09).opacity(0.97))
        }
        .ignoresSafeArea()
    }

    func failure(_ msg: String) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "exclamationmark.triangle").font(.system(size: 34))
            Text(msg).font(.system(size: 14)).multilineTextAlignment(.center).frame(maxWidth: 480)
            Button("Close") { Task { await pm.close() } }.buttonStyle(PillStyle(white: true))
        }
        .padding(24)
        .background(RoundedRectangle(cornerRadius: 14).fill(Color(white: 0.1).opacity(0.95)))
    }
}

/// AirPlay picker (send the video to an Apple TV / AirPlay TV).
struct AirPlayButton: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let v = AVRoutePickerView()
        v.tintColor = .white
        v.activeTintColor = UIColor(red: 229 / 255, green: 9 / 255, blue: 20 / 255, alpha: 1)
        v.prioritizesVideoDevices = true
        return v
    }
    func updateUIView(_ uiView: AVRoutePickerView, context: Context) {}
}
#endif
