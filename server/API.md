# 로컬 이벤트 브리지 v0.2

`node server/index.mjs`는 외부 패키지 없이 `127.0.0.1:4780`에서 실행됩니다. 빌드된 `dist` UI와 `/api/*`를 같은 서버에서 제공합니다. 원문 프롬프트, 출력, 파일 내용, 비밀 값은 보내지 말고 공개해도 되는 짧은 작업 제목과 관측 메타데이터만 사용하세요.

## API

| 경로 | 동작 |
| --- | --- |
| `GET /` | `dist/index.html` 제공. 먼저 UI를 빌드해야 함 |
| `GET /api/health` | 실행 상태, 최근 관측 시각, 직원 수, 영속 저장 상태 반환 |
| `GET /api/history` | 최근 최대 200건을 `{ "events": [...] }`로 반환 |
| `GET /api/state` | `{ "events": [...], "agents": [...], "projects": [...] }` 현재 상태 반환 |
| `GET /api/events` | 일반 SSE `message` 이벤트. 연결 시 최근 100건 재생 후 새 수신 이벤트 전달 |
| `POST /api/events` | 정규화한 이벤트를 저장·전달. 신규 `202`, 같은 ID 재전송 `200` |
| `GET /api/usage` | 계정 공유 사용량의 공급자별 snapshot과 창별 신선도 반환 |
| `POST /api/usage` | 허용된 익명 사용량 필드만 저장. 정상 수락 시 `202` |
| `GET /api/settings` | 회사명과 사장 이름 표시 설정 반환 |
| `POST /api/settings`, `PATCH /api/settings` | 회사명·사장 이름 일부 또는 모두 수정. 정상 저장 시 `200` |

사용량의 수집 방식, Codex/Spark 구분, stale 정책과 전체 필드 계약은 [계정 공유 사용량](../docs/USAGE.md)을 참고하세요. 사용량은 작업 이벤트와 별도로 저장하며 SSE 이벤트에 섞지 않습니다.

`/api/history`, `/api/state.events`, SSE 재생은 오래된 순서에서 최신 순서입니다. SSE는 `id: ...`와 `data: { ... }` 형식입니다. `Last-Event-ID`가 최근 100건 안에 있으면 그 다음부터 재생합니다. 없으면 최근 100건을 재생합니다. 클라이언트도 ID로 중복을 제거해야 합니다. 20초마다 SSE 주석 heartbeat를 전송하며 동시 연결은 64개까지 허용합니다.

POST는 `Content-Type: application/json`과 최대 16 KiB 본문을 받습니다. 검증 실패는 `400`, 본문 초과는 `413`, 다른 콘텐츠 형식은 `415`입니다. 같은 ID를 다시 보내도 기존 이벤트를 수정하지 않습니다. 메모리 전용 서버는 최근 200건, 영속 서버는 최근 5,000건 안에서 중복을 제거합니다. POST 응답은 `{ "ok": true, "duplicate": false, "event": { ... } }`입니다.

새 이벤트의 `timestamp`와 `modelObservedAt`이 수신기 현재 시각보다 60초 넘게 미래이면 `400`으로 거절합니다. 작은 로컬 시계 차이는 허용하되 잘못된 미래 시각이 이후 상태를 장기간 막지 않게 합니다. 과거 기록에는 이 제한을 적용하지 않으며 저장된 journal·snapshot의 복원과 독립적인 HTTP 수신 정책입니다.

## 이벤트 계약

```json
{
  "id": "review-handoff-001",
  "source": "codex",
  "observation": "hook",
  "type": "handoff",
  "agentId": "developer",
  "agentName": "개발 직원",
  "role": "개발팀",
  "status": "working",
  "title": "화면 구현 검토 요청",
  "toAgentId": "reviewer",
  "toAgentName": "검수 직원",
  "projectId": "project-001",
  "projectName": "작은회사",
  "sessionId": "session-001",
  "sessionName": "사무실 화면 구현",
  "modelEvidence": "unknown"
}
```

