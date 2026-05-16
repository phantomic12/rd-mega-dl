'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'downloads.db');
let db;

const SCHEMA = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mega_folder_url TEXT NOT NULL,
    mega_folder_name TEXT,
    filename TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    file_size_mega INTEGER DEFAULT 0,
    rd_link TEXT,
    rd_download_url TEXT,
    rd_filename TEXT,
    rd_filesize INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending'
        CHECK(status IN ('pending','matching','unrestricting','downloading','completed','error','cancelled')),
    bytes_downloaded INTEGER DEFAULT 0,
    retry_count INTEGER DEFAULT 0,
    error_message TEXT,
    error_code INTEGER,
    added_at DATETIME DEFAULT (datetime('now')),
    started_at DATETIME,
    completed_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_folder ON jobs(mega_folder_url);

CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT (datetime('now')),
    level TEXT CHECK(level IN ('INFO','WARN','ERROR','DEBUG')),
    source TEXT,
    message TEXT
);

CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);

CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mega_url TEXT NOT NULL,
    folder_name TEXT,
    total_files INTEGER DEFAULT 0,
    completed_files INTEGER DEFAULT 0,
    status TEXT DEFAULT 'parsing'
        CHECK(status IN ('parsing','queued','in_progress','completed','error')),
    error_message TEXT,
    added_at DATETIME DEFAULT (datetime('now'))
);
`;

// ANSI colors for console
const COLORS = {
    INFO: '\x1b[32m',   // green
    WARN: '\x1b[33m',   // yellow
    ERROR: '\x1b[31m',  // red
    DEBUG: '\x1b[36m',  // cyan
    RESET: '\x1b[0m'
};

function initDb() {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(SCHEMA);
    return db;
}

function getDb() {
    if (!db) throw new Error('Database not initialized. Call initDb() first.');
    return db;
}

function closeDb() {
    if (db) {
        db.close();
        db = null;
    }
}

// ── Logging ──────────────────────────────────────────────────

function addLog(level, source, message) {
    const d = getDb();
    d.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(level, source, message);
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const color = COLORS[level] || COLORS.RESET;
    console.log(`${color}[${ts}] [${level}] [${source}] ${message}${COLORS.RESET}`);
}

function getLogs(limit = 100, level = null) {
    const d = getDb();
    if (level) {
        return d.prepare('SELECT * FROM logs WHERE level = ? ORDER BY id DESC LIMIT ?').all(level, limit);
    }
    return d.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit);
}

function clearLogs() {
    getDb().prepare('DELETE FROM logs').run();
}

// ── Folders ──────────────────────────────────────────────────

function addFolder(megaUrl) {
    const d = getDb();
    const info = d.prepare('INSERT INTO folders (mega_url) VALUES (?)').run(megaUrl);
    return info.lastInsertRowid;
}

function updateFolder(id, fields) {
    const d = getDb();
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(fields)) {
        sets.push(`${k} = ?`);
        vals.push(v);
    }
    vals.push(id);
    d.prepare(`UPDATE folders SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

function getAllFolders() {
    return getDb().prepare('SELECT * FROM folders ORDER BY added_at DESC').all();
}

function getFolder(id) {
    return getDb().prepare('SELECT * FROM folders WHERE id = ?').get(id);
}

// ── Jobs ─────────────────────────────────────────────────────

