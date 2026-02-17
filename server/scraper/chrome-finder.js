const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Cross-platform Chrome/Chromium finder.
 * Priority: CHROME_PATH env -> @puppeteer/browsers cache -> system install
 * @param {string} [customCachePath] - Optional custom cache dir for @puppeteer/browsers
 */
function findChrome(customCachePath) {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const platform = process.platform;

  const cacheDirs = [];
  if (customCachePath) {
    cacheDirs.push(path.join(customCachePath, 'chrome'));
  }
  cacheDirs.push(path.join(os.homedir(), '.cache', 'puppeteer', 'chrome'));

  for (const cacheDir of cacheDirs) {
    if (!fs.existsSync(cacheDir)) continue;
    const versions = fs.readdirSync(cacheDir).sort().reverse();
    for (const ver of versions) {
      let bin;
      if (platform === 'win32') {
        bin = path.join(cacheDir, ver, 'chrome-win64', 'chrome.exe');
      } else if (platform === 'darwin') {
        bin = path.join(cacheDir, ver, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
        if (!fs.existsSync(bin)) {
          bin = path.join(cacheDir, ver, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
        }
      } else {
        bin = path.join(cacheDir, ver, 'chrome-linux64', 'chrome');
      }
      if (fs.existsSync(bin)) return bin;
    }
  }

  if (platform === 'win32') {
    const winPaths = [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Chromium', 'Application', 'chrome.exe'),
    ];
    for (const p of winPaths) {
      if (p && fs.existsSync(p)) return p;
    }
  } else if (platform === 'darwin') {
    const macPaths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    for (const p of macPaths) {
      if (fs.existsSync(p)) return p;
    }
  } else {
    const linuxPaths = [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/snap/bin/chromium',
    ];
    for (const p of linuxPaths) {
      if (fs.existsSync(p)) return p;
    }
  }

  return null;
}

module.exports = { findChrome };