필수 필드는 `source`, `type`, `agentId`, `title`입니다. `handoff`는 수신자가 확인된 실제 전달 이벤트이며 `toAgentId`가 추가로 필요합니다. `message.sent`는 관측된 메시지 전송 기록이며 수신자는 선택 사항입니다. 메시지 기록만으로 직원의 상태나 모델을 갱신하지 않습니다. 추정한 내부 사고 과정이나 가짜 전달 이벤트를 생성하지 않습니다.

| 필드 | 허용 값 또는 길이 |
| --- | --- |
| `source` | `codex`, `claude`, `manual` |
| `type` | `agent.started`, `agent.status`, `agent.completed`, `message.sent`, `handoff`, `approval.requested`, `approval.resolved`, `task.created`, `user.instruction`, `agent.retired`, `session.ended`, `agent.model` |
| 선택적 `status` | `working`, `thinking`, `waiting`, `reviewing`, `approval`, `done`, `error`, `idle` |
| 선택적 `activityKind` | `coding`, `documents`, `research`, `testing`, `reviewing`, `planning`, `design`, `delivery`, `shipping`, `general` |
| 선택적 `observation` | `hook`, `app-server`, `codex-log`, `claude-log`, `manual` |
| `id`, `taskId`, `projectId`, `sessionId`, `parentAgentId` | 1~120자 |
| `agentId`, `toAgentId`, `title`, `sessionName` | 1~160자 |
| `agentName`, `toAgentName` | 1~64자 |
| `role` | 1~80자 |
| `projectName`, `model`, `toolName` | 1~100자 |
| `modelEvidence` | `reported` 또는 `unknown`. 생략 시 `unknown` |
| 선택적 `timestamp` | 시간대가 있는 ISO 8601. 생략 시 서버 현재 시간, 제공 시 UTC ISO 문자열로 정규화. 신규 HTTP 수신에서 서버보다 60초 넘게 미래인 값 거절 |
| 선택적 `modelObservedAt` | 실제 모델 증거의 시각. 시간대가 있는 ISO 8601. `reported` 모델과 함께 보존. 신규 HTTP 수신에서 서버보다 60초 넘게 미래인 값 거절 |
| `agent.model`의 `referenceEventId` | 갱신 대상 직원 snapshot의 현재 `id`, 1~120자 |

`id` 생략 시 서버 UUID를 생성합니다. 필수라고 명시한 필드를 제외하면 선택 사항입니다. 모델은 `modelEvidence: "reported"`와 함께 보고된 실제 값만 보존합니다. `reported`인데 `model`이 없으면 거절하며, `unknown` 또는 증거 생략 시 `model`을 버립니다. 앱에서 선택한 모델이나 부모 직원의 모델을 추정하지 않습니다. `codex-log`는 로컬 Codex 실행 기록 관찰이며 app-server 연결과 구분합니다.

문자열 앞뒤 공백은 제거하고 빈 문자열·제어 문자는 거절합니다. 정의되지 않은 필드는 버리며 저장·응답·SSE에 포함하지 않습니다. 오류 응답에도 원래 입력값을 포함하지 않습니다.

### 실제 모델 보정

`agent.model`은 이미 있는 직원의 모델 메타데이터만 보정합니다. `source: "claude"`, `observation: "claude-log"`, `modelEvidence: "reported"`, 실제 `model`, `modelObservedAt`, `referenceEventId`가 필요합니다. 일반 이벤트와 마찬가지로 `agentId`와 짧은 `title`도 필요합니다. transcript 원문이나 계정 정보는 보내지 않습니다.

기존 `source + agentId` 직원이 있고 snapshot의 `id`가 `referenceEventId`와 일치할 때만 `model`, `modelEvidence`, `modelObservedAt`을 교체합니다. snapshot의 `id`, `type`, `timestamp`, `lastEventAt`, 제목, 상태, 작업 ID, 소속, 퇴근·세션 종료 여부는 그대로 유지합니다. 새 직원을 만들거나 작업·승인·활동으로 간주하지 않습니다. 대상이 없거나 참조가 오래됐거나 증거가 현재 `taskStartedAt`보다 앞서면 상태 변경 없이 무시합니다. 이미 적용한 `modelObservedAt`보다 오래된 보정도 무시합니다.

