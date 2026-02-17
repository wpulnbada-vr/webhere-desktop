const { EXCLUDE_PATTERNS } = require('./constants');
const { sleep, normalizeImageUrl } = require('./utils');

async function getPostImages(bm, adapter, postUrl, minWidth, minHeight) {
  const allImages = new Set();
  const pagesToVisit = [postUrl];
  const visitedPages = new Set();

  while (pagesToVisit.length > 0) {
    const currentUrl = pagesToVisit.shift();
    if (visitedPages.has(currentUrl) || bm.aborted) break;
    visitedPages.add(currentUrl);

    let pageImages = [];
    let html = '';

    const pageTimeout = new Promise(r => setTimeout(() => r('timeout'), 60000));
    const pageWork = (async () => {
      let navUrl = currentUrl;
      if (bm.jsDisabledMode) {
        await bm.page.setJavaScriptEnabled(false);
      } else {
        await bm.page.setJavaScriptEnabled(true);
      }
      await bm.page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(bm.jsDisabledMode ? 800 : 1500);

      // Check for Cloudflare on post page and try mirror domains
      const cfTitle = await bm.page.title().catch(() => '');
      if (bm.isCloudflarePage(cfTitle)) {
        bm._emit('cf', { message: `포스트 페이지 CF 감지, 우회 시도...` });
        const passed = await bm.waitForCloudflare();
        if (!passed) {
          const mirrorUrls = bm.getMirrorUrl(navUrl);
          if (mirrorUrls) {
            for (const mUrl of mirrorUrls) {
              bm._emit('cf', { message: `CF 우회: ${new URL(mUrl).hostname} 시도...` });
              try {
                await bm.page.goto(mUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
                await sleep(1500);
                const t = await bm.page.title().catch(() => '');
                if (!bm.isCloudflarePage(t)) {
                  bm._emit('cf', { message: `미러 도메인 접속 성공!` });
                  navUrl = mUrl;
                  break;
                }
              } catch {}
            }
          }
        }
      }

      if (bm.jsDisabledMode) {
        html = await bm.page.content().catch(() => '');
        pageImages = extractImagesFromHtml(html);
      } else {
        const currentPageUrl = bm.page.url();
        if (currentPageUrl === 'about:blank' || !currentPageUrl.startsWith('http') || bm.isCloudflarePage(await bm.page.title().catch(() => ''))) {
          bm.jsDisabledMode = true;
          bm._emit('status', { message: 'JS-free 모드로 전환' });
          await bm.page.setJavaScriptEnabled(false);
          await bm.page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await sleep(800);
          html = await bm.page.content().catch(() => '');
          pageImages = extractImagesFromHtml(html);
        } else {
          await bm.closeExtraTabs();

          // Scroll for lazy loading
          await Promise.race([
            bm.page.evaluate(async () => {
              for (let i = 0; i < 30; i++) {
                window.scrollBy(0, window.innerHeight);
                await new Promise(r => setTimeout(r, 120));
              }
              window.scrollTo(0, 0);
            }),
            new Promise(r => setTimeout(r, 8000)),
          ]).catch(() => {});
          await sleep(1000);

          await bm.page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {});

          // DOM extraction with content area filtering (Phase 0 fix)
          const contentSelectors = adapter.getContentSelectors();
          const excludeSelectors = adapter.getExcludeSelectors();

          pageImages = await Promise.race([
            bm.page.evaluate((exPatterns, mw, mh, contentSels, excludeSels) => {
              const origin = location.origin;
              const resolve = (u) => {
                if (!u) return '';
                if (u.startsWith('http')) return u;
                try { return new URL(u, origin).href; } catch { return ''; }
              };

              const isExcluded = (el) => {
                for (const sel of excludeSels) {
                  if (el.closest(sel)) return true;
                }
                return false;
              };

              const extractFromEl = (root) => {
                const images = new Set();
                root.querySelectorAll('img').forEach(img => {
                  if (isExcluded(img)) return;
                  const lazySrc = resolve(img.dataset.lazySrc || img.dataset.src || img.dataset.original || '');
                  const currentSrc = img.currentSrc || img.src || '';
                  const src = lazySrc || currentSrc;
                  if (!src || !src.startsWith('http')) return;
                  const lower = src.toLowerCase();
                  if (exPatterns.some(p => lower.includes(p))) return;
                  if (/-\d+x\d+\.\w+$/.test(src)) return;
                  const isLazy = !!lazySrc || img.loading === 'lazy' || img.classList.contains('lazyload');
                  const w = img.naturalWidth || img.width || 0;
                  const h = img.naturalHeight || img.height || 0;
                  if (isLazy || w >= mw || h >= mh) images.add(src);
                });
                root.querySelectorAll('img[srcset]').forEach(img => {
                  if (isExcluded(img)) return;
                  const srcset = img.getAttribute('srcset') || '';
                  srcset.split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean).forEach(src => {
                    const resolved = resolve(src);
                    if (resolved && !/-\d+x\d+\.\w+$/.test(resolved)) images.add(resolved);
                  });
                });
                root.querySelectorAll('a[href]').forEach(a => {
                  if (isExcluded(a)) return;
                  const href = a.href;
                  if (!href || !href.startsWith('http')) return;
                  if (/\.(jpg|jpeg|png|webp|gif|bmp)(![a-z]+)?(\?|$)/i.test(href)) {
                    const lower = href.toLowerCase();
                    if (exPatterns.some(p => lower.includes(p))) return;
                    if (/-\d+x\d+\.\w+$/.test(href)) return;
                    images.add(href);
                  }
                });
                return images;
              };

              // Try content area selectors first
              let contentImages = new Set();
              for (const sel of contentSels) {
                const el = document.querySelector(sel);
                if (el) {
                  const imgs = extractFromEl(el);
                  imgs.forEach(i => contentImages.add(i));
                }
              }

              // If content area found enough images, use them
              if (contentImages.size >= 5) return [...contentImages];

              // Fallback: full page extraction (with exclude filtering)
              const fullImages = extractFromEl(document);
              return [...fullImages];
            }, EXCLUDE_PATTERNS, minWidth, minHeight, contentSelectors, excludeSelectors),
            new Promise(r => setTimeout(() => r([]), 10000)),
          ]).catch(() => []);

          if (pageImages.length === 0) {
            html = await bm.page.content().catch(() => '');
            pageImages = extractImagesFromHtml(html);
          }
        }
      }
      return 'done';
    })();

    try {
      const result = await Promise.race([pageWork, pageTimeout]);
      if (result === 'timeout') {
        bm._emit('status', { message: `페이지 타임아웃, 스킵: ${currentUrl.split('/').pop()}` });
        await bm.page.goto('about:blank', { timeout: 5000 }).catch(() => {});
        continue;
      }
    } catch (err) {
      if (!html) {
        try {
          await bm.page.setJavaScriptEnabled(false);
          await bm.page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          html = await bm.page.content().catch(() => '');
          pageImages = extractImagesFromHtml(html);
        } catch {}
      }
    }

    pageImages = pageImages.map(url => normalizeImageUrl(url));
    pageImages.forEach(url => allImages.add(url));

    // Cache CDP response bodies
    if (bm.cdp && pageImages.length > 0) {
      const cacheStart = Date.now();
      for (const imgUrl of pageImages) {
        if (Date.now() - cacheStart > 10000) break;
        if (bm.imageCache.has(imgUrl)) continue;
        const info = bm.capturedImages.get(imgUrl);
        if (!info || info.status !== 200) continue;
        try {
          const { body, base64Encoded } = await bm.cdp.send('Network.getResponseBody', { requestId: info.requestId });
          const buffer = base64Encoded ? Buffer.from(body, 'base64') : Buffer.from(body);
          if (buffer.length > 0) bm.imageCache.set(imgUrl, buffer);
        } catch {}
      }
    }

    // Discover post-internal pagination
    if (visitedPages.size === 1) {
      if (!html) html = await bm.page.content().catch(() => '');
      const baseHtml = postUrl.replace(/\/\d+$/, '');
      const escaped = baseHtml.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pageNums = [];

      html.replace(new RegExp(`href=["']${escaped}/(\\d+)["']`, 'g'), (_, num) => {
        pageNums.push({ num: parseInt(num), url: `${baseHtml}/${num}` });
      });

      if (postUrl.endsWith('.html')) {
        const htmlBase = postUrl.replace(/\.html$/, '');
        const htmlEscaped = htmlBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        html.replace(new RegExp(`href=["']${htmlEscaped}_(\\d+)\\.html["']`, 'g'), (_, num) => {
          pageNums.push({ num: parseInt(num), url: `${htmlBase}_${num}.html` });
        });
      }

      const seenNums = new Set();
      pageNums.sort((a, b) => a.num - b.num).forEach(({ num, url: nextUrl }) => {
        if (!seenNums.has(num) && !visitedPages.has(nextUrl)) {
          seenNums.add(num);
          pagesToVisit.push(nextUrl);
        }
      });
    }
  }
  return [...allImages];
}

