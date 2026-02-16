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
      resolve({ app, server, port });
    });
  });
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
