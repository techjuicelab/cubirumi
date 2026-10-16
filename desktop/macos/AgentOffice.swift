import AppKit
import WebKit

@MainActor
private final class OfficeLanguageHandler: NSObject, WKScriptMessageHandler {
    weak var app: OfficeApp?
    init(app: OfficeApp) { self.app = app }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        app?.userContentController(userContentController, didReceive: message)
    }
}

@MainActor
final class OfficeApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate, WKScriptMessageHandler {
    private let officeURL = URL(string: "http://127.0.0.1:4780/?desktop=1")!
    private var window: NSWindow!
    private var webView: WKWebView!
    private var retryTimer: Timer?
    private var pinItem: NSMenuItem!
    private var status: NSTextField!
    private let runtime = BundledRuntime()
    private let updater: OfficeUpdater
    private let loginItems: OfficeLoginItems
    private let localization: OfficeLocalization
    private let defaults: UserDefaults
    private var statusMessage: OfficeMessage = .connecting
    private var connectionTask: Task<Void, Never>?
    private var terminationPending = false
    private var runtimeFailure = false
    private var observationWindows: [ObjectIdentifier: (window: NSWindow, webView: WKWebView)] = [:]
    private var observationRetries: [ObjectIdentifier: Timer] = [:]
    private let showWindow: @MainActor (NSWindow) -> Void
    private let productName = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "Agent Office"

    init(defaults: UserDefaults = .standard, loginItems: OfficeLoginItems? = nil,
         showWindow: @escaping @MainActor (NSWindow) -> Void = { $0.makeKeyAndOrderFront(nil) }) {
        self.defaults = defaults
        let localization = OfficeLocalization(defaults: defaults)
        self.localization = localization
        self.updater = OfficeUpdater(localization: localization)
        self.loginItems = loginItems ?? OfficeLoginItems(localization: localization)
        self.showWindow = showWindow
        super.init()
    }

