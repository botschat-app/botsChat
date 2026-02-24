import WebKit
import UniformTypeIdentifiers

/// Serves bundled web assets for the `botschat://` custom scheme.
/// The web app loads from `botschat://app/index.html` and all relative paths
/// are resolved against the bundled `web-dist` directory.
class LocalSchemeHandler: NSObject, WKURLSchemeHandler {

    private lazy var webDistURL: URL? = {
        Bundle.main.url(forResource: "web-dist", withExtension: nil)
    }()

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let requestURL = urlSchemeTask.request.url,
              let webDist = webDistURL else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }

        var path = requestURL.path
        if path.isEmpty || path == "/" {
            path = "/index.html"
        }

        // Remove leading slash to get relative path
        let relativePath = String(path.dropFirst())
        let fileURL = webDist.appendingPathComponent(relativePath)

        // Security: ensure the resolved path is within webDist
        guard fileURL.standardizedFileURL.path.hasPrefix(webDist.standardizedFileURL.path) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }

        // SPA fallback: if file doesn't exist, serve index.html
        let actualURL: URL
        if FileManager.default.fileExists(atPath: fileURL.path) {
            actualURL = fileURL
        } else {
            actualURL = webDist.appendingPathComponent("index.html")
        }

        do {
            let data = try Data(contentsOf: actualURL)
            let mimeType = Self.mimeType(for: actualURL.pathExtension)

            let response = URLResponse(
                url: requestURL,
                mimeType: mimeType,
                expectedContentLength: data.count,
                textEncodingName: mimeType.hasPrefix("text/") ? "utf-8" : nil
            )

            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(data)
            urlSchemeTask.didFinish()
        } catch {
            urlSchemeTask.didFailWithError(error)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        // No long-running tasks to cancel
    }

    private static func mimeType(for ext: String) -> String {
        if let utType = UTType(filenameExtension: ext) {
            return utType.preferredMIMEType ?? "application/octet-stream"
        }

        // Fallback for common web types
        switch ext.lowercased() {
        case "html", "htm": return "text/html"
        case "css": return "text/css"
        case "js", "mjs": return "application/javascript"
        case "json": return "application/json"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        case "ttf": return "font/ttf"
        case "ico": return "image/x-icon"
        default: return "application/octet-stream"
        }
    }
}
