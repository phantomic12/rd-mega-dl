'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { File } = require('megajs');
const db = require('./db');

const RD_BASE = 'https://api.real-debrid.com/rest/1.0';

// ── Config hot-reload ────────────────────────────────────────

function loadEnv() {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx === -1) continue;
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim();
            if (!process.env[key]) process.env[key] = val;
        }
    }
}

function getConfig() {
    loadEnv();

    const cfgPath = path.join(__dirname, 'config.json');
    const defaults = {
        download_dir: './downloads',
        min_wait_ms: 5000,
        max_wait_ms: 15000,
        server_port: 3000,
        max_retries: 3,
        concurrent_downloads: 4,
        unrestrict_batch_size: 10,
        unrestrict_batch_delay_ms: 300
    };

    let fileCfg = {};
    if (fs.existsSync(cfgPath)) {
        fileCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    } else {
        fs.writeFileSync(cfgPath, JSON.stringify(defaults, null, 2));
    }

    // Merge: config.json wins for non-secret settings, .env wins for rd_api_key
    const config = { ...defaults, ...fileCfg };

    // API key: .env takes priority, then config.json, then env var
    if (process.env.RD_API_KEY) {
        config.rd_api_key = process.env.RD_API_KEY;
    } else if (fileCfg.rd_api_key) {
        config.rd_api_key = fileCfg.rd_api_key;
    }

    // Docker-friendly overrides
    if (process.env.DOWNLOAD_DIR) config.download_dir = process.env.DOWNLOAD_DIR;
    if (process.env.SERVER_PORT) config.server_port = parseInt(process.env.SERVER_PORT, 10);
    if (process.env.SERVER_HOST) config.server_host = process.env.SERVER_HOST;

    return config;
}

// ── Worker state ─────────────────────────────────────────────

let running = false;
let isPaused = false;
let pauseReason = '';
let pauseUntil = null;
let activeStreams = new Map();       // jobId → stream (for cancellation)
let jobNameIndex = new Map();        // filename_lower → [job, ...]
let currentFolderId = null;

function getStatus() {
    return { running, isPaused, pauseReason, pauseUntil, activeDownloads: activeStreams.size };
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
    // Destroy all active download streams
    for (const [jobId, stream] of activeStreams) {
        try { stream.destroy(); } catch {}
    }
    activeStreams.clear();
}

// ── Utilities ────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function sanitizeFilename(name) {
    if (!name) return 'unnamed';
    let s = name
        .replace(/\.\./g, '_')
        .replace(/\0/g, '')
        .replace(/[<>:"|?*]/g, '_')
        .replace(/\\/g, '_')
        .replace(/\//g, '_');
    s = s.replace(/[\s.]+$/, '');
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
    5: 30000, 6: 60000, 17: 300000, 18: 600000,
    19: 120000, 21: 60000, 25: 120000, 33: 60000, 36: 600000
};

function classifyError(err) {
    const status = err.response?.status;
    const errorCode = err.response?.data?.error_code;
    const errorMsg = err.response?.data?.error || err.message;

    if (status === 429 || errorCode === 34) {
        const retryAfter = parseInt(err.response?.headers?.['retry-after'] || '60', 10) * 1000;
        return { type: 'rate_limit', wait: retryAfter, message: errorMsg, errorCode: 34 };
    }
    if (FATAL_CODES.has(errorCode)) return { type: 'fatal', message: errorMsg, errorCode };
    if (PERMANENT_CODES.has(errorCode)) return { type: 'permanent', message: errorMsg, errorCode };
    if (TRANSIENT_WAIT[errorCode]) return { type: 'transient', wait: TRANSIENT_WAIT[errorCode], message: errorMsg, errorCode };
    if (errorCode === 23) return { type: 'fatal', message: 'Traffic exhausted', errorCode: 23 };
    if (!err.response) return { type: 'transient', wait: 30000, message: `Network error: ${err.message}`, errorCode: null };
    if (status >= 500) return { type: 'transient', wait: 60000, message: errorMsg, errorCode };
    if (status >= 400) return { type: 'permanent', message: errorMsg, errorCode };
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
    return resp.data;
}

async function unrestrictLink(link) {
    const resp = await axios.post(`${RD_BASE}/unrestrict/link`, `link=${encodeURIComponent(link)}`, {
        headers: { ...rdHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 30000
    });
    return resp.data;
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
                    filename: node.name,
                    relative_path: relativePath.replace(/\\/g, '/'),
                    file_size_mega: node.size || 0,
                    status: 'pending'
                });
            }
        }

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

        db.addJobsBatch(jobs);
        db.updateFolder(folderId, { folder_name: folderName, total_files: jobs.length, status: 'queued' });
        db.addLog('INFO', 'mega', `Parsed ${jobs.length} files from "${folderName}"`);

        // Create directory tree
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

        // Phase 1: Batch unrestrict all links
        await batchUnrestrictAndMatch(megaUrl, folderId);

    } catch (err) {
        db.updateFolder(folderId, { status: 'error', error_message: err.message });
        db.addLog('ERROR', 'mega', `Failed to parse folder: ${err.message}`);
    }
}

