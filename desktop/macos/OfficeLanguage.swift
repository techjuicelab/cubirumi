import Foundation

enum OfficeLanguage: String, CaseIterable {
    case en
    case ko

    static func normalized(_ value: Any?) -> OfficeLanguage {
        guard let value = value as? String else { return .en }
        return OfficeLanguage(rawValue: value) ?? .en
    }

    static func acceptsOrigin(scheme: String, host: String, port: Int, isMainFrame: Bool) -> Bool {
        isMainFrame && scheme == "http" && host == "127.0.0.1" && port == 4780
    }
}

@MainActor
final class OfficeLocalization {
    static let preferenceKey = "OfficeLanguage"
    private let defaults: UserDefaults
    private(set) var language: OfficeLanguage

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        language = OfficeLanguage.normalized(defaults.object(forKey: Self.preferenceKey))
    }

    @discardableResult
    func setLanguage(_ language: OfficeLanguage) -> Bool {
        let changed = self.language != language
        self.language = language
        if defaults.string(forKey: Self.preferenceKey) != language.rawValue {
            defaults.set(language.rawValue, forKey: Self.preferenceKey)
        }
        return changed
    }

    func text(_ english: String, _ korean: String) -> String {
        language == .ko ? korean : english
    }

    func text(_ message: OfficeMessage) -> String {
        let pair = message.translations
        return text(pair.english, pair.korean)
    }
}

enum OfficeMessage {
    case connecting, preparing, waiting, closing, shutdownFailed
    case incompleteBundle, startupFailed, portConflict, serverStopped, launchFailed

    var translations: (english: String, korean: String) {
        switch self {
        case .connecting:
            return ("Connecting to your local office…", "로컬 사무실에 연결하고 있어요…")
        case .preparing:
            return ("Preparing your office…", "사무실을 준비하고 있어요…")
        case .waiting:
            return ("Waiting for the office server.\nThe app will connect automatically when the local receiver starts.", "사무실 서버를 기다리고 있어요.\n설치한 로컬 수신기가 실행되면 자동으로 연결됩니다.")
        case .closing:
            return ("Closing your office…", "사무실을 닫고 있어요…")
        case .shutdownFailed:
            return ("The office server is still running. Please try quitting the app again in a moment.", "사무실 서버가 아직 종료되지 않았어요. 잠시 후 앱 종료를 다시 시도해 주세요.")
        case .incompleteBundle:
            return ("The app is missing required files. Please download and reinstall Cubirumi.", "앱의 실행 파일이 완전하지 않아요. Cubirumi를 다시 내려받아 설치해 주세요.")
        case .startupFailed:
            return ("The office server could not start. Please quit and reopen the app.", "사무실 서버를 시작하지 못했어요. 앱을 종료한 뒤 다시 열어 주세요.")
        case .portConflict:
            return ("Another local server is using port 4780.\nCheck any existing Agent Office startup service or terminal server, then reopen this app.", "다른 로컬 서버가 4780 포트를 사용하고 있어요.\n기존 Agent Office 자동 실행이나 터미널 서버를 확인한 뒤 이 앱을 다시 열어 주세요.")
        case .serverStopped:
            return ("The office server stopped. Please quit and reopen the app.", "사무실 서버가 종료되었어요. 앱을 종료한 뒤 다시 열어 주세요.")
        case .launchFailed:
            return ("The bundled office server could not launch. Please check the installation files and supported macOS version.", "앱에 포함된 사무실 서버를 실행하지 못했어요. 설치 파일과 macOS 지원 버전을 확인해 주세요.")
        }
    }
}
