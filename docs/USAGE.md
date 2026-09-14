# 계정 공유 사용량

사무실의 에너지는 연결된 계정의 사용 한도를 표시합니다. 회사·프로젝트·직원별 예산이나 작업 성과가 아니며, 같은 계정을 쓰는 다른 작업의 사용량도 포함합니다. 일반 Codex와 Codex Spark는 별도 한도로 표시합니다. 일반 Codex의 창이 보고되지 않으면 Spark 수치로 대신 채우지 않습니다.

## Codex 자동 조회

`npm start`의 runtime이 브리지 준비 후 `scripts/codex-usage.mjs`를 시작합니다. 로그인된 로컬 Codex CLI의 별도 `codex app-server --stdio` 프로세스에 다음 요청만 보냅니다.

1. `initialize`
2. `initialized`
3. `account/rateLimits/read`

스레드 생성·재개·작업 실행·사용량 초기화·크레딧 소비 API는 호출하지 않습니다. 수집 코드가 인증 파일을 직접 읽지도 않습니다. Codex CLI의 기존 인증을 사용하므로 CLI가 설치되지 않았거나 현재 인증 방식에서 사용량을 지원하지 않으면 미확인으로 표시합니다. 프로토콜과 시간 단위는 [Codex 공식 app-server 문서](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt)를 따릅니다.

정상 조회는 종료 후 1분 간격으로 반복합니다. 원격 조회는 15초로 제한하며, 결과 수신·실패·중지 때 자식 프로세스를 종료합니다. SIGTERM 후에도 남아 있으면 1초 뒤 SIGKILL을 보냅니다. 응답은 최대 2 MiB까지만 읽으며 stderr는 저장하지 않습니다. 조회 실패가 이어지면 재시도 간격은 1분, 2분, 4분으로 늘어나고 이후 4분을 유지합니다. 브리지 전송 실패는 최대 1분 후 다시 시도합니다. 동시에 여러 조회를 실행하지 않습니다.

`rateLimitsByLimitId`가 있으면 해당 응답을 우선 사용하고, 없을 때만 이전 형식의 `rateLimits`를 읽습니다. 현재 지원하는 bucket은 `codex`와 `codex_bengalfox`입니다. 새로운 bucket을 임의로 일반 Codex 한도에 합치지 않습니다.

```sh
# 익명 사용량을 한 번 조회해 stdout에 표시하며 브리지에는 쓰지 않음
node scripts/codex-usage.mjs --once --dry-run

# 한 번 조회해 실행 중인 로컬 브리지에 전송
node scripts/codex-usage.mjs --once

# Codex 사용량 자동 조회를 제외하고 runtime 실행
AGENT_OFFICE_DISABLE_USAGE=1 npm start
```

CLI 경로를 별도로 지정하려면 `AGENT_OFFICE_CODEX_BIN`을 사용합니다. `AGENT_OFFICE_DISABLE_OBSERVER=1`은 Codex 작업 관측기와 Codex 사용량 수집기를 모두 시작하지 않습니다. `node server/index.mjs`만 실행하면 HTTP API만 열리며 사용량 수집기는 시작되지 않습니다.

## Claude Code 상태줄

Claude는 연결된 Claude Code 상태줄이 제공하는 `rate_limits.five_hour`와 `rate_limits.seven_day`의 수치만 받습니다. `used_percentage`는 사용한 비율이며 `resets_at`은 Unix 초 단위입니다. 지원되는 계정·버전에서 실제 응답 후 이 필드가 제공되어야 표시할 수 있습니다. 상태줄 설치만으로 실제 한도가 확인된 것은 아닙니다. 일반 Claude 채팅 앱의 화면이나 인증 파일을 읽어 사용량을 추정하지 않습니다.

`scripts/claude-statusline.mjs`는 기존 상태줄 명령의 입력과 출력을 유지하면서 허용된 사용량 필드만 브리지에 전송합니다. 숫자가 없으면 `unavailable`로 보고합니다. 원문 입력 전체를 사용량 저장소에 보내지 않습니다. Claude 연결과 설치 방법은 [연결 안내](../README.md)를 참고하세요.

