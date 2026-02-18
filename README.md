<p align="center">
  <h1 align="center">WebHere Desktop</h1>
  <p align="center">
    A cross-platform desktop app for organizing and archiving publicly available images.
    <br />
    Just enter a URL — WebHere handles the rest.
  </p>
  <p align="center">
    <a href="../../releases"><img src="https://img.shields.io/github/v/release/wpulnbada-vr/webhere-desktop?style=flat-square" alt="Release" /></a>
    <img src="https://img.shields.io/badge/Electron-35-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron" />
    <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20Linux-0078D4?style=flat-square" alt="Platform" />
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License" /></a>
  </p>
</p>

---

## Disclaimer

This tool is intended for **personal archival** and **educational purposes only**. Users are solely responsible for ensuring their usage complies with:

- The **terms of service** of any website they access
- Applicable **copyright and intellectual property** laws
- **robots.txt** directives and site access policies

The developers assume no liability for misuse of this software. Do not use this tool to download copyrighted content without explicit permission from the content owner.

---

## Features

### Image Archiving
- **Batch Processing** — Enter a URL and an optional keyword to collect matching images
- **Smart Page Navigation** — Follows pagination, multi-page galleries, and linked sub-pages
- **Lazy-load Aware** — Scrolls pages to trigger lazy-loaded content and parses `data-src`, `srcset`, and other deferred attributes
- **CDP Capture** — Uses Chrome DevTools Protocol to capture original-quality images from network responses
- **Duplicate Filtering** — Skips thumbnails, icons, and already-downloaded files based on size and pattern matching
- **Concurrent Downloads** — Parallel download pipeline with configurable concurrency
- **Job Queue** — Run up to 2 jobs simultaneously with automatic queuing

### Monitoring & Management
- **System Monitoring** — Real-time CPU, memory, disk, browser status dashboard
- **Job Statistics** — Success rate chart, top sites/keywords, 30-day activity graph
- **Discord Alerts** — Webhook notifications for job completion, failure, and disk warnings
- **File Manager** — Browse, upload, download, delete files and folders from the dashboard
- **ZIP Export** — Download selected files or entire folders as a single .zip archive
- **Persistent History** — Browse and manage past jobs across sessions with bulk clear

