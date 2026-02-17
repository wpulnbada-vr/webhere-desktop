const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { sleep } = require('./utils');

function downloadImage(url, filepath, referer) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const proto = urlObj.protocol === 'https:' ? https : http;
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers: {
        'Referer': referer || urlObj.origin,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      },
      timeout: 15000,
    };

    const req = proto.get(options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const loc = res.headers.location;
        if (loc) {
          const fullUrl = loc.startsWith('http') ? loc : new URL(loc, url).href;
          downloadImage(fullUrl, filepath, referer).then(resolve).catch(reject);
        } else {
          reject(new Error('Redirect without location'));
        }
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const file = fs.createWriteStream(filepath);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', (err) => { fs.unlink(filepath, () => {}); reject(err); });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function getExtension(imgUrl) {
  try {
    const urlObj = new URL(imgUrl);
    let ext = path.extname(urlObj.pathname).split('?')[0];
    if (ext.length > 6 || !ext.match(/^\.\w+$/)) ext = '.jpg';
    return ext;
  } catch {
    return '.jpg';
  }
}

async function preloadImages(page, urls, cdp, capturedImages) {
  const uncaptured = urls.filter(u => !capturedImages.has(u));
  if (uncaptured.length === 0) return;

  for (let b = 0; b < uncaptured.length; b += 10) {
    const batch = uncaptured.slice(b, b + 10);
    await Promise.race([
      page.evaluate(async (urls) => {
        const promises = urls.map(url => new Promise(resolve => {
          const img = new Image();
          img.onload = () => resolve();
          img.onerror = () => resolve();
          setTimeout(resolve, 8000);
          img.src = url;
        }));
        await Promise.all(promises);
      }, batch),
      new Promise(r => setTimeout(r, 10000)),
    ]).catch(() => {});
  }
  await sleep(500);
}

module.exports = { downloadImage, getExtension, preloadImages };
