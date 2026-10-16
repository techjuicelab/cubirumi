import AppKit
import ServiceManagement

enum OfficeLegacyLoginStatus { case absent, configured, unrecognized }

@MainActor
final class OfficeLegacyLoginItem {
    static let label = "io.cubirumi.login"
    private let plist: URL
    private let backups: URL
    private let files: FileManager
    private let launchctl: ([String]) throws -> Int32

    init(home: URL = FileManager.default.homeDirectoryForCurrentUser, files: FileManager = .default,
         launchctl: @escaping ([String]) throws -> Int32 = OfficeLegacyLoginItem.runLaunchctl) {
        plist = home.appendingPathComponent("Library/LaunchAgents/\(Self.label).plist")
        backups = home.appendingPathComponent("Library/Application Support/AgentOffice/login-item-backups")
        self.files = files
        self.launchctl = launchctl
    }

    var status: OfficeLegacyLoginStatus {
        let attributes: [FileAttributeKey: Any]
        do { attributes = try files.attributesOfItem(atPath: plist.path) }
        catch let error as NSError {
            return error.domain == NSCocoaErrorDomain && [NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(error.code)
                ? .absent : .unrecognized
        }
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let data = try? Data(contentsOf: plist), Self.recognizes(data) else { return .unrecognized }
        return .configured
    }

    private static func recognizes(_ data: Data) -> Bool {
        guard let dictionary = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              dictionary["Label"] as? String == label,
              dictionary["Program"] == nil || dictionary["Program"] as? String == "/usr/bin/open",
              let arguments = dictionary["ProgramArguments"] as? [String], arguments.count == 3,
              arguments[0] == "/usr/bin/open", arguments[1] == "-g",
              arguments[2].hasPrefix("/"), URL(fileURLWithPath: arguments[2]).lastPathComponent == "Cubirumi.app" else { return false }
        return true
    }

    func disable() throws {
        guard status != .absent else { return }
        guard status == .configured else { throw OfficeLoginError.unrecognizedLegacy }
        let original = try Data(contentsOf: plist)
        guard Self.recognizes(original), status == .configured else { throw OfficeLoginError.unrecognizedLegacy }
        let directory = backups.appendingPathComponent(UUID().uuidString)
        try files.createDirectory(at: directory, withIntermediateDirectories: true)
        try original.write(to: directory.appendingPathComponent(plist.lastPathComponent), options: .withoutOverwriting)
        let service = "gui/\(getuid())/\(Self.label)"
        let stopped = try launchctl(["bootout", service])
        // launchctl returns 113 when this service is no longer loaded in the user's GUI domain.
        if stopped != 0 {
            guard try launchctl(["print", service]) == 113 else { throw OfficeLoginError.legacyStopFailed }
        }
        guard try Data(contentsOf: plist) == original, status == .configured else { throw OfficeLoginError.legacyChanged }
        try files.removeItem(at: plist)
    }

    nonisolated private static func runLaunchctl(_ arguments: [String]) throws -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        return process.terminationStatus
    }
}

enum OfficeLoginError: Error {
    case unrecognizedLegacy, legacyStopFailed, legacyChanged, statusUnchanged
}

@MainActor
final class OfficeLoginItems: NSObject, NSMenuItemValidation {
    private let localization: OfficeLocalization
    private let serviceStatus: () -> SMAppService.Status
    private let register: () throws -> Void
    private let unregister: () throws -> Void
    private let legacyStatus: () -> OfficeLegacyLoginStatus
    private let disableLegacy: () throws -> Void
    private let openSettings: () -> Void
    private let reportError: (String) -> Void
    private weak var toggleItem: NSMenuItem?

    init(localization: OfficeLocalization,
         serviceStatus: @escaping () -> SMAppService.Status = { SMAppService.mainApp.status },
         register: @escaping () throws -> Void = { try SMAppService.mainApp.register() },
         unregister: @escaping () throws -> Void = { try SMAppService.mainApp.unregister() },
         legacy: OfficeLegacyLoginItem? = nil,
         legacyStatus: (() -> OfficeLegacyLoginStatus)? = nil, disableLegacy: (() throws -> Void)? = nil,
         openSettings: @escaping () -> Void = { SMAppService.openSystemSettingsLoginItems() },
         reportError: ((String) -> Void)? = nil) {
        self.localization = localization
        self.serviceStatus = serviceStatus
        self.register = register
        self.unregister = unregister
        let legacy = legacy ?? OfficeLegacyLoginItem()
        self.legacyStatus = legacyStatus ?? { legacy.status }
        self.disableLegacy = disableLegacy ?? { try legacy.disable() }
        self.openSettings = openSettings
        self.reportError = reportError ?? { message in
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = localization.text("Could Not Change Launch at Login", "로그인 실행 설정을 변경할 수 없어요")
            alert.informativeText = message
            alert.addButton(withTitle: localization.text("OK", "확인"))
            alert.runModal()
        }
        super.init()
    }

