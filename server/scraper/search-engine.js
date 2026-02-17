const { sleep } = require('./utils');

async function searchPosts(bm, adapter, url, keyword, maxPages) {
  const strategy = adapter.getSearchStrategy();
  const origin = new URL(url).origin;

  // 1. Try adapter's custom search URL first (e.g., /search/?keyword=)
  const customUrl = adapter.getCustomSearchUrl(origin, keyword);
  if (customUrl) {
    bm._emit('status', { message: '사이트 전용 검색 사용 중...' });
    const customResults = await customSearchPosts(bm, customUrl, origin, keyword, maxPages);
    if (customResults.length > 0) return customResults;
  }

  // 2. WordPress ?s= search
  if (strategy === 'auto' || strategy === 'wordpress') {
    const wpResults = await wpSearchPosts(bm, url, keyword, maxPages);
    if (wpResults.length > 0) {
      const kwLower = keyword.toLowerCase();
      const hasRelevant = wpResults.some(p => p.title.toLowerCase().includes(kwLower));
      if (hasRelevant) return wpResults;
    }
  }

  // 3. Form-based search
  if (strategy === 'auto') {
    bm._emit('status', { message: '사이트 내 검색폼으로 전환...' });
    const formResults = await formSearchPosts(bm, url, keyword, maxPages);
    if (formResults.length > 0) return formResults;
  }

  // 4. Category browsing fallback
  bm._emit('status', { message: '카테고리 브라우징으로 전환...' });
  return browseCategoryPosts(bm, url, keyword, maxPages);
}

async function customSearchPosts(bm, searchUrl, origin, keyword, maxPages) {
  const allPosts = [];
  const kwLower = keyword.toLowerCase();
  let pageNum = 1;
  let paginationStyle = null; // 'query_page', 'path_page', 'query_p'

  while (pageNum <= maxPages) {
    if (bm.aborted) break;

    let pageUrl;
    if (pageNum === 1) {
      pageUrl = searchUrl;
    } else if (paginationStyle === 'path_page') {
      pageUrl = searchUrl.replace(/\/$/, '') + `/page/${pageNum}`;
    } else if (paginationStyle === 'query_p') {
      const sep = searchUrl.includes('?') ? '&' : '?';
      pageUrl = `${searchUrl}${sep}p=${pageNum}`;
    } else {
      const sep = searchUrl.includes('?') ? '&' : '?';
      pageUrl = `${searchUrl}${sep}page=${pageNum}`;
    }

    bm._emit('status', { message: `검색 페이지 ${pageNum} 스캔 중...` });

    try {
      await bm.safeGoto(pageUrl);
      if (!bm.jsDisabledMode) {
        await bm.page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {});
      }
    } catch { break; }

    const html = await bm.getPageHtml();
    if (html.length < 500) break;

    // Detect pagination style on first page
    if (paginationStyle === null) {
      if (html.includes('/page/2')) paginationStyle = 'path_page';
      else if (html.includes('?p=2') || html.includes('&p=2')) paginationStyle = 'query_p';
      else paginationStyle = 'query_page';
    }

    let posts = extractPostsFromHtml(html, origin);
    if (posts.length < 5 && !bm.jsDisabledMode) {
      const domPosts = await extractPostsFromDOM(bm.page, origin);
      if (domPosts.length > posts.length) posts = domPosts;
    }

    if (posts.length === 0) break;

    // Filter by keyword (site may mix search results with latest posts)
    const matched = posts.filter(p => p.title.toLowerCase().includes(kwLower));
    if (matched.length > 0) {
      allPosts.push(...matched);
      bm._emit('status', { message: `페이지 ${pageNum}: ${matched.length}개 매칭` });
    }

    // Check pagination
    const hasNext = html.includes(`page=${pageNum + 1}`) || html.includes(`/page/${pageNum + 1}`) || html.includes(`p=${pageNum + 1}`);
    if (!hasNext) break;
    pageNum++;
  }

  return dedup(allPosts, pageNum);
}

async function wpSearchPosts(bm, baseUrl, keyword, maxPages) {
  const allPosts = [];
  let pageNum = 1;
  const origin = new URL(baseUrl).origin;
  let searchParams = null;

  while (pageNum <= maxPages) {
    if (bm.aborted) break;

    let searchUrl;
    if (pageNum === 1) {
      searchUrl = `${origin}/?s=${encodeURIComponent(keyword)}`;
    } else if (searchParams) {
      searchUrl = `${origin}/page/${pageNum}${searchParams}`;
    } else {
      searchUrl = `${origin}/page/${pageNum}/?s=${encodeURIComponent(keyword)}`;
    }

    bm._emit('status', { message: `검색 페이지 ${pageNum} 스캔 중...` });

    try {
      await bm.safeGoto(searchUrl);
      if (!bm.jsDisabledMode) {
        await bm.page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {});
      }
    } catch { break; }

    if (!searchParams && pageNum === 1) {
      const currentUrl = bm.page.url();
      try {
        const cu = new URL(currentUrl);
        if (cu.search && cu.search.includes('s=')) {
          searchParams = cu.search;
        }
      } catch {}
    }

    const html = await bm.getPageHtml();
    if (html.includes('Page not found') || html.includes('Nothing Found') || html.length < 500) break;

    let posts = extractPostsFromHtml(html, origin);

    if (posts.length < 5 && !bm.jsDisabledMode) {
      const domPosts = await extractPostsFromDOM(bm.page, origin);
      if (domPosts.length > posts.length) posts = domPosts;
    }

    if (posts.length === 0) break;
    allPosts.push(...posts);

    const hasNext = html.includes(`/page/${pageNum + 1}`) || html.includes(`page=${pageNum + 1}`);
    if (!hasNext) break;
    pageNum++;
  }

  return dedup(allPosts, pageNum);
}

