// Player logic around AVPlayer: start (resume point), direct play vs server stream, retry through the server
// when direct play fails, audio + subtitle choice, Skip Intro, next-episode countdown, progress reports to
// Jellyfin (start / every 10 s / pause / seek / stop), lock-screen info. Same behaviour as the TV player.
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import AVFoundation
import MediaPlayer
import Combine
import JFKit

@MainActor
final class PlayerModel: ObservableObject {
    enum Phase: Equatable { case loading, ready, failed(String), ended }

    @Published var phase: Phase = .loading
    @Published var item: BaseItem
    @Published var position: Double = 0
    @Published var duration: Double = 0
    @Published var paused = false
    @Published var controls = true
    @Published var scrubbing = false
    @Published var scrubValue: Double = 0
    @Published var subtitleText: String?
    @Published var audioStreams: [MediaStream] = []
    @Published var subStreams: [MediaStream] = []
    @Published var audioIndex: Int?
    @Published var subIndex: Int = -1
    @Published var skipSegment: Segment?
    @Published var nextEp: BaseItem?
    @Published var countdown: Int?
    @Published var dismissedNext = false
    @Published var panel: Panel?
    @Published var buffering = false
    @Published var fill = false
    @Published var status: String?
    @Published var clock = Date()

    enum Panel { case tracks, episodes }

    let player = AVPlayer()
    private let model: AppModel
    private let client: JellyfinClient
    private var source: MediaSource?
    private var playSessionId: String?
    private var method: PlayMethod = .directPlay
    private var burnIn = false
    private var triedServer = false
    private var segments: [Segment] = []
    private var cues: [Cue] = []
    private var timeObserver: Any?
    private var bag = Set<AnyCancellable>()
    private var lastReport = Date.distantPast
    private var started = false
    private var countdownTask: Task<Void, Never>?
    private var hideTask: Task<Void, Never>?
    private var clockTask: Task<Void, Never>?
    private var subtitleTask: Task<Void, Never>?
    private var closed = false