화면은 로컬 수신 데이터를 5초마다, 창으로 돌아왔을 때 즉시 확인합니다. `수신 내용 새로고침`도 로컬 수신 내용을 다시 읽으며 Claude 원격 한도를 직접 조회하지 않습니다. 상태줄을 못 받았으면 `상태줄 연결 대기`, 공식 한도 필드가 없으면 `공식 사용량 수신 대기`, 오래되면 `마지막 수치 오래됨`으로 구분합니다. Claude 카드에서 사용량 상세의 Claude 섹션으로 바로 이동할 수 있으며, `Claude 사용량 열기`는 [공식 사용량 페이지](https://claude.ai/settings/usage)를 엽니다. 해당 페이지의 수치를 사무실에 자동으로 옮기거나 원격 수집 연결이 완료됐다고 표시하지 않습니다. 실제 사용량 확인 절차는 [Claude 확인 프롬프트](CLAUDE_VERIFY_PROMPT.md)에 있습니다.

공식 `refreshInterval`은 상태줄 스크립트를 다시 실행하지만 원격 한도 재조회를 보장하지 않습니다. 기존 값의 시각을 임의로 최신으로 바꾸지 않습니다. 사용량의 관측 시각은 상태줄이 다시 실행된 시각이 아니라 해당 Claude Code 세션 기록의 마지막 응답 시각이며, 기록 파일에서는 그 시각만 읽습니다. 응답이 없는 세션을 열어 두기만 하면 수치는 15분 뒤 `마지막 수치 오래됨`으로 바뀌고, 그 세션에서 새 응답을 받으면 다시 갱신됩니다. Desktop 앱에서 쓴 사용량은 터미널 세션이 다음 응답을 받을 때 함께 반영됩니다. 다른 Claude 세션에서 빈 한도를 보내도 이미 받은 유효 수치를 즉시 무효화하지 않고 원래 관측 시각으로 신선도를 판단합니다. 보고 프로세스가 늦게 시작돼도 최초 관측 시각을 유지합니다.

`AGENT_OFFICE_USAGE_ENDPOINT`를 지정하면 저장된 상태줄 설정의 endpoint보다 우선합니다. 목적지는 인증 정보·쿼리 없는 로컬 HTTP `/api/usage`만 허용하며 외부 주소는 전송하지 않습니다.

## 신선도와 미확인 값

| 표시 | 의미 |
| --- | --- |
| provider `live` | 관측 수치가 있고, 마지막 조회가 성공했으며 `updatedAt` 이후 15분을 넘지 않음 |
| provider `stale` | 기존 수치는 있지만 이후 조회 실패가 보고됐거나 마지막 관측 후 15분 초과 |
| provider `unavailable` | 확인된 사용 비율이 없음 |
| window `stale` | provider가 stale이거나 해당 창의 `resetsAt`이 지남 |
| window `unavailable` | 해당 창의 `usedPercent`가 미확인 |

초기화 시각이 지났다는 이유로 사용량을 0%, 잔여량을 100%로 바꾸지 않습니다. 새 수치를 받아야 다시 live가 됩니다. 에너지 탱크는 provider가 `stale`이어도 회복 시각이 지나지 않은 창의 마지막 수치를 회색으로 흐리게 남기고, 퍼센트 바로 옆에 `마지막 기록`을 표시합니다. 캡션에는 창 이름과 관측 시각(`HH:MM 기준`, 다른 날이면 날짜 포함)을 붙이며 보조 기술용 레이블에 `최신 아님`을 넣어 현재 잔여량으로 읽히지 않게 합니다. 탱크에서는 회복 시각이 지난 창과 미확인 값은 수치 대신 `—`를 표시합니다. 상세 패널은 회복 시각이 지난 창도 `마지막 기록`으로 남겨 두되 `새 사용량을 기다리는 중`으로 표시하고, 새 수치가 오기 전에는 100%로 채우지 않습니다. 한 번도 비율을 받지 못한 창은 `미확인`이며 마지막 기록으로 표현하지 않습니다. 상세의 관측 시각에도 다른 날이면 날짜를 붙입니다. Spark의 초기화 시각이 지나도 정상인 일반 Codex 창은 live로 남습니다. 저장소를 다시 열어도 신선도는 저장된 관측 시각을 기준으로 계산합니다.

누락·`null` 값은 미확인입니다. `remainingPercent`는 유효한 `usedPercent`가 있을 때만 `100 - usedPercent`로 계산합니다. 수집 실패 시 마지막 관측 시각과 수치를 보존하고 stale로 바꿉니다. 이전 시각으로 뒤늦게 도착한 관측은 최신 수치를 덮어쓰지 않습니다.

## HTTP 계약

`GET /api/usage`는 다음 구조를 반환합니다. 아직 관측하지 않은 서버의 응답 예시입니다.

```json
{
  "providers": [
    {
      "provider": "codex",
      "status": "unavailable",
      "updatedAt": null,
      "source": "none",
      "reason": "not-observed",
      "windows": []
    },
    {
      "provider": "claude",
      "status": "unavailable",
      "updatedAt": null,
      "source": "none",
      "reason": "not-observed",
      "windows": []
    }
  ]
}
```

`POST /api/usage`는 위 provider 객체 하나를 받습니다. 정상 수락 시 `202`와 `{ "ok": true, "provider": { ... } }`를 반환합니다. `Content-Type: application/json`, 최대 16 KiB, 기존 브리지의 Host·Origin 제한이 동일하게 적용됩니다. 수신 코드는 다른 호스트로 향하는 redirect를 따르지 않습니다.

| 필드 | 계약 |
| --- | --- |
| `provider` | `codex` 또는 `claude` |
| `status` | `live`, `stale`, `unavailable` |
| `updatedAt` | 시간대가 있는 ISO 8601 또는 미관측 시 `null`. 관측값이 있으면 필수. 서버보다 60초 넘게 미래인 시각 거절 |
| `source` | Codex: `codex-app-server`, `codex-log`, `none`. Claude: `claude-statusline`, `none`. 자동 Codex 수집은 `codex-app-server`만 사용 |
| 선택적 `reason` | `not-observed`, `unsupported`, `authentication-required`, `read-failed`, `expired`, `outdated`, `timeout`, `collector-unavailable` |
| `windows` | 최대 4개. 같은 ID 중복 거절 |
| window `id` | Codex: `codex:primary`, `codex:secondary`, `codex_bengalfox:primary`, `codex_bengalfox:secondary`. Claude: `five_hour`, `seven_day` |
| window `usedPercent` | 0~100의 유한한 숫자 또는 `null` |
| window `windowMinutes` | 1~525600의 정수 또는 `null`. 실제 보고된 길이 사용 |
| window `resetsAt` | Unix 초 단위 정수 또는 `null`. 밀리초를 보내지 않음 |
| window `label`, `remainingPercent`, `status` | 서버가 생성·계산하는 출력 필드. 입력으로 보내도 해당 값을 신뢰하지 않음 |

`primary`가 반드시 5시간 창이라는 뜻은 아닙니다. 기간은 `windowMinutes`로 판단해야 합니다. `live` 요청에는 유효한 사용 비율을 가진 창이 적어도 하나 필요합니다. 문자열로 된 숫자, 잘못된 ID·source·reason은 `400`, 본문 초과는 `413`, 콘텐츠 형식 오류는 `415`입니다. 저장에 실패하면 `500`을 반환하고 이전 메모리 상태를 보존합니다.

## 저장 범위

`AGENT_OFFICE_DATA_DIR` 또는 기본 사용자 데이터 디렉터리의 `usage.json`에 공급자별 최신 snapshot만 저장합니다. 디렉터리는 `0700`, 파일은 `0600`이며 symlink·hardlink 파일을 거절합니다. 임시 파일을 동기화한 뒤 원자적으로 교체합니다. `createOfficeServer()`에 `dataDir`을 주지 않은 테스트에서는 파일을 쓰지 않습니다.

저장 필드는 위 계약으로 제한됩니다. 계정 ID, 이메일, 인증 토큰, 플랜 정보, 크레딧 ID·잔액, 원격 오류 원문, 작업 내용은 저장하지 않습니다. label은 서버가 알려진 공급자와 기간으로 생성하므로 입력의 계정 이름이 섞이지 않습니다. 로컬 API에 쓰기 권한이 있는 프로그램이 보고한 값은 받을 수 있으며, API 자체가 공급자의 인증된 서명이나 계정 신원을 증명하지는 않습니다.
