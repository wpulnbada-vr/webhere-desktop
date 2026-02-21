const express = require('express');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const { execFileSync } = require('child_process');
// serve-index removed for security
const ImageScraper = require('./scraper');
const Monitor = require('./monitor');
const Auth = require('./auth');
const FileManager = require('./filemanager');

// Kill orphaned Chrome processes from previous runs on startup
try {
  execFileSync('pkill', ['-f', 'puppeteer_dev_profile'], { stdio: 'ignore', timeout: 5000 });
  console.log('[WebHere-Desktop] Cleaned up orphaned Chrome processes');
} catch {}

// Job store (in-memory)
const jobs = new Map();
const MAX_CONCURRENT = 2;
const queue = [];

let HISTORY_FILE;
let DOWNLOADS_DIR;

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    }
  } catch {}
  return [];
}

function saveHistory(history) {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch {}
}

function addToHistory(job) {
  let history = loadHistory();
  const idx = history.findIndex(h => h.id === job.id);
  const entry = {
    id: job.id,
    url: job.url,
    keyword: job.keyword,
    status: job.status,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    result: job.result,
    error: job.error,
  };
  if (idx !== -1) {
    history[idx] = entry;
  } else {
    history.unshift(entry);
  }
  if (job.status === 'completed' && job.result?.total > 0) {
    history = history.filter(h =>
      h.id === job.id ||
      h.url !== job.url ||
      h.keyword !== job.keyword ||
      (h.result?.total || 0) > 0
    );
  }
  if (history.length > 200) history.length = 200;
  saveHistory(history);
}

function updateHistoryItem(jobId, updates) {
  const history = loadHistory();
  const idx = history.findIndex(h => h.id === jobId);
  if (idx !== -1) {
    Object.assign(history[idx], updates);
    saveHistory(history);
  }
}

function getRunningCount() {
  let count = 0;
  for (const job of jobs.values()) {
    if (job.status === 'running') count++;
  }
  return count;
}

function processQueue() {
  while (queue.length > 0 && getRunningCount() < MAX_CONCURRENT) {
    const jobId = queue.shift();
    const job = jobs.get(jobId);
    if (job && job.status === 'queued') {
      runJob(job);
    }
  }
}

