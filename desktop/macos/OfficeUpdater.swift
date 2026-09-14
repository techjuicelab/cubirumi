import AppKit
#if canImport(Sparkle)
import Sparkle
#endif

@MainActor
final class OfficeUpdater: NSObject, NSMenuItemValidation {
    private let bundle: Bundle
#if canImport(Sparkle)
    private var controller: SPUStandardUpdaterController?
#endif

    init(bundle: Bundle = .main) {
        self.bundle = bundle
        super.init()
    }

    static func configurationIsValid(_ bundle: Bundle) -> Bool {
        guard let feed = bundle.object(forInfoDictionaryKey: "SUFeedURL") as? String,
              let feedURL = URL(string: feed), feedURL.scheme == "https", feedURL.host?.isEmpty == false,
              feedURL.user == nil, feedURL.password == nil,
              let key = bundle.object(forInfoDictionaryKey: "SUPublicEDKey") as? String,
              Data(base64Encoded: key)?.count == 32,
              let repository = bundle.object(forInfoDictionaryKey: "AgentOfficeRepositoryURL") as? String,
              let repositoryURL = URL(string: repository), repositoryURL.scheme == "https",
              repositoryURL.host == "github.com", repositoryURL.user == nil, repositoryURL.password == nil,
              repositoryURL.path.split(separator: "/").count == 2 else { return false }
        return true
    }

    func start() {
#if canImport(Sparkle)
        guard controller == nil, Self.configurationIsValid(bundle) else { return }
        let updater = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: nil, userDriverDelegate: nil)
        controller = updater
        // Initial defaults come from Info.plist. Never overwrite a user's saved choice at launch.
        updater.startUpdater()
#endif
    }

    func appendMenuItems(to menu: NSMenu) {
        let check = NSMenuItem(title: "업데이트 확인…", action: #selector(checkForUpdates), keyEquivalent: "")
        let automaticChecks = NSMenuItem(title: "자동으로 업데이트 확인", action: #selector(toggleAutomaticChecks), keyEquivalent: "")
        let automaticDownloads = NSMenuItem(title: "업데이트 자동 다운로드 및 종료 시 설치", action: #selector(toggleAutomaticDownloads), keyEquivalent: "")
        for item in [check, automaticChecks, automaticDownloads] {
            item.target = self
            item.toolTip = Self.configurationIsValid(bundle) ? nil : "이 빌드에는 자동 업데이트 연결이 설정되어 있지 않습니다."
            menu.addItem(item)
        }
    }

    @objc private func checkForUpdates(_ sender: Any?) {
#if canImport(Sparkle)
        guard let controller, controller.updater.canCheckForUpdates else { return }
        controller.checkForUpdates(sender)
#endif
    }

    @objc private func toggleAutomaticChecks(_ sender: NSMenuItem) {
#if canImport(Sparkle)
        guard let updater = controller?.updater else { return }
        updater.automaticallyChecksForUpdates.toggle()
#endif
    }

    @objc private func toggleAutomaticDownloads(_ sender: NSMenuItem) {
#if canImport(Sparkle)
        guard let updater = controller?.updater, updater.allowsAutomaticUpdates else { return }
        updater.automaticallyDownloadsUpdates.toggle()
#endif
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
#if canImport(Sparkle)
        guard let updater = controller?.updater else { menuItem.state = .off; return false }
        if menuItem.action == #selector(checkForUpdates) { return updater.canCheckForUpdates }
        if menuItem.action == #selector(toggleAutomaticChecks) {
            menuItem.state = updater.automaticallyChecksForUpdates ? .on : .off
            return true
        }
        if menuItem.action == #selector(toggleAutomaticDownloads) {
            menuItem.state = updater.automaticallyDownloadsUpdates ? .on : .off
            return updater.allowsAutomaticUpdates
        }
#endif
        return false
    }
}
