# Claude Code 연결과 붙여 넣을 프롬프트

Claude Code CLI 또는 Claude Desktop의 **로컬 Code 세션**에서 사용합니다. 일반 Chat/Cowork와 원격 작업 전체를 관측하는 플러그인은 아닙니다. Desktop의 로컬 Code 세션은 CLI와 hooks·플러그인 설정을 공유합니다. [공식 Desktop 문서](https://code.claude.com/docs/en/desktop#shared-configuration)

## 설치

macOS 다운로드판은 저장소를 받을 필요 없이 [앱에 포함된 설치 명령](DESKTOP.md#다운로드판에서-claude-code-연결)을 사용합니다. 아래 명령은 소스에서 실행하는 개발 설치용입니다.

이 저장소를 받은 폴더에서 로컬 사무실을 먼저 실행한 뒤 아래 명령을 실행합니다. AI 응답을 생성하거나 다른 플러그인을 제거하지 않습니다.

```sh
cd /absolute/path/to/agent-office
node scripts/install-claude.mjs install
node scripts/install-claude.mjs status
```

설치기는 공식 `claude plugin marketplace add`와 `claude plugin install --scope user`로 `agent-office@agent-office-local`을 등록합니다. 플러그인과 marketplace 버전은 각 manifest에 기록되어 있습니다. 기존 사용자 설정을 보존하고 표시줄 명령만 wrapper로 연결합니다. 다른 출처의 같은 이름 marketplace는 덮어쓰지 않습니다. [공식 marketplace 안내](https://code.claude.com/docs/en/plugin-marketplaces)

기존 표시줄이 있으면 원래 stdin과 stdout을 그대로 이어줍니다. 한도 수치는 별도 로컬 프로세스가 짧은 제한 시간 안에 `http://127.0.0.1:4780/api/usage`로 전달합니다. 기존 표시줄이 없으면 짧은 한도 문구가 표시됩니다. 설치 전 설정 백업과 원래 표시줄 명령은 사용자 데이터 폴더의 `claude-backups/`와 `claude-statusline.json`에 비공개 권한으로 저장됩니다. 기본 위치는 macOS에서 `~/Library/Application Support/AgentOffice`, Linux에서 `~/.local/share/agent-office`이며 `AGENT_OFFICE_DATA_DIR`로 바꿀 수 있습니다. `CLAUDE_CONFIG_DIR`도 지원합니다. macOS/Linux 설치기이며 Windows 자동 설정은 지원하지 않습니다.

새 Claude Code 세션을 열어 적용을 확인합니다. 이 로컬 marketplace는 저장소 폴더를 출처로 사용하므로 폴더를 유지하세요. Desktop에서는 **로컬 Code 세션의 플러그인 목록**에서 활성 상태를 확인합니다.

## 사용량의 범위

공식 statusline 입력의 `rate_limits.five_hour`와 `rate_limits.seven_day`에서 `used_percentage`와 `resets_at`만 사용합니다. 리셋 시각은 Unix 초입니다. Claude.ai Pro/Max에서는 첫 API 응답 후 값이 생길 수 있으며, 각 창이 없거나 만료될 수 있습니다. API 키 모드나 값이 없는 경우에는 0%로 추정하지 않고 **미확인**으로 표시합니다. `context_window`는 구독 사용 한도로 대체하지 않습니다. 프롬프트·대화 기록·계정·인증 정보는 사용량 수집 대상이 아닙니다. [공식 statusline 입력](https://code.claude.com/docs/en/statusline#available-data)

statusline 사용량 보고는 **터미널 Claude Code 기준**입니다. Desktop 문서에는 커스텀 statusline 명령의 실행이 명시되어 있지 않아 Desktop만 사용할 때 사용량이 자동 보고된다고 보장하지 않습니다. 일반 작업 훅 연결과 사용량 보고는 각각 확인해야 합니다. 실제 사용량 값은 새 Claude 작업에서 공식 입력이 도착한 뒤 확인할 수 있습니다.

## 설치 후 Claude에 붙여 넣기

다음 프롬프트는 실제 현재 프로젝트를 읽는 작은 작업입니다. 여기 적힌 프롬프트를 설치기가 자동 전송하지 않습니다.

```text
Agent Office가 이 컴퓨터에 연결되어 있습니다. 현재 프로젝트의 README와 폴더 구조를 읽기 전용으로 확인해 주세요. 서로 독립적으로 검토할 수 있으면 하위 에이전트 2명에게 구조 요약과 개선점 검토를 나눠 맡겨 주세요. 코드나 설정은 수정하지 마세요. 작업 상태는 설치된 훅이 전달하므로 시연 이벤트를 만들거나 수동으로 중복 전송하지 마세요. 실제 사용한 모델·전달·승인·사용량만 근거가 있을 때 설명하고, 확인할 수 없는 값은 미확인으로 남겨 주세요. 마지막에는 구조 요약과 개선점 3가지만 정리해 주세요.
```

다른 컴퓨터에서 설치 자체를 Claude에 맡기려면 다음을 사용합니다.

```text
이 컴퓨터의 /absolute/path/to/agent-office 저장소에서 README와 docs/CLAUDE_SETUP_PROMPT.md를 읽고 Claude Code 사용자 범위 연결을 설치해 주세요. 저장소 위치는 실제 경로로 바꿔 사용하세요. 공식 CLI와 scripts/install-claude.mjs를 사용하고 기존 플러그인·계정·statusLine 설정을 보존하세요. 백업은 비공개 사용자 데이터 폴더에만 저장하세요. 새 AI 작업이나 브라우저 조작은 실행하지 말고 설치 상태와 다음 세션에서 확인할 항목만 알려 주세요.
```

문서 확인일: 2026-09-13. 설치 여부, 격리된 입력 fixture 검증, 실제 Claude 세션에서 관측된 이벤트·사용량은 서로 다른 검증 단계입니다.
