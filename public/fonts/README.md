# 자체 호스팅 글꼴

2026-09-12에 Fontsource 공식 npm 패키지에서 아래 파일을 가져왔습니다. 글꼴 바이너리는 수정하지 않았습니다. 브라우저는 `/fonts/`의 로컬 파일만 요청합니다.

| 글꼴 | 패키지 | 포함 굵기 | 포함 문자 집합 |
| --- | --- | --- | --- |
| Gowun Dodum | `@fontsource/gowun-dodum@5.3.0` | 400 | Korean, Latin, Latin Extended, Vietnamese |
| IBM Plex Sans KR | `@fontsource/ibm-plex-sans-kr@5.3.0` | 400, 500, 600, 700 | Korean, Latin, Latin Extended |

WOFF2 16개, 총 2,646,228바이트입니다. CSS는 `src/fonts.css`에 있습니다. Korean은 Fontsource의 전체 Korean 파일을 사용하며 나머지 subset의 `unicode-range`는 같은 패키지의 `unicode.json` 값을 그대로 사용합니다. 450 굵기는 원본에 없어 포함하지 않았고, 브라우저가 사용 가능한 굵기를 선택합니다.

각 폴더의 `LICENSE.txt`는 해당 패키지가 제공하는 SIL Open Font License 1.1 원문입니다. 배포할 때 글꼴과 함께 보존하세요. 바이너리 무결성 기록은 `SHA256SUMS`입니다.

출처:

- [Gowun Dodum 설치 안내](https://fontsource.org/fonts/gowun-dodum/install)
- [IBM Plex Sans KR 설치 안내](https://fontsource.org/fonts/ibm-plex-sans-kr/install)
- [Gowun Dodum npm 5.3.0](https://registry.npmjs.org/@fontsource/gowun-dodum/5.3.0)
- [IBM Plex Sans KR npm 5.3.0](https://registry.npmjs.org/@fontsource/ibm-plex-sans-kr/5.3.0)
