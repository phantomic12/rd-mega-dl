'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { File } = require('megajs');
const db = require('./db');

const RD_BASE = 'https://api.real-debrid.com/rest/1.0';

// ── Config hot-reload ────────────────────────────────────────

function getConfig() {
    const cfgPath = path.join(__dirname, 'config.json');
    if (!fs.existsSync(cfgPath)) {
        const defaults = {
            rd_api_key: 'XXX-123-XXX',
            download_dir: './downloads',
            min_wait_ms: 5000,
            max_wait_ms: 15000,
            server_port: 3000,
            max_retries: 3
        };
        fs.writeFileSync(cfgPath, JSON.stringify(defaults, null, 2));
        return defaults;
    }
    return JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
}

// ── Worker state ─────────────────────────────────────────────

let running = false;
let isPaused = false;
let pauseReason = '';
let pauseUntil = null;
let currentJobId = null;
let currentStream = null;
let lastDownloadTime = 0;

function getStatus() {
    return { running, isPaused, currentJobId, pauseReason, pauseUntil };
}

function pause(reason = 'Manual pause') {
    isPaused = true;
    pauseReason = reason;
    db.addLog('WARN', 'worker', `Worker paused: ${reason}`);
}

function resume() {
    isPaused = false;
    pauseReason = '';
    pauseUntil = null;
    db.addLog('INFO', 'worker', 'Worker resumed');
}

function stop() {
    running = false;
    if (currentStream) {
        currentStream.destroy();
        currentStream = null;
    }
}

// ── Utilities ────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function randomDelay(min, max) {
    return Math.floor(Math.random() * (max - min) + min);
}

