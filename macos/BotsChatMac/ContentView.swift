import SwiftUI
import WebKit

struct ContentView: View {
    @StateObject private var webViewManager = WebViewManager()

    var body: some View {
        WebViewContainer(manager: webViewManager)
            .ignoresSafeArea()
            .onReceive(NotificationCenter.default.publisher(for: .openSettings)) { _ in
                webViewManager.evaluateJS("document.querySelector('[data-settings-btn]')?.click()")
            }
            .onReceive(NotificationCenter.default.publisher(for: .toggleSidebar)) { _ in
                webViewManager.evaluateJS("""
                    document.querySelector('[data-sidebar-toggle]')?.click()
                """)
            }
            .onReceive(NotificationCenter.default.publisher(for: .pushNavigation)) { notification in
                if let sessionKey = notification.userInfo?["sessionKey"] as? String {
                    let escaped = sessionKey.replacingOccurrences(of: "'", with: "\\'")
                    webViewManager.evaluateJS("""
                        window.dispatchEvent(new CustomEvent('botschat:push-nav', {
                            detail: { sessionKey: '\(escaped)' }
                        }));
                    """)
                }
            }
    }
}
