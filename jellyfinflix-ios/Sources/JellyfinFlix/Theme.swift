// Look shared with the TV app (jellyfinflix/src/style.css): near-black, red accent, white rounded pills.
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import UIKit
import JFKit

enum Theme {
    static let bg = Color(red: 11 / 255, green: 11 / 255, blue: 13 / 255)
    static let bg2 = Color(red: 20 / 255, green: 20 / 255, blue: 24 / 255)
    static let bg3 = Color(red: 31 / 255, green: 31 / 255, blue: 37 / 255)
    static let sheet = Color(red: 28 / 255, green: 28 / 255, blue: 33 / 255)
    static let text = Color(red: 244 / 255, green: 244 / 255, blue: 246 / 255)
    static let muted = Color(red: 163 / 255, green: 163 / 255, blue: 173 / 255)
    static let accent = Color(red: 229 / 255, green: 9 / 255, blue: 20 / 255)
    static let ok = Color(red: 47 / 255, green: 191 / 255, blue: 113 / 255)
    static let amber = Color(red: 242 / 255, green: 165 / 255, blue: 22 / 255)

    static func applyUIKitAppearance() {
        let tab = UITabBarAppearance()
        tab.configureWithOpaqueBackground()
        tab.backgroundColor = UIColor(red: 11 / 255, green: 11 / 255, blue: 13 / 255, alpha: 0.96)
        UITabBar.appearance().standardAppearance = tab
        UITabBar.appearance().scrollEdgeAppearance = tab
        UITabBar.appearance().unselectedItemTintColor = UIColor(white: 0.64, alpha: 1)
        let nav = UINavigationBarAppearance()
        nav.configureWithTransparentBackground()
        nav.titleTextAttributes = [.foregroundColor: UIColor.white]
        nav.largeTitleTextAttributes = [.foregroundColor: UIColor.white]
        UINavigationBar.appearance().standardAppearance = nav
        UINavigationBar.appearance().scrollEdgeAppearance = nav
    }
}

struct Brand: View {
    var size: CGFloat = 22
    var body: some View {
        (Text("Jellyfin").foregroundColor(Theme.text) + Text("Flix").foregroundColor(Theme.accent))
            .font(.system(size: size, weight: .heavy))
    }
}

/// Rounded pill button (white = main action).
struct PillStyle: ButtonStyle {
    var white = false
    var height: CGFloat = 40
    var fill = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: height > 42 ? 16 : 14, weight: .bold))
            .lineLimit(1)
            .padding(.horizontal, 14)
            .frame(height: height)
            .frame(maxWidth: fill ? .infinity : nil)
            .foregroundColor(white ? .black : Theme.text)
            .background(Capsule().fill(white ? Theme.text : Color.white.opacity(0.2)))
            .opacity(configuration.isPressed ? 0.75 : 1)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
    }
}

/// Image from the server with a dark placeholder (name shown when there is no art).
struct RemoteImage: View {
    var url: URL?
    var label: String = ""
    var contentMode: ContentMode = .fill

    var body: some View {
        ZStack {
            LinearGradient(colors: [Color(white: 0.17), Color(white: 0.09)], startPoint: .topLeading, endPoint: .bottomTrailing)
            if let url {
                AsyncImage(url: url, transaction: Transaction(animation: .easeIn(duration: 0.2))) { phase in
                    switch phase {
                    case .success(let img): img.resizable().aspectRatio(contentMode: contentMode)
                    case .failure: fallback
                    default: Color.clear
                    }
                }
            } else {
                fallback
            }
        }
        .clipped()
    }

    var fallback: some View {
        Text(label).font(.system(size: 12, weight: .bold)).foregroundColor(Color(white: 0.85)).padding(8)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
    }
}

struct ProgressLine: View {
    var value: Double
    var height: CGFloat = 3
    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Rectangle().fill(Color.white.opacity(0.25))
                Rectangle().fill(Theme.accent).frame(width: g.size.width * CGFloat(min(1, max(0, value))))
            }
        }
        .frame(height: height)
    }
}

struct Chip: View {
    var text: String
    var kind: String // ok / run / bad
    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .bold))
            .padding(.horizontal, 8).padding(.vertical, 2)
            .foregroundColor(color)
            .background(Capsule().fill(color.opacity(0.18)))
    }
    var color: Color { kind == "ok" ? Theme.ok : kind == "run" ? Theme.amber : Theme.accent }
}

struct ToastView: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        if let t = model.toast {
            Text(t)
                .font(.system(size: 14, weight: .semibold))
                .padding(.horizontal, 16).padding(.vertical, 10)
                .background(Capsule().fill(Color(white: 0.16).opacity(0.97)))
                .overlay(Capsule().stroke(Color.white.opacity(0.12)))
                .padding(.top, 56)
                .transition(.move(edge: .top).combined(with: .opacity))
                .animation(.easeOut(duration: 0.2), value: model.toast)
                .allowsHitTesting(false)
        }
    }
}

extension BaseItem {
    /// Title line for cards: "S3:E5 Roller Disco" for episodes.
    var cardTitle: String {
        if isEpisode {
            let e = Fmt.episode(self)
            return (e.isEmpty ? "" : e + " ") + (Name ?? "")
        }
        return Name ?? ""
    }
}
#endif
