import SwiftUI
import WebKit

struct WebViewContainer: NSViewRepresentable {
    let manager: WebViewManager

    func makeNSView(context: Context) -> WKWebView {
        return manager.webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
