import Foundation
import Darwin

private final class LocalHealthSessionDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor
final class BundledRuntime {
    enum State {
        case external
        case starting
        case ready
        case failed(String)
    }

    private let nodeURL: URL
    private let runtimeURL: URL
    private let runtimeRoot: URL
    private let resourcesPresent: Bool
    private let bundleIncomplete: Bool
    private let instanceID = UUID().uuidString
    private let healthURL: URL
    private let healthSession = URLSession(configuration: .ephemeral, delegate: LocalHealthSessionDelegate(), delegateQueue: nil)
    private var process: Process?
    private var input: Pipe?
    private var startupTask: Task<Void, Never>?
    private var shutdownTask: Task<Void, Never>?
    private var stopping = false
    private var shutdownCallbacks: [(Bool) -> Void] = []
    var onStateChange: ((State) -> Void)?

    var isBundled: Bool { resourcesPresent }

    init(bundle: Bundle = .main, healthURL: URL = URL(string: "http://127.0.0.1:4780/api/health")!) {
        self.healthURL = healthURL
        nodeURL = bundle.bundleURL.appendingPathComponent("Contents/Helpers/node")
        runtimeRoot = bundle.bundleURL.appendingPathComponent("Contents/Resources/runtime", isDirectory: true)
        runtimeURL = runtimeRoot.appendingPathComponent("scripts/runtime.mjs")
        let nodeExists = FileManager.default.fileExists(atPath: nodeURL.path)
        let runtimeExists = FileManager.default.fileExists(atPath: runtimeURL.path)
        resourcesPresent = nodeExists || runtimeExists
        bundleIncomplete = !nodeExists || !runtimeExists
    }

    func start() {
        guard startupTask == nil, process == nil, !stopping else { return }
        guard resourcesPresent else { onStateChange?(.external); return }
        guard !bundleIncomplete, FileManager.default.isExecutableFile(atPath: nodeURL.path) else {
            onStateChange?(.failed("앱의 실행 파일이 완전하지 않아요. Agent Office를 다시 내려받아 설치해 주세요."))
            return
        }
        onStateChange?(.starting)
        startupTask = Task { [weak self] in
            guard let self else { return }
            // An existing listener belongs to another launch. Never adopt or stop it.
            if await self.healthResponse() != nil {
                guard !Task.isCancelled, !self.stopping else { return }
                self.onStateChange?(.failed(self.conflictMessage))
                return
            }
            guard !Task.isCancelled, !self.stopping else { return }
            self.launch()
            for _ in 0..<50 {
                guard !Task.isCancelled, !self.stopping, self.process?.isRunning == true else { return }
                if let health = await self.healthResponse() {
                    guard !Task.isCancelled, !self.stopping else { return }
                    if self.matches(health) {
                        self.onStateChange?(.ready)
                    } else {
                        self.onStateChange?(.failed(self.conflictMessage))
                        self.shutdown { _ in }
                    }
                    return
                }
                do { try await Task.sleep(nanoseconds: 200_000_000) } catch { return }
            }
            guard !Task.isCancelled, !self.stopping else { return }
            self.onStateChange?(.failed("사무실 서버를 시작하지 못했어요. 앱을 종료한 뒤 다시 열어 주세요."))
            self.shutdown { _ in }
        }
    }

    private var conflictMessage: String {
        "다른 로컬 서버가 4780 포트를 사용하고 있어요.\n기존 Agent Office 자동 실행이나 터미널 서버를 확인한 뒤 이 앱을 다시 열어 주세요."
    }

