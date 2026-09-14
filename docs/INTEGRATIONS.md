# 설치와 에이전트 연결

## 기본 실행

저장소 루트에서 `npm ci`, `npm run build`, `npm start` 순서로 실행합니다. 화면과 이벤트 API는 **http://127.0.0.1:4780** 에 있습니다. 같은 컴퓨터의 AI 앱과 함께 사용하는 구성입니다.

포트가 사용 중이면 이미 실행 중인 Agent Office를 확인하세요. 설치기는 다른 프로그램의 포트를 강제로 빼앗지 않습니다.

## Codex 자동 관측

관측기는 기본적으로 `~/.codex/state_5.sqlite`와 `~/.codex/sessions`를 읽습니다. `CODEX_HOME`이 설정되어 있으면 해당 Codex 데이터 폴더를 사용합니다. SQLite는 읽기 전용으로 열고 JSONL의 새 기록을 약 3초 간격으로 확인합니다. 원래 앱에 작업·승인 요청을 보내지 않습니다.

처음 연결할 때 최근 24시간 동안 갱신된 최대 80개 후보 중 진행 중인 작업만 표시합니다. 회사 이름이나 예전 대화 전체를 가져오지 않습니다. 이후 관측한 직원·이벤트와 최소 상태 커서는 사용자 데이터 폴더에 보관합니다.

관측기가 연결되지 않아도 웹 화면과 이벤트 수신기는 유지됩니다. `observer-status.json`에서 상태와 오류 횟수·대기 이벤트 수를 확인할 수 있습니다. 버전별 SQLite/JSONL 형식 차이는 연결 실패 원인이 될 수 있습니다.

### Codex 플러그인

공개 플러그인은 `plugins/agent-office`에 있습니다. 저장소 루트에서 Codex CLI로 로컬 marketplace를 등록하고 설치합니다.

```sh
codex plugin marketplace add "$PWD"
codex plugin add agent-office@agent-office-community
```

기존의 다른 이름으로 설치된 Agent Office 플러그인이 있다면 먼저 기존 플러그인을 비활성화해 hooks가 중복 실행되지 않도록 하세요. marketplace는 이 저장소의 `.agents/plugins/marketplace.json`을 사용합니다.

설치한 뒤 새 Codex 세션에서 `/hooks`를 열어 **Agent Office의 명령만 검토·신뢰**합니다. hook은 로컬 `/api/events`로 짧은 상태 메타데이터만 보내고 실패해도 원래 작업을 막지 않습니다. 일반적인 명령은 `node`를 사용하므로 Codex 실행 환경의 PATH에서 Node.js를 찾을 수 있어야 합니다.