### Web Drive
- **Grid / List View** — Toggle between image thumbnail grid and detailed file list
- **Search & Sort** — Find files by name, sort by name/size/date
- **Share Links** — Generate temporary share URLs (token-based, 24h expiry)
- **Copy & Move** — Copy or move files/folders between directories
- **Context Menu** — Right-click for quick actions (copy, move, delete, share)
- **Drag & Drop Upload** — Drop files directly into the browser to upload
- **Image Preview** — Click to view full-size images with zoom
- **OpenClaw Compatible** — Manage files remotely via [WebClaw](https://github.com/wpulnbada-vr/webclaw) and OpenClaw bot

### Security
- **Admin Authentication** — Password-protected dashboard (bcrypt hashed, JWT tokens)
- **API Keys** — Generate `wih_` prefixed keys for external service access (e.g., OpenClaw)
- **Path Traversal Protection** — All file operations validated against the downloads directory

## Download

### Windows

Download the latest installer from the [**Releases**](../../releases) page.

> On first launch, the app will download a lightweight Chromium runtime (~130 MB) for headless browsing.
> Progress is shown in the title bar. This only happens once.

### Linux

```bash
# AppImage
chmod +x WebHere-*.AppImage
./WebHere-*.AppImage
```

## Build from Source

```bash
git clone https://github.com/wpulnbada-vr/webhere-desktop.git
cd webhere-desktop
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

### First-time Setup

On first access, you'll be prompted to set an admin password. This protects the file manager and API key features.

### Tabs

| Tab | Description |
|-----|-------------|
| **Jobs** | Enter URLs, start archiving, view real-time progress and history |
| **Monitoring** | System metrics, job statistics, Discord alert config, API key management |
| **Files** | Browse downloads, upload/delete files, download as ZIP |

## How It Works

WebHere runs a local Express server inside the Electron process, paired with a headless Chromium instance powered by Puppeteer.

```
Electron Main Process
├── Express API Server (localhost only, auto-assigned port)
│   ├── Archiving Engine (Puppeteer + CDP)
│   ├── Auth Module (bcrypt + JWT + API Keys)
│   ├── File Manager (upload/download/delete/ZIP)
│   └── Monitor (metrics + Discord webhooks)
└── BrowserWindow (React UI)
```

**Image Discovery Pipeline:**

1. Navigate to the target URL with a full browser context
2. If a keyword is provided, search the site and collect matching page URLs
3. For each page, scroll to trigger lazy-loaded content
4. Extract image URLs from DOM elements (`img[src]`, `img[srcset]`, `a[href]`) and network traffic (CDP)
5. Filter by minimum dimensions and file size to skip thumbnails and icons
6. Download images in parallel batches, with automatic retry and fallback

**Key Design Decisions:**

- Chromium is not bundled — it's downloaded on first launch via `@puppeteer/browsers`, keeping the installer under 80 MB
- The Express server binds exclusively to `127.0.0.1` and is never exposed to the network
- Cross-platform Chrome detection (`CHROME_PATH` env > managed cache > system install)
- Single instance lock prevents multiple app windows from conflicting
- Auth config stored in user data directory (not app directory)

## Data Storage

| Item | Windows | Linux |
|------|---------|-------|
| Downloaded images | `Documents\WebHere Downloads\` | `~/Documents/WebHere Downloads/` |
| Job history | `%APPDATA%\WebHere\history.json` | `~/.config/WebHere/history.json` |
| Auth config | `%APPDATA%\WebHere\auth-config.json` | `~/.config/WebHere/auth-config.json` |
| Chromium runtime | `%APPDATA%\WebHere\chrome\` | `~/.config/WebHere/chrome/` |

## Uninstall

### Windows

1. Open **Settings > Apps > Installed Apps** (or **Control Panel > Programs**)
2. Find **WebHere** and click **Uninstall**

The uninstaller automatically removes:
- Application files and shortcuts
- App data (`%APPDATA%\WebHere\`) including Chromium cache and job history

> **Note:** Downloaded images in `Documents\WebHere Downloads\` are **not** deleted by the uninstaller. Delete this folder manually if no longer needed.

### Linux

```bash
# Remove the AppImage
rm WebHere-*.AppImage

# Remove app data and Chromium cache
rm -rf ~/.config/WebHere

# (Optional) Remove downloaded images
rm -rf ~/Documents/WebHere\ Downloads
```

### In-App Reset

Right-click the **system tray icon** and select **"Reset Data"** to delete history and cached Chromium without uninstalling the app. An optional checkbox lets you also delete all downloaded images.

### CLI Reset

```bash
# Remove history and Chromium cache (keep downloaded images)
WebHere --clear-data

# Remove everything including downloaded images
WebHere --clear-data --include-downloads
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Desktop framework | [Electron](https://www.electronjs.org/) 35 |
| Packaging | [electron-builder](https://www.electron.build/) |
| Backend | [Express](https://expressjs.com/) 4 |
| Browser automation | [Puppeteer](https://pptr.dev/) |
| Frontend | React 19 + [Vite](https://vite.dev/) + Tailwind CSS v4 |
| Authentication | bcryptjs + jsonwebtoken |
| File upload | multer |
| Archive | [Archiver](https://www.archiverjs.com/) |

## Project Structure

```
webhere-desktop/
├── main.js            # Electron main process
├── preload.js         # Context-isolated IPC bridge
├── server/
│   ├── server.js      # Express API (startServer function)
│   ├── scraper.js     # Puppeteer-based image archiver
│   ├── auth.js        # Authentication (password + JWT + API keys)
│   ├── filemanager.js # File management API
│   └── monitor.js     # System monitoring + Discord alerts
├── public/            # Production React build
└── build/
    └── icon.png       # App icon
```

## Contributing

Contributions are welcome! Please open an issue first to discuss what you'd like to change.

## License

[MIT](LICENSE)