정상 형식의 보정은 적용 여부와 관계없이 journal과 SSE에 기록되며 POST는 기존 이벤트와 같은 수락·중복 규칙을 사용합니다. UI는 `agent.model`을 메타데이터 갱신으로 처리하고 작업 활동·도구 사용·응답 종료·전달 횟수에 포함하지 않아야 합니다. 모델 보정 자체의 수신은 작업 진행이나 완료의 증거가 아닙니다.

## 현재 직원 상태

`activityKind`는 로컬에서 확인한 업무 종류만 담습니다. 도구 인수·파일 경로·명령 원문을 포함하지 않습니다. 알 수 없는 새 도구 사용은 `general`, 응답 종료·대기·퇴근은 종류를 지우며 모델 보정은 기존 종류를 유지합니다. 종류가 다른 병렬 도구 호출은 `general`로 단순화하고 결과는 실제 호출 ID에 맞춰 연결합니다. [업무 애니메이션 기준](../docs/ACTIVITY_ANIMATIONS.md)

`/api/state.agents`는 최대 512명의 최신 메타데이터 snapshot입니다. 각 항목은 이벤트와 같은 `id`, `timestamp`, `type`, `agentId`, `source`, `title` 및 선택적 메타데이터를 포함하며 다음 필드를 추가합니다.

직원의 정체성은 `source + agentId`입니다. 서로 다른 공급자의 같은 `agentId`를 합치지 않습니다. `source: "manual"`인 `user.instruction`은 기록 출처를 바꾸지 않고 이미 관측된 수신자에게 적용합니다. `toAgentId`가 있으면 그 직원을, 없으면 `agentId` 직원을 대상으로 삼으며 해당 ID의 직원이 유일할 때만 상태를 갱신합니다. 대상이 없거나 공급자 간 ID가 겹쳐 모호하면 기록만 보존하고 직원을 새로 만들거나 임의로 선택하지 않습니다. 직원 snapshot의 `source`·이름·소속은 기존 수신자의 값을 유지하고, 이력·SSE의 원래 `source: "manual"`은 그대로 남습니다. 실제 어댑터처럼 공급자별 접두사가 있는 직원 ID를 사용하면 이러한 모호함을 피할 수 있습니다.

- `status`: 현재 표시 상태
- `lastEventAt`: 해당 직원의 마지막 이벤트 시각
- `retired`: 명시적인 퇴근 여부
- `sessionEnded`: 소속 세션 종료가 보고됐는지 여부
- `sessionObservation`: 현재 소속 세션을 확인한 경로. 이후 hook이 마지막 이벤트가 되어도 별도로 보존
- `taskStartedAt`: 마지막 Claude `user.instruction`의 시각. task ID가 없는 새 지시도 이전 턴과 구분
- 선택적 `modelObservedAt`: 보존된 모델 증거의 실제 시각

일반 이벤트에서 생략한 프로젝트·세션·역할과 같은 turn에서 이전에 보고된 모델은 보존합니다. 명시적인 `taskId`가 이전과 달라지고 새 모델이 미확인이면 이전 모델을 지워 `unknown`으로 표시합니다. 세션 소속은 `app-server` > `codex-log` > `hook` > `manual` 순서로 근거를 유지하여 하위 hook의 로컬 sessionId가 관측한 상위 채팅방을 덮어쓰지 않게 합니다. `agent.completed`는 응답 종료이므로 직원 상태를 `idle`로 바꾸고 남겨 둡니다. 요구사항 달성이나 퇴근의 증거로 간주하지 않습니다. 원래 이벤트의 `status`는 `/api/history`와 SSE에서 그대로 유지합니다.

Claude의 새 `user.instruction`은 `taskId`가 없어도 이전 모델과 모델 증거 시각을 지웁니다. 새 지시 자체에 실제 모델이 보고됐다면 해당 모델을 사용합니다. `taskStartedAt`은 새 지시의 `timestamp`에서 생성하며 이후 일반 상태 이벤트에서는 유지합니다. 재시작 시 snapshot에 이 필드가 없으면 보존된 journal의 snapshot checkpoint 이전 마지막 Claude 지시로 복원할 수 있습니다. 해당 지시가 보존 범위를 벗어났으면 경계를 추정하지 않습니다.

