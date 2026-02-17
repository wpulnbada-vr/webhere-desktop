# WebImageHere Scraper Refactoring

## Overview

모놀리식 `scraper.js` (1,125줄)를 모듈화된 `scraper/` 디렉토리 (15개 파일, 1,396줄)로 리팩토링.
Strategy + Registry 패턴으로 사이트별 특화 어댑터 시스템을 구축.

## Architecture

### Before (단일 파일)
```
scraper.js (1,125줄)
  └── class ImageScraper (모든 로직 포함)
```

### After (모듈 분리)
```
scraper/
  index.js              (198줄) 오케스트레이터 (ImageScraper)
  browser-manager.js    (196줄) 브라우저 생명주기, CDP, Cloudflare, 미러 도메인
  search-engine.js      (406줄) 검색 전략 (Custom, WP, Form, Category)
  image-extractor.js    (267줄) 이미지 추출 + content area 필터링
  downloader.js          (80줄) 이미지 다운로드 (CDP cache + Node.js fallback)
  chrome-finder.js       (76줄) 크로스플랫폼 Chrome 탐색
  adapter-registry.js    (38줄) URL → 어댑터 매칭 레지스트리
  base-adapter.js        (32줄) 기본 사이트 어댑터 인터페이스
  constants.js           (13줄) 공통 상수
  utils.js               (23줄) 유틸리티 함수
  adapters/
    everiaclub.js        (25줄) EveriaClub 특화
    4khd.js              (25줄) 4KHD 특화
    wordpress-generic.js (17줄) WordPress 범용
```

## Key Improvements

### 1. Content Area Filtering (사이드바 썸네일 문제 해결)

**문제**: everiaclub.com에서 gms 스크래핑 시 사이드바 썸네일 1,338개가 포함 (총 2,406개 중)

**해결**: `image-extractor.js`에서 어댑터의 CSS 셀렉터로 content area 필터링
- 본문 영역 내 이미지만 추출 (`.entry-content`, `article` 등)
- 사이드바/위젯 영역 제외 (`aside`, `.sidebar`, `.widget` 등)
- 5개 미만이면 전체 페이지 fallback

### 2. Custom Search URL (사이트별 검색 엔드포인트)

**문제**: 사이트마다 검색 URL 패턴이 다름
- everiaclub.com: `/search/?keyword=KEYWORD`
- 4khd.com: `/search/KEYWORD`
- WordPress 기본: `/?s=KEYWORD`

**해결**: `getCustomSearchUrl(origin, keyword)` 어댑터 메서드
- 사이트별 커스텀 검색 URL 지원
- 페이지네이션 자동 감지 (`/page/N`, `?page=N`, `?p=N`)
- 키워드 필터링 (검색 결과에 최신 포스트가 섞여있는 경우 대응)

### 3. Search Strategy Pipeline

검색 우선순위:
1. **Custom Search** — 어댑터의 `getCustomSearchUrl()` (최우선)
2. **WordPress ?s=** — 키워드 관련성 검증 포함
3. **Form Search** — 사이트 내 검색 폼 자동 감지
4. **Category Browsing** — 페이지네이션으로 키워드 매칭 포스트 탐색

### 4. Adapter System (Strategy + Registry 패턴)

```javascript
// 어댑터 인터페이스
class BaseSiteAdapter {
  static match(url)                    // URL 매칭
  getSearchStrategy()                  // 'auto' | 'wordpress'
  getCustomSearchUrl(origin, keyword)  // 커스텀 검색 URL (null = 기본)
  getContentSelectors()                // 본문 영역 CSS 셀렉터
  getExcludeSelectors()                // 제외 영역 CSS 셀렉터
  getDownloadHeaders(imgUrl, pageUrl)  // 커스텀 다운로드 헤더
  normalizeImageUrl(url)               // URL 정규화
}
```

새 사이트 어댑터 추가: `scraper/adapters/sitename.js` 파일 생성만으로 자동 등록

### 5. Cross-Project Sync (3개 프로젝트 통합)