// ── Phase 1: Batch Unrestrict & Match ────────────────────────

async function batchUnrestrictAndMatch(megaUrl, folderId) {
    db.addLog('INFO', 'rd', 'Phase 1: Batch unrestricting all links...');
    db.updateFolder(folderId, { status: 'in_progress' });
    currentFolderId = folderId;

    let rdLinks;
    try {
        rdLinks = await unrestrictFolder(megaUrl);
    } catch (err) {
        db.addLog('ERROR', 'rd', `RD /unrestrict/folder failed: ${err.message}`);
        return;
    }

    if (!Array.isArray(rdLinks) || rdLinks.length === 0) {
        db.addLog('WARN', 'rd', 'RD returned empty folder links.');
        return;
    }

    db.addLog('INFO', 'rd', `Got ${rdLinks.length} links. Building name index...`);

    // Build filename → job lookup
    const jobs = db.getJobsByFolder(megaUrl);
    jobNameIndex.clear();
    for (const job of jobs) {
        const key = job.filename.toLowerCase();
        if (!jobNameIndex.has(key)) jobNameIndex.set(key, []);
        jobNameIndex.get(key).push(job);
    }
    db.addLog('INFO', 'rd', `Name index: ${jobNameIndex.size} unique filenames`);

    // Process in parallel batches
    const config = getConfig();
    const BATCH_SIZE = config.unrestrict_batch_size || 10;
    const BATCH_DELAY = config.unrestrict_batch_delay_ms || 300;

    let matchedCount = 0;
    let orphanCount = 0;
    const startTime = Date.now();

    for (let i = 0; i < rdLinks.length; i += BATCH_SIZE) {
        if (!running) break;

        const batch = rdLinks.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(rdLinks.length / BATCH_SIZE);

        // Unrestrict entire batch in parallel
        const results = await Promise.allSettled(
            batch.map(url => unrestrictLink(url).catch(e => ({ __error: e })))
        );

        // Match each result to a job
        for (const r of results) {
            if (r.status === 'rejected' || r.value?.__error) {
                const err = r.value?.__error || r.reason;
                const classified = classifyError(err);
                if (classified.type === 'rate_limit') {
                    db.addLog('WARN', 'rd', `Rate limited during batch unrestrict. Pausing ${classified.wait / 1000}s...`);
                    await sleep(classified.wait);
                    // Re-process this link
                    i -= BATCH_SIZE; // rewind batch
                    break;
                }
                continue;
            }

            const rdData = r.value;
            const filename = rdData.filename || '';
            const filesize = rdData.filesize || 0;
            const downloadUrl = rdData.download;

            if (!downloadUrl) continue;

            // Find matching job by filename
            const candidates = jobNameIndex.get(filename.toLowerCase()) || [];
            let matchedJob = null;

            if (candidates.length === 1) {
                matchedJob = candidates[0];
            } else if (candidates.length > 1) {
                matchedJob = candidates.find(j =>
                    !j.rd_download_url && Math.abs((j.file_size_mega || 0) - filesize) < 1024
                );
                if (!matchedJob) matchedJob = candidates.find(j => !j.rd_download_url);
            }

            if (matchedJob) {
                db.updateRdData(matchedJob.id, {
                    rdLink: '', // link already consumed
                    rdDownloadUrl: downloadUrl,
                    rdFilename: filename,
                    rdFilesize: filesize
                });
                // Mark in-memory object too so size matching works for duplicates
                matchedJob.rd_download_url = downloadUrl;
                matchedCount++;
            } else {
                // Orphan — save under _unmatched/
                orphanCount++;
                const folderInfo = db.getFolder(folderId);
                const folderName = folderInfo?.folder_name || 'MegaFolder';
                const relPath = `${folderName}/_unmatched/${sanitizeFilename(filename)}`;
                const orphanId = db.addJob({
                    mega_folder_url: megaUrl,
                    mega_folder_name: folderName,
                    filename: filename,
                    relative_path: relPath,
                    file_size_mega: filesize,
                    status: 'pending'
                });
                db.updateRdData(orphanId, {
                    rdLink: '',
                    rdDownloadUrl: downloadUrl,
                    rdFilename: filename,
                    rdFilesize: filesize
                });
                const dir = path.dirname(path.join(config.download_dir, relPath));
                fs.mkdirSync(dir, { recursive: true });
            }
        }

        // Progress
        const pct = ((i + BATCH_SIZE) / rdLinks.length * 100).toFixed(1);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        db.addLog('INFO', 'rd', `Batch ${batchNum}/${totalBatches} (${pct}%) — ${matchedCount} matched, ${orphanCount} orphans — ${elapsed}s elapsed`);

        if (i + BATCH_SIZE < rdLinks.length) {
            await sleep(BATCH_DELAY);
        }
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(0);
    db.addLog('INFO', 'rd', `Phase 1 complete: ${matchedCount + orphanCount}/${rdLinks.length} unrestricted in ${totalTime}s (${matchedCount} matched, ${orphanCount} orphans)`);
    db.updateFolder(folderId, { status: 'queued' });
}

// ── Download engine ──────────────────────────────────────────

async function downloadFile(job) {
    const config = getConfig();
    const localPath = path.join(config.download_dir, job.relative_path);
    const dir = path.dirname(localPath);
    fs.mkdirSync(dir, { recursive: true });

    if (fs.existsSync(localPath)) {
        fs.unlinkSync(localPath);
    }

    const url = job.rd_download_url;
    db.addLog('INFO', 'worker', `[#${job.id}] Downloading: ${job.filename} -> ${job.relative_path}`);

    const response = await axios.get(url, {
        responseType: 'stream',
        timeout: 0,
        headers: rdHeaders()
    });

    const totalBytes = parseInt(response.headers['content-length'] || job.rd_filesize || '0', 10);
    if (totalBytes > 0) {
        db.getDb().prepare('UPDATE jobs SET rd_filesize = ? WHERE id = ?').run(totalBytes, job.id);
    }

    return new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(localPath);
        activeStreams.set(job.id, response.data);

        let bytesReceived = 0;
        let lastProgressUpdate = 0;

        response.data.on('data', (chunk) => {
            bytesReceived += chunk.length;
            const now = Date.now();
            if (now - lastProgressUpdate >= 1000) {
                lastProgressUpdate = now;
                db.updateProgress(job.id, bytesReceived);
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
            activeStreams.delete(job.id);
            db.updateProgress(job.id, bytesReceived);
            db.addLog('INFO', 'worker', `[#${job.id}] Completed: ${job.filename} (${formatBytes(bytesReceived)})`);
            resolve();
        });

        writer.on('error', (err) => {
            activeStreams.delete(job.id);
            if (fs.existsSync(localPath)) { try { fs.unlinkSync(localPath); } catch {} }
            reject(err);
        });

        response.data.on('error', (err) => {
            activeStreams.delete(job.id);
            writer.destroy();
            if (fs.existsSync(localPath)) { try { fs.unlinkSync(localPath); } catch {} }
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

// ── Phase 2: Parallel download pool ──────────────────────────

async function downloadWorker(workerId) {
    const config = getConfig();

    while (running) {
        if (isPaused) {
            await sleep(2000);
            continue;
        }

        // Atomically claim a job
        const job = db.claimNextJob();
        if (!job) {
            await sleep(1000);
            continue;
        }

        try {
            await downloadFile(job);
            db.updateStatus(job.id, 'completed');
            db.updateCompletedAt(job.id);
            db.updateFolderCompletedCount(job.mega_folder_url);

        } catch (err) {
            if (err.message === 'Download cancelled') {
                db.updateStatus(job.id, 'cancelled');
                db.addLog('INFO', 'worker', `[W${workerId}] [#${job.id}] Cancelled`);
                continue;
            }

            const classified = classifyError(err);
            db.addLog('ERROR', 'worker', `[W${workerId}] [#${job.id}] ${job.filename}: [${classified.type}] ${classified.message}`);

            if (classified.type === 'rate_limit') {
                // Global pause
                isPaused = true;
                pauseReason = `Rate limited. Waiting ${classified.wait / 1000}s`;
                pauseUntil = Date.now() + classified.wait;
                db.updateStatus(job.id, 'pending');
                db.addLog('WARN', 'worker', `[W${workerId}] ${pauseReason}`);
                await sleep(classified.wait);
                isPaused = false;
                pauseReason = '';
                pauseUntil = null;
                continue;
            }

            if (classified.type === 'fatal') {
                isPaused = true;
                pauseReason = `Fatal: ${classified.message}`;
                db.updateStatus(job.id, 'error');
                db.setErrorMessage(job.id, classified.message, classified.errorCode);
                db.addLog('ERROR', 'worker', `[W${workerId}] FATAL: ${classified.message}. Worker paused.`);
                return; // stop this worker
            }

            if (classified.type === 'permanent') {
                db.updateStatus(job.id, 'error');
                db.setErrorMessage(job.id, classified.message, classified.errorCode);
                continue;
            }

            // Transient error
            const newRetry = (job.retry_count || 0) + 1;
            if (newRetry > config.max_retries) {
                db.updateStatus(job.id, 'error');
                db.setErrorMessage(job.id, `Max retries exceeded. Last: ${classified.message}`, classified.errorCode);
                db.addLog('ERROR', 'worker', `[W${workerId}] [#${job.id}] Max retries reached`);
                continue;
            }

            db.updateRetryCount(job.id, newRetry);
            db.updateStatus(job.id, 'pending');
            db.setErrorMessage(job.id, null, null);
            db.addLog('WARN', 'worker', `[W${workerId}] [#${job.id}] Retry ${newRetry}/${config.max_retries}`);

            if (classified.wait) {
                await sleep(classified.wait);
            }
        }
    }

    db.addLog('INFO', 'worker', `Worker ${workerId} stopped`);
}

async function start() {
    if (running) return;
    running = true;

    const config = getConfig();
    const concurrency = config.concurrent_downloads || 4;

    db.addLog('INFO', 'worker', `Phase 2: Starting ${concurrency} parallel download workers`);

    // Wait until we have matched jobs
    while (running) {
        const stats = db.getJobStats();
        const ready = stats.pending || 0;
        if (ready > 0) break;
        await sleep(2000);
    }

    // Spawn concurrent workers
    const workers = [];
    for (let i = 0; i < concurrency; i++) {
        workers.push(downloadWorker(i + 1));
    }

    await Promise.all(workers);
    db.addLog('INFO', 'worker', 'All download workers stopped');
}

module.exports = {
    start, stop, pause, resume, getStatus,
    parseMegaFolder, checkUser, getConfig
};