`agent.retired`만 `retired: true`로 바꿉니다. `session.ended`는 같은 `source + sessionId` 직원들을 `idle`, `sessionEnded: true`로 표시하며 자동 퇴근시키지 않습니다. `agent.started`, `task.created`, `user.instruction`은 활동 재개로 표시합니다. 승인 해소는 실제 승인 결과를 새로 추정하지 않으며 제공된 상태 또는 `idle`을 사용합니다.

`/api/state.projects`는 명시적인 `projectId`가 있는 직원만 묶은 요약으로 `projectId`, 선택적 `projectName`, `agentCount`, `activeAgentCount`, `sessionCount`를 제공합니다. `activeAgentCount`는 퇴근하지 않은 인원이며 현재 작업 중인 인원과 다릅니다. 프로젝트·세션 정보를 모르는 직원에게 가짜 소속을 만들지 않습니다.

화면 초기화 시 snapshot을 현재 상태로 사용하고 `events`는 업무 기록에 채우세요. 과거 이력을 snapshot 위에 다시 적용하면 현재 상태를 오래된 상태로 되돌릴 수 있습니다. 이후 SSE 이벤트를 적용하되 초기 재생 ID의 중복을 제거하세요.

## 영속 기록과 권한

기본 production 저장 위치는 macOS의 `~/Library/Application Support/AgentOffice`, 다른 OS의 `~/.local/share/agent-office`입니다. `AGENT_OFFICE_DATA_DIR`로 지정할 수 있습니다. `createOfficeServer()` 테스트 API는 디스크에 쓰지 않으며 `{ dataDir }`를 명시해야 저장합니다. `{ initialEvents }`는 정규화한 초기 이벤트를 넣는 선택 옵션입니다.

- `events.jsonl`: 최신 5,000건을 논리적 보존·중복 제거 범위로 사용합니다. 매 수신마다 append·fsync하고, 상한에 도달한 뒤에는 256건마다 최신 5,000건으로 원자적으로 정리합니다. 정리 사이 디스크 행 수는 최대 5,255건이며 재시작 시에도 최신 5,000건으로 정리합니다. API의 이력·중복 제거 범위는 늘어나지 않습니다.
- `agents.json`: 최대 512명의 최신 snapshot. 최근 200건이나 5,000건 이력에서 벗어난 조용한 직원도 snapshot에 남아 있으면 재시작 시 복원합니다.
- `usage.json`: 공급자별 최신 익명 사용량 snapshot. 창별 초기화 시각이 지나거나 오래된 값을 자동으로 100% 잔여량으로 바꾸지 않습니다.
- 디렉터리 권한은 `0700`, 파일 권한은 `0600`으로 제한합니다. 저장 파일의 symlink·hardlink는 거절합니다.
- POST 성공 전에 journal 쓰기와 동기화를 완료합니다. journal 쓰기 실패 시 이벤트를 수락하지 않고 `500`을 반환합니다. snapshot 쓰기만 실패하면 이미 보관된 이벤트는 수락하되 저장 상태를 비정상으로 표시합니다.
- 재시작 시 손상된 개별 JSONL 행을 건너뛰고 정상 행만 복구·정규화합니다. `persistence.recoveredRecords`에 복구 중 제외된 레코드/파일 수를 기록합니다.

`/api/health`에는 `lastEventAt`(마지막 이벤트가 보고한 시각), `lastReceivedAt`(이번 실행에서 서버가 마지막으로 받은 시각), `agentCount`, `persistence`가 추가됩니다. 재시작 후 새 수신 전에는 `lastReceivedAt: null`입니다. `persistence`는 `enabled`, `format`, `retainedEventCount`, `maxEvents`, `maxAgents`, `healthy`, `lastWriteAt`, `recoveredRecords`를 포함합니다. `ok: true`는 HTTP 서버의 응답 여부이며 저장 건강 상태는 `persistence.healthy`를 따로 확인해야 합니다.