async function formSearchPosts(bm, baseUrl, keyword, maxPages) {
  const origin = new URL(baseUrl).origin;
  try {
    await bm.safeGoto(baseUrl);
    if (!bm.jsDisabledMode) {
      await bm.page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {});
    }
  } catch { return []; }

  const searchParam = await bm.page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])')];
    const searchInput = inputs.find(el => {
      const ph = (el.placeholder || '').toLowerCase();
      const name = (el.name || '').toLowerCase();
      const id = (el.id || '').toLowerCase();
      return ph.includes('title') || ph.includes('search') || ph.includes('keyword') ||
             name.includes('search') || name.includes('title') || name.includes('keyword') || name.includes('query') || name === 'q' ||
             id.includes('search') || id.includes('title');
    });
    return searchInput ? (searchInput.name || null) : null;
  }).catch(() => null);

  if (!searchParam) return [];

  const searchUrl = new URL(baseUrl);
  searchUrl.searchParams.set(searchParam, keyword);
  bm._emit('status', { message: `검색: ${searchUrl.searchParams.toString().split('=')[0]}` });

  try {
    await bm.safeGoto(searchUrl.href);
    if (!bm.jsDisabledMode) {
      await bm.page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {});
    }
  } catch { return []; }

  const searchedUrl = bm.page.url();
  const html = await bm.getPageHtml();

  let posts = extractPostsFromHtml(html, origin);
  if (posts.length < 3 && !bm.jsDisabledMode) {
    const domPosts = await extractPostsFromDOM(bm.page, origin);
    if (domPosts.length > posts.length) posts = domPosts;
  }

  const allPosts = [...posts];

  if (posts.length > 0) {
    let pageNum = 2;
    while (pageNum <= maxPages && !bm.aborted) {
      const hasNext = html.includes(`?p=${pageNum}`) || html.includes(`&p=${pageNum}`) ||
                      html.includes(`/page/${pageNum}`) || html.includes(`page=${pageNum}`);
      if (!hasNext) break;

      let nextUrl;
      try {
        const su = new URL(searchedUrl);
        su.searchParams.set('p', pageNum);
        nextUrl = su.href;
      } catch { break; }

      bm._emit('status', { message: `검색 결과 페이지 ${pageNum} 스캔 중...` });
      try {
        await bm.safeGoto(nextUrl);
        if (!bm.jsDisabledMode) {
          await bm.page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {});
        }
      } catch { break; }

      const pageHtml = await bm.getPageHtml();
      let pagePosts = extractPostsFromHtml(pageHtml, origin);
      if (pagePosts.length < 3 && !bm.jsDisabledMode) {
        const domP = await extractPostsFromDOM(bm.page, origin);
        if (domP.length > pagePosts.length) pagePosts = domP;
      }
      if (pagePosts.length === 0) break;
      allPosts.push(...pagePosts);
      pageNum++;
    }
  }

  return dedup(allPosts, 1);
}

async function browseCategoryPosts(bm, baseUrl, keyword, maxPages) {
  const allPosts = [];
  let pageNum = 1;
  const origin = new URL(baseUrl).origin;
  const kwLower = keyword.toLowerCase();
  let paginationStyle = null;

  while (pageNum <= maxPages) {
    if (bm.aborted) break;

    let pageUrl;
    if (pageNum === 1) {
      pageUrl = baseUrl;
    } else if (paginationStyle === 'path') {
      const base = baseUrl.replace(/\/+$/, '');
      pageUrl = `${base}/page/${pageNum}`;
    } else if (paginationStyle === 'p_query') {
      pageUrl = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}p=${pageNum}`;
    } else {
      pageUrl = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}page=${pageNum}`;
    }

    bm._emit('status', { message: `페이지 ${pageNum} 스캔 중...` });

    try {
      await bm.safeGoto(pageUrl);
      if (!bm.jsDisabledMode) {
        await bm.page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {});
      }
    } catch { break; }

    const html = await bm.getPageHtml();
    if (html.length < 500) break;

    if (paginationStyle === null) {
      if (html.includes('/page/2')) paginationStyle = 'path';
      else if (html.includes('?p=2') || html.includes('&p=2')) paginationStyle = 'p_query';
      else paginationStyle = 'query';
    }

    let posts = extractPostsFromHtml(html, origin);

    if (posts.length < 5 && !bm.jsDisabledMode) {
      const domPosts = await extractPostsFromDOM(bm.page, origin);
      if (domPosts.length > posts.length) {
        posts = domPosts;
      }
    }

    const matched = posts.filter(p => p.title.toLowerCase().includes(kwLower));
    if (matched.length > 0) {
      allPosts.push(...matched);
      bm._emit('status', { message: `페이지 ${pageNum}: ${matched.length}개 매칭 (전체 ${posts.length}개 중)` });
    }

    const hasNext = html.includes(`page=${pageNum + 1}`) || html.includes(`/page/${pageNum + 1}`) || html.includes(`p=${pageNum + 1}`);
    if (!hasNext) break;
    if (posts.length === 0) break;
    pageNum++;
  }

  return dedup(allPosts, pageNum);
}