    private func launch() {
        let child = Process()
        let stdin = Pipe()
        let dataURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/AgentOffice", isDirectory: true)
        var environment = ProcessInfo.processInfo.environment
        environment["AGENT_OFFICE_DATA_DIR"] = environment["AGENT_OFFICE_DATA_DIR"].flatMap { $0.isEmpty ? nil : $0 } ?? dataURL.path
        environment["AGENT_OFFICE_INSTANCE_ID"] = instanceID
        environment["AGENT_OFFICE_MANAGED_DESKTOP"] = "1"
        environment["AGENT_OFFICE_ENDPOINT"] = "http://127.0.0.1:4780/api/events"
        environment["AGENT_OFFICE_USAGE_ENDPOINT"] = "http://127.0.0.1:4780/api/usage"
        let searchPaths = [nodeURL.deletingLastPathComponent().path,
                           FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin").path,
                           "/opt/homebrew/bin", "/usr/local/bin"]
            + (environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(separator: ":").map(String.init)
        var seenPaths = Set<String>()
        environment["PATH"] = searchPaths.filter { seenPaths.insert($0).inserted }.joined(separator: ":")
        // A GUI launch must not load another Node installation's injected modules.
        environment.removeValue(forKey: "NODE_OPTIONS")
        environment.removeValue(forKey: "NODE_PATH")
        environment.removeValue(forKey: "SPARKLE_PRIVATE_KEY")
        child.executableURL = nodeURL
        child.arguments = [runtimeURL.path]
        child.currentDirectoryURL = runtimeRoot
        child.environment = environment
        child.standardInput = stdin
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        child.terminationHandler = { [weak self] terminated in
            Task { @MainActor [weak self] in
                guard let self, self.process === terminated else { return }
                self.input = nil
                if !self.stopping {
                    self.onStateChange?(.failed("사무실 서버가 종료되었어요. 앱을 종료한 뒤 다시 열어 주세요."))
                }
            }
        }
        process = child
        input = stdin
        do {
            try child.run()
            try? stdin.fileHandleForReading.close()
        }
        catch {
            process = nil
            input = nil
            onStateChange?(.failed("앱에 포함된 사무실 서버를 실행하지 못했어요. 설치 파일과 macOS 지원 버전을 확인해 주세요."))
        }
    }

    private struct Health {
        let ok: Bool
        let service: String?
        let instanceID: String?
    }

    private func healthResponse() async -> Health? {
        var request = URLRequest(url: healthURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 0.7)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (data, response) = try await healthSession.data(for: request)
            guard let http = response as? HTTPURLResponse else { return nil }
            guard data.count <= 64 * 1024,
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return Health(ok: false, service: nil, instanceID: nil)
            }
            return Health(ok: http.statusCode == 200 && object["ok"] as? Bool == true,
                          service: object["service"] as? String, instanceID: object["instanceId"] as? String)
        } catch { return nil }
    }

    private func matches(_ health: Health) -> Bool {
        health.ok && health.service == "agent-office" && health.instanceID == instanceID
    }

    func validateConnection() async -> Bool {
        guard resourcesPresent else { return true }
        guard !stopping, process?.isRunning == true, let health = await healthResponse() else { return false }
        return !stopping && process?.isRunning == true && matches(health)
    }

    func shutdown(completion: @escaping (Bool) -> Void) {
        shutdownCallbacks.append(completion)
        guard shutdownTask == nil else { return }
        stopping = true
        startupTask?.cancel()
        startupTask = nil
        // Closing the parent's write end also works if the app exits unexpectedly.
        try? input?.fileHandleForWriting.close()
        input = nil
        shutdownTask = Task { [weak self] in
            guard let self else { return }
            if let child = self.process, child.isRunning {
                await self.waitForExit(child, iterations: 50)
                if child.isRunning {
                    child.terminate()
                    await self.waitForExit(child, iterations: 20)
                }
                if child.isRunning {
                    // Signal only the Process created by this controller, never a port owner or process group.
                    _ = Darwin.kill(child.processIdentifier, SIGKILL)
                    await self.waitForExit(child, iterations: 10)
                }
            }
            let stopped = self.process?.isRunning != true
            if stopped { self.process = nil }
            let callbacks = self.shutdownCallbacks
            self.shutdownCallbacks.removeAll()
            self.shutdownTask = nil
            callbacks.forEach { $0(stopped) }
        }
    }

    private func waitForExit(_ child: Process, iterations: Int) async {
        for _ in 0..<iterations {
            guard child.isRunning else { return }
            do { try await Task.sleep(nanoseconds: 100_000_000) } catch { return }
        }
    }
}
