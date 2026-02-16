# WebImageHere Desktop

웹사이트에서 이미지를 자동으로 수집하는 데스크톱 앱.
설치(.exe)만 하면 바로 사용 가능 — 별도 서버 설정 불필요.

![Electron](https://img.shields.io/badge/Electron-35-47848F?logo=electron&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux-blue)
![License](https://img.shields.io/badge/License-MIT-green)

## 주요 기능

- **키워드 검색 스크래핑** — URL + 키워드 입력만으로 관련 이미지 자동 수집
- **WordPress 사이트 최적화** — 검색 페이지네이션, 카테고리 브라우징 자동 전환
- **Cloudflare 우회** — Stealth 플러그인 기반 자동 감지 및 우회
- **CDN 안티핫링크 우회** — CDP 네트워크 캡처로 원본 이미지 데이터 직접 추출
- **Lazy-load 대응** — 자동 스크롤 + data-src/srcset 속성 완전 파싱
- **게시물 내부 페이지네이션** — 멀티페이지 갤러리 포스트 자동 탐색
- **ZIP 다운로드** — 폴더별 일괄 압축 다운로드
- **시스템 트레이** — 닫기 버튼으로 트레이 최소화, 백그라운드 실행
- **단일 인스턴스** — 중복 실행 방지, 기존 창 자동 포커스

## 아키텍처

```
[Electron Main Process]
    ├── Express Server (in-process, 127.0.0.1:{auto-port})
    ├── Puppeteer + Chrome for Testing (첫 실행 시 자동 다운로드)
    └── BrowserWindow → http://localhost:{port}
```

- Electron이 Express 서버를 내부에서 시작 (외부 노출 없음)
- BrowserWindow가 localhost로 React UI를 로드
- Chrome for Testing을 첫 실행 시 `@puppeteer/browsers`로 자동 다운로드 (~130MB)
- 포트 자동 탐색 (3000~3099)

## 설치 및 실행

### Windows (.exe 인스톨러)

[Releases](../../releases) 페이지에서 `WebImageHere-Setup-x.x.x.exe`를 다운로드하여 설치합니다.

> 첫 실행 시 Chrome for Testing이 자동 다운로드됩니다 (~130MB).
> 타이틀바에 진행률이 표시됩니다.

### 소스에서 빌드

```bash
# 1. 클론
git clone https://github.com/wpulnbada-vr/WebImageHere.git
cd WebImageHere

# 2. 의존성 설치
npm install

# 3. 개발 모드 실행
npm start

# 4. Windows 인스톨러 빌드
npm run build:win

# 5. Linux AppImage 빌드
npm run build:linux
```

빌드 결과물은 `dist/` 디렉토리에 생성됩니다.

## 사용법

1. 앱 실행
2. URL 입력 (예: `https://example.com/gallery`)
3. 키워드 입력 (선택사항 — 비워두면 해당 URL의 이미지만 수집)
4. **스크래핑 시작** 클릭
5. 완료 후 **다운로드 폴더** 버튼으로 결과 확인

## 데이터 경로

| 항목 | Windows | Linux |
|------|---------|-------|
| 다운로드 이미지 | `Documents\WebImageHere Downloads\` | `~/Documents/WebImageHere Downloads/` |
| 작업 히스토리 | `%APPDATA%\WebImageHere\history.json` | `~/.config/WebImageHere/history.json` |
| Chrome 캐시 | `%APPDATA%\WebImageHere\chrome\` | `~/.config/WebImageHere/chrome/` |

## 프로젝트 구조

```
WebImageHere/
├── package.json          # Electron + electron-builder 설정
├── main.js               # Electron 메인 프로세스
├── preload.js            # contextBridge IPC 브릿지
├── server/
│   ├── server.js         # Express 서버 (startServer() 함수)
│   └── scraper.js        # Puppeteer 스크래퍼 + 크로스플랫폼 findChrome()
├── public/               # React UI (Vite 빌드 결과)
│   ├── index.html
│   └── assets/
└── build/
    └── icon.png          # 앱 아이콘
```

## 기술 스택

| 구성 요소 | 기술 |
|-----------|------|
| 데스크톱 프레임워크 | [Electron](https://www.electronjs.org/) 35 |
| 빌드/패키징 | [electron-builder](https://www.electron.build/) (NSIS) |
| 백엔드 | [Express](https://expressjs.com/) 4 |
| 브라우저 자동화 | [Puppeteer](https://pptr.dev/) + [Stealth Plugin](https://github.com/nicedoc/puppeteer-extra-plugin-stealth) |
| Chrome 관리 | [@puppeteer/browsers](https://www.npmjs.com/package/@puppeteer/browsers) |
| 프론트엔드 | React (Vite 빌드) |
| 압축 | [Archiver](https://www.archiverjs.com/) |

## 개발 노트

### Chrome 자동 다운로드

앱에 Chrome을 번들하지 않아 인스톨러 크기를 ~80MB로 유지합니다.
첫 실행 시 `@puppeteer/browsers`가 Chrome for Testing stable 버전을 다운로드합니다.
다운로드 실패 시 시스템에 설치된 Chrome/Chromium으로 자동 폴백합니다.

### 크로스플랫폼 Chrome 탐지

`findChrome()` 함수가 OS별로 Chrome을 탐색합니다:

- `CHROME_PATH` 환경변수 (최우선)
- `@puppeteer/browsers` 캐시 디렉토리
- 시스템 설치 경로 (Windows: Program Files, LocalAppData / macOS: /Applications / Linux: /usr/bin)

### 서버 보안

Electron 모드에서 Express는 `127.0.0.1`에만 바인딩됩니다.
외부 네트워크에서 접근할 수 없습니다.

## 빌드 설정 (electron-builder)

```jsonc
{
  "asarUnpack": [
    // Puppeteer가 Chrome 프로세스를 생성하려면 asar 밖에 있어야 함
    "node_modules/puppeteer-core/**/*",
    "node_modules/puppeteer-extra/**/*",
    "node_modules/puppeteer-extra-plugin-stealth/**/*"
  ],
  "nsis": {
    "oneClick": false,                        // 설치 옵션 표시
    "allowToChangeInstallationDirectory": true, // 경로 선택 가능
    "createDesktopShortcut": true,
    "createStartMenuShortcut": true
  }
}
```

## License

MIT
