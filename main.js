const { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');

// ── Paths ──────────────────────────────────────────────────────────────────────
const isPackaged = app.isPackaged;
const appRoot = isPackaged ? path.dirname(app.getPath('exe')) : __dirname;
const userDataDir = app.getPath('userData'); // %APPDATA%/WebImageHere (Win) or ~/.config/WebImageHere (Linux)
const documentsDir = app.getPath('documents');

const DOWNLOADS_DIR = path.join(documentsDir, 'WebImageHere Downloads');
const HISTORY_FILE = path.join(userDataDir, 'history.json');
const CHROME_CACHE_DIR = path.join(userDataDir, 'chrome');

// Ensure directories
for (const dir of [DOWNLOADS_DIR, userDataDir, CHROME_CACHE_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── CLI: --clear-data flag ─────────────────────────────────────────────────────
if (process.argv.includes('--clear-data')) {
  const deleteAll = process.argv.includes('--include-downloads');
  const removed = [];
  if (fs.existsSync(path.join(userDataDir, 'history.json'))) {
    fs.unlinkSync(path.join(userDataDir, 'history.json'));
    removed.push('history.json');
  }
  const chromeDir = path.join(userDataDir, 'chrome');
  if (fs.existsSync(chromeDir)) {
    fs.rmSync(chromeDir, { recursive: true, force: true });
    removed.push('chrome/');
  }
  if (deleteAll) {
    const dlDir = path.join(documentsDir, 'WebImageHere Downloads');
    if (fs.existsSync(dlDir)) {
      fs.rmSync(dlDir, { recursive: true, force: true });
      removed.push('WebImageHere Downloads/');
    }
  }
  console.log(removed.length > 0 ? `Removed: ${removed.join(', ')}` : 'Nothing to clean up.');
  process.exit(0);
}

// ── Single Instance Lock ───────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── Globals ────────────────────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;
let expressServer = null;
let serverPort = null;

// ── Port finder ────────────────────────────────────────────────────────────────
function findAvailablePort(startPort = 3000) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(startPort, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', () => {
      if (startPort < 3100) {
        resolve(findAvailablePort(startPort + 1));
      } else {
        reject(new Error('No available port found (3000-3099)'));
      }
    });
  });
}

// ── Chrome download ────────────────────────────────────────────────────────────
async function ensureChrome() {
  const { findChrome } = require('./server/scraper');
  const existing = findChrome(CHROME_CACHE_DIR);
  if (existing) {
    console.log(`[Chrome] Found: ${existing}`);
    return existing;
  }

  console.log('[Chrome] Not found, downloading Chrome for Testing...');
  if (mainWindow) {
    mainWindow.webContents.executeJavaScript(
      `document.title = 'Chrome 다운로드 중... (최초 1회)'`
    ).catch(() => {});
  }

  try {
    const { install, Browser, detectBrowserPlatform, resolveBuildId } = require('@puppeteer/browsers');
    const platform = detectBrowserPlatform();
    const buildId = await resolveBuildId(Browser.CHROME, platform, 'stable');

    const result = await install({
      browser: Browser.CHROME,
      buildId,
      cacheDir: CHROME_CACHE_DIR,
      downloadProgressCallback: (downloadedBytes, totalBytes) => {
        if (mainWindow && totalBytes > 0) {
          const pct = Math.round((downloadedBytes / totalBytes) * 100);
          mainWindow.setProgressBar(pct / 100);
          mainWindow.webContents.executeJavaScript(
            `document.title = 'Chrome 다운로드 중... ${pct}%'`
          ).catch(() => {});
        }
      },
    });

    if (mainWindow) {
      mainWindow.setProgressBar(-1); // remove progress
      mainWindow.webContents.executeJavaScript(
        `document.title = 'WebImageHere'`
      ).catch(() => {});
    }

    console.log(`[Chrome] Downloaded: ${result.executablePath}`);
    return result.executablePath;
  } catch (err) {
    console.error('[Chrome] Download failed:', err.message);
    // Fallback: try system Chrome
    const fallback = findChrome();
    if (fallback) {
      console.log(`[Chrome] Fallback to system Chrome: ${fallback}`);
      return fallback;
    }
    throw new Error('Chrome을 찾을 수 없습니다. Chrome 브라우저를 설치해주세요.');
  }
}

