// JellyfinFlix for iPhone: entry point, app delegate (orientation lock) and the root switch
// between "Who's watching?" and the browse tabs. The player is a full-screen cover on top.
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import UIKit
import JFKit

@main
struct JellyfinFlixApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var model = AppModel()

    init() {
        // artwork cache: 60 MB in memory, 400 MB on disk
        URLCache.shared = URLCache(memoryCapacity: 60 * 1024 * 1024, diskCapacity: 400 * 1024 * 1024)
        Theme.applyUIKitAppearance()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .preferredColorScheme(.dark)
                .tint(.white)
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    static var orientationLock: UIInterfaceOrientationMask = .portrait

    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        AppDelegate.orientationLock
    }
}

/// Browsing stays upright; the player turns sideways (owner: portrait browsing, landscape playback).
enum Orientation {
    static func set(_ mask: UIInterfaceOrientationMask) {
        AppDelegate.orientationLock = mask
        for scene in UIApplication.shared.connectedScenes {
            guard let ws = scene as? UIWindowScene else { continue }
            for w in ws.windows {
                var vc = w.rootViewController
                while let v = vc {
                    v.setNeedsUpdateOfSupportedInterfaceOrientations()
                    vc = v.presentedViewController
                }
            }
            ws.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { _ in }
        }
    }
}

struct RootView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.scenePhase) private var phase

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            if model.session == nil {
                ProfilesView()
                    .transition(.opacity)
            } else {
                BrowseView()
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.25), value: model.session?.user.id)
        .fullScreenCover(item: $model.playRequest) { req in
            PlayerView(request: req)
                .environmentObject(model)
        }
        .overlay(alignment: .top) { ToastView() }
        .alert(item: $model.alert) { a in
            Alert(title: Text(a.title), message: Text(a.message), dismissButton: .default(Text("OK")))
        }
        .task { await model.start() }
        .onChange(of: phase) { _, p in
            if p == .active { Task { await model.cameBack() } }
        }
    }
}
#endif
