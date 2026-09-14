# macOS 다운로드판과 업데이트 배포

이 문서는 Cubirumi의 공개 후보 파일을 만드는 개발자용 안내입니다. 배포 저장소 [techjuicelab/cubirumi](https://github.com/techjuicelab/cubirumi)와 Sparkle 공개키는 설정되어 있으며 공개 릴리스는 준비 중입니다. 신규 Mac의 다운로드·첫 실행과 공개 피드에서 이전 버전을 새 버전으로 바꾸는 전체 흐름은 아직 검증하지 않았습니다.

## 배포 구성

다운로드판은 Node.js **24.20.0**, Sparkle **2.10.0**, 로컬 관측 서버와 빌드한 웹 화면을 포함합니다. macOS **13.5 이상**을 대상으로 Apple Silicon `arm64`와 Intel `x64`를 각각 만듭니다. 사용자는 npm이나 저장소를 설치할 필요가 없습니다. 개발용 `desktop:build`·`desktop:install`은 이 패키지와 달리 별도 서버를 사용합니다.

현재 산출물은 ZIP입니다. DMG 생성은 구현되어 있지 않습니다. 앱은 임시 서명으로 빌드하며 Apple Developer ID 서명·공증을 제공하지 않습니다. 최초 설치에는 [앱별 실행 허용 안내](DESKTOP.md)를 제공합니다.

패키지는 런타임 파일 허용목록과 새로 빌드한 웹 화면으로 구성합니다. 개인 설정·관측 기록·개발 중 보고서는 앱에 넣지 않습니다. Node·Sparkle 배포 파일은 공식 출처와 고정 SHA-256으로 확인하고, 앱에 각 라이선스를 함께 보관합니다.

## 로컬 검증용 패키지

macOS에서 Node.js 22.18 이상, npm, Xcode 또는 Command Line Tools가 필요합니다. 저장소 루트에서 실행합니다.

```sh
npm ci
npm test
npm run desktop:package -- --arch arm64
```

Intel 대상은 `--arch x64`를 지정합니다. 생략하면 빌드하는 Mac의 아키텍처를 사용합니다. 패키지 명령은 TypeScript 검사와 웹 빌드를 자체적으로 수행하며, 실행 중인 소스 서버의 `dist` 대신 임시 패키지 폴더에 화면을 빌드합니다. 기존 설치 앱이나 실행 서비스를 교체하지 않습니다.

결과는 `artifacts/packages/` 아래 새 폴더에 만들어집니다. 명령이 출력하는 **결과 폴더 전체 경로**를 다음 단계에 사용하세요. 폴더에는 `.app`, 아키텍처별 ZIP, 패키지 메타데이터 `package.json`이 있습니다. 업데이트 설정이 없으면 로컬 검증용이며 자동 업데이트는 비활성화됩니다.

## 공개 저장소와 업데이트 공개키

`desktop/release.json`은 공개 가능한 설정만 보관합니다.

| 필드 | 의미 |
| --- | --- |
| `productName` | 앱 표시 이름과 다운로드 파일 이름. 현재 `Cubirumi` |
| `repository` | GitHub `owner/repository`. 현재 `techjuicelab/cubirumi`, 미설정은 `null` |
| `publicEDKey` | Sparkle Ed25519 공개키의 Base64 문자열. 미설정은 `null` |
| `minimumSystemVersion` | 최소 macOS 버전. 현재 `13.5` |

저장소와 공개키를 함께 설정한 뒤 공개 후보를 다시 빌드합니다. 첫 공개 전에 이름·저장소·키를 확정하고, 이후 임의로 바꿔 기존 설치의 업데이트 경로를 끊지 않도록 합니다.

```sh
npm run desktop:package -- --arch arm64 --release
npm run desktop:package -- --arch x64 --release
```

`--release`는 저장소나 공개키가 없으면 실패합니다. 이 옵션만으로 ZIP에 업데이트 서명이 추가되거나 GitHub에 공개되지는 않습니다. 버전은 루트 `package.json`의 `major.minor.patch`를 사용하며 다음 배포에서는 반드시 증가시킵니다.

## 1Password로 서명 키 주입

Ed25519 비밀키는 배포자 1Password의 항목을 기준으로 관리합니다. 현재 배포키는 생성·보관과 공개키 등록을 마쳤으며 1Password에서 다시 읽어 공개키와의 일치를 확인했습니다. 비밀키를 저장소·명령 인수·릴리스 설명·로그에 넣지 않습니다. 앱에는 대응하는 공개키만 넣습니다. 포크에서 별도 앱을 배포할 때는 자신의 키와 저장소를 설정합니다.

1Password에서 해당 필드의 **Copy Secret Reference**로 복사한 `op://` 참조를 배포자 전용 `env/release.op.env` 파일에 적습니다. 공개 파일 [env/release.op.env.example](../env/release.op.env.example)은 형식 예시이며 실제 만들어 둔 항목의 참조로 바꿉니다. `env/release.op.env`는 Git에서 제외합니다. 참조 파일에는 비밀키 값을 적지 않습니다.

```dotenv
SPARKLE_PRIVATE_KEY="op://AI Automation/Release Signing/private_key"
```

참조 파일과 앞 단계에서 출력된 패키지 결과 폴더를 지정합니다.

```sh
op run --env-file=env/release.op.env -- npm run release:prepare -- "artifacts/packages/패키지-결과-폴더"
```

`release:prepare`는 현재 공개 설정과 패키지 메타데이터·SHA-256을 대조합니다. 주입받은 비밀키는 Sparkle `sign_update`의 표준 입력으로 전달하며 키 파일이나 프로세스 명령 인수로 만들지 않습니다. ZIP 서명이 앱의 공개키와 맞는지 확인하고 피드도 서명·검증합니다.

서명된 후보는 `artifacts/releases/`의 새 폴더에 만들어집니다.

| 파일 | 용도 |
| --- | --- |
| 아키텍처별 `.zip` | 사용자가 내려받거나 Sparkle이 설치할 앱 |
| `appcast-arm64.xml` 또는 `appcast-x64.xml` | 해당 아키텍처의 서명된 업데이트 피드 |
| `SHA256SUMS-arm64.txt` 또는 `SHA256SUMS-x64.txt` | ZIP과 피드의 해시 |

ZIP을 서명한 뒤 다시 압축하거나 수정하면 안 됩니다. 바뀐 파일은 새로 패키징하고 서명합니다. GitHub Actions의 `SPARKLE_PRIVATE_KEY` secret은 배포용 복사본이며 1Password를 원본과 교체 이력의 기준으로 유지합니다.

## GitHub Release 게시

`desktop:package`·`release:prepare` 명령은 로컬 파일만 만듭니다. GitHub에 `v<major.minor.patch>` 태그를 push하면 [release.yml](../.github/workflows/release.yml)이 **정식 릴리스 게시까지 자동으로 수행**합니다. 태그는 루트 `package.json`의 버전, 저장소는 `desktop/release.json`의 값과 일치해야 합니다. 첫 실행 전에 1Password의 키를 GitHub Actions의 `SPARKLE_PRIVATE_KEY` secret에 배포용 복사본으로 등록합니다.

워크플로는 Apple Silicon과 Intel의 macOS runner에서 각각 공개 파일 검사·테스트·패키징·서명을 수행합니다. 양쪽 작업이 모두 성공하면 ZIP·피드·해시 총 6개 파일을 모아 해시를 검증하고, 한 Release의 초안에 파일을 올린 뒤 정식 `latest` 릴리스로 공개합니다. 한쪽 아키텍처가 실패하면 게시 단계는 진행하지 않습니다. 앱의 실제 설치·시각 검수·버전 간 업데이트 확인은 이 자동 빌드와 별도로 수행합니다.

앱은 다음 주소에서 자신의 아키텍처에 맞는 피드를 읽습니다. 저장소 경로는 `desktop/release.json`에서 가져옵니다.

```text
https://github.com/techjuicelab/cubirumi/releases/latest/download/appcast-arm64.xml
https://github.com/techjuicelab/cubirumi/releases/latest/download/appcast-x64.xml
```

피드의 ZIP 주소는 `releases/download/v<버전>/<파일명>`을 가리킵니다. 공개되지 않은 초안·미리보기 릴리스를 정식 `latest` 업데이트 경로와 혼동하지 않습니다. [GitHub Release 관리 안내](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)

## 공개 전에 확인할 사용자 흐름

- Node.js와 기존 소스 서버가 없는 Mac에서 ZIP을 다운로드하고 첫 실행을 허용해 사무실이 열리는지 확인합니다.
- 두 아키텍처는 각각 실제 대상 Mac에서 시작·관측·종료를 확인합니다. 교차 컴파일만으로 대상 기기 검증을 대신하지 않습니다.
- 기존 별도 서버가 `4780`을 사용하면 충돌을 안내하고 그 서버를 종료하거나 재사용하지 않는지 확인합니다.
- 공개 피드를 사용하는 이전 버전에서 새 버전을 확인·다운로드하고, 앱 종료 후 적용되는지 확인합니다. 사용자 선택과 회사명·사장 이름·기록이 유지되어야 합니다.
- 수정된 ZIP·잘못된 서명·조회 실패가 설치 성공으로 처리되지 않는지 확인합니다.

로컬 빌드·테스트 통과, 공개 파일 다운로드, 신규 Mac 첫 실행, 실제 버전 간 자동 업데이트의 확인 결과는 각각 기록합니다. 현재 문서는 마지막 두 흐름이 완료되었다고 보증하지 않습니다.