function addJob(fields) {
    const d = getDb();
    const info = d.prepare(`
        INSERT INTO jobs (mega_folder_url, mega_folder_name, filename, relative_path, file_size_mega, status)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        fields.mega_folder_url,
        fields.mega_folder_name || null,
        fields.filename,
        fields.relative_path,
        fields.file_size_mega || 0,
        fields.status || 'pending'
    );
    return info.lastInsertRowid;
}

function addJobsBatch(jobsArray) {
    const d = getDb();
    const stmt = d.prepare(`
        INSERT INTO jobs (mega_folder_url, mega_folder_name, filename, relative_path, file_size_mega, status)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insert = d.transaction((jobs) => {
        for (const j of jobs) {
            stmt.run(
                j.mega_folder_url,
                j.mega_folder_name || null,
                j.filename,
                j.relative_path,
                j.file_size_mega || 0,
                j.status || 'pending'
            );
        }
    });
    insert(jobsArray);
}

function getNextPending() {
    return getDb().prepare(
        "SELECT * FROM jobs WHERE status = 'pending' AND rd_download_url IS NOT NULL ORDER BY added_at ASC LIMIT 1"
    ).get();
}

function claimNextJob() {
    // Atomically claim a job: update status and return the row in one transaction
    const d = getDb();
    const claim = d.transaction(() => {
        const job = d.prepare(
            "SELECT * FROM jobs WHERE status = 'pending' AND rd_download_url IS NOT NULL ORDER BY added_at ASC LIMIT 1"
        ).get();
        if (job) {
            d.prepare("UPDATE jobs SET status = 'downloading', started_at = datetime('now') WHERE id = ?").run(job.id);
        }
        return job;
    });
    return claim();
}

function getJob(id) {
    return getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

function getAllJobs(statusFilter) {
    const d = getDb();
    if (statusFilter && statusFilter.length > 0) {
        const placeholders = statusFilter.map(() => '?').join(',');
        return d.prepare(`SELECT * FROM jobs WHERE status IN (${placeholders}) ORDER BY added_at DESC`).all(...statusFilter);
    }
    return d.prepare('SELECT * FROM jobs ORDER BY added_at DESC').all();
}

function getJobsByFolder(megaFolderUrl) {
    return getDb().prepare('SELECT * FROM jobs WHERE mega_folder_url = ?').all(megaFolderUrl);
}

function getJobStats() {
    const rows = getDb().prepare('SELECT status, COUNT(*) as count FROM jobs GROUP BY status').all();
    const stats = { pending: 0, matching: 0, unrestricting: 0, downloading: 0, completed: 0, error: 0, cancelled: 0 };
    for (const r of rows) {
        stats[r.status] = r.count;
    }
    return stats;
}

function updateStatus(id, status) {
    getDb().prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, id);
}

function updateProgress(id, bytesDownloaded) {
    getDb().prepare('UPDATE jobs SET bytes_downloaded = ? WHERE id = ?').run(bytesDownloaded, id);
}

function updateRdData(id, data) {
    getDb().prepare(`
        UPDATE jobs SET rd_link = ?, rd_download_url = ?, rd_filename = ?, rd_filesize = ? WHERE id = ?
    `).run(data.rdLink || null, data.rdDownloadUrl || null, data.rdFilename || null, data.rdFilesize || 0, id);
}

function updateStartedAt(id) {
    getDb().prepare("UPDATE jobs SET started_at = datetime('now') WHERE id = ?").run(id);
}

function updateCompletedAt(id) {
    getDb().prepare("UPDATE jobs SET completed_at = datetime('now') WHERE id = ?").run(id);
}

function setErrorMessage(id, message, errorCode) {
    getDb().prepare('UPDATE jobs SET error_message = ?, error_code = ? WHERE id = ?').run(message, errorCode || null, id);
}

function updateRetryCount(id, count) {
    getDb().prepare('UPDATE jobs SET retry_count = ? WHERE id = ?').run(count, id);
}

function resetJob(id) {
    getDb().prepare("UPDATE jobs SET status = 'pending', retry_count = 0, error_message = NULL, error_code = NULL, bytes_downloaded = 0 WHERE id = ?").run(id);
}

function resetAllFailed() {
    const info = getDb().prepare("UPDATE jobs SET status = 'pending', retry_count = 0, error_message = NULL, error_code = NULL, bytes_downloaded = 0 WHERE status = 'error'").run();
    return info.changes;
}

function deleteJob(id) {
    getDb().prepare("DELETE FROM jobs WHERE id = ? AND status IN ('completed','cancelled','error')").run(id);
}

function clearCompleted() {
    const info = getDb().prepare("DELETE FROM jobs WHERE status = 'completed'").run();
    return info.changes;
}

function updateFolderCompletedCount(megaFolderUrl) {
    const d = getDb();
    const row = d.prepare("SELECT COUNT(*) as cnt FROM jobs WHERE mega_folder_url = ? AND status = 'completed'").get(megaFolderUrl);
    d.prepare("UPDATE folders SET completed_files = ? WHERE mega_url = ?").run(row.cnt, megaFolderUrl);
    // Check if all are done
    const total = d.prepare("SELECT total_files FROM folders WHERE mega_url = ?").get(megaFolderUrl);
    if (total && row.cnt >= total.total_files) {
        d.prepare("UPDATE folders SET status = 'completed' WHERE mega_url = ?").run(megaFolderUrl);
    }
}

module.exports = {
    initDb, getDb, closeDb,
    addLog, getLogs, clearLogs,
    addFolder, updateFolder, getAllFolders, getFolder,
    addJob, addJobsBatch, getNextPending, claimNextJob, getJob, getAllJobs, getJobsByFolder, getJobStats,
    updateStatus, updateProgress, updateRdData, updateStartedAt, updateCompletedAt,
    setErrorMessage, updateRetryCount, resetJob, resetAllFailed,
    deleteJob, clearCompleted, updateFolderCompletedCount
};
