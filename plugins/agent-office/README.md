# Agent Office Codex 플러그인

이 폴더는 Codex에 설치할 수 있는 플러그인 묶음입니다. 사무실 웹 서버는 별도로 실행해야 합니다.

Node.js 24 이상을 설치하고, 복제한 Agent Office 저장소에서 실행하세요.

```sh
cd /absolute/path/to/agent-office
npm ci
npm run build
node scripts/runtime.mjs
```

브라우저에서 `http://127.0.0.1:4780/`을 엽니다. macOS와 Linux에서 이 실행 방식을 사용할 수 있습니다. 로그인 시 자동 실행 등록은 macOS의 `node scripts/install-runtime.mjs install`로 제공합니다. Linux 자동 서비스 등록은 포함하지 않으며 Windows 실행은 실험적입니다.

플러그인의 hook은 Codex 실행 환경의 `PATH`에서 `node`를 찾습니다. 터미널에서는 되지만 데스크톱 앱에서 안 된다면 해당 앱 환경의 Node 경로를 확인해야 합니다. 공개 hook 파일에는 특정 컴퓨터의 Node 절대 경로를 포함하지 않습니다.

사용자 지정 Codex 저장소는 `CODEX_HOME`으로 지정할 수 있습니다. 기본값은 사용자 홈 아래 `.codex`이며, 관측기는 그 아래 `state_5.sqlite`와 `sessions`를 읽기 전용으로 사용합니다. Codex 기록이 아직 없는 컴퓨터에서도 사무실 서버는 유지되며 관측 연결을 30초 간격으로 다시 확인합니다. Claude Code만 사용하는 경우 `AGENT_OFFICE_DISABLE_OBSERVER=1`로 Codex 관측기를 끌 수 있습니다.

Codex에서 새롭거나 변경된 hook은 `/hooks`에서 검토하고 신뢰해야 동작합니다. 플러그인 등록, hook 신뢰, 사무실 서버 실행, 실제 이벤트 수신은 각각 별도 상태입니다. 자세한 설치 흐름은 복제한 저장소의 `README.md`를 참고하세요.