| 프로젝트 | 경로 | 이전 | 이후 |
|----------|------|------|------|
| Host | `~/webimagehere/` | `scraper.js` (1,125줄) | `scraper/` (15파일) |
| Desktop | `~/webimagehere-desktop/server/` | `scraper.js` (884줄) | `scraper/` (동일) |
| Claw | `~/webimage-claw/src/core/` | `scraper.js` (796줄) + `chrome-finder.js` + `constants.js` | `scraper/` (동일) |

3개 프로젝트가 완전히 동일한 scraper/ 코드를 공유. 하위 호환성 유지 (`require('./scraper')` → `scraper/index.js`).

## Test Results

### 사이트별 검색 결과

| 사이트 | gms | jucy | 주희 | russia |
|--------|-----|------|------|--------|
| **everiaclub.com** | 1,473 | - | - | - |
| **girl-atlas.com** | 152 | 0 | 0 | - |
| **hotgirl.asia** | 827 | 0 | 78 | - |
| **foamgirl.net** | 1,332 | 1,994 | 206 | - |
| **4khd.com** | 502 | - | - | 127 |
| **watch4beauty.com** | 0 (구독 필요) | - | - | 0 |
| **kr.xchina.co** | CF 실패 | CF 실패 | CF 실패 | - |
| **v2ph.com** | CF 실패 | - | - | CF 실패 |

### 키워드별 총 다운로드

| 키워드 | 총 파일 수 | 앨범 수 |
|--------|-----------|---------|
| gms | 2,788 | 64 |
| jucy | 1,989 | 48 |
| 주희 | 284 | 8 |
| russia | 122 | 5 |

### Content Area Filtering 효과 (everiaclub.com gms 기준)

| 항목 | Before | After |
|------|--------|-------|
| 검색 방식 | WP `?s=` (키워드 무시) | Custom `/search/?keyword=` |
| 포스트 소스 | 무관한 최신 포스트 | GMS 전용 37개 포스트 |
| 사이드바 포함 | ~1,338개 포함 | 제외됨 |
| 앨범명 파일명 | `gms_0001.jpg` | `gms_고말숙,_LEDG-108A_0001.jpg` |
| 총 다운로드 | 2,406개 (무관한 이미지 포함) | 1,473개 (정확한 결과) |

## How to Add a New Site Adapter

`scraper/adapters/` 디렉토리에 새 JS 파일을 생성하면 자동으로 등록됩니다.

```javascript
// scraper/adapters/example.js
const BaseSiteAdapter = require('../base-adapter');

class ExampleAdapter extends BaseSiteAdapter {
  static match(url) { return /example\.com/i.test(url); }

  getCustomSearchUrl(origin, keyword) {
    return `${origin}/search/?q=${encodeURIComponent(keyword)}`;
  }

  getContentSelectors() {
    return ['.article-body', '.post-content', 'article'];
  }

  getExcludeSelectors() {
    return ['aside', '.sidebar', 'nav', 'footer'];
  }
}

module.exports = ExampleAdapter;
```

## Files Changed

### New Files (15)
- `scraper/index.js` — 오케스트레이터
- `scraper/browser-manager.js` — 브라우저 관리
- `scraper/search-engine.js` — 검색 전략
- `scraper/image-extractor.js` — 이미지 추출
- `scraper/downloader.js` — 다운로드
- `scraper/chrome-finder.js` — Chrome 탐색
- `scraper/adapter-registry.js` — 레지스트리
- `scraper/base-adapter.js` — 기본 어댑터
- `scraper/constants.js` — 상수
- `scraper/utils.js` — 유틸리티
- `scraper/adapters/everiaclub.js` — EveriaClub
- `scraper/adapters/4khd.js` — 4KHD
- `scraper/adapters/wordpress-generic.js` — WordPress 범용
- `SCRAPER-REFACTORING.md` — 이 문서

### Deleted Files
- `scraper.js` — `scraper/` 디렉토리로 대체

### Modified Files (Claw only)
- `src/desktop/chrome-manager.js` — import 경로 변경 (`../core/chrome-finder` → `../core/scraper/chrome-finder`)
