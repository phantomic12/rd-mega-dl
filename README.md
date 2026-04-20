# RD-Mega-DL

A self-contained Node.js app that downloads **Mega.nz shared folders** through [Real-Debrid](https://real-debrid.com/), preserving the original folder structure. Comes with a dark-mode WebUI — no build step, no framework, no bullshit.

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## Why?

Mega has aggressive bandwidth limits on free accounts. Real-Debrid can unrestrict Mega links and serve them from fast CDN servers. This tool automates the entire pipeline: parse folder → unrestrict every file → download them all while keeping the directory tree intact.

## Features

- **Folder tree reconstruction** — Mega folder structures are recreated locally, not dumped flat
- **WebUI dashboard** — Submit links, monitor progress, retry failures, view logs — all from the browser
- **SQLite database** — Every job is tracked with full state history; survives crashes and restarts
- **Smart retry logic** — Transient errors retry with backoff; permanent errors are flagged and skipped
- **Rate limit awareness** — Auto-pauses when hitting RD's 250 req/min limit
- **Random delays** — Configurable random wait between downloads to avoid hammering the API
- **Streaming downloads** — Files are streamed to disk with real-time progress tracking
- **Graceful shutdown** — `Ctrl+C` stops the worker cleanly, no partial corruption
- **Zero build step** — Vanilla HTML/CSS/JS frontend served by Fastify

## Quick Start

```bash
git clone <this-repo> rd-mega-dl
cd rd-mega-dl
npm install
```

Edit `config.json` and drop in your Real-Debrid API key (grab it from https://real-debrid.com/apitoken):

```json
{
  "rd_api_key": "YOUR_API_KEY_HERE"
}
```

Start it:

```bash
node index.js
```

Open **http://127.0.0.1:3000** in your browser. Click **+ Add Link**, paste a Mega folder URL, and watch it go.

## Configuration

Everything lives in **`config.json`**. Edit it directly — the worker hot-reloads it on every job cycle, no restart needed.

> **A note on environment variables:** This project doesn't use them. I fucking hate `.env` files and the 47 packages people install just to read them. Configuration is a JSON file. Open it, edit it, save it. If you want env var support, wire it up yourself — it's a free country.

| Key | Type | Default | Description |
|---|---|---|---|
| `rd_api_key` | `string` | `"XXX-123-XXX"` | Your Real-Debrid API token. **Required.** Get it at https://real-debrid.com/apitoken |
| `download_dir` | `string` | `"./downloads"` | Where files are saved. Supports relative and absolute paths. Created automatically if missing. |
| `min_wait_ms` | `number` | `5000` | Minimum random delay (ms) between finishing one download and starting the next. |
| `max_wait_ms` | `number` | `15000` | Maximum random delay (ms). The actual wait is random between `min` and `max`. |
| `server_port` | `number` | `3000` | Port the WebUI server listens on. |
| `max_retries` | `number` | `3` | How many times a failed job is retried before being marked as permanently failed. |

### Example config

```json
{
  "rd_api_key": "ABC123DEF456",
  "download_dir": "D:/Media/Downloads",
  "min_wait_ms": 3000,
  "max_wait_ms": 10000,
  "server_port": 8080,
  "max_retries": 5
}
```

Settings can also be changed live from the WebUI's **Settings** dialog — except the server port, which requires a restart.

## WebUI

The dashboard at `http://127.0.0.1:<port>` gives you:

- **Stats bar** — live count of pending / downloading / completed / error / cancelled jobs, plus worker status
- **Current download** — filename, folder path, progress bar with percentage and bytes
- **Queue** — upcoming downloads, with cancel buttons
- **Completed / Errors / Cancelled** — collapsible sections; errors have Retry and Remove buttons
- **+ Add Link** — paste a Mega folder URL to parse and queue all files
- **Settings** — edit config and test your API key without touching the file
- **Logs** — filterable log viewer (INFO / WARN / ERROR) with clear function

## API

All routes are under `/api`. Useful if you want to script submissions or build your own frontend.

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/folders` | Submit a Mega folder URL (`{ "url": "..." }`) |
| `GET` | `/api/folders` | List all submitted folders |
| `GET` | `/api/jobs` | List all jobs (optional `?status=pending`) |
| `GET` | `/api/jobs/stats` | Job counts by status |
| `GET` | `/api/jobs/:id` | Single job detail |
| `POST` | `/api/jobs/:id/retry` | Retry a failed/cancelled job |
| `POST` | `/api/jobs/:id/cancel` | Cancel a pending/active job |
| `POST` | `/api/jobs/retry-all` | Reset all failed jobs to pending |
| `DELETE` | `/api/jobs/:id` | Delete a job record |
| `DELETE` | `/api/jobs/clear-completed` | Remove all completed job records |
| `GET` | `/api/logs` | Fetch logs (`?limit=100&level=ERROR`) |
| `DELETE` | `/api/logs` | Clear all logs |
| `GET` | `/api/config` | Get current config (API key is redacted) |
| `POST` | `/api/config` | Update config fields |
| `GET` | `/api/worker/status` | Worker state (running, paused, current job) |
| `POST` | `/api/worker/pause` | Pause the worker |
| `POST` | `/api/worker/resume` | Resume the worker |
| `GET` | `/api/user` | Verify RD API key, returns account info |

## How It Works

1. You submit a Mega.nz **folder** URL
2. The app uses [megajs](https://github.com/nicedoc/megajs) to anonymously read the folder tree (names, sizes, paths)
3. It calls RD's `/unrestrict/folder` endpoint to get unrestricted download URLs
4. It matches RD URLs back to the Mega file tree by filename + filesize (RD returns a flat list with no metadata)
5. Each file is downloaded via streaming HTTP, saved to the correct subfolder
6. Random delay → next file → repeat until queue is empty

### The Matching Problem

Mega folders have a tree structure. RD's `/unrestrict/folder` returns a flat array of URLs with **zero metadata** — no filenames, no sizes, nothing. The app calls `/unrestrict/link` on each URL to get the actual filename and filesize, then matches them to the megajs tree using:

1. **Exact filename match** — primary key
2. **Filesize verification** — ±1KB tolerance for encoding differences
3. **Order-based fallback** — if names don't match, try positional matching
4. **Flat-folder fallback** — for single-depth folders

## Project Structure

```
rd-mega-dl/
├── index.js          # Entry point — Fastify server, API routes, startup/shutdown
├── worker.js         # Core engine — Mega parsing, RD API, download queue, retry logic
├── db.js             # SQLite layer — schema, migrations, all query helpers
├── config.json       # Configuration file (edit this)
├── package.json      # Dependencies
├── public/
│   ├── index.html    # Dashboard layout and dialogs
│   ├── style.css     # Dark theme styles
│   └── app.js        # Frontend logic — polling, rendering, event handling
└── downloads/        # Default download directory (created automatically)
```

## Requirements

- **Node.js ≥ 18**
- **Real-Debrid premium account** with API access
- Windows, macOS, or Linux

## License

MIT — do whatever you want with it.
