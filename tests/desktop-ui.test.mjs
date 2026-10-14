import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('native WebKit exposes fullscreen and opens, restricts, and releases independent observation windows', {
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
        let blocker = BlockNavigation()
        var windows: [NSWindow] = []
        let delegate = OfficeApp(showWindow: { window in
            windows.append(window)
            // Returning a view exercises the real popup callback, while cancellation prevents any bridge GET.
            (window.contentView as? WKWebView)?.navigationDelegate = blocker
        })
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
        delegate.webViewDidClose(child)
        try check(child.uiDelegate == nil && child.navigationDelegate == nil, "closing a popup retained its delegates")
        windows[1].close()
        print("NATIVE_UI fullscreen=true independent_windows=2 external_popup=false close_releases_delegates=true")
    }
}
`;
  const source = join(directory, 'NativeUI.swift'), executable = join(directory, 'native-ui');
  await writeFile(source, application.slice(0, entryPoint) + harness);
  const compile = spawnSync('xcrun', ['swiftc', '-parse-as-library', source,
    join(root, 'desktop/macos/BundledRuntime.swift'), join(root, 'desktop/macos/OfficeUpdater.swift'),
    '-framework', 'AppKit', '-framework', 'WebKit', '-o', executable], {
    encoding: 'utf8', timeout: 35_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(compile.status, 0, compile.stderr || compile.error?.message);
  const result = spawnSync(executable, [], { encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /NATIVE_UI fullscreen=true independent_windows=2 external_popup=false close_releases_delegates=true/);
});
