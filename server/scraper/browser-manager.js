const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { BLOCKED_SCRIPTS, IMAGE_EXTENSIONS } = require('./constants');
const { sleep } = require('./utils');

puppeteer.use(StealthPlugin());

class BrowserManager {
  constructor(emit) {
    this.browser = null;
    this.page = null;
    this.jsDisabledMode = false;
    this.cdp = null;
    this.capturedImages = new Map();
    this.imageCache = new Map();
    this.aborted = false;
    this._mirrorDomains = new Map();
    this._emit = emit || (() => {});
  }

  async launch(chromePath) {
    this._emit('status', { message: '브라우저 시작 중...' });
    this.browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-popup-blocking',
        '--disable-notifications',
      ],
      executablePath: chromePath,
    });

    this.browser.on('targetcreated', async (target) => {
      try {
        const p = await target.page();
        if (p) {
          const allPages = await this.browser.pages();
          if (allPages.length > 1 && p !== this.page) {
            await p.close();
          }
        }
      } catch {}
    });

    this.page = (await this.browser.pages())[0];
    await this.page.setViewport({ width: 1920, height: 1080 });

    this.cdp = await this.page.createCDPSession();
    await this.cdp.send('Network.enable');
    this.cdp.on('Network.responseReceived', (params) => {
      const url = params.response.url;
      if (IMAGE_EXTENSIONS.test(url) || /\.gif(\?|$)/i.test(url)) {
        this.capturedImages.set(url, { requestId: params.requestId, status: params.response.status });
      }
    });

    await this.page.setRequestInterception(true);
    this.page.on('request', (req) => {
      const reqUrl = req.url().toLowerCase();
      if (BLOCKED_SCRIPTS.some(s => reqUrl.includes(s))) {
        req.abort();
      } else {
        req.continue();
      }
    });
  }

  isCloudflarePage(title) {
    return title.includes('Just a moment') || title.includes('Checking') ||
           title.includes('잠시만') || title.includes('请稍候') ||
           title.includes('Einen Moment') || title.includes('Un instant');
  }

  async waitForCloudflare() {
    const maxWait = this._mirrorDomains.size > 0 ? 10 : 30;
    for (let i = 0; i < maxWait; i++) {
      const title = await this.page.title().catch(() => '');
      if (!this.isCloudflarePage(title)) {
        if (i > 0) this._emit('cf', { message: `Cloudflare 통과! (${i}초)` });
        return true;
      }
      this._emit('cf', { message: `Cloudflare 우회 중... (${i + 1}초)` });
      await sleep(1000);
    }
    return false;
  }

  async discoverMirrorDomains(url) {
    const currentHost = new URL(url).hostname;
    if (this._mirrorDomains.has(currentHost)) return;
    const baseName = currentHost.replace(/\.\w+$/, '');
    const mirrors = await this.page.evaluate((baseName, currentHost) => {
      const found = new Set();
      document.querySelectorAll('a[href]').forEach(a => {
        try {
          const h = new URL(a.href).hostname;
          if (h !== currentHost && h.startsWith(baseName + '.')) found.add(h);
        } catch {}
      });
      return [...found];
    }, baseName, currentHost).catch(() => []);
    if (mirrors.length > 0) {
      this._mirrorDomains.set(currentHost, mirrors);
      this._emit('status', { message: `미러 도메인 발견: ${mirrors.join(', ')}` });
    }
  }

  getMirrorUrl(url) {
    try {
      const parsed = new URL(url);
      const mirrors = this._mirrorDomains.get(parsed.hostname);
      if (!mirrors || mirrors.length === 0) return null;
      return mirrors.map(h => { const u = new URL(url); u.hostname = h; return u.href; });
    } catch { return null; }
  }

  async safeGoto(url) {
    if (this.jsDisabledMode) {
      await this.page.setJavaScriptEnabled(false);
    }
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await sleep(1000);

    if (!this.jsDisabledMode) {
      const currentUrl = this.page.url();
      if (currentUrl === 'about:blank' || !currentUrl.startsWith('http')) {
        this.jsDisabledMode = true;
        this._emit('status', { message: 'JS-free 모드 전환' });
        await this.page.setJavaScriptEnabled(false);
        await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await sleep(1000);
      }
    }

    const title = await this.page.title().catch(() => '');
    if (this.isCloudflarePage(title)) {
      const passed = await this.waitForCloudflare();
      if (!passed) {
        const mirrorUrls = this.getMirrorUrl(url);
        if (mirrorUrls) {
          for (const mirrorUrl of mirrorUrls) {
            this._emit('cf', { message: `CF 우회: ${new URL(mirrorUrl).hostname} 시도...` });
            try {
              await this.page.goto(mirrorUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
              await sleep(1000);
              const t = await this.page.title().catch(() => '');
              if (!this.isCloudflarePage(t)) {
                this._emit('cf', { message: `미러 도메인 접속 성공!` });
                return;
              }
            } catch {}
          }
        }
      }
    }
  }

  async getPageHtml() {
    if (!this.jsDisabledMode) {
      await this.closeExtraTabs();
      await this.page.evaluate(async () => {
        for (let i = 0; i < 40; i++) {
          window.scrollBy(0, window.innerHeight);
          await new Promise(r => setTimeout(r, 150));
        }
        window.scrollTo(0, 0);
      }).catch(() => {});
      await sleep(1000);
    }
    return await this.page.content().catch(() => '');
  }

  async closeExtraTabs() {
    const openPages = await this.browser.pages();
    for (const p of openPages) {
      if (p !== this.page) { try { await p.close(); } catch {} }
    }
  }

  async cleanup() {
    if (this.cdp) {
      try { await this.cdp.detach(); } catch {}
      this.cdp = null;
    }
    this.capturedImages.clear();
    this.imageCache.clear();
    if (this.browser) {
      try { await this.browser.close(); } catch {}
      this.browser = null;
      this.page = null;
    }
  }
}

module.exports = BrowserManager;
