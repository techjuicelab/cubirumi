# Agent Office 아이콘 보관함

최종 선택은 **C · 화이트·스카이블루 (`C-white-sky`)**입니다. 초기 시안 6개와 색상 시안 3개, 총 9개 PNG를 향후 교체와 디자인 검토를 위해 보관합니다.

- [초기 시안 6개 갤러리](archive/2026-09-13/index.html)
- [세 층 건물 색상 시안 3개 갤러리](archive/three-floors-colors-v1/index.html)
- [선택한 C · 화이트·스카이블루](archive/three-floors-colors-v1/C-white-sky.png)
- [향후 다크 모드 후보 B · 네이비·앰버](archive/three-floors-colors-v1/B-navy-amber.png)
- [배포용 C 투명 PNG와 재생성 안내](production/README.md)

B안은 향후 다크 모드 후보로 보관하며, **다크 모드에 따른 아이콘 자동 변경 기능은 아직 구현하지 않았습니다.** 나머지 시안도 모두 유지합니다.

`archive/`에는 `artifacts/icon-concepts/2026-09-13/`와 `artifacts/icon-concepts/three-floors-colors-v1/`의 PNG, 갤러리 HTML, README, 프롬프트와 자산 JSON을 원본 바이트 그대로 복사했습니다. 원본 폴더도 유지했습니다. 두 폴더의 이름과 상대 경로를 유지해 색상 갤러리의 초기 시안 참조도 연결됩니다. 각 폴더의 README는 제작 당시 설명을 그대로 보존한 기록이며, 최종 선택은 이 문서에 기록합니다.

`legacy/`에는 기존 SVG 아이콘을 출처별로 이름을 구분해 보관합니다.

| 보관 파일 | 원본 위치 |
| --- | --- |
| `legacy/public-app-icon.svg` | `public/app-icon.svg` |
| `legacy/public-favicon.svg` | `public/favicon.svg` |
| `legacy/plugin-agent-office-icon.svg` | `plugins/agent-office/assets/icon.svg` |

[archive-manifest.json](archive-manifest.json)은 보관 파일 19개의 SHA-256, 바이트 크기, 상대 원본 경로를 기록합니다. PNG 9개에는 이미지 크기도 기록했습니다. 해시 대상은 복사한 보관 파일이며, 이 안내 문서와 매니페스트 자체는 제외합니다. 보관된 시안은 편집하지 않으며, 배포용 PNG·ICNS 등 가공본은 별도로 관리합니다.
