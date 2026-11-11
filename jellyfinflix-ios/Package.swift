// swift-tools-version: 6.0
// JellyfinFlix for iPhone (JTV-28). Built with xtool (SwiftPM only, no Xcode project).
// JFKit = Jellyfin + player logic, Foundation only, so it builds and is unit-tested on Linux too.
// JellyfinFlix = the SwiftUI app (the one library product xtool turns into the .app).
import PackageDescription

let package = Package(
    name: "JellyfinFlix",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "JellyfinFlix", targets: ["JellyfinFlix"]),
    ],
    targets: [
        .target(name: "JFKit"),
        // Swift 5 language mode for the UI target: SwiftUI/AVFoundation callbacks without strict-concurrency noise.
        .target(name: "JellyfinFlix", dependencies: ["JFKit"], swiftSettings: [.swiftLanguageMode(.v5)]),
        .testTarget(name: "JFKitTests", dependencies: ["JFKit"]),
    ]
)
