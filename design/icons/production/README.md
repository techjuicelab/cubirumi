# 배포용 C · 화이트·스카이블루

[투명 PNG 원본](C-white-sky-transparent-source.png)은 선택한 C 시안에서 바깥 여백과 외부 그림자만 투명 처리한 1254×1254 RGBA 파일입니다. 내부 그림과 색상은 원본 RGB 픽셀 그대로입니다. 초기 시안과 A·B·C 원본은 [보관함](../README.md)에 유지합니다.

이미지 생성 도구의 투명화 결과는 불투명 체크무늬를 포함하여 사용하지 않았습니다. 사용자가 코드 처리를 요청한 뒤 원본 C의 하늘색 외곽을 기준으로 마스크를 만들고, 외곽에만 안티앨리어싱을 적용했습니다. 원래 디자인 생성 프롬프트는 [색상 시안 프롬프트](../archive/three-floors-colors-v1/prompts.json)에 보관되어 있습니다.

이 원본으로 macOS의 `AppIcon.icns`와 웹 PNG 5개를 생성합니다. [asset-manifest.json](asset-manifest.json)에 원본·생성 자산의 상대 경로와 SHA-256을 기록했습니다.

일반 설치에는 이미지 가공 도구가 필요하지 않습니다. 배포용 파일을 다시 만들 때만 저장소 루트에서 실행합니다.

```sh
# macOS 기본 sips 및 iconutil로 해상도 변환과 ICNS 패키징
npm run icons:build
npm run build
npm run desktop:install
```

아이콘을 교체하려면 별도의 투명 정사각형 PNG(1024px 이상)를 준비하고 `npm run icons:build -- path/to/icon.png`로 지정할 수 있습니다. 설치 후 앱을 종료하고 다시 열면 새 아이콘이 표시됩니다. 보관된 원본에는 덮어쓰지 않습니다.

현재 C의 투명 원본 자체를 재현할 때는 Python 3와 Pillow가 있는 환경에서 `python3 design/icons/prepare-c-alpha.py`를 실행합니다. 이 스크립트는 C의 원본 해시가 다르면 중단하며, 다른 시안용 범용 배경 제거 도구가 아닙니다. 다크 모드에 따른 자동 아이콘 전환은 포함하지 않습니다.