function runJob(job) {
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  updateHistoryItem(job.id, { status: 'running', startedAt: job.startedAt });

  const scraper = new ImageScraper();
  job.scraper = scraper;

  scraper.on('progress', (event) => {
    job.lastEvent = event;
    job.events.push(event);

    for (const client of job.clients) {
      client.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    if (event.type === 'complete') {
      job.status = 'completed';
      job.completedAt = new Date().toISOString();
      job.result = { total: event.total, folder: event.folder, duration: event.duration };
      addToHistory(job);
      Monitor.onJobEvent('complete', job);
      closeClients(job);
      processQueue();
    } else if (event.type === 'error' && !job.events.some(e => e.type === 'complete')) {
      if (job.status !== 'completed') {
        job.status = 'failed';
        job.completedAt = new Date().toISOString();
        job.error = event.message;
        addToHistory(job);
        Monitor.onJobEvent('fail', job);
        closeClients(job);
        processQueue();
      }
    }
  });

  scraper.scrape(job.url, job.keyword, {
    downloadDir: DOWNLOADS_DIR,
    chromePath: job._chromePath,
  }).catch((err) => {
    job.status = 'failed';
    job.error = err.message;
    closeClients(job);
    processQueue();
  });
}

function closeClients(job) {
  for (const client of job.clients) {
    try { client.end(); } catch {}
  }
  job.clients = [];
}

/**
 * Start the Express server.
 */
function startServer(options = {}) {
  const {
    port = 3000,
    host = '0.0.0.0',
    downloadsDir = path.join(__dirname, '..', 'downloads'),
    historyFile = path.join(__dirname, '..', 'history.json'),
    publicDir = path.join(__dirname, '..', 'public'),
    chromePath,
    configDir,
  } = options;

  HISTORY_FILE = historyFile;
  DOWNLOADS_DIR = downloadsDir;

  // Initialize modules with config directory
  const cfgDir = configDir || path.dirname(historyFile);
  Auth.init(cfgDir);
  Monitor.init(cfgDir, downloadsDir);

  const serverStartTime = new Date().toISOString();

  if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

  const app = express();
  app.use(express.json());
  app.use(express.static(publicDir));
  // /downloads — auth-protected static file serving
  app.use('/downloads', Auth.authMiddleware, express.static(downloadsDir));

  // POST /api/scrape
  app.post('/api/scrape', (req, res) => {
    const { url, keyword } = req.body;

    if (!url) return res.status(400).json({ error: 'URL is required' });
    try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

    for (const existing of jobs.values()) {
      if (existing.url === url && existing.keyword === (keyword || '') &&
          (existing.status === 'running' || existing.status === 'queued')) {
        return res.status(409).json({ error: 'duplicate', existingJobId: existing.id });
      }
    }

    const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const job = {
      id: jobId, url, keyword: keyword || '', status: 'queued',
      createdAt: new Date().toISOString(), startedAt: null, completedAt: null,
      events: [], lastEvent: null, clients: [], scraper: null,
      result: null, error: null, _chromePath: chromePath,
    };

    jobs.set(jobId, job);
    addToHistory(job);

    if (getRunningCount() < MAX_CONCURRENT) {
      runJob(job);
    } else {
      queue.push(jobId);
    }

    res.json({ jobId, status: job.status });
  });

  // GET /api/progress/:jobId — SSE stream
  app.get('/api/progress/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    for (const event of job.events) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    if (job.status === 'completed' || job.status === 'failed') {
      res.end();
      return;
    }

    job.clients.push(res);
    req.on('close', () => {
      job.clients = job.clients.filter(c => c !== res);
    });
  });

  // GET /api/jobs
  app.get('/api/jobs', (req, res) => {
    const list = [];
    for (const job of jobs.values()) {
      list.push({
        id: job.id, url: job.url, keyword: job.keyword, status: job.status,
        createdAt: job.createdAt, completedAt: job.completedAt,
        result: job.result, error: job.error,
      });
    }
    res.json(list.reverse());
  });

  // POST /api/abort/:jobId
  app.post('/api/abort/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.scraper) job.scraper.abort();
    job.status = 'aborted';
    job.completedAt = new Date().toISOString();
    addToHistory(job);
    closeClients(job);
    res.json({ status: 'aborted' });
  });

  // DELETE /api/jobs/:jobId
  app.delete('/api/jobs/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.scraper) job.scraper.abort();
    closeClients(job);
    const qIdx = queue.indexOf(req.params.jobId);
    if (qIdx !== -1) queue.splice(qIdx, 1);
    jobs.delete(req.params.jobId);
    const history = loadHistory();
    const filtered = history.filter(h => h.id !== req.params.jobId);
    if (filtered.length !== history.length) saveHistory(filtered);
    processQueue();
    res.json({ status: 'deleted' });
  });

  // DELETE /api/history — Clear all history
  app.delete('/api/history', (req, res) => {
    saveHistory([]);
    res.json({ ok: true });
  });

  // GET /api/history
  app.get('/api/history', (req, res) => {
    const history = loadHistory();
    const result = history.map(h => {
      const memJob = jobs.get(h.id);
      if (memJob) {
        return {
          id: memJob.id, url: memJob.url, keyword: memJob.keyword, status: memJob.status,
          createdAt: memJob.createdAt, completedAt: memJob.completedAt,
          result: memJob.result, error: memJob.error,
        };
      }
      return h;
    });
    res.json(result);
  });

  // GET /browse/:folder — auth-protected
  app.get('/browse/:folder', Auth.authMiddleware, (req, res) => {
    const folder = req.params.folder;
    const dir = path.join(downloadsDir, folder);
    if (!fs.existsSync(dir)) return res.status(404).send('Folder not found');

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const perPage = 200;
    const allFiles = fs.readdirSync(dir)
      .filter(f => /\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(f))
      .sort();
    const totalFiles = allFiles.length;
    const totalPages = Math.ceil(totalFiles / perPage) || 1;
    const files = allFiles.slice((page - 1) * perPage, page * perPage);

    let paginationHtml = '';
    if (totalPages > 1) {
      const links = [];
      if (page > 1) links.push(`<a href="?page=${page - 1}">&laquo; Prev</a>`);
      const start = Math.max(1, page - 3);
      const end = Math.min(totalPages, page + 3);
      if (start > 1) links.push(`<a href="?page=1">1</a>`);
      if (start > 2) links.push('<span>...</span>');
      for (let i = start; i <= end; i++) {
        links.push(i === page ? `<span class="current">${i}</span>` : `<a href="?page=${i}">${i}</a>`);
      }
      if (end < totalPages - 1) links.push('<span>...</span>');
      if (end < totalPages) links.push(`<a href="?page=${totalPages}">${totalPages}</a>`);
      if (page < totalPages) links.push(`<a href="?page=${page + 1}">Next &raquo;</a>`);
      paginationHtml = `<div class="pagination">${links.join(' ')}</div>`;
    }

    const imagesHtml = files.map(f => {
      const url = `/downloads/${encodeURIComponent(folder)}/${encodeURIComponent(f)}`;
      return `<div class="img-card"><a href="${url}" target="_blank"><img loading="lazy" src="${url}" alt="${f}"></a><div class="name">${f}</div></div>`;
    }).join('\n');

    res.send(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${folder} (${totalFiles} images)</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#1a1a2e;color:#e0e0e0;font-family:system-ui,sans-serif;padding:16px}
h1{font-size:1.2rem;margin-bottom:4px;color:#fff}
.info{font-size:.85rem;color:#888;margin-bottom:12px}
.info a{color:#64b5f6;text-decoration:none}
.info a:hover{text-decoration:underline}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px}
.img-card{background:#16213e;border-radius:6px;overflow:hidden;transition:transform .15s}
.img-card:hover{transform:scale(1.02)}
.img-card img{width:100%;aspect-ratio:1;object-fit:cover;display:block}
.img-card .name{padding:4px 6px;font-size:.7rem;color:#999;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pagination{text-align:center;padding:16px 0;display:flex;gap:6px;justify-content:center;flex-wrap:wrap}
.pagination a,.pagination span{padding:6px 12px;border-radius:4px;text-decoration:none;font-size:.85rem}
.pagination a{background:#16213e;color:#64b5f6}
.pagination a:hover{background:#1a3a5c}
.pagination .current{background:#64b5f6;color:#fff;font-weight:bold}
</style></head><body>
<h1>${folder}</h1>
<div class="info">${totalFiles} images &middot; Page ${page}/${totalPages} &middot; <a href="/api/zip/${encodeURIComponent(folder)}" download="${folder}.zip">Download ZIP</a> &middot; <a href="/downloads/${encodeURIComponent(folder)}/">Raw file list</a></div>
${paginationHtml}
<div class="grid">${imagesHtml}</div>
${paginationHtml}
</body></html>`);
  });

  // GET /api/folder-files/:folder — List downloaded files (for ImageGrid)
  app.get('/api/folder-files/:folder', (req, res) => {
    const folder = req.params.folder;
    const dir = path.join(downloadsDir, folder);
    if (!fs.existsSync(dir)) return res.json([]);
    const files = fs.readdirSync(dir)
      .filter(f => /\.(jpg|jpeg|png|webp|gif)$/i.test(f))
      .sort()
      .map(f => ({
        name: f,
        url: `/downloads/${encodeURIComponent(folder)}/${encodeURIComponent(f)}`,
      }));
    res.json(files);
  });

  // --- Auth API ---
  app.get('/api/auth/status', (req, res) => {
    const setupComplete = Auth.isSetupComplete();
    const apiKey = req.headers['x-api-key'];
    const authHeader = req.headers.authorization;
    let authenticated = false;
    if (apiKey && Auth.verifyApiKey(apiKey)) authenticated = true;
    if (authHeader && authHeader.startsWith('Bearer ') && Auth.verifyToken(authHeader.slice(7))) authenticated = true;
    res.json({ setupComplete, authenticated });
  });

  app.post('/api/auth/setup', async (req, res) => {
    if (Auth.isSetupComplete()) return res.status(400).json({ error: 'Already configured' });
    const { password } = req.body;
    if (!password || password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    await Auth.createAdmin(password);
    const token = Auth.generateToken();
    res.json({ ok: true, token });
  });

  app.post('/api/auth/login', async (req, res) => {
    const { password } = req.body;
    const valid = await Auth.verifyPassword(password);
    if (!valid) return res.status(401).json({ error: 'Invalid password' });
    const token = Auth.generateToken();
    res.json({ ok: true, token });
  });

  app.post('/api/auth/api-keys', Auth.authMiddleware, (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const entry = Auth.generateApiKey(name);
    res.json(entry);
  });

  app.get('/api/auth/api-keys', Auth.authMiddleware, (req, res) => {
    res.json(Auth.listApiKeys());
  });

  app.delete('/api/auth/api-keys/:id', Auth.authMiddleware, (req, res) => {
    const ok = Auth.deleteApiKey(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Key not found' });
    res.json({ ok: true });
  });

  // --- Share (public, no auth) ---
  app.get('/api/share/:token', (req, res) => {
    const link = Auth.verifyShareToken(req.params.token);
    if (!link) return res.status(404).json({ error: 'Link expired or not found' });

    const filePath = path.join(downloadsDir, link.filePath.replace(/^\/+/, ''));
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(downloadsDir)) return res.status(400).json({ error: 'Invalid path' });
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File not found' });

    res.download(resolved);
  });

  // --- File Manager API ---
  app.use('/api/files', FileManager.createRouter(Auth.authMiddleware, downloadsDir));

  // --- Monitor API ---
  app.get('/api/monitor/system', (req, res) => {
    res.json(Monitor.collectSystemMetrics(jobs, queue, serverStartTime));
  });

  app.get('/api/monitor/stats', (req, res) => {
    const history = loadHistory();
    res.json(Monitor.aggregateStats(history));
  });

  app.get('/api/monitor/realtime', (req, res) => {
    const history = loadHistory();
    res.json(Monitor.getRealtimeStatus(jobs, queue, history));
  });

  app.get('/api/monitor/config', (req, res) => {
    const config = Monitor.loadConfig();
    const masked = { ...config.discord };
    if (masked.webhookUrl) {
      masked.webhookUrl = masked.webhookUrl.slice(0, 20) + '...' + masked.webhookUrl.slice(-10);
    }
    res.json(masked);
  });

  app.post('/api/monitor/config', Auth.authMiddleware, (req, res) => {
    try {
      const config = Monitor.loadConfig();
      const { webhookUrl, enabled, notifyOnComplete, notifyOnFail, notifyOnDiskWarning, diskWarningThresholdMB } = req.body;
      if (webhookUrl !== undefined) config.discord.webhookUrl = webhookUrl;
      if (enabled !== undefined) config.discord.enabled = enabled;
      if (notifyOnComplete !== undefined) config.discord.notifyOnComplete = notifyOnComplete;
      if (notifyOnFail !== undefined) config.discord.notifyOnFail = notifyOnFail;
      if (notifyOnDiskWarning !== undefined) config.discord.notifyOnDiskWarning = notifyOnDiskWarning;
      if (diskWarningThresholdMB !== undefined) config.discord.diskWarningThresholdMB = diskWarningThresholdMB;
      Monitor.saveConfig(config);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/monitor/test-alert', Auth.authMiddleware, async (req, res) => {
    const config = Monitor.loadConfig();
    if (!config.discord.webhookUrl) return res.status(400).json({ error: 'No webhook URL configured' });
    const ok = await Monitor.sendDiscordAlert(config, 'test', {});
    res.json({ ok: !!ok });
  });

  // GET /api/zip/:folder
  app.get('/api/zip/:folder', (req, res) => {
    const folder = req.params.folder;
    const dir = path.join(downloadsDir, folder);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Folder not found' });

    const files = fs.readdirSync(dir).filter(f => /\.(jpg|jpeg|png|webp|gif)$/i.test(f));
    if (files.length === 0) return res.status(404).json({ error: 'No images in folder' });

    res.setHeader('Content-Type', 'application/zip');
    const safeFilename = encodeURIComponent(folder) + '.zip';
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${safeFilename}; filename="${safeFilename}"`);

    const archive = archiver('zip', { zlib: { level: 1 } });
    archive.pipe(res);
    for (const file of files) {
      archive.file(path.join(dir, file), { name: file });
    }
    archive.finalize();
  });

  // Graceful shutdown: clean up all running browsers before exit
  async function gracefulShutdown(signal) {
    console.log(`[WebHere-Desktop] ${signal} received, shutting down...`);
    const cleanups = [];
    for (const [id, job] of jobs) {
      if (job.status === 'running' && job.scraper) {
        job.scraper.abort();
        if (job.scraper._bm) cleanups.push(job.scraper._bm.cleanup());
      }
    }
    if (cleanups.length > 0) {
      await Promise.allSettled(cleanups);
      console.log(`[WebHere-Desktop] Cleaned up ${cleanups.length} browser(s)`);
    }
    process.exit(0);
  }
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  return new Promise((resolve) => {
    const server = app.listen(port, host, () => {
      console.log(`[WebHere] http://localhost:${port}`);
      recoverOrphanedJobs(chromePath);
      resolve({ app, server, port });
    });
  });
}

function recoverOrphanedJobs(chromePath) {
  const history = loadHistory();
  const orphaned = history.filter(h => h.status === 'running' || h.status === 'queued');
  if (orphaned.length === 0) return;

  console.log(`[WebHere] Recovering ${orphaned.length} interrupted job(s)...`);
  for (const h of orphaned) {
    const job = {
      id: h.id, url: h.url, keyword: h.keyword || '', status: 'queued',
      createdAt: h.createdAt, startedAt: null, completedAt: null,
      events: [], lastEvent: null, clients: [], scraper: null,
      result: null, error: null, _chromePath: chromePath,
    };
    jobs.set(h.id, job);
    updateHistoryItem(h.id, { status: 'queued' });

    if (getRunningCount() < MAX_CONCURRENT) {
      runJob(job);
    } else {
      queue.push(h.id);
    }
    console.log(`[WebHere]   → Re-queued: "${h.keyword}" (${h.url})`);
  }
}

// Standalone mode
if (require.main === module) {
  startServer({
    port: parseInt(process.env.PORT) || 3000,
    host: '0.0.0.0',
    downloadsDir: path.join(__dirname, '..', 'downloads'),
    historyFile: path.join(__dirname, '..', 'history.json'),
    publicDir: path.join(__dirname, '..', 'public'),
  });
}

module.exports = { startServer };