function extractPostsFromHtml(html, origin) {
  const resolveHref = (raw) => {
    if (raw.startsWith('http')) return raw;
    try { return new URL(raw, origin + '/').href; } catch { return origin + '/' + raw; }
  };
  const results = [];
  const seen = new Set();

  for (const m of html.matchAll(/<h[234][^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/gi)) {
    const href = resolveHref(m[1]);
    const title = m[2].trim();
    if (!href.startsWith(origin)) continue;
    if (href.includes('?s=') || href.includes('/page/') || href.includes('/search/')) continue;
    try { const p = new URL(href).pathname; if (p === '/tag' || p.startsWith('/tag/') || p.startsWith('/category/')) continue; } catch {}
    if (seen.has(href)) continue;
    seen.add(href);
    results.push({ url: href, title: title.substring(0, 200) });
  }

  if (results.length === 0) {
    for (const m of html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>[^]*?<h[234][^>]*>([^<]+)<\/h[234]>/gi)) {
      const href = resolveHref(m[1]);
      const title = m[2].trim();
      if (!href.startsWith(origin)) continue;
      if (href.includes('?s=') || href.includes('/page/') || href.includes('/search/')) continue;
      try { const p = new URL(href).pathname; if (p === '/tag' || p.startsWith('/tag/') || p.startsWith('/category/')) continue; } catch {}
      if (seen.has(href)) continue;
      seen.add(href);
      results.push({ url: href, title: title.substring(0, 200) });
    }
  }

  if (results.length === 0) {
    for (const m of html.matchAll(/<p[^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>([^<]+)<\/a>\s*<\/p>/gi)) {
      const href = resolveHref(m[1]);
      const title = m[2].trim();
      if (title.length < 3) continue;
      if (!href.startsWith(origin)) continue;
      if (href.includes('?s=') || href.includes('/page/') || href.includes('/search/')) continue;
      if (/\.(html|php)$/i.test(new URL(href).pathname)) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      results.push({ url: href, title: title.substring(0, 200) });
    }
  }

  if (results.length === 0) {
    for (const m of html.matchAll(/<a[^>]+href=["']([^"']+\.html)["'][^>]*>([^<]{5,})<\/a>/gi)) {
      const href = resolveHref(m[1]);
      const title = m[2].trim();
      if (!href.startsWith(origin)) continue;
      if (href.includes('/page/') || href.includes('/search/') || href.includes('?s=')) continue;
      if (/^\d+P?$/i.test(title)) continue;
      if (title.length < 5) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      results.push({ url: href, title: title.substring(0, 200) });
    }
  }

  return results;
}

async function extractPostsFromDOM(page, origin) {
  return page.evaluate((orig) => {
    const results = [];
    const seen = new Set();
    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.href;
      if (!href || !href.startsWith(orig)) return;
      if (href.includes('/page/') || href.includes('/search/') || href.includes('?s=') || href.includes('?post_type=')) return;
      const parsedUrl = new URL(href);
      const pathname = parsedUrl.pathname;
      if (pathname === '/tag' || pathname.startsWith('/tag/') || pathname.startsWith('/category/') || pathname.startsWith('/tags/')) return;
      if (/^\/[a-z][a-z0-9-]*\/?$/i.test(pathname) && !parsedUrl.search) return;
      if (pathname === '/' || pathname === '') return;
      const title = (a.textContent || '').trim();
      if (title.length < 5) return;
      if (/^\d+P?$/i.test(title)) return;
      if (href === orig || href === orig + '/') return;
      if (seen.has(href)) return;
      seen.add(href);
      results.push({ url: href, title: title.substring(0, 200) });
    });
    return results;
  }, origin).catch(() => []);
}

function dedup(posts, pageCount) {
  const seen = new Set();
  const result = posts.filter(p => {
    if (seen.has(p.url)) return false;
    seen.add(p.url);
    return true;
  });
  result._pageCount = pageCount;
  return result;
}

module.exports = { searchPosts, extractPostsFromHtml, extractPostsFromDOM };