    static func configureWebView(_ configuration: WKWebViewConfiguration) {
        configuration.preferences.isElementFullscreenEnabled = true
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        if let iconURL = Bundle.main.url(forResource: "AppIcon", withExtension: "icns"), let icon = NSImage(contentsOf: iconURL) {
            NSApp.applicationIconImage = icon
        }
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1060, height: 760),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = productName
        window.minSize = NSSize(width: 480, height: 420)
        window.backgroundColor = NSColor(red: 0.86, green: 0.91, blue: 0.95, alpha: 1)
        window.isReleasedWhenClosed = false
        window.center()
        window.setFrameAutosaveName("AgentOfficeWindow")
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        Self.configureWebView(configuration)
        configureLanguageBridge(configuration)
        webView = WKWebView(frame: window.contentView!.bounds, configuration: configuration)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        window.contentView!.addSubview(webView)
        status = NSTextField(wrappingLabelWithString: localization.text(.connecting))
        status.alignment = .center
        status.font = .systemFont(ofSize: 14)
        status.textColor = .secondaryLabelColor
        status.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(status)
        NSLayoutConstraint.activate([
            status.centerXAnchor.constraint(equalTo: window.contentView!.centerXAnchor),
            status.centerYAnchor.constraint(equalTo: window.contentView!.centerYAnchor),
            status.widthAnchor.constraint(lessThanOrEqualTo: window.contentView!.widthAnchor, constant: -60)
        ])
        buildMenu()
        applyPin(defaults.bool(forKey: "AlwaysOnTop"))
        showWindow(window)
        NSApp.activate(ignoringOtherApps: true)
        runtime.onStateChange = { [weak self] state in
            guard let self, !self.terminationPending else { return }
            switch state {
            case .external, .ready:
                self.runtimeFailure = false
                self.loadOffice()
            case .starting:
                self.runtimeFailure = false
                self.webView.isHidden = true
                self.setStatus(.preparing)
                self.status.isHidden = false
            case .failed(let message):
                self.runtimeFailure = true
                self.retryTimer?.invalidate()
                self.connectionTask?.cancel()
                self.webView.stopLoading()
                self.webView.isHidden = true
                self.setStatus(message)
                self.status.isHidden = false
            }
        }
        runtime.start()
        updater.start()
    }

    private func buildMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem(); menu.addItem(appItem)
        let appMenu = NSMenu(); appItem.submenu = appMenu
        appMenu.addItem(withTitle: localization.text("About \(productName)", "\(productName)에 관하여"), action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        updater.appendMenuItems(to: appMenu)
        appMenu.addItem(.separator())
        loginItems.appendMenuItems(to: appMenu)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: localization.text("Hide \(productName)", "\(productName) 가리기"), action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        let languageItem = NSMenuItem(title: localization.text("Language", "언어"), action: nil, keyEquivalent: "")
        let languageMenu = NSMenu(title: languageItem.title)
        for language in OfficeLanguage.allCases {
            let item = NSMenuItem(title: language == .en ? "English" : "한국어", action: #selector(selectLanguage(_:)), keyEquivalent: "")
            item.representedObject = language.rawValue
            item.target = self
            item.state = localization.language == language ? .on : .off
            languageMenu.addItem(item)
        }
        languageItem.submenu = languageMenu
        appMenu.addItem(languageItem)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: localization.text("Quit \(productName)", "\(productName) 종료"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let editItem = NSMenuItem(); menu.addItem(editItem)
        let editMenu = NSMenu(title: localization.text("Edit", "편집")); editItem.submenu = editMenu
        editMenu.addItem(withTitle: localization.text("Undo", "실행 취소"), action: NSSelectorFromString("undo:"), keyEquivalent: "z")
        editMenu.addItem(withTitle: localization.text("Redo", "다시 실행"), action: NSSelectorFromString("redo:"), keyEquivalent: "z").keyEquivalentModifierMask = [.shift, .command]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: localization.text("Cut", "잘라내기"), action: NSSelectorFromString("cut:"), keyEquivalent: "x")
        editMenu.addItem(withTitle: localization.text("Copy", "복사"), action: NSSelectorFromString("copy:"), keyEquivalent: "c")
        editMenu.addItem(withTitle: localization.text("Paste", "붙여넣기"), action: NSSelectorFromString("paste:"), keyEquivalent: "v")
        editMenu.addItem(withTitle: localization.text("Select All", "모두 선택"), action: NSSelectorFromString("selectAll:"), keyEquivalent: "a")
        let windowItem = NSMenuItem(); menu.addItem(windowItem)
        let windowMenu = NSMenu(title: localization.text("Window", "창")); windowItem.submenu = windowMenu
        pinItem = NSMenuItem(title: localization.text("Always on Top", "항상 위에 표시"), action: #selector(togglePin), keyEquivalent: "t")
        pinItem.target = self; pinItem.state = window?.level == .floating ? .on : .off; windowMenu.addItem(pinItem)
        let reload = NSMenuItem(title: localization.text("Reload Office", "사무실 새로고침"), action: #selector(reloadOffice), keyEquivalent: "r")
        reload.target = self; windowMenu.addItem(reload)
        let cctv = NSMenuItem(title: localization.text("View Entire Building", "건물 전체 보기"), action: #selector(buildingCctv), keyEquivalent: "0")
        cctv.target = self; windowMenu.addItem(cctv)
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: localization.text("Minimize", "최소화"), action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: localization.text("Enter Full Screen", "전체 화면"), action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f").keyEquivalentModifierMask = [.control, .command]
        NSApp.mainMenu = menu; NSApp.windowsMenu = windowMenu
    }

    private var observationTitle: String {
        "\(productName) · \(localization.text("Observation", "관찰"))"
    }

    private func setStatus(_ message: OfficeMessage) {
        statusMessage = message
        status?.stringValue = localization.text(message)
    }

    private func configureLanguageBridge(_ configuration: WKWebViewConfiguration) {
        // A weak proxy avoids a web view -> message handler -> app ownership cycle.
        configuration.userContentController.removeScriptMessageHandler(forName: "officeLanguage")
        configuration.userContentController.add(OfficeLanguageHandler(app: self), name: "officeLanguage")
        updateLanguageScript(configuration.userContentController)
    }

    private func updateLanguageScript(_ controller: WKUserContentController) {
        let prefix = "window.cubirumiInitialLanguage = "
        let retainedScripts = controller.userScripts.filter { !$0.source.hasPrefix(prefix) }
        controller.removeAllUserScripts()
        retainedScripts.forEach(controller.addUserScript)
        controller.addUserScript(WKUserScript(source: "\(prefix)'\(localization.language.rawValue)';",
                                               injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    private func changeLanguage(_ language: OfficeLanguage) {
        guard localization.setLanguage(language) else { return }
        buildMenu()
        status?.stringValue = localization.text(statusMessage)
        for observation in observationWindows.values { observation.window.title = observationTitle }
        // The value is restricted to the enum's two literals before entering JavaScript.
        let script = "window.cubirumiSetLanguage?.('\(language.rawValue)')"
        for view in [webView].compactMap({ $0 }) + observationWindows.values.map(\.webView) {
            updateLanguageScript(view.configuration.userContentController)
            view.evaluateJavaScript(script, completionHandler: nil)
        }
    }

    @objc private func selectLanguage(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let language = OfficeLanguage(rawValue: raw) else { return }
        changeLanguage(language)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard message.name == "officeLanguage",
              let raw = message.body as? String, let language = OfficeLanguage(rawValue: raw),
              OfficeLanguage.acceptsOrigin(scheme: origin.protocol, host: origin.host, port: origin.port,
                                           isMainFrame: message.frameInfo.isMainFrame),
              let source = message.frameInfo.request.url, isOffice(source),
              let sourceView = message.webView,
              sourceView === webView || observationWindows.values.contains(where: { $0.webView === sourceView }) else { return }
        changeLanguage(language)
    }

    private func applyPin(_ enabled: Bool) {
        for target in [window!] + observationWindows.values.map(\.window) {
            target.level = enabled ? .floating : .normal
            target.collectionBehavior = enabled ? [.canJoinAllSpaces, .fullScreenAuxiliary] : [.managed, .fullScreenPrimary]
        }
        pinItem.state = enabled ? .on : .off
    }
    @objc private func togglePin() {
        let enabled = window.level != .floating
        defaults.set(enabled, forKey: "AlwaysOnTop"); applyPin(enabled)
    }
    private var activeWebView: WKWebView? {
        observationWindows.values.first(where: { $0.window === NSApp.keyWindow })?.webView ?? webView
    }
    @objc private func reloadOffice() {
        if let active = activeWebView, active !== webView { active.reload() }
        else { loadOffice() }
    }
    @objc private func buildingCctv() {
        activeWebView?.evaluateJavaScript("document.querySelector('[data-building-cctv]')?.click()", completionHandler: nil)
    }
    private func loadOffice() {
        guard !terminationPending, !runtimeFailure else { return }
        retryTimer?.invalidate(); retryTimer = nil
        setStatus(.connecting); status.isHidden = false
        connectionTask?.cancel()
        connectionTask = Task { [weak self] in
            guard let self else { return }
            let connected = await self.runtime.validateConnection()
            guard !Task.isCancelled, !self.terminationPending, !self.runtimeFailure else { return }
            guard connected else { self.retryConnection(); return }
            self.webView.isHidden = false
            self.webView.load(URLRequest(url: self.officeURL, cachePolicy: .reloadIgnoringLocalCacheData))
        }
    }
    private func retryConnection() {
        guard !terminationPending, !runtimeFailure else { return }
        setStatus(.waiting)
        status.isHidden = false
        retryTimer?.invalidate()
        retryTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.loadOffice() }
        }
    }
    private func isOffice(_ url: URL) -> Bool {
        url.scheme == "http" && url.host == "127.0.0.1" && url.port == 4780 && url.user == nil && url.password == nil
    }
    private func openUsageLink(_ action: WKNavigationAction) {
        guard action.navigationType == .linkActivated,
              let source = action.sourceFrame.request.url, isOffice(source),
              let url = action.request.url,
              url.absoluteString == "https://claude.ai/settings/usage" else { return }
        NSWorkspace.shared.open(url)
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, isOffice(url) else {
            openUsageLink(navigationAction)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard !terminationPending, !runtimeFailure, let url = navigationAction.request.url, isOffice(url) else {
            openUsageLink(navigationAction)
            return nil
        }
        Self.configureWebView(configuration)
        configureLanguageBridge(configuration)
        let width = min(2400, max(480, windowFeatures.width?.doubleValue ?? 960))
        let height = min(1800, max(420, windowFeatures.height?.doubleValue ?? 720))
        let observation = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                                   styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        observation.title = observationTitle
        observation.minSize = NSSize(width: 480, height: 420)
        observation.isReleasedWhenClosed = false
        observation.delegate = self
        observation.center()
        let enabled = defaults.bool(forKey: "AlwaysOnTop")
        observation.level = enabled ? .floating : .normal
        observation.collectionBehavior = enabled ? [.canJoinAllSpaces, .fullScreenAuxiliary] : [.managed, .fullScreenPrimary]
        let childView = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: configuration)
        childView.autoresizingMask = [.width, .height]
        childView.navigationDelegate = self
        childView.uiDelegate = self
        observation.contentView = childView
        observationWindows[ObjectIdentifier(observation)] = (observation, childView)
        showWindow(observation)
        // WebKit owns the pending navigation and must receive this exact new view.
        return childView
    }
    func webViewDidClose(_ webView: WKWebView) {
        observationWindows.values.first(where: { $0.webView === webView })?.window.close()
    }
    func windowWillClose(_ notification: Notification) {
        guard let closing = notification.object as? NSWindow,
              let removed = observationWindows.removeValue(forKey: ObjectIdentifier(closing)) else { return }
        observationRetries.removeValue(forKey: ObjectIdentifier(removed.webView))?.invalidate()
        removed.webView.stopLoading()
        removed.webView.navigationDelegate = nil
        removed.webView.uiDelegate = nil
    }
    private func retryWebView(_ webView: WKWebView) {
        if webView === self.webView { retryConnection(); return }
        let key = ObjectIdentifier(webView)
        guard !terminationPending, !runtimeFailure,
              observationWindows.values.contains(where: { $0.webView === webView }) else { return }
        observationRetries.removeValue(forKey: key)?.invalidate()
        observationRetries[key] = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self, weak webView] _ in
            MainActor.assumeIsolated {
                guard let self, let webView else { return }
                self.observationRetries.removeValue(forKey: key)
                guard !self.terminationPending, !self.runtimeFailure,
                      self.observationWindows.values.contains(where: { $0.webView === webView }) else { return }
                webView.load(URLRequest(url: self.officeURL, cachePolicy: .reloadIgnoringLocalCacheData))
            }
        }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView === self.webView { status.isHidden = true }
        observationRetries.removeValue(forKey: ObjectIdentifier(webView))?.invalidate()
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { retryWebView(webView) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { retryWebView(webView) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { retryWebView(webView) }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow(window); return true
    }
    func applicationDidBecomeActive(_ notification: Notification) { loginItems.refresh() }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard runtime.isBundled else { return .terminateNow }
        guard !terminationPending else { return .terminateLater }
        terminationPending = true
        retryTimer?.invalidate()
        connectionTask?.cancel()
        webView.stopLoading()
        for timer in observationRetries.values { timer.invalidate() }
        observationRetries.removeAll()
        for observation in observationWindows.values { observation.webView.stopLoading() }
        setStatus(.closing)
        status.isHidden = false
        runtime.shutdown { [weak self] stopped in
            guard let self else { return }
            if !stopped {
                self.terminationPending = false
                self.runtimeFailure = true
                self.setStatus(.shutdownFailed)
            }
            sender.reply(toApplicationShouldTerminate: stopped)
        }
        return .terminateLater
    }
    func applicationWillTerminate(_ notification: Notification) {
        retryTimer?.invalidate()
        connectionTask?.cancel()
        for timer in observationRetries.values { timer.invalidate() }
        observationRetries.removeAll()
    }
}

@main
enum Main {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = OfficeApp()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
