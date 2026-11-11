// Tiny WebVTT parser for subtitles the app draws itself (same approach as the TV app).
import Foundation

public struct Cue: Sendable, Equatable {
    public var start: Double
    public var end: Double
    public var text: String
}

public enum VTT {
    public static func parse(_ s: String) -> [Cue] {
        var cues: [Cue] = []
        let blocks = s.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n\n")
        for b in blocks {
            let lines = b.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
            guard let ti = lines.firstIndex(where: { $0.contains("-->") }) else { continue }
            let parts = lines[ti].components(separatedBy: "-->")
            guard parts.count == 2, let a = time(parts[0]), let e = time(parts[1].split(separator: " ").first.map(String.init) ?? "") else { continue }
            let text = lines[(ti + 1)...].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { continue }
            cues.append(Cue(start: a, end: e, text: stripTags(text)))
        }
        return cues.sorted { $0.start < $1.start }
    }

    /// "01:02:03.456" or "02:03.456" (comma also accepted) -> seconds
    public static func time(_ raw: String) -> Double? {
        let s = raw.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        let p = s.split(separator: ":").map(String.init)
        guard p.count == 2 || p.count == 3 else { return nil }
        var total = 0.0
        for (i, part) in p.enumerated() {
            guard let v = Double(part) else { return nil }
            total += v * pow(60, Double(p.count - 1 - i))
        }
        return total
    }

    static func stripTags(_ s: String) -> String {
        s.replacingOccurrences(of: #"<[^>]+>"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: "&amp;", with: "&").replacingOccurrences(of: "&lt;", with: "<").replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&nbsp;", with: " ")
    }

    /// Text on screen at time t (cues may overlap; joined with a new line).
    public static func text(at t: Double, in cues: [Cue]) -> String? {
        // binary search for the last cue starting at or before t
        var lo = 0, hi = cues.count - 1, idx = -1
        while lo <= hi {
            let mid = (lo + hi) / 2
            if cues[mid].start <= t { idx = mid; lo = mid + 1 } else { hi = mid - 1 }
        }
        guard idx >= 0 else { return nil }
        var out: [String] = []
        var i = idx
        while i >= 0 && idx - i < 6 {
            if cues[i].start <= t && t < cues[i].end { out.insert(cues[i].text, at: 0) }
            i -= 1
        }
        return out.isEmpty ? nil : out.joined(separator: "\n")
    }
}