    init(model: AppModel, client: JellyfinClient, item: BaseItem) {
        self.model = model
        self.client = client
        self.item = item
        player.allowsExternalPlayback = true
        player.preventsDisplaySleepDuringVideoPlayback = true
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self] t in
            MainActor.assumeIsolated { self?.tick(t.seconds) }
        }
        player.publisher(for: \.timeControlStatus).receive(on: RunLoop.main).sink { [weak self] s in
            guard let self else { return }
            self.buffering = s == .waitingToPlayAtSpecifiedRate
            let p = s == .paused
            if p != self.paused, self.started {
                self.paused = p
                self.report(.progress, event: p ? "Pause" : "Unpause")
                self.updateNowPlaying()
                if p { self.startClock() } else { self.scheduleHide() }
            }
        }.store(in: &bag)
        NotificationCenter.default.publisher(for: .AVPlayerItemDidPlayToEndTime).receive(on: RunLoop.main).sink { [weak self] n in
            guard let self, (n.object as? AVPlayerItem) === self.player.currentItem else { return }
            self.reachedEnd()
        }.store(in: &bag)
        setupRemoteCommands()
    }

    // MARK: start

    func start(fromStart: Bool) async {
        var it = item
        if it.isSeries || it.Type == "Season" {
            guard let ep = try? await Library.nextEpisode(client, seriesId: it.SeriesId ?? it.Id) else { fail("No episodes to play."); return }
            it = ep
        }
        // fresh user data so the resume point is current
        if let full = try? await Library.item(client, it.Id) { it = full }
        item = it
        let resumeAt = fromStart ? 0 : Ticks.seconds(it.positionTicks)
        await open(at: resumeAt, audio: nil, sub: nil)
        loadExtras()
    }

    /// Ask the server how to play, then load the stream and seek. Used for the first start and every restart.
    private func open(at seconds: Double, audio: Int?, sub: Int?, forceServer: Bool = false) async {
        phase = .loading
        var o = PlaybackOptions()
        o.maxBitrate = model.activeQuality.rawValue
        o.audioIndex = audio
        o.subtitleIndex = sub.flatMap { $0 >= 0 && burnIn ? $0 : nil }
        o.mediaSourceId = (audio != nil || o.subtitleIndex != nil) ? source?.Id : nil
        o.burnIn = burnIn
        o.noDirect = forceServer
        // no StartTimeTicks: the stream always covers the whole video and we seek once it is ready
        do {
            let info = try await Playback.fetchInfo(client, itemId: item.Id, o)
            guard let ms = info.MediaSources?.first else { throw JFError.badAnswer("no playable media") }
            let old = playSessionId
            if method != .directPlay, let old { await Playback.stopEncoding(client, deviceId: model.deviceId, playSessionId: old) }
            source = ms
            playSessionId = info.PlaySessionId
            audioStreams = Tracks.audio(ms)
            subStreams = Tracks.subtitles(ms)
            if audioIndex == nil { audioIndex = audio ?? ms.DefaultAudioStreamIndex ?? audioStreams.first?.Index }
            if !started, sub == nil, let d = ms.DefaultSubtitleStreamIndex, let s = subStreams.first(where: { $0.Index == d }), !Tracks.isPicture(s) { subIndex = d }
            let pick = try Playback.choose(client, itemId: item.Id, source: ms, playSessionId: info.PlaySessionId, deviceId: model.deviceId, forceServer: forceServer)
            method = pick.method
            let asset = AVURLAsset(url: pick.url)
            let pi = AVPlayerItem(asset: asset)
            pi.preferredForwardBufferDuration = 0
            observe(pi, resumeAt: seconds)
            pendingSeek = seconds
            player.replaceCurrentItem(with: pi)
            position = seconds
            if (ms.RunTimeTicks ?? item.RunTimeTicks ?? 0) > 0 { duration = Ticks.seconds(ms.RunTimeTicks ?? item.RunTimeTicks ?? 0) }
            if subIndex >= 0, let s = subStreams.first(where: { $0.Index == subIndex }), !Tracks.isPicture(s) { loadTextSubtitle(s, quiet: true) }
        } catch {
            fail((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
        }
    }

    private var pendingSeek: Double = 0

    private func observe(_ pi: AVPlayerItem, resumeAt: Double) {
        pi.publisher(for: \.status).receive(on: RunLoop.main).sink { [weak self, weak pi] s in
            guard let self, let pi, pi === self.player.currentItem else { return }
            switch s {
            case .readyToPlay:
                let d = pi.duration.seconds
                if d.isFinite, d > 0 { self.duration = d }
                let at = self.pendingSeek
                self.pendingSeek = 0
                if at > 1 {
                    // resume point: seek first, then play (so the first picture is the right one)
                    pi.seek(to: CMTime(seconds: at, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
                        Task { @MainActor in self?.phase = .ready; self?.player.play() }
                    }
                } else {
                    self.phase = .ready
                    self.player.play()
                }
                if !self.started {
                    self.started = true
                    self.report(.start)
                } else {
                    self.report(.progress, event: "AudioTrackChange")
                }
                self.updateNowPlaying()
                self.scheduleHide()
            case .failed:
                self.playbackFailed(pi.error)
            default: break
            }
        }.store(in: &bag)
    }

    private func playbackFailed(_ e: Error?) {
        // Direct play failed on the iPhone: try once more through the server (same rule as the TV app).
        if method == .directPlay && !triedServer {
            triedServer = true
            status = "Trying again through the server…"
            let at = position
            Task { await open(at: at, audio: audioIndex, sub: subIndex, forceServer: true); status = nil }
            return
        }
        fail("This video could not be played. " + (e?.localizedDescription ?? ""))
    }

    private func fail(_ msg: String) {
        phase = .failed(msg)
        controls = true
    }

    private func loadExtras() {
        let it = item
        Task {
            segments = await Library.segments(client, it.Id)
            if it.isEpisode { nextEp = try? await Library.episodeAfter(client, it) }
        }
    }

    // MARK: time

    private func tick(_ t: Double) {
        guard t.isFinite, phase == .ready || phase == .loading else { return }
        if !scrubbing { position = t }
        subtitleText = cues.isEmpty ? nil : VTT.text(at: t, in: cues)
        skipSegment = Segments.skippable(at: t, in: segments)
        if Date().timeIntervalSince(lastReport) >= 10, started, !paused { report(.progress, event: "TimeUpdate") }
        if let n = nextEp, !dismissedNext, countdown == nil, duration > 60, model.autoplayNext, panel != .episodes {
            let at = Segments.nextCardTime(duration: duration, segs: segments)
            if t >= at && t < duration - 1.5 { startCountdown(n) }
        }
    }

    func togglePlay() {
        if phase == .ended { return }
        if player.timeControlStatus == .paused { player.play() } else { player.pause() }
        poke()
    }

    func seek(to s: Double) {
        let target = max(0, min(duration > 0 ? duration - 1 : s, s))
        position = target
        player.seek(to: CMTime(seconds: target, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            Task { @MainActor in self?.report(.progress, event: "TimeUpdate") }
        }
        if target < Segments.nextCardTime(duration: duration, segs: segments) { cancelCountdown() }
        poke()
    }

    func skip(_ by: Double) { seek(to: position + by) }

    func skipIntro() {
        if let s = skipSegment { seek(to: s.end) }
    }

    // MARK: controls visibility

    func poke() {
        withAnimation(.easeOut(duration: 0.2)) { controls = true }
        scheduleHide()
    }

    func toggleControls() {
        if controls { withAnimation(.easeOut(duration: 0.2)) { controls = false } } else { poke() }
    }

    private func scheduleHide() {
        hideTask?.cancel()
        hideTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 3_500_000_000)
            guard let self, !Task.isCancelled, !self.paused, !self.scrubbing, self.panel == nil, self.phase == .ready else { return }
            withAnimation(.easeOut(duration: 0.3)) { self.controls = false }
        }
    }

    /// Pause clock: current time and "Ends at", refreshed every 15 s while paused.
    private func startClock() {
        clock = Date()
        clockTask?.cancel()
        clockTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                guard let self, self.paused else { return }
                self.clock = Date()
            }
        }
    }

    var endsAt: String { Fmt.endsAt(remainingSeconds: duration - position, now: clock) }

    // MARK: tracks

    func chooseAudio(_ s: MediaStream) {
        guard s.Index != audioIndex else { return }
        audioIndex = s.Index
        panel = nil
        Task {
            // direct play: switch inside the file when the iPhone lists the same number of audio tracks
            if method == .directPlay, let pi = player.currentItem,
               let group = try? await pi.asset.loadMediaSelectionGroup(for: .audible),
               group.options.count == audioStreams.count,
               let n = audioStreams.firstIndex(where: { $0.Index == s.Index }) {
                pi.select(group.options[n], in: group)
                model.show("Audio: " + Tracks.label(s), seconds: 2)
                report(.progress, event: "AudioTrackChange")
                return
            }
            // otherwise the server sends a stream with that track
            model.show("Audio: " + Tracks.label(s), seconds: 2)
            await open(at: position, audio: s.Index, sub: subIndex)
        }
    }

    func chooseSubtitle(_ index: Int) {
        panel = nil
        let wasBurn = burnIn
        subIndex = index
        cues = []
        subtitleText = nil
        subtitleTask?.cancel()
        guard index >= 0, let s = subStreams.first(where: { $0.Index == index }) else {
            if wasBurn { burnIn = false; Task { await open(at: position, audio: audioIndex, sub: -1) } }
            model.show("Subtitles off", seconds: 1.5)
            report(.progress, event: "SubtitleTrackChange")
            return
        }
        if Tracks.isPicture(s) {
            // picture subtitles (PGS / DVD) are burned into the picture by the server, only when chosen
            burnIn = true
            model.show("Subtitles: \(Tracks.label(s)) (the server draws them into the picture)", seconds: 3)
            Task { await open(at: position, audio: audioIndex, sub: index) }
            return
        }
        if wasBurn { burnIn = false; Task { await open(at: position, audio: audioIndex, sub: index) } }
        loadTextSubtitle(s, quiet: false)
        report(.progress, event: "SubtitleTrackChange")
    }

    /// Text subtitles: fetched as WebVTT and drawn by the app. The first pull from a big MKV can take a while on the server.
    private func loadTextSubtitle(_ s: MediaStream, quiet: Bool) {
        guard let ms = source, let url = Playback.subtitleURL(client, itemId: item.Id, mediaSourceId: ms.Id, stream: s) else { return }
        subtitleTask?.cancel()
        if !quiet { model.show("Loading subtitles…", seconds: 2) }
        subtitleTask = Task { [weak self] in
            var r = URLRequest(url: url)
            r.timeoutInterval = 180
            do {
                let (d, resp) = try await URLSession.shared.data(for: r)
                guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw JFError.http((resp as? HTTPURLResponse)?.statusCode ?? 0) }
                guard let self, !Task.isCancelled, self.subIndex == s.Index else { return }
                self.cues = VTT.parse(String(decoding: d, as: UTF8.self))
                if !quiet { self.model.show("Subtitles: " + Tracks.label(s), seconds: 2) }
            } catch {
                if !Task.isCancelled { self?.model.show("Could not load subtitles: \(error.localizedDescription)", seconds: 3) }
            }
        }
    }

    // MARK: next episode

    private func startCountdown(_ n: BaseItem) {
        countdown = 10
        countdownTask?.cancel()
        countdownTask = Task { [weak self] in
            while let self, let c = self.countdown, c > 0, !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if Task.isCancelled { return }
                if self.paused { continue }
                self.countdown = c - 1
            }
            guard let self, !Task.isCancelled, self.countdown == 0 else { return }
            await self.playNext()
        }
    }

    func keepWatching() {
        dismissedNext = true
        cancelCountdown()
    }

    private func cancelCountdown() {
        countdownTask?.cancel()
        countdown = nil
    }

    func playNext() async {
        guard let n = nextEp else { return }
        await play(n, fromStart: false)
    }

    /// Switch to another episode (next-episode card or the Episodes panel).
    func play(_ ep: BaseItem, fromStart: Bool) async {
        cancelCountdown()
        panel = nil
        await finishCurrent(switching: true)
        item = ep
        started = false
        triedServer = false
        burnIn = false
        dismissedNext = false
        nextEp = nil
        segments = []
        cues = []
        subtitleText = nil
        audioIndex = nil
        subIndex = -1
        source = nil
        position = 0
        duration = 0
        await start(fromStart: fromStart)
    }

    private func reachedEnd() {
        if nextEp != nil && model.autoplayNext && !dismissedNext {
            Task { await playNext() }
        } else {
            phase = .ended
            Task { await close() }
        }
    }

    // MARK: reports

    enum R { case start, progress }

    private func report(_ k: R, event: String? = nil) {
        guard let ms = source else { return }
        lastReport = Date()
        let body = Playback.reportBody(itemId: item.Id, mediaSourceId: ms.Id, playSessionId: playSessionId, positionTicks: Ticks.from(seconds: position),
                                       paused: paused, method: method, audio: audioIndex, subtitle: subIndex >= 0 ? subIndex : nil, event: event)
        let c = client
        Task.detached { await Playback.report(c, k == .start ? .start : .progress, body) }
    }

    /// Stop report with the last position, and stop the server's transcode.
    private func finishCurrent(switching: Bool) async {
        guard let ms = source, started else { return }
        let t = player.currentTime().seconds
        if t.isFinite, t > 0 { position = t }
        player.pause()
        let body = Playback.reportBody(itemId: item.Id, mediaSourceId: ms.Id, playSessionId: playSessionId, positionTicks: Ticks.from(seconds: position),
                                       paused: true, method: method, audio: audioIndex, subtitle: subIndex >= 0 ? subIndex : nil)
        await Playback.report(client, .stop, body)
        if method != .directPlay { await Playback.stopEncoding(client, deviceId: model.deviceId, playSessionId: playSessionId) }
        started = false
    }

    func close() async {
        guard !closed else { return }
        closed = true
        cancelCountdown()
        hideTask?.cancel(); clockTask?.cancel(); subtitleTask?.cancel()
        await finishCurrent(switching: false)
        player.replaceCurrentItem(with: nil)
        if let o = timeObserver { player.removeTimeObserver(o); timeObserver = nil }
        bag.removeAll()
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        removeRemoteCommands()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        model.playbackEnded()
        model.playRequest = nil
    }

    /// App sent to the background / screen locked: pause and save the position (like the TV app on Home).
    func wentToBackground() {
        guard started else { return }
        player.pause()
        report(.progress, event: "Pause")
    }

    // MARK: lock screen / Control Center

    private func updateNowPlaying() {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: item.isEpisode ? "\(Fmt.episode(item)) \(item.Name ?? "")" : (item.Name ?? ""),
            MPMediaItemPropertyPlaybackDuration: duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
            MPNowPlayingInfoPropertyPlaybackRate: paused ? 0.0 : 1.0,
        ]
        if let s = item.SeriesName { info[MPMediaItemPropertyArtist] = s }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func setupRemoteCommands() {
        let cc = MPRemoteCommandCenter.shared()
        cc.playCommand.addTarget { [weak self] _ in self?.player.play(); return .success }
        cc.pauseCommand.addTarget { [weak self] _ in self?.player.pause(); return .success }
        cc.togglePlayPauseCommand.addTarget { [weak self] _ in self?.togglePlay(); return .success }
        cc.skipForwardCommand.preferredIntervals = [10]
        cc.skipBackwardCommand.preferredIntervals = [10]
        cc.skipForwardCommand.addTarget { [weak self] _ in self?.skip(10); return .success }
        cc.skipBackwardCommand.addTarget { [weak self] _ in self?.skip(-10); return .success }
        cc.changePlaybackPositionCommand.addTarget { [weak self] e in
            if let e = e as? MPChangePlaybackPositionCommandEvent { self?.seek(to: e.positionTime) }
            return .success
        }
    }

    private func removeRemoteCommands() {
        let cc = MPRemoteCommandCenter.shared()
        for c in [cc.playCommand, cc.pauseCommand, cc.togglePlayPauseCommand, cc.skipForwardCommand, cc.skipBackwardCommand, cc.changePlaybackPositionCommand] as [MPRemoteCommand] {
            c.removeTarget(nil)
        }
    }

    // MARK: episodes panel

    @Published var panelSeasons: [BaseItem] = []
    @Published var panelSeasonId: String?
    @Published var panelEpisodes: [BaseItem] = []

    func openEpisodes() {
        panel = .episodes
        guard let sid = item.SeriesId else { return }
        Task {
            if panelSeasons.isEmpty { panelSeasons = (try? await Library.seasons(client, seriesId: sid)) ?? [] }
            if panelSeasonId == nil { panelSeasonId = item.SeasonId ?? panelSeasons.first?.Id }
            await loadPanelEpisodes()
        }
    }

    func loadPanelEpisodes() async {
        guard let sid = item.SeriesId, let season = panelSeasonId else { return }
        panelEpisodes = (try? await Library.episodes(client, seriesId: sid, seasonId: season)) ?? []
    }

    func imageURL(_ it: BaseItem, width: Int) -> URL? { Art.url(client, Art.card(it), width: width, height: width * 9 / 16) }
}
#endif
