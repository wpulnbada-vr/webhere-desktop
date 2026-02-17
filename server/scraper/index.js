const { EventEmitter } = require('events');
const sanitize = require('sanitize-filename');
const fs = require('fs');
const path = require('path');

const { findChrome } = require('./chrome-finder');
const { sleep, extractAlbumName } = require('./utils');
const BrowserManager = require('./browser-manager');
const { searchPosts } = require('./search-engine');
const { getPostImages } = require('./image-extractor');
const { downloadImage, getExtension, preloadImages } = require('./downloader');
const registry = require('./adapter-registry');

class ImageScraper extends EventEmitter {
  constructor() {
    super();
    this.aborted = false;
    this._bm = null;
  }

  emit(type, data) {
    super.emit('progress', { type, ...data });
  }

  async scrape(url, keyword, options = {}) {
    const {
      minWidth = 400,
      minHeight = 400,
      minFileSize = 5000,
      concurrency = 3,
      maxPages = 50,
      downloadDir = path.join(__dirname, '..', 'downloads'),
      chromePath,
    } = options;

    const resolvedChromePath = chromePath || findChrome();
    const adapter = registry.resolve(url);

    const folderName = sanitize(keyword || 'unnamed').replace(/\s+/g, '_').toLowerCase();
    const saveDir = path.join(downloadDir, folderName);
    if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

    const startTime = Date.now();
    let totalDownloaded = 0;

    const bm = new BrowserManager((type, data) => this.emit(type, data));
    this._bm = bm;

    try {
      await bm.launch(resolvedChromePath);

      // Initial navigation + Cloudflare bypass
      this.emit('status', { message: `${url} 접속 중...` });
      await bm.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      const cfPassed = await bm.waitForCloudflare();
      if (!cfPassed) {
        this.emit('error', { message: 'Cloudflare 우회 실패 (30초 타임아웃)' });
        return { success: false, total: 0, folder: saveDir };
      }

      // Discover mirror domains for Cloudflare fallback
      await bm.discoverMirrorDomains(url);

      // Search for keyword
      let posts = [];
      if (keyword) {
        this.emit('status', { message: `"${keyword}" 검색 중...` });
        posts = await searchPosts(bm, adapter, url, keyword, maxPages);
        this.emit('search', { pages: posts._pageCount || 1, posts: posts.length });
      } else {
        posts = [{ url, title: 'Direct URL' }];
      }

      if (posts.length === 0) {
        this.emit('status', { message: '검색 결과가 없습니다.' });
        this.emit('complete', { total: 0, folder: folderName, duration: this._duration(startTime) });
        return { success: true, total: 0, folder: saveDir };
      }

      // Collect images from each post
      const allImageUrls = new Set();
      let existingCount = fs.readdirSync(saveDir).filter(f => /\.(jpg|jpeg|png|webp|gif)$/i.test(f)).length;
      let fileCounter = existingCount;

      for (let i = 0; i < posts.length; i++) {
        if (this.aborted) break;
        bm.aborted = this.aborted;
        const post = posts[i];
        this.emit('post', { current: i + 1, total: posts.length, title: post.title });

        const albumName = extractAlbumName(post.title, keyword);
        const imgs = await getPostImages(bm, adapter, post.url, minWidth, minHeight);
        const newImgs = imgs.filter(u => !allImageUrls.has(u));
        newImgs.forEach(u => allImageUrls.add(u));

        if (newImgs.length > 0) {
          this.emit('found', { count: newImgs.length, message: `${newImgs.length}개 이미지 발견` });
        }

        // Preload uncaptured images via browser (for CDN anti-hotlink bypass)
        if (newImgs.length > 0 && bm.cdp && !bm.jsDisabledMode) {
          await preloadImages(bm.page, newImgs, bm.cdp, bm.capturedImages);
        }

        // Download in batches
        for (let j = 0; j < newImgs.length; j += concurrency) {
          if (this.aborted) break;
          const batch = newImgs.slice(j, j + concurrency);
          const results = await Promise.all(batch.map(async (imgUrl) => {
            try {
              const ext = getExtension(imgUrl);
              fileCounter++;
              const prefix = albumName ? `${folderName}_${albumName}` : folderName;
              const filename = `${prefix}_${String(fileCounter).padStart(4, '0')}${ext}`;
              const filepath = path.join(saveDir, filename);

              let downloaded = false;
              // 1. Check pre-cached image data
              const cachedBuffer = bm.imageCache.get(imgUrl);
              if (cachedBuffer) {
                fs.writeFileSync(filepath, cachedBuffer);
                bm.imageCache.delete(imgUrl);
                downloaded = true;
              }
              // 2. Try live CDP response body
              if (!downloaded) {
                const captured = bm.capturedImages.get(imgUrl);
                if (captured && captured.status === 200 && bm.cdp) {
                  try {
                    const { body, base64Encoded } = await bm.cdp.send('Network.getResponseBody', { requestId: captured.requestId });
                    const buffer = base64Encoded ? Buffer.from(body, 'base64') : Buffer.from(body);
                    if (buffer.length > 0) {
                      fs.writeFileSync(filepath, buffer);
                      downloaded = true;
                    }
                  } catch {}
                }
              }
              // 3. Fallback: Node.js direct download
              if (!downloaded) {
                try {
                  await downloadImage(imgUrl, filepath, url);
                  downloaded = true;
                } catch {}
              }

              if (!downloaded) { fileCounter--; return false; }

              const stat = fs.statSync(filepath);
              if (stat.size < minFileSize) {
                fs.unlinkSync(filepath);
                fileCounter--;
                return false;
              }
              return true;
            } catch {
              fileCounter--;
              return false;
            }
          }));

          totalDownloaded += results.filter(Boolean).length;
          this.emit('download', {
            current: totalDownloaded,
            total: allImageUrls.size,
            filename: `${folderName}_${String(fileCounter).padStart(4, '0')}`,
          });
        }
      }

      const duration = this._duration(startTime);
      this.emit('complete', { total: totalDownloaded, folder: folderName, duration });
      return { success: true, total: totalDownloaded, folder: saveDir, duration };

    } catch (err) {
      this.emit('error', { message: err.message });
      return { success: false, total: totalDownloaded, error: err.message };
    } finally {
      await bm.cleanup();
    }
  }

  _duration(startTime) {
    const sec = Math.floor((Date.now() - startTime) / 1000);
    const min = Math.floor(sec / 60);
    const s = sec % 60;
    return min > 0 ? `${min}분 ${s}초` : `${s}초`;
  }

  abort() {
    this.aborted = true;
    if (this._bm) this._bm.aborted = true;
  }
}

module.exports = ImageScraper;
module.exports.findChrome = findChrome;