    func appendMenuItems(to menu: NSMenu) {
        let toggle = NSMenuItem(title: "", action: #selector(toggleLogin), keyEquivalent: "")
        toggle.target = self
        menu.addItem(toggle)
        toggleItem = toggle
        let settings = NSMenuItem(title: localization.text("Login Item Settings…", "로그인 항목 설정…"), action: #selector(showSettings), keyEquivalent: "")
        settings.target = self
        menu.addItem(settings)
        refresh()
    }

    func refresh() {
        guard let item = toggleItem else { return }
        let status = serviceStatus(), legacy = legacyStatus()
        item.title = localization.text("Launch at Login", "로그인 시 실행")
        item.toolTip = nil
        if legacy != .absent {
            item.state = .mixed
            item.title = localization.text("Launch at Login (Legacy Setup)", "로그인 시 실행 (기존 설정)")
            item.toolTip = localization.text("An earlier login setup exists. Click to disable it and preserve a backup.", "이전 자동 실행 설정이 있어요. 클릭하면 백업을 보관하고 자동 실행을 해제합니다.")
        } else {
            switch status {
            case .enabled: item.state = .on
            case .requiresApproval:
                item.state = .mixed
                item.title = localization.text("Launch at Login (Approval Required)", "로그인 시 실행 (승인 필요)")
                item.toolTip = localization.text("Allow Cubirumi in Login Item Settings, or click here to remove its registration.", "로그인 항목 설정에서 Cubirumi를 허용하거나, 여기를 클릭해 등록을 해제하세요.")
            case .notRegistered: item.state = .off
            case .notFound:
                item.state = .off
                item.toolTip = localization.text("macOS could not find this login item. Try enabling it to check this installation.", "macOS에서 로그인 항목을 찾지 못했어요. 켜기를 시도해 설치 상태를 확인할 수 있습니다.")
            @unknown default:
                item.state = .mixed
                item.toolTip = localization.text("macOS returned an unknown login item status. Check Login Item Settings.", "로그인 항목 상태를 확인하지 못했어요. 로그인 항목 설정을 확인해 주세요.")
            }
        }
    }

    func setEnabled(_ enabled: Bool) throws {
        defer { refresh() }
        if enabled {
            guard legacyStatus() == .absent else { throw OfficeLoginError.unrecognizedLegacy }
            if serviceStatus() != .enabled { try register() }
            if serviceStatus() == .requiresApproval { openSettings() }
            guard serviceStatus() == .enabled || serviceStatus() == .requiresApproval else { throw OfficeLoginError.statusUnchanged }
        } else {
            if legacyStatus() != .absent { try disableLegacy() }
            if serviceStatus() == .enabled || serviceStatus() == .requiresApproval { try unregister() }
            guard legacyStatus() == .absent, serviceStatus() == .notRegistered || serviceStatus() == .notFound else { throw OfficeLoginError.statusUnchanged }
        }
    }

    @objc private func toggleLogin(_ sender: NSMenuItem) {
        let status = serviceStatus()
        do {
            try setEnabled(legacyStatus() == .absent && status != .enabled && status != .requiresApproval)
        } catch {
            let message: String
            switch error {
            case OfficeLoginError.unrecognizedLegacy:
                message = localization.text("The earlier login file could not be safely identified. It was preserved. Check ~/Library/LaunchAgents/io.cubirumi.login.plist.", "이전 로그인 설정 파일을 안전하게 확인하지 못해 보존했어요. ~/Library/LaunchAgents/io.cubirumi.login.plist를 확인해 주세요.")
            case OfficeLoginError.legacyStopFailed, OfficeLoginError.legacyChanged:
                message = localization.text("The earlier login setup could not be removed safely. Its file was preserved. Please try again or check Login Item Settings.", "이전 로그인 설정을 안전하게 해제하지 못해 파일을 보존했어요. 다시 시도하거나 로그인 항목 설정을 확인해 주세요.")
            default:
                message = localization.text("macOS could not apply the change. Check Login Item Settings and the app's installation.\n", "macOS에서 변경을 적용하지 못했어요. 로그인 항목 설정과 앱 설치 상태를 확인해 주세요.\n") + error.localizedDescription
            }
            reportError(message)
        }
    }

    @objc private func showSettings(_ sender: Any?) { openSettings() }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        refresh()
        return true
    }
}