function sanitizeFilename(name) {
    if (!name) return 'unnamed';
    let s = name
        .replace(/\.\./g, '_')        // prevent path traversal
        .replace(/\0/g, '')           // null bytes
        .replace(/[<>:"|?*]/g, '_')   // Windows-illegal chars
        .replace(/\\/g, '_')          // backslash
        .replace(/\//g, '_');         // forward slash
    // Trim trailing dots and spaces (Windows)
    s = s.replace(/[\s.]+$/, '');
    // Truncate but preserve extension
    if (s.length > 200) {
        const ext = path.extname(s);
        s = s.slice(0, 200 - ext.length) + ext;
    }
    return s || 'unnamed';
}

// ── RD API Error classification ──────────────────────────────

const PERMANENT_CODES = new Set([2, 3, 4, 7, 16, 20, 22, 24, 28, 35, 37]);
const FATAL_CODES = new Set([8, 9, 14, 15]);
const TRANSIENT_WAIT = {
    5: 30000,     // Slow down
    6: 60000,     // Resource unreachable
    17: 300000,   // Hoster maintenance
    18: 600000,   // Hoster limit reached
    19: 120000,   // Hoster temp unavailable
    21: 60000,    // Too many active downloads
    25: 120000,   // Service unavailable
    33: 60000,    // Torrent already active
    36: 600000    // Fair usage limit
};

function classifyError(err) {
    const status = err.response?.status;
    const errorCode = err.response?.data?.error_code;
    const errorMsg = err.response?.data?.error || err.message;

    if (status === 429 || errorCode === 34) {
        const retryAfter = parseInt(err.response?.headers?.['retry-after'] || '60', 10) * 1000;
        return { type: 'rate_limit', wait: retryAfter, message: errorMsg, errorCode: 34 };
    }
    if (FATAL_CODES.has(errorCode)) {
        return { type: 'fatal', message: errorMsg, errorCode };
    }
    if (PERMANENT_CODES.has(errorCode)) {
        return { type: 'permanent', message: errorMsg, errorCode };
    }
    if (TRANSIENT_WAIT[errorCode]) {
        return { type: 'transient', wait: TRANSIENT_WAIT[errorCode], message: errorMsg, errorCode };
    }
    if (errorCode === 23) {
        return { type: 'fatal', message: 'Traffic exhausted', errorCode: 23 };
    }
    // Network errors (no response)
    if (!err.response) {
        return { type: 'transient', wait: 30000, message: `Network error: ${err.message}`, errorCode: null };
    }
    // Unknown HTTP errors
    if (status >= 500) {
        return { type: 'transient', wait: 60000, message: errorMsg, errorCode };
    }
    if (status >= 400) {
        return { type: 'permanent', message: errorMsg, errorCode };
    }
    return { type: 'transient', wait: 30000, message: errorMsg, errorCode };
}

// ── RD API calls ─────────────────────────────────────────────

function rdHeaders() {
    const config = getConfig();
    return { Authorization: `Bearer ${config.rd_api_key}` };
}

async function unrestrictFolder(folderUrl) {
    db.addLog('INFO', 'rd', `Unrestricting folder: ${folderUrl}`);
    const resp = await axios.post(`${RD_BASE}/unrestrict/folder`, `link=${encodeURIComponent(folderUrl)}`, {
        headers: { ...rdHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 30000
    });
    return resp.data; // array of URL strings
}

async function unrestrictLink(link) {
    db.addLog('INFO', 'rd', `Unrestricting link: ${link.slice(0, 80)}...`);
    const resp = await axios.post(`${RD_BASE}/unrestrict/link`, `link=${encodeURIComponent(link)}`, {
        headers: { ...rdHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 30000
    });
    return resp.data; // { id, filename, mimeType, filesize, link, host, chunks, crc, download, streamable }
}

async function checkUser() {
    const resp = await axios.get(`${RD_BASE}/user`, {
        headers: rdHeaders(),
        timeout: 15000
    });
    return resp.data;
}

// ── Mega folder parsing ──────────────────────────────────────

async function parseMegaFolder(megaUrl, folderId) {
    db.addLog('INFO', 'mega', `Parsing Mega folder: ${megaUrl}`);
    try {
        const folder = File.fromURL(megaUrl);
        await folder.loadAttributes();

        const folderName = sanitizeFilename(folder.name || 'MegaFolder');
        const jobs = [];

        function traverse(node, currentPath) {
            if (node.directory) {
                const dirName = sanitizeFilename(node.name);
                const newPath = currentPath ? path.join(currentPath, dirName) : dirName;
                if (node.children) {
                    for (const child of node.children) {
                        traverse(child, newPath);
                    }
                }
            } else {
                const fileName = sanitizeFilename(node.name);
                const relativePath = currentPath ? path.join(currentPath, fileName) : path.join(folderName, fileName);
                jobs.push({
                    mega_folder_url: megaUrl,
                    mega_folder_name: folderName,
                    filename: node.name, // original unsanitized for matching
                    relative_path: relativePath.replace(/\\/g, '/'), // normalize to forward slashes
                    file_size_mega: node.size || 0,
                    status: 'pending'
                });
            }
        }

        // Root folder children
        if (folder.children) {
            for (const child of folder.children) {
                traverse(child, folderName);
            }
        }

        if (jobs.length === 0) {
            db.updateFolder(folderId, { status: 'error', error_message: 'No files found in folder' });
            db.addLog('WARN', 'mega', 'No files found in Mega folder');
            return;
        }

        // Batch insert
        db.addJobsBatch(jobs);
        db.updateFolder(folderId, { folder_name: folderName, total_files: jobs.length, status: 'queued' });
        db.addLog('INFO', 'mega', `Parsed ${jobs.length} files from "${folderName}"`);

        // Create directories on disk
        const config = getConfig();
        const dirs = new Set();
        for (const j of jobs) {
            const dir = path.dirname(path.join(config.download_dir, j.relative_path));
            dirs.add(dir);
        }
        for (const dir of dirs) {
            fs.mkdirSync(dir, { recursive: true });
        }
        db.addLog('INFO', 'mega', `Created ${dirs.size} directories`);

        // Now unrestrict folder via RD to get individual links
        await matchRdLinks(megaUrl, folderId);

    } catch (err) {
        db.updateFolder(folderId, { status: 'error', error_message: err.message });
        db.addLog('ERROR', 'mega', `Failed to parse folder: ${err.message}`);
    }
}

// ── Matching RD links to megajs tree ─────────────────────────

async function matchRdLinks(megaUrl, folderId) {
    db.addLog('INFO', 'rd', 'Starting RD folder unrestriction and matching...');
    db.updateFolder(folderId, { status: 'in_progress' });

    let rdLinks;
    try {
        rdLinks = await unrestrictFolder(megaUrl);
    } catch (err) {
        db.addLog('WARN', 'rd', `RD /unrestrict/folder failed: ${err.message}. Files will be unrestricted individually.`);
        return; // Jobs stay pending, worker will unrestrict individually
    }

    if (!Array.isArray(rdLinks) || rdLinks.length === 0) {
        db.addLog('WARN', 'rd', 'RD returned empty folder links. Files will be unrestricted individually.');
        return;
    }

    db.addLog('INFO', 'rd', `RD returned ${rdLinks.length} links from folder`);

    // Get all jobs for this folder
    const jobs = db.getJobsByFolder(megaUrl);

    // Build match map: filename -> [job, ...]
    const nameMap = new Map();
    for (const j of jobs) {
        const key = j.filename.toLowerCase();
        if (!nameMap.has(key)) nameMap.set(key, []);
        nameMap.get(key).push(j);
    }

    // Unrestrict each RD link and match
    let matchedCount = 0;
    const config = getConfig();

    for (let i = 0; i < rdLinks.length; i++) {
        const rdUrl = rdLinks[i];
        try {
            // Throttle: small delay between unrestrict calls to respect rate limits
            if (i > 0) await sleep(300);

            const rdData = await unrestrictLink(rdUrl);
            const rdFilename = rdData.filename || '';
            const rdFilesize = rdData.filesize || 0;
            const rdDownloadUrl = rdData.download;

            // Try exact filename match
            const candidates = nameMap.get(rdFilename.toLowerCase()) || [];

            let matched = null;
            if (candidates.length === 1) {
                matched = candidates[0];
            } else if (candidates.length > 1) {
                // Try size match within tolerance
                matched = candidates.find(c =>
                    !c.rd_download_url && Math.abs(c.file_size_mega - rdFilesize) < 1024
                );
                // Fallback: first unmatched
                if (!matched) matched = candidates.find(c => !c.rd_download_url);
            }

            if (matched) {
                db.updateRdData(matched.id, {
                    rdLink: rdUrl,
                    rdDownloadUrl: rdDownloadUrl,
                    rdFilename: rdFilename,
                    rdFilesize: rdFilesize
                });
                matched.rd_download_url = rdDownloadUrl; // mark locally
                matchedCount++;
                db.addLog('DEBUG', 'rd', `Matched: ${rdFilename} -> ${matched.relative_path}`);
            } else {
                // No match — create as flat file under folder
                const folderInfo = db.getFolder(folderId);
                const folderName = folderInfo?.folder_name || 'MegaFolder';
                const relPath = `${folderName}/${sanitizeFilename(rdFilename)}`;
                db.addJob({
                    mega_folder_url: megaUrl,
                    mega_folder_name: folderName,
                    filename: rdFilename,
                    relative_path: relPath,
                    file_size_mega: rdFilesize,
                    status: 'pending'
                });
                // Update the new job with RD data
                const newJob = db.getDb().prepare("SELECT id FROM jobs WHERE relative_path = ? AND mega_folder_url = ? ORDER BY id DESC LIMIT 1").get(relPath, megaUrl);
                if (newJob) {
                    db.updateRdData(newJob.id, { rdLink: rdUrl, rdDownloadUrl: rdDownloadUrl, rdFilename, rdFilesize });
                }
                const dir = path.dirname(path.join(config.download_dir, relPath));
                fs.mkdirSync(dir, { recursive: true });
                db.addLog('WARN', 'rd', `No tree match for "${rdFilename}", saved to ${relPath}`);
            }
        } catch (err) {
            const classified = classifyError(err);
            if (classified.type === 'rate_limit') {
                db.addLog('WARN', 'rd', `Rate limited during matching. Waiting ${classified.wait / 1000}s`);
                await sleep(classified.wait);
                i--; // retry this one
                continue;
            }
            db.addLog('ERROR', 'rd', `Failed to unrestrict link ${i + 1}: ${classified.message}`);
        }
    }

    db.addLog('INFO', 'rd', `Matching complete: ${matchedCount}/${rdLinks.length} matched to tree`);
}

// ── Download engine ──────────────────────────────────────────

async function downloadFile(job) {
    const config = getConfig();
    const localPath = path.join(config.download_dir, job.relative_path);
    const dir = path.dirname(localPath);
    fs.mkdirSync(dir, { recursive: true });

    // Clean up partial file on retry
    if (fs.existsSync(localPath)) {
        fs.unlinkSync(localPath);
    }

    const url = job.rd_download_url;
    db.addLog('INFO', 'worker', `Downloading: ${job.filename} -> ${job.relative_path}`);

    const response = await axios.get(url, {
        responseType: 'stream',
        timeout: 0, // no timeout for downloads
        headers: rdHeaders()
    });

    const totalBytes = parseInt(response.headers['content-length'] || job.rd_filesize || '0', 10);
    if (totalBytes > 0) {
        db.getDb().prepare('UPDATE jobs SET rd_filesize = ? WHERE id = ?').run(totalBytes, job.id);
    }

    return new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(localPath);
        currentStream = response.data;

        let bytesReceived = 0;
        let lastProgressUpdate = 0;

        response.data.on('data', (chunk) => {
            bytesReceived += chunk.length;
            const now = Date.now();
            if (now - lastProgressUpdate >= 1000) {
                lastProgressUpdate = now;
                db.updateProgress(job.id, bytesReceived);
                // Check for external cancellation
                const current = db.getJob(job.id);
                if (current && current.status === 'cancelled') {
                    response.data.destroy();
                    writer.destroy();
                    if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
                    reject(new Error('Download cancelled'));
                    return;
                }
            }
        });

        response.data.pipe(writer);

        writer.on('finish', () => {
            currentStream = null;
            db.updateProgress(job.id, bytesReceived);
            db.addLog('INFO', 'worker', `Completed: ${job.filename} (${formatBytes(bytesReceived)})`);
            resolve();
        });

        writer.on('error', (err) => {
            currentStream = null;
            if (fs.existsSync(localPath)) {
                try { fs.unlinkSync(localPath); } catch {}
            }
            reject(err);
        });

        response.data.on('error', (err) => {
            currentStream = null;
            writer.destroy();
            if (fs.existsSync(localPath)) {
                try { fs.unlinkSync(localPath); } catch {}
            }
            reject(err);
        });
    });
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

// ── Error handler ────────────────────────────────────────────

async function handleError(job, err) {
    const classified = classifyError(err);
    const config = getConfig();

    db.addLog('ERROR', 'worker', `Error on "${job.filename}": [${classified.type}] ${classified.message}`);

    if (classified.type === 'rate_limit') {
        // Global pause, do NOT increment retry
        isPaused = true;
        pauseReason = `Rate limited (429). Waiting ${classified.wait / 1000}s`;
        pauseUntil = Date.now() + classified.wait;
        db.updateStatus(job.id, 'pending'); // re-queue
        db.addLog('WARN', 'worker', pauseReason);
        await sleep(classified.wait);
        isPaused = false;
        pauseReason = '';
        pauseUntil = null;
        return;
    }

    if (classified.type === 'fatal') {
        // Stop everything
        isPaused = true;
        pauseReason = `Fatal: ${classified.message}`;
        db.updateStatus(job.id, 'error');
        db.setErrorMessage(job.id, classified.message, classified.errorCode);
        db.addLog('ERROR', 'worker', `FATAL ERROR: ${classified.message}. Worker paused.`);
        return;
    }

    if (classified.type === 'permanent') {
        db.updateStatus(job.id, 'error');
        db.setErrorMessage(job.id, classified.message, classified.errorCode);
        return;
    }

    // Transient error
    const newRetry = (job.retry_count || 0) + 1;
    if (newRetry > config.max_retries) {
        db.updateStatus(job.id, 'error');
        db.setErrorMessage(job.id, `Max retries (${config.max_retries}) exceeded. Last: ${classified.message}`, classified.errorCode);
        db.addLog('ERROR', 'worker', `Max retries reached for "${job.filename}"`);
        return;
    }

    db.updateRetryCount(job.id, newRetry);
    db.updateStatus(job.id, 'pending');
    db.setErrorMessage(job.id, null, null);
    db.addLog('WARN', 'worker', `Retry ${newRetry}/${config.max_retries} for "${job.filename}" (waiting ${classified.wait / 1000}s)`);

    if (classified.wait) {
        await sleep(classified.wait);
    }
}

// ── Main worker loop ─────────────────────────────────────────

async function start() {
    if (running) return;
    running = true;
    db.addLog('INFO', 'worker', 'Download worker started');

    while (running) {
        if (isPaused) {
            await sleep(5000);
            // Auto-resume if pause timer expired
            if (pauseUntil && Date.now() >= pauseUntil) {
                resume();
            }
            continue;
        }

        const config = getConfig();
        const job = getNextPending();

        if (!job) {
            await sleep(5000);
            continue;
        }

        currentJobId = job.id;

        // Check if cancelled before starting
        const freshJob = db.getJob(job.id);
        if (!freshJob || freshJob.status === 'cancelled') {
            currentJobId = null;
            continue;
        }

        // Random delay between downloads
        if (lastDownloadTime > 0) {
            const delay = randomDelay(config.min_wait_ms, config.max_wait_ms);
            db.addLog('INFO', 'worker', `Waiting ${(delay / 1000).toFixed(1)}s before next download...`);
            await sleep(delay);
        }

        try {
            // Step 1: Unrestrict if needed
            if (!freshJob.rd_download_url) {
                db.updateStatus(job.id, 'unrestricting');
                let linkToUnrestrict = freshJob.rd_link;

                // If no rd_link either, we need the individual file URL — this shouldn't happen
                // if matching worked, but handle it
                if (!linkToUnrestrict) {
                    db.addLog('WARN', 'worker', `No RD link for "${job.filename}". Marking as error.`);
                    db.updateStatus(job.id, 'error');
                    db.setErrorMessage(job.id, 'No RD link available. Folder unrestriction may have failed.');
                    currentJobId = null;
                    continue;
                }

                const rdResult = await unrestrictLink(linkToUnrestrict);
                db.updateRdData(job.id, {
                    rdLink: linkToUnrestrict,
                    rdDownloadUrl: rdResult.download,
                    rdFilename: rdResult.filename,
                    rdFilesize: rdResult.filesize
                });
                freshJob.rd_download_url = rdResult.download;
                freshJob.rd_filesize = rdResult.filesize;
            }

            // Step 2: Download
            db.updateStatus(job.id, 'downloading');
            db.updateStartedAt(job.id);
            await downloadFile({ ...freshJob, rd_download_url: freshJob.rd_download_url });
            db.updateStatus(job.id, 'completed');
            db.updateCompletedAt(job.id);
            db.updateFolderCompletedCount(freshJob.mega_folder_url);
            lastDownloadTime = Date.now();

        } catch (err) {
            if (err.message === 'Download cancelled') {
                db.addLog('INFO', 'worker', `Download cancelled: ${job.filename}`);
            } else {
                await handleError(freshJob, err);
            }
        }

        currentJobId = null;
    }

    db.addLog('INFO', 'worker', 'Download worker stopped');
}

module.exports = {
    start, stop, pause, resume, getStatus,
    parseMegaFolder, checkUser, getConfig
};