// ── Create window ──────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Minimize to tray instead of closing
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ── Tray ───────────────────────────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, 'build', 'icon.png');
  let trayIcon;
  if (fs.existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } else {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('WebImageHere');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '열기',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: '다운로드 폴더',
      click: () => {
        shell.openPath(DOWNLOADS_DIR);
      },
    },
    { type: 'separator' },
    {
      label: '데이터 초기화',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
        showResetDialog();
      },
    },
    { type: 'separator' },
    {
      label: '종료',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── Data cleanup ────────────────────────────────────────────────────────────────
async function clearAppData(options = {}) {
  const { deleteDownloads = false, deleteChrome = true, deleteHistory = true } = options;
  const removed = [];

  if (deleteHistory && fs.existsSync(HISTORY_FILE)) {
    fs.unlinkSync(HISTORY_FILE);
    removed.push('Job history');
  }

  if (deleteChrome && fs.existsSync(CHROME_CACHE_DIR)) {
    fs.rmSync(CHROME_CACHE_DIR, { recursive: true, force: true });
    removed.push('Chromium runtime (~130 MB)');
  }

  if (deleteDownloads && fs.existsSync(DOWNLOADS_DIR)) {
    fs.rmSync(DOWNLOADS_DIR, { recursive: true, force: true });
    removed.push('Downloaded images');
  }

  return removed;
}

async function showResetDialog() {
  const { response, checkboxChecked } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Cancel', 'Reset'],
    defaultId: 0,
    cancelId: 0,
    title: 'Reset App Data',
    message: 'Delete app data and reset to initial state?',
    detail: 'This will remove:\n- Job history\n- Cached Chromium browser (~130 MB)\n\nDownloaded images will NOT be deleted unless checked below.',
    checkboxLabel: 'Also delete all downloaded images',
    checkboxChecked: false,
  });

  if (response === 1) {
    const removed = await clearAppData({
      deleteDownloads: checkboxChecked,
      deleteChrome: true,
      deleteHistory: true,
    });
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Reset Complete',
      message: `Deleted: ${removed.join(', ')}`,
      detail: 'Restart the app to apply changes.',
    });
  }
}

// ── IPC handlers ────────────────────────────────────────────────────────────────
function setupIPC() {
  ipcMain.handle('open-downloads', () => {
    shell.openPath(DOWNLOADS_DIR);
  });

  ipcMain.handle('get-version', () => {
    return app.getVersion();
  });

  ipcMain.handle('get-downloads-dir', () => {
    return DOWNLOADS_DIR;
  });
}

// ── App lifecycle ──────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  setupIPC();
  createWindow();
  createTray();

  try {
    // Find available port
    serverPort = await findAvailablePort(3000);
    console.log(`[Server] Using port ${serverPort}`);

    // Ensure Chrome is available
    let chromePath;
    try {
      chromePath = await ensureChrome();
    } catch (err) {
      dialog.showErrorBox('Chrome 오류', err.message);
      app.isQuitting = true;
      app.quit();
      return;
    }

    // Start Express server
    const { startServer } = require('./server/server');
    const result = await startServer({
      port: serverPort,
      host: '127.0.0.1',
      downloadsDir: DOWNLOADS_DIR,
      historyFile: HISTORY_FILE,
      publicDir: path.join(__dirname, 'public'),
      chromePath,
    });
    expressServer = result.server;

    // Load UI
    mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
  } catch (err) {
    console.error('[Startup Error]', err);
    dialog.showErrorBox('시작 오류', err.message);
    app.isQuitting = true;
    app.quit();
  }
});

app.on('window-all-closed', () => {
  // On macOS, keep app running in background
  if (process.platform !== 'darwin') {
    app.isQuitting = true;
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
  }
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (expressServer) {
    expressServer.close();
  }
});
