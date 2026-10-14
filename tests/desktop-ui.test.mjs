import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('native WebKit localizes menus, synchronizes language safely, and retains observation-window behavior', {
  skip: process.platform !== 'darwin', timeout: 60_000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'office-native-ui-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const application = await readFile(join(root, 'desktop/macos/AgentOffice.swift'), 'utf8');
  const entryPoint = application.lastIndexOf('\n@main\n');
  assert.ok(entryPoint > 0);
  // Compile the production delegate with a test entry point; no app launch, runtime, or real bridge access.
  const harness = String.raw`
@MainActor
final class BlockNavigation: NSObject, WKNavigationDelegate {
    var loaded = false
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded = true }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(.cancel)
    }
}

extension OfficeApp {
    func auditBuildMenu() { buildMenu() }
    func auditLanguage() -> OfficeLanguage { localization.language }
    func auditSelectLanguage(_ language: String) {
        let item = NSMenuItem()
        item.representedObject = language
        selectLanguage(item)
        buildMenu()
    }
}

enum AuditFailure: Error { case failed(String) }

@main
enum Audit {
    @MainActor static func check(_ condition: Bool, _ message: String) throws {
        if !condition { throw AuditFailure.failed(message) }
    }
    @MainActor static func wait(_ condition: () -> Bool) throws {
        let deadline = Date().addingTimeInterval(8)
        while !condition() && Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
        try check(condition(), "WebKit callback timed out")
    }
    @MainActor static func evaluate(_ view: WKWebView, _ script: String) throws -> Any? {
        var finished = false
        var result: Any?
        var failure: Error?
        view.evaluateJavaScript(script) { value, error in
            result = value; failure = error; finished = true
        }
        try wait { finished }
        if let failure { throw failure }
        return result
    }
    @MainActor static func main() throws {
        let application = NSApplication.shared
        application.setActivationPolicy(.prohibited)
        let suite = "io.cubirumi.language-audit.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(true, forKey: "AlwaysOnTop")
        defaults.set("saved-history", forKey: "HistorySentinel")
        let localization = OfficeLocalization(defaults: defaults)
        try check(localization.language == .en, "English is not the default language")
        try check(OfficeLanguage.normalized("invalid") == .en, "invalid language did not fall back to English")
        try check(OfficeLanguage.normalized("ko") == .ko, "Korean language is not recognized")
        try check(OfficeLanguage.acceptsOrigin(scheme: "http", host: "127.0.0.1", port: 4780, isMainFrame: true), "local origin was rejected")
        for origin in [("https", "127.0.0.1", 4780, true), ("http", "localhost", 4780, true),
                       ("http", "127.0.0.1", 4781, true), ("http", "127.0.0.1", 4780, false)] {
            try check(!OfficeLanguage.acceptsOrigin(scheme: origin.0, host: origin.1, port: origin.2, isMainFrame: origin.3), "untrusted language origin was accepted")
        }
        let blocker = BlockNavigation()
        var windows: [NSWindow] = []
        let delegate = OfficeApp(defaults: defaults, showWindow: { window in
            windows.append(window)
            // Returning a view exercises the real popup callback, while cancellation prevents any bridge GET.
            (window.contentView as? WKWebView)?.navigationDelegate = blocker
        })
        delegate.auditBuildMenu()
        try check(application.mainMenu?.item(at: 1)?.submenu?.title == "Edit", "native menu did not default to English")
        let configuration = WKWebViewConfiguration()
        OfficeApp.configureWebView(configuration)
        try check(configuration.preferences.isElementFullscreenEnabled, "element fullscreen is disabled")
        // Evaluation has no physical click, so allow script-created popups in this isolated view only.
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        let source = WKWebView(frame: NSRect(x: 0, y: 0, width: 640, height: 480), configuration: configuration)
        source.uiDelegate = delegate
        source.loadHTMLString("<html><body>synthetic office</body></html>", baseURL: URL(string: "http://127.0.0.1:4780/"))
        try wait { !source.isLoading }
        let api = try evaluate(source, "typeof document.documentElement.requestFullscreen") as? String
        try check(api == "function", "fullscreen API is unavailable")
        let opened = try evaluate(source, "Boolean(window.open('/', 'office-audit-first', 'popup,width=960,height=720'))") as? Bool
        try check(opened == true && windows.count == 1, "independent observation window was not created")
        guard let child = windows[0].contentView as? WKWebView else { throw AuditFailure.failed("missing child web view") }
        try check(child !== source, "popup reused the original web view")
        try check(child.configuration.preferences.isElementFullscreenEnabled, "popup lost fullscreen support")
        try check(child.uiDelegate === delegate, "popup lost its navigation and popup policy")
        let second = try evaluate(source, "Boolean(window.open('/', 'office-audit-second', 'popup,width=900,height=650'))") as? Bool
        try check(second == true && windows.count == 2, "additional independent window was not retained")
        let outside = try evaluate(source, "Boolean(window.open('https://example.invalid/', 'office-audit-outside'))") as? Bool
        try check(outside == false && windows.count == 2, "external popup bypassed the local URL policy")
        for window in windows {
            let view = window.contentView as! WKWebView
            view.navigationDelegate = nil
            view.loadHTMLString("<html><script>window.appliedLanguages=[];window.cubirumiSetLanguage=function(language){window.appliedLanguages.push(language)}</script></html>", baseURL: URL(string: "http://127.0.0.1:4780/"))
            try wait { !view.isLoading }
        }
        delegate.auditSelectLanguage("ko")
        try check(delegate.auditLanguage() == .ko, "native language selection failed")
        try check(application.mainMenu?.item(at: 1)?.submenu?.title == "편집", "Korean native menu is missing")
        try check(defaults.string(forKey: OfficeLocalization.preferenceKey) == "ko", "language choice was not saved")
        try check(OfficeLocalization(defaults: defaults).language == .ko, "saved language was not restored")
        try check(defaults.bool(forKey: "AlwaysOnTop") && defaults.string(forKey: "HistorySentinel") == "saved-history", "language change modified unrelated preferences")
        for window in windows {
            let value = try evaluate(window.contentView as! WKWebView, "window.appliedLanguages.join(',')") as? String
            try check(value == "ko", "native language selection did not synchronize every observation window")
            try check(window.title.hasSuffix("· 관찰"), "observation window title did not change language")
        }
        delegate.auditSelectLanguage("invalid")
        try check(delegate.auditLanguage() == .ko, "invalid native menu value changed the language")
        _ = try evaluate(child, "window.webkit.messageHandlers.officeLanguage.postMessage('en'); true")
        try wait { delegate.auditLanguage() == .en }
        try check(application.mainMenu?.item(at: 1)?.submenu?.title == "Edit", "English native menu did not restore")
        let initial = child.configuration.userContentController.userScripts.filter { $0.source.hasPrefix("window.cubirumiInitialLanguage = ") }
        try check(initial.count == 1 && initial[0].source.contains("'en'"), "native language hint did not refresh without duplicate scripts")
        _ = try evaluate(child, "window.webkit.messageHandlers.officeLanguage.postMessage('invalid'); true")
        _ = try evaluate(child, "const frame=document.createElement('iframe');frame.srcdoc=\"<script>window.webkit.messageHandlers.officeLanguage.postMessage('ko')<\\/script>\";document.body.append(frame); true")
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        try check(delegate.auditLanguage() == .en, "invalid or iframe language message was accepted")
        child.loadHTMLString("<html><body>untrusted origin</body></html>", baseURL: URL(string: "http://127.0.0.1:4781/"))
        try wait { !child.isLoading }
        _ = try evaluate(child, "window.webkit.messageHandlers.officeLanguage.postMessage('ko'); true")
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        try check(delegate.auditLanguage() == .en, "another port changed native language")
        delegate.webViewDidClose(child)
        try check(child.uiDelegate == nil && child.navigationDelegate == nil, "closing a popup retained its delegates")
        windows[1].close()
        print("NATIVE_UI fullscreen=true independent_windows=2 external_popup=false close_releases_delegates=true")
        print("NATIVE_LANGUAGE default=en persisted=true windows_synchronized=2 origin_guard=true preferences_preserved=true")
    }
}
`;
  const source = join(directory, 'NativeUI.swift'), executable = join(directory, 'native-ui');
  await writeFile(source, application.slice(0, entryPoint) + harness);
  const compile = spawnSync('xcrun', ['swiftc', '-parse-as-library', source,
    join(root, 'desktop/macos/BundledRuntime.swift'), join(root, 'desktop/macos/OfficeUpdater.swift'),
    join(root, 'desktop/macos/OfficeLanguage.swift'),
    '-framework', 'AppKit', '-framework', 'WebKit', '-o', executable], {
    encoding: 'utf8', timeout: 35_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(compile.status, 0, compile.stderr || compile.error?.message);
  const result = spawnSync(executable, [], { encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /NATIVE_UI fullscreen=true independent_windows=2 external_popup=false close_releases_delegates=true/);
  assert.match(result.stdout, /NATIVE_LANGUAGE default=en persisted=true windows_synchronized=2 origin_guard=true preferences_preserved=true/);
});
