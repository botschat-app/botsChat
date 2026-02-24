import WebKit
import Combine
import UserNotifications

class WebViewManager: NSObject, ObservableObject {
    let webView: WKWebView
    private var popupWebView: WKWebView?
    private var popupWindow: NSWindow?

    override init() {
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        let prefs = WKWebpagePreferences()
        prefs.allowsContentJavaScript = true
        config.defaultWebpagePreferences = prefs

        config.preferences.javaScriptCanOpenWindowsAutomatically = true

        // Register JS→Native message handler for notifications
        let contentController = config.userContentController

        let nativeScript = WKUserScript(
            source: """
                window.__BOTSCHAT_NATIVE__ = true;
                window.__BOTSCHAT_PLATFORM__ = 'macos';
                window.__BOTSCHAT_NATIVE_NOTIFY__ = function(payload) {
                    window.webkit.messageHandlers.botschatNotification.postMessage(payload);
                };
                window.__BOTSCHAT_NATIVE_REQUEST_PERMISSION__ = function() {
                    window.webkit.messageHandlers.botschatNotificationPermission.postMessage({});
                };
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        )
        contentController.addUserScript(nativeScript)

        // Fix: prevent Enter from triggering send during IME composition.
        // In WKWebView, when a Chinese IME user presses Enter to confirm
        // English text, the keydown fires before compositionend and
        // isComposing can already be false. This capture-phase listener
        // intercepts the event before React sees it.
        let imeFix = WKUserScript(
            source: """
                (function() {
                    var composing = false;
                    var justEnded = false;
                    var timer = null;
                    document.addEventListener('compositionstart', function() {
                        composing = true;
                        justEnded = false;
                        if (timer) { clearTimeout(timer); timer = null; }
                    }, true);
                    document.addEventListener('compositionupdate', function() {
                        composing = true;
                        justEnded = false;
                    }, true);
                    document.addEventListener('compositionend', function() {
                        composing = false;
                        justEnded = true;
                        if (timer) clearTimeout(timer);
                        timer = setTimeout(function() { justEnded = false; timer = null; }, 300);
                    }, true);
                    document.addEventListener('keydown', function(e) {
                        if (e.key === 'Enter' && !e.shiftKey &&
                            (composing || justEnded || e.isComposing || e.keyCode === 229)) {
                            e.stopImmediatePropagation();
                            e.preventDefault();
                        }
                    }, true);
                })();
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        contentController.addUserScript(imeFix)

        // Fix scrolling for full-page views (Login, Onboarding, DataConsent).
        // The production CSS sets `html, body { overflow: hidden }` for the
        // panel-based main layout, which prevents scrolling on these pages.
        let scrollFix = WKUserScript(
            source: """
                (function() {
                    var style = document.createElement('style');
                    style.textContent = `
                        html, body { overflow: auto !important; }
                        #root > div > .min-h-screen,
                        #root > div.min-h-screen {
                            min-height: 100vh;
                            overflow-y: auto;
                        }
                        .flex.h-screen { overflow: hidden; }
                    `;
                    document.head.appendChild(style);
                })();
            """,
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        )
        contentController.addUserScript(scrollFix)

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.customUserAgent = "BotsChatMac/1.0"

        if #available(macOS 13.3, *) {
            webView.isInspectable = true
        }

        self.webView = webView
        super.init()

        // Register JS→Native notification handlers (must be after super.init)
        contentController.add(self, name: "botschatNotification")
        contentController.add(self, name: "botschatNotificationPermission")

        webView.navigationDelegate = self
        webView.uiDelegate = self

        loadWebApp()
    }

    func evaluateJS(_ script: String) {
        webView.evaluateJavaScript(script) { _, error in
            if let error = error {
                print("[WebView] JS eval error: \(error.localizedDescription)")
            }
        }
    }

    private func loadWebApp() {
        // Load the production web app directly — OAuth, WebSocket, and API
        // all work naturally from an HTTPS origin.
        // For local dev, change this to e.g. "http://localhost:8787"
        let urlString = ProcessInfo.processInfo.environment["BOTSCHAT_URL"]
            ?? "https://console.botschat.app"

        if let url = URL(string: urlString) {
            webView.load(URLRequest(url: url))
        }
    }

    private func dismissPopup() {
        popupWindow?.close()
        popupWindow = nil
        popupWebView = nil
    }
}

// MARK: - WKNavigationDelegate

extension WebViewManager: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }

        if url.scheme == "https" || url.scheme == "http" {
            decisionHandler(.allow)
            return
        }

        if url.scheme == "mailto" || url.scheme == "tel" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }

        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        print("[WebView] Navigation failed: \(error.localizedDescription)")
    }
}

// MARK: - WKUIDelegate (OAuth popup + JS dialogs)

extension WebViewManager: WKUIDelegate {
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {

        let url = navigationAction.request.url
        let host = url?.host ?? ""

        // OAuth-related domains should open in a child WKWebView so Firebase
        // signInWithPopup can complete its flow and postMessage back.
        let isAuthDomain = host.contains("accounts.google.com") ||
                           host.contains("github.com") ||
                           host.contains("appleid.apple.com") ||
                           host.contains("firebaseapp.com") ||
                           host.contains("firebaseauth.com") ||
                           host.contains("googleapis.com") ||
                           host.hasSuffix(".botschat.app")

        if isAuthDomain {
            return openPopup(configuration: configuration, url: url)
        }

        // Non-auth external links open in the system browser
        if let url = url, url.scheme == "https" || url.scheme == "http" {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    private func openPopup(configuration: WKWebViewConfiguration, url: URL?) -> WKWebView {
        let popup = WKWebView(frame: .zero, configuration: configuration)
        popup.uiDelegate = self
        popup.navigationDelegate = self

        if #available(macOS 13.3, *) {
            popup.isInspectable = true
        }

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 500, height: 700),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Sign In"
        window.contentView = popup
        window.center()
        window.isReleasedWhenClosed = false
        window.makeKeyAndOrderFront(nil)

        self.popupWebView = popup
        self.popupWindow = window

        return popup
    }

    func webViewDidClose(_ webView: WKWebView) {
        if webView == popupWebView {
            dismissPopup()
        }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.begin { result in
            completionHandler(result == .OK ? panel.urls : nil)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = "BotsChat"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = "BotsChat"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }
}

// MARK: - WKScriptMessageHandler (Native Notifications)

extension WebViewManager: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController,
                                didReceive message: WKScriptMessage) {
        switch message.name {
        case "botschatNotification":
            handleNotificationRequest(message.body)
        case "botschatNotificationPermission":
            requestNotificationPermission()
        default:
            break
        }
    }

    private func handleNotificationRequest(_ body: Any) {
        guard let dict = body as? [String: Any] else {
            print("[Notification] Invalid payload")
            return
        }

        let title = dict["title"] as? String ?? "BotsChat"
        let bodyText = dict["body"] as? String ?? ""
        let sessionKey = dict["sessionKey"] as? String

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = bodyText
        content.sound = .default
        if let sessionKey = sessionKey {
            content.userInfo = ["sessionKey": sessionKey]
        }

        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil
        )

        UNUserNotificationCenter.current().add(request) { error in
            if let error = error {
                print("[Notification] Failed to deliver: \(error.localizedDescription)")
            }
        }
    }

    private func requestNotificationPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            DispatchQueue.main.async {
                let result = granted ? "granted" : "denied"
                self.evaluateJS("window.__BOTSCHAT_NOTIFICATION_PERMISSION__ = '\(result)';")
            }
            if let error = error {
                print("[Notification] Permission request error: \(error.localizedDescription)")
            }
        }
    }
}