기록에는 관측된 메타데이터가 남습니다. 외부 네트워크로 전송하지 않습니다. 원문 내용을 제목이나 메타데이터 필드에 직접 넣으면 그 내용까지 자동으로 구별해 가릴 수는 없으므로 어댑터에서 짧은 허용 항목만 보내야 합니다.

## 접근 범위와 정적 UI

브리지는 루프백 인터페이스에서만 실행됩니다. 허용하는 Host는 `localhost` 또는 `127.0.0.1`의 `5173`, `4173`, `4780` 포트입니다. Origin은 이 주소의 `http://` 형식만 정확히 허용합니다. Origin이 없는 CLI 요청도 허용하되 `Sec-Fetch-Site: cross-site`는 거절합니다. 다른 Host·Origin은 `403`이며 CORS 와일드카드는 사용하지 않습니다.

정적 파일은 `dist` 안의 명시적인 HTML/JS/CSS/이미지/글꼴/manifest/JSON 파일만 제공합니다. 숨김 파일, 소스맵, 서버 소스, 디렉터리 목록, symlink, hardlink, 루트 밖 경로는 제공하지 않습니다. `/api/*`의 없는 경로를 HTML로 바꾸지 않습니다. 영속 저장소를 공개 `dist` 안에 둘 수 없습니다. UI 파일이 아직 없더라도 API는 계속 동작합니다. GET과 HEAD를 지원합니다.

로컬 프로그램은 이벤트를 보낼 수 있으므로 `source`, `observation`, `modelEvidence`는 호출자의 보고이며 Codex/Claude의 인증된 신원 증명이 아닙니다. API 자체가 Codex/Claude를 자동으로 감지하지 않으며 별도 hook·관찰기 또는 명시적인 이벤트 연결이 필요합니다.

```sh
curl http://127.0.0.1:4780/api/events \
  -H 'Content-Type: application/json' \
  -d '{"source":"manual","observation":"manual","type":"agent.started","agentId":"developer","agentName":"개발 직원","status":"working","title":"사무실 화면 구현"}'
```

Vite 개발 서버는 기존처럼 `/api`를 `http://127.0.0.1:4780`으로 프록시할 수 있습니다. 종료 시 열린 SSE 연결도 종료합니다. 기본 서버 실행은 홈 저장소를 만들므로 단위 테스트에서는 반드시 명시적인 임시 경로 또는 메모리 전용 구성을 사용합니다.

## 로컬 회사 설정

`GET /api/settings`는 `{ "companyName": "나의 회사", "ownerName": "나" }` 형태의 표시용 설정만 반환합니다. 사용자 데이터 폴더의 `settings.json`을 읽으며 회사명만 있는 기존 설정도 호환됩니다. 파일이 없으면 공개 기본값을 사용하고, 실행 중 읽기 실패가 생기면 마지막 정상 값을 유지합니다. 다른 로컬 필드는 반환하지 않습니다.

`POST`와 `PATCH /api/settings`는 `Content-Type: application/json`으로 두 필드 중 하나 이상을 받습니다. 생략한 필드는 유지합니다. 회사명은 1~80자, 사장 이름은 1~40자이며 앞뒤 공백을 제거하고 빈 값·제어문자·추가 키는 거절합니다. 본문 상한은 16 KiB입니다. 성공 응답은 두 필드 전체이며 저장은 원자적으로 수행하고 파일 권한은 `0600`입니다. 검증 실패는 `400`, 파일 저장 실패는 `500`이고 기존 설정은 보존됩니다. 기존 Host/Origin 제한이 동일하게 적용됩니다. 이 API는 표시 설정만 바꾸며 AI 작업이나 승인을 제어하지 않습니다.

`/THIRD_PARTY_NOTICES.txt`와 `/fonts/<font-family>/LICENSE.txt`는 빌드에 동봉된 공개 라이선스 고지로 `text/plain` 응답을 제공합니다. 임의의 `.txt` 파일과 사용자 설정 파일은 정적 경로로 제공하지 않습니다.