function extractImagesFromHtml(html) {
  const images = new Set();
  for (const m of html.matchAll(/<img[^>]*>/gi)) {
    const tag = m[0];
    const urls = [];
    for (const attr of ['data-lazy-src', 'data-src', 'data-original', 'src']) {
      const attrMatch = tag.match(new RegExp(`${attr}=["']([^"']+)["']`, 'i'));
      if (attrMatch && attrMatch[1].startsWith('http')) urls.push(attrMatch[1]);
    }
    const srcsetMatch = tag.match(/srcset=["']([^"']+)["']/i);
    if (srcsetMatch) {
      srcsetMatch[1].split(',').map(s => s.trim().split(/\s+/)[0]).filter(s => s.startsWith('http')).forEach(s => urls.push(s));
    }
    for (const src of urls) {
      if (EXCLUDE_PATTERNS.some(p => src.toLowerCase().includes(p))) continue;
      if (/-\d+x\d+\.\w+$/.test(src)) continue;
      images.add(src);
    }
  }
  for (const m of html.matchAll(/href=["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp|gif|bmp)(?:\?[^"']*)?)["']/gi)) {
    const src = m[1];
    if (EXCLUDE_PATTERNS.some(p => src.toLowerCase().includes(p))) continue;
    if (/-\d+x\d+\.\w+$/.test(src)) continue;
    images.add(src);
  }
  return [...images];
}

module.exports = { getPostImages, extractImagesFromHtml };
