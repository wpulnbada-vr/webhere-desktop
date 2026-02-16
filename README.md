<p align="center">
  <h1 align="center">WebImageHere</h1>
  <p align="center">
    A cross-platform desktop app for batch downloading images from the web.
    <br />
    Just enter a URL — WebImageHere handles the rest.
  </p>
  <p align="center">
    <a href="../../releases"><img src="https://img.shields.io/github/v/release/wpulnbada-vr/WebImageHere?style=flat-square" alt="Release" /></a>
    <img src="https://img.shields.io/badge/Electron-35-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron" />
    <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20Linux-0078D4?style=flat-square" alt="Platform" />
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License" /></a>
  </p>
</p>

---

## Features

- **Batch Image Download** — Enter a URL and an optional keyword to collect all matching images automatically
- **Smart Page Navigation** — Follows pagination, multi-page galleries, and linked sub-pages to find every image
- **Lazy-load Aware** — Scrolls pages to trigger lazy-loaded content and parses `data-src`, `srcset`, and other deferred attributes
- **High-fidelity Capture** — Uses Chrome DevTools Protocol to capture original image data directly from network responses, ensuring full-resolution downloads
- **Duplicate Filtering** — Skips thumbnails, icons, and already-downloaded files based on size and pattern matching
- **Concurrent Downloads** — Parallel download pipeline with configurable concurrency
- **ZIP Export** — Download an entire image folder as a single .zip archive
- **Job Queue** — Run up to 2 scraping jobs simultaneously with automatic queuing
- **Persistent History** — Browse and manage past downloads across sessions

## Download

### Windows

Download the latest installer from the [**Releases**](../../releases) page.

> On first launch, the app will download a lightweight Chromium runtime (~130 MB) for headless browsing.
> Progress is shown in the title bar. This only happens once.

### Linux

```bash
# AppImage
chmod +x WebImageHere-*.AppImage
./WebImageHere-*.AppImage
```

## Build from Source

```bash
git clone https://github.com/wpulnbada-vr/WebImageHere.git
cd WebImageHere
npm install

# Development
npm start

# Build installer
npm run build:win     # Windows (NSIS)
npm run build:linux   # Linux (AppImage)
```

Build output is written to `dist/`.

## Usage

1. Launch the app
2. Enter a target URL (e.g., a gallery or blog page)
3. Optionally enter a keyword to filter results
4. Click **Start** — progress is streamed in real time
5. View results in the built-in gallery or open the downloads folder

## How It Works

WebImageHere runs a local Express server inside the Electron process, paired with a headless Chromium instance powered by Puppeteer.

```
Electron Main Process
├── Express API Server (localhost only, auto-assigned port)
├── Puppeteer (headless Chromium)
└── BrowserWindow (React UI)
```

**Image Discovery Pipeline:**

1. Navigate to the target URL with a full browser context
2. If a keyword is provided, search the site and collect matching post URLs
3. For each page, scroll to trigger lazy-loaded content
4. Extract image URLs from DOM elements (`img[src]`, `img[srcset]`, `a[href]`) and network traffic (CDP)
5. Filter by minimum dimensions and file size to skip thumbnails and icons
6. Download images in parallel batches, with automatic retry and fallback

**Key Design Decisions:**

- Chromium is not bundled — it's downloaded on first launch via `@puppeteer/browsers`, keeping the installer under 80 MB
- The Express server binds exclusively to `127.0.0.1` and is never exposed to the network
- Cross-platform Chrome detection (`CHROME_PATH` env > managed cache > system install)
- Single instance lock prevents multiple app windows from conflicting

## Data Storage

| Item | Windows | Linux |
|------|---------|-------|
| Downloaded images | `Documents\WebImageHere Downloads\` | `~/Documents/WebImageHere Downloads/` |
| Job history | `%APPDATA%\WebImageHere\history.json` | `~/.config/WebImageHere/history.json` |
| Chromium runtime | `%APPDATA%\WebImageHere\chrome\` | `~/.config/WebImageHere/chrome/` |

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Desktop framework | [Electron](https://www.electronjs.org/) 35 |
| Packaging | [electron-builder](https://www.electron.build/) |
| Backend | [Express](https://expressjs.com/) 4 |
| Browser automation | [Puppeteer](https://pptr.dev/) |
| Frontend | React + [Vite](https://vite.dev/) |
| Archive | [Archiver](https://www.archiverjs.com/) |

## Project Structure

```
WebImageHere/
├── main.js            # Electron main process
├── preload.js         # Context-isolated IPC bridge
├── server/
│   ├── server.js      # Express API (startServer function)
│   └── scraper.js     # Puppeteer-based image collector
├── public/            # Production React build
└── build/
    └── icon.png       # App icon
```

## Contributing

Contributions are welcome! Please open an issue first to discuss what you'd like to change.

## License

[MIT](LICENSE)
