const express = require('express');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const serveIndex = require('serve-index');
const ImageScraper = require('./scraper');

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
  const history = loadHistory();
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
      closeClients(job);
      processQueue();
    } else if (event.type === 'error' && !job.events.some(e => e.type === 'complete')) {
      if (job.status !== 'completed') {
        job.status = 'failed';
        job.completedAt = new Date().toISOString();
        job.error = event.message;
        addToHistory(job);
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
 * @param {object} options
 * @param {number} options.port - Port to listen on
 * @param {string} options.host - Host to bind to (default: '0.0.0.0')
 * @param {string} options.downloadsDir - Directory for downloaded images
 * @param {string} options.historyFile - Path to history.json
 * @param {string} options.publicDir - Path to static frontend files
 * @param {string} [options.chromePath] - Chrome executable path
 * @returns {Promise<{app: express.Application, server: import('http').Server, port: number}>}
 */
function startServer(options = {}) {
  const {
    port = 3000,
    host = '0.0.0.0',
    downloadsDir = path.join(__dirname, '..', 'downloads'),
    historyFile = path.join(__dirname, '..', 'history.json'),
    publicDir = path.join(__dirname, '..', 'public'),
    chromePath,
  } = options;

  HISTORY_FILE = historyFile;
  DOWNLOADS_DIR = downloadsDir;

  // Ensure directories exist
  if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

  const app = express();
  app.use(express.json());
  app.use(express.static(publicDir));
  app.use('/downloads', express.static(downloadsDir), serveIndex(downloadsDir, { icons: true }));

  // POST /api/scrape
  app.post('/api/scrape', (req, res) => {
    const { url, keyword } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    for (const existing of jobs.values()) {
      if (existing.url === url && existing.keyword === (keyword || '') &&
          (existing.status === 'running' || existing.status === 'queued')) {
        return res.status(409).json({ error: 'duplicate', existingJobId: existing.id });
      }
    }

    const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const job = {
      id: jobId,
      url,
      keyword: keyword || '',
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      events: [],
      lastEvent: null,
      clients: [],
      scraper: null,
      result: null,
      error: null,
      _chromePath: chromePath,
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
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

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
        id: job.id,
        url: job.url,
        keyword: job.keyword,
        status: job.status,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
        result: job.result,
        error: job.error,
      });
    }
    res.json(list.reverse());
  });

  // POST /api/abort/:jobId
  app.post('/api/abort/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    if (job.scraper) {
      job.scraper.abort();
    }
    job.status = 'aborted';
    job.completedAt = new Date().toISOString();
    addToHistory(job);
    closeClients(job);
    res.json({ status: 'aborted' });
  });

  // DELETE /api/jobs/:jobId
  app.delete('/api/jobs/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    if (job.scraper) {
      job.scraper.abort();
    }
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

  // GET /api/history — Persistent history with live status from memory
  app.get('/api/history', (req, res) => {
    const history = loadHistory();
    const result = history.map(h => {
      const memJob = jobs.get(h.id);
      if (memJob) {
        return {
          id: memJob.id,
          url: memJob.url,
          keyword: memJob.keyword,
          status: memJob.status,
          createdAt: memJob.createdAt,
          completedAt: memJob.completedAt,
          result: memJob.result,
          error: memJob.error,
        };
      }
      return h;
    });
    res.json(result);
  });

  // GET /browse/:folder — Lightweight paginated image gallery
  app.get('/browse/:folder', (req, res) => {
    const folder = req.params.folder;
    const dir = path.join(downloadsDir, folder);
    if (!fs.existsSync(dir)) {
      return res.status(404).send('Folder not found');
    }

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

  // GET /api/files/:folder
  app.get('/api/files/:folder', (req, res) => {
    const folder = req.params.folder;
    const dir = path.join(downloadsDir, folder);
    if (!fs.existsSync(dir)) {
      return res.json([]);
    }
    const files = fs.readdirSync(dir)
      .filter(f => /\.(jpg|jpeg|png|webp|gif)$/i.test(f))
      .sort()
      .map(f => ({
        name: f,
        url: `/downloads/${encodeURIComponent(folder)}/${encodeURIComponent(f)}`,
      }));
    res.json(files);
  });

  // GET /api/zip/:folder
  app.get('/api/zip/:folder', (req, res) => {
    const folder = req.params.folder;
    const dir = path.join(downloadsDir, folder);
    if (!fs.existsSync(dir)) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    const files = fs.readdirSync(dir).filter(f => /\.(jpg|jpeg|png|webp|gif)$/i.test(f));
    if (files.length === 0) {
      return res.status(404).json({ error: 'No images in folder' });
    }

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

  return new Promise((resolve) => {
    const server = app.listen(port, host, () => {
      console.log(`[WebImageHere] http://localhost:${port}`);
      recoverOrphanedJobs(chromePath);
      resolve({ app, server, port });
    });
  });
}

function recoverOrphanedJobs(chromePath) {
  const history = loadHistory();
  const orphaned = history.filter(h => h.status === 'running' || h.status === 'queued');
  if (orphaned.length === 0) return;

  console.log(`[WebImageHere] Recovering ${orphaned.length} interrupted job(s)...`);
  for (const h of orphaned) {
    const job = {
      id: h.id,
      url: h.url,
      keyword: h.keyword || '',
      status: 'queued',
      createdAt: h.createdAt,
      startedAt: null,
      completedAt: null,
      events: [],
      lastEvent: null,
      clients: [],
      scraper: null,
      result: null,
      error: null,
      _chromePath: chromePath,
    };
    jobs.set(h.id, job);
    updateHistoryItem(h.id, { status: 'queued' });

    if (getRunningCount() < MAX_CONCURRENT) {
      runJob(job);
    } else {
      queue.push(h.id);
    }
    console.log(`[WebImageHere]   → Re-queued: "${h.keyword}" (${h.url})`);
  }
}

// Standalone mode: run directly with `node server/server.js`
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