이미 실행 중인 데스크톱 세션은 플러그인을 소급 로드하지 않을 수 있습니다. 이 경우 로컬 관측기로 현재 작업을 표시하고 새 세션부터 hooks가 보완합니다. [공식 Codex plugins](https://learn.chatgpt.com/docs/plugins) · [공식 hooks와 신뢰 검토](https://learn.chatgpt.com/docs/hooks)

### 수동 hook 예제

`integrations/codex-hooks.example.json`의 `/absolute/path/to/agent-office`를 실제 설치 위치로 바꾸고 대상 프로젝트의 hooks 설정에 기존 내용을 보존하며 병합할 수 있습니다. 동봉 플러그인과 같은 hooks를 중복 설치하지 마세요.

`codex-notify.example.toml`은 구형 완료 알림 연결 예시입니다. `agent-turn-complete`만 처리하므로 진행·승인을 관측할 수 없습니다.

## Claude Code

Agent Office 서버가 실행 중인 상태에서 저장소 루트 기준으로 다음을 실행합니다.

```sh
node scripts/install-claude.mjs install
node scripts/install-claude.mjs status
```

공식 CLI로 사용자 플러그인을 등록하고 기존 설정을 보존하면서 사용량 표시줄을 연결합니다. 새 Claude Code 터미널 세션을 열어 `/hooks`에서 플러그인 등록을 확인하세요. 새 세션에서 시작·도구 사용·하위 에이전트·승인 요청·응답 종료를 전송합니다. 사용량은 지원되는 계정의 첫 API 응답 후 공식 statusline 데이터가 도착해야 표시됩니다.

Claude Code hook에서 모델이 누락되면 플러그인은 해당 직원의 실행 기록 끝부분에서 `message.model`과 기록 시각을 확인합니다. 팀장은 `transcript_path`, 하위 직원은 자신의 `agent_transcript_path` 또는 `<세션>/subagents/agent-<id>.jsonl`·`workflows/<워크플로>/agent-<id>.jsonl`을 사용합니다. 세션과 직원 ID가 정확히 일치해야 하며 부모 모델을 자식에게 적용하지 않습니다. 시작 이벤트에서는 이전 응답의 모델을 읽어 새 실행 모델로 표시하지 않습니다.

`npm start`는 `scripts/claude-models.mjs`를 함께 실행해, 기존에 연결된 Claude 직원의 미확인 모델도 10초마다 보완합니다. `CLAUDE_CONFIG_DIR/projects` 또는 기본 `~/.claude/projects`에서 해당 세션·직원의 기록만 찾고, 작업 상태와 마지막 활동 시각은 보존합니다. 파일이 없거나 일치하는 근거가 없으면 미확인으로 둡니다. 인증 정보를 읽거나 AI 응답을 생성하지 않습니다. `AGENT_OFFICE_DISABLE_CLAUDE_MODELS=1`로 끌 수 있습니다.

`scripts/claude-observer.mjs`는 새 Claude Code 기록을 기본 2초 간격으로 확인합니다. 훅을 받지 못한 새 대화라도 로컬 기록이 생기면 사무실에 등록합니다. 처음에는 최근 2분의 실제 활동과 이미 등록된 직원만 대상으로 하며 과거 대화 전체를 출근시키지 않습니다. 원문 메시지·도구 인수·결과는 전송하지 않고 관측된 동작 이름, 상태와 본인의 모델만 전송합니다. 일반 Chat/Cowork나 로컬 기록이 없는 빈 창을 관측하지 않습니다. `AGENT_OFFICE_DISABLE_CLAUDE_OBSERVER=1`로 끌 수 있습니다. `node scripts/claude-observer.mjs --once --dry-run`은 전송 없이 후보만 보여줍니다.

저장소를 갱신한 뒤 `node scripts/install-claude.mjs install`을 다시 실행하면 해당 로컬 marketplace와 사용자 플러그인을 업데이트합니다. 플러그인은 새 Claude Code 세션에 적용되며, 실행 중인 이전 세션의 모델 누락은 로컬 보정기가 보완합니다. `node scripts/claude-models.mjs --once --dry-run`은 전송 없이 모델 보정 후보만 보여줍니다. 일반 작업 이벤트나 임의 사용량을 만들어 보내는 테스트는 실제 서버에서 실행하지 마세요.

한 세션에서 hooks만 시험하려면 `claude --plugin-dir "$PWD/integrations/claude-plugin"`을 사용할 수 있습니다. 이미 사용자 플러그인을 설치했다면 중복으로 로드하지 마세요. [기존 표시줄 보존·Desktop 범위·붙여 넣을 프롬프트](CLAUDE_SETUP_PROMPT.md) · [사용량 연결](USAGE.md)

일반 Claude Chat/Cowork의 모든 작업을 읽는 기능은 아닙니다. 실제 Claude 사용 환경의 hook 수신은 별도로 확인해야 합니다. [Claude Code hooks](https://code.claude.com/docs/en/hooks) · [Plugins reference](https://code.claude.com/docs/en/plugins-reference)

## 회사명과 저장 위치

```sh
npm run company -- "예시 스튜디오"
```

변경 후 화면을 새로고침합니다. 설정 파일은 다음 데이터 폴더의 `settings.json`이며 저장소·플러그인·빌드에 포함되지 않습니다.

- macOS: `~/Library/Application Support/AgentOffice`
- 그 외: `~/.local/share/agent-office`
- 재정의: `AGENT_OFFICE_DATA_DIR`

앱의 **설정 → 우리 회사와 사장님**에서 회사명과 사장 이름을 함께 바꿀 수 있습니다. `GET /api/settings`는 표시용 `companyName`과 `ownerName`을 반환하며 같은 경로의 `POST`·`PATCH`는 일부 필드만 변경할 수 있습니다. 터미널의 회사명 변경은 사장 이름을 보존합니다. HTTP API에서 원래 AI 앱의 작업이나 승인을 제어하지 않습니다.

## macOS 자동 실행 관리

```sh
node scripts/install-runtime.mjs install
node scripts/install-runtime.mjs status
node scripts/install-runtime.mjs stop
```

사용자 LaunchAgent `io.agent-office.runtime`을 사용합니다. 설치할 때 Node.js와 저장소 경로를 해당 컴퓨터의 plist에 기록합니다. 저장소나 Node.js를 옮기려면 기존 위치에서 서비스를 제거한 뒤 새 위치에서 설치해야 합니다. `stop`은 현재 로그인 세션만 중지하며 `~/Library/LaunchAgents/io.agent-office.runtime.plist`를 제거하지 않습니다. 기존 경로의 자동 실행 등록 파일이 남아 있으면 새 위치의 설치기는 이를 덮어쓰지 않습니다.

`stop`은 현재 로그인 세션에서 중지합니다. 자동 실행을 완전히 해제하려면 중지 후 `~/Library/LaunchAgents/io.agent-office.runtime.plist`를 제거하세요. 개인 기록은 자동 삭제하지 않습니다. Linux에서는 터미널에서 `npm start`로 실행하며 systemd 서비스 자동 설치는 포함하지 않습니다.

## 서류 전달과 승인 표시

서류 전달은 발신자·수신자와 성공 여부가 확인된 이벤트에만 사용합니다. 현재 Codex 기록의 메시지 결과가 비어 있으면 전달 성공을 추정하지 않습니다. 하위 직원 생성만으로 서류 전달을 만들지도 않습니다.

수신 파이프라인의 예시를 보고 싶다면 다음 명령으로 가상 데이터를 보낼 수 있습니다. 실제 AI 메시지 전송은 아닙니다.

```sh
node scripts/send-event.mjs < integrations/handoff.example.json
```

승인 요청은 원래 앱에서 처리합니다. 도구가 재개되었다는 이유만으로 승인 도장을 찍지 않습니다. 이벤트 필드와 수신 제한은 [server/API.md](../server/API.md)를 참고하세요.
