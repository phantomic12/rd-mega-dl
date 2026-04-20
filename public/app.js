'use strict';

// ── State ────────────────────────────────────────────────────

let currentLogLevel = '';
let logPollTimer = null;
const POLL_MS = 2000;

// ── Helpers ──────────────────────────────────────────────────

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function api(method, url, body) {
    const opts = { method, headers: {} };
    if (body) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    if (res.status === 204) return null;
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
}

// ── Rendering ────────────────────────────────────────────────

function renderStatsBar(stats) {
    setText('stat-pending', stats.pending || 0, 'Pending');
    setText('stat-downloading', stats.downloading || 0, 'Downloading');
    setText('stat-completed', stats.completed || 0, 'Completed');
    setText('stat-error', stats.error || 0, 'Errors');
    setText('stat-cancelled', stats.cancelled || 0, 'Cancelled');
}

function setText(id, num, label) {
    const el = document.getElementById(id);
    if (!el) return;
    const span = el.querySelector('.stat-num');
    if (span) span.textContent = num;
}

function renderWorkerBadge(worker) {
    const el = document.getElementById('worker-badge');
    if (!el) return;
    if (worker.isPaused) {
        el.textContent = `⏸ Worker: Paused — ${worker.pauseReason || ''}`;
        el.style.color = '#ffd93d';
    } else if (worker.running) {
        el.textContent = '● Worker: Running';
        el.style.color = '#00d4aa';
    } else {
        el.textContent = '○ Worker: Stopped';
        el.style.color = '#888';
    }
}

function renderCurrentDownload(job) {
    const container = document.getElementById('current-download');
    if (!job) {
        container.innerHTML = '<div class="current-empty">No active download</div>';
        return;
    }
    const pct = job.rd_filesize > 0 ? Math.round((job.bytes_downloaded / job.rd_filesize) * 100) : 0;
    const dirPath = job.relative_path ? job.relative_path.split('/').slice(0, -1).join('/') : '';
    container.innerHTML = `
        <div class="current-info">
            <div class="current-filename">${escapeHtml(job.filename)}</div>
            <div class="current-path">${escapeHtml(dirPath)}</div>
            <div class="progress-bar-wrap">
                <div class="progress-bar-fill" style="width:${pct}%"></div>
                <div class="progress-text">${pct}% — ${formatBytes(job.bytes_downloaded)} / ${formatBytes(job.rd_filesize || job.file_size_mega)}</div>
            </div>
            <div class="current-actions">
                <button class="btn btn-sm btn-warn" onclick="cancelJob(${job.id})">Cancel</button>
            </div>
        </div>
    `;
}

function renderQueue(jobs) {
    const container = document.getElementById('queue-list');
    const countEl = document.getElementById('queue-count');
    countEl.textContent = jobs.length;
    if (jobs.length === 0) {
        container.innerHTML = '<div class="job-row" style="color:var(--text-dim);font-style:italic;">Queue empty</div>';
        return;
    }
    container.innerHTML = jobs.slice(0, 100).map(j => `
        <div class="job-row">
            <span class="job-name" title="${escapeHtml(j.filename)}">${escapeHtml(j.filename)}</span>
            <span class="job-path" title="${escapeHtml(j.relative_path)}">${escapeHtml(dirOf(j.relative_path))}</span>
            <span class="job-size">${formatBytes(j.file_size_mega || j.rd_filesize)}</span>
            <span class="job-actions">
                <button class="btn btn-sm" onclick="cancelJob(${j.id})">Cancel</button>
            </span>
        </div>
    `).join('');
}

function renderCompleted(jobs) {
    const container = document.getElementById('completed-list');
    const countEl = document.getElementById('completed-count');
    countEl.textContent = jobs.length;
    if (jobs.length === 0) {
        container.innerHTML = '<div class="job-row" style="color:var(--text-dim);font-style:italic;">No completed downloads</div>';
        return;
    }
    container.innerHTML = jobs.slice(0, 200).map(j => `
        <div class="job-row">
            <span class="job-name" title="${escapeHtml(j.filename)}">${escapeHtml(j.filename)}</span>
            <span class="job-path" title="${escapeHtml(j.relative_path)}">${escapeHtml(dirOf(j.relative_path))}</span>
            <span class="job-size">${formatBytes(j.rd_filesize || j.file_size_mega)}</span>
        </div>
    `).join('');
}

function renderErrors(jobs) {
    const container = document.getElementById('error-list');
    const countEl = document.getElementById('error-count');
    const actionsEl = document.getElementById('error-actions');
    countEl.textContent = jobs.length;
    actionsEl.classList.toggle('hidden', jobs.length === 0);
    if (jobs.length === 0) {
        container.innerHTML = '<div class="job-row" style="color:var(--text-dim);font-style:italic;">No errors</div>';
        return;
    }
    container.innerHTML = jobs.map(j => `
        <div class="job-row">
            <span class="job-name" title="${escapeHtml(j.filename)}">⚠ ${escapeHtml(j.filename)}</span>
            <span class="job-error-msg" title="${escapeHtml(j.error_message)}">${escapeHtml(j.error_message || 'Unknown error')}</span>
            <span class="job-actions">
                <button class="btn btn-sm btn-primary" onclick="retryJob(${j.id})">Retry</button>
                <button class="btn btn-sm" onclick="deleteJob(${j.id})">Remove</button>
            </span>
        </div>
    `).join('');
}

function renderCancelled(jobs) {
    const container = document.getElementById('cancelled-list');
    const countEl = document.getElementById('cancelled-count');
    countEl.textContent = jobs.length;
    if (jobs.length === 0) {
        container.innerHTML = '<div class="job-row" style="color:var(--text-dim);font-style:italic;">No cancelled jobs</div>';
        return;
    }
    container.innerHTML = jobs.map(j => `
        <div class="job-row">
            <span class="job-name" title="${escapeHtml(j.filename)}">${escapeHtml(j.filename)}</span>
            <span class="job-path">${escapeHtml(dirOf(j.relative_path))}</span>
            <span class="job-actions">
                <button class="btn btn-sm btn-primary" onclick="retryJob(${j.id})">Retry</button>
                <button class="btn btn-sm" onclick="deleteJob(${j.id})">Remove</button>
            </span>
        </div>
    `).join('');
}

function dirOf(relPath) {
    if (!relPath) return '';
    const parts = relPath.split('/');
    return parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : '';
}

// ── Actions ──────────────────────────────────────────────────

async function cancelJob(id) {
    try {
        await api('POST', `/api/jobs/${id}/cancel`);
    } catch (e) {
        console.error('Cancel failed:', e.message);
    }
}

async function retryJob(id) {
    try {
        await api('POST', `/api/jobs/${id}/retry`);
    } catch (e) {
        console.error('Retry failed:', e.message);
    }
}

async function deleteJob(id) {
    try {
        await api('DELETE', `/api/jobs/${id}`);
    } catch (e) {
        console.error('Delete failed:', e.message);
    }
}

// ── Polling ──────────────────────────────────────────────────

async function poll() {
    try {
        const [stats, jobs, workerStatus] = await Promise.all([
            api('GET', '/api/jobs/stats'),
            api('GET', '/api/jobs'),
            api('GET', '/api/worker/status')
        ]);
        renderStatsBar(stats);
        renderWorkerBadge(workerStatus);
        const downloading = jobs.filter(j => j.status === 'downloading');
        const pending = jobs.filter(j => j.status === 'pending' || j.status === 'unrestricting' || j.status === 'matching');
        const completed = jobs.filter(j => j.status === 'completed');
        const errors = jobs.filter(j => j.status === 'error');
        const cancelled = jobs.filter(j => j.status === 'cancelled');
        renderCurrentDownload(downloading[0] || null);
        renderQueue(pending);
        renderCompleted(completed);
        renderErrors(errors);
        renderCancelled(cancelled);
    } catch (e) {
        console.error('Poll error:', e.message);
    }
}

setInterval(poll, POLL_MS);
poll();

// ── Dialog management ────────────────────────────────────────

function openDialog(id) {
    const d = document.getElementById(id);
    if (d) d.showModal();
}

function closeDialog(id) {
    const d = document.getElementById(id);
    if (d) d.close();
}

// Close buttons
document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => closeDialog(btn.dataset.close));
});

// Click outside dialog content to close
document.querySelectorAll('dialog').forEach(dialog => {
    dialog.addEventListener('click', (e) => {
        if (e.target === dialog) dialog.close();
    });
});

// Collapsible sections
document.querySelectorAll('[data-toggle]').forEach(header => {
    header.addEventListener('click', () => {
        const target = document.getElementById(header.dataset.toggle);
        if (target) target.classList.toggle('collapsed');
        const chevron = header.querySelector('.chevron');
        if (chevron) chevron.textContent = target.classList.contains('collapsed') ? '▾' : '▴';
    });
});

// ── Header buttons ───────────────────────────────────────────

document.getElementById('btn-add').addEventListener('click', () => {
    document.getElementById('mega-url').value = '';
    document.getElementById('add-status').classList.add('hidden');
    openDialog('dialog-add');
});

document.getElementById('btn-settings').addEventListener('click', async () => {
    try {
        const config = await api('GET', '/api/config');
        document.getElementById('cfg-api-key').value = '';
        document.getElementById('cfg-api-key').placeholder = config.rd_api_key || 'Enter API key';
        document.getElementById('cfg-download-dir').value = config.download_dir || './downloads';
        document.getElementById('cfg-min-wait').value = config.min_wait_ms || 5000;
        document.getElementById('cfg-max-wait').value = config.max_wait_ms || 15000;
        document.getElementById('cfg-max-retries').value = config.max_retries || 3;
        document.getElementById('key-test-result').textContent = '';
    } catch (e) { console.error(e); }
    openDialog('dialog-settings');
});

document.getElementById('btn-logs').addEventListener('click', () => {
    openDialog('dialog-logs');
    loadLogs();
    logPollTimer = setInterval(loadLogs, 3000);
});

document.getElementById('dialog-logs').addEventListener('close', () => {
    if (logPollTimer) { clearInterval(logPollTimer); logPollTimer = null; }
});

// ── Add link ─────────────────────────────────────────────────

document.getElementById('btn-submit-link').addEventListener('click', async () => {
    const url = document.getElementById('mega-url').value.trim();
    const statusEl = document.getElementById('add-status');
    if (!url) {
        statusEl.textContent = 'Please enter a Mega folder URL';
        statusEl.className = 'add-status error';
        statusEl.classList.remove('hidden');
        return;
    }
    try {
        statusEl.textContent = 'Submitting...';
        statusEl.className = 'add-status info';
        statusEl.classList.remove('hidden');
        await api('POST', '/api/folders', { url });
        statusEl.textContent = 'Folder submitted! Parsing in progress...';
        statusEl.className = 'add-status success';
        setTimeout(() => closeDialog('dialog-add'), 2000);
    } catch (e) {
        statusEl.textContent = e.message;
        statusEl.className = 'add-status error';
        statusEl.classList.remove('hidden');
    }
});

// ── Settings ─────────────────────────────────────────────────

document.getElementById('btn-save-config').addEventListener('click', async () => {
    const updates = {};
    const apiKey = document.getElementById('cfg-api-key').value.trim();
    if (apiKey) updates.rd_api_key = apiKey;
    updates.download_dir = document.getElementById('cfg-download-dir').value.trim() || './downloads';
    updates.min_wait_ms = parseInt(document.getElementById('cfg-min-wait').value, 10) || 5000;
    updates.max_wait_ms = parseInt(document.getElementById('cfg-max-wait').value, 10) || 15000;
    updates.max_retries = parseInt(document.getElementById('cfg-max-retries').value, 10) || 3;
    try {
        await api('POST', '/api/config', updates);
        closeDialog('dialog-settings');
    } catch (e) {
        alert('Failed to save: ' + e.message);
    }
});

document.getElementById('btn-test-key').addEventListener('click', async () => {
    const result = document.getElementById('key-test-result');
    result.textContent = 'Testing...';
    result.style.color = '#888';
    try {
        const user = await api('GET', '/api/user');
        result.textContent = `✓ ${user.username} (${user.type})`;
        result.style.color = '#00d4aa';
    } catch (e) {
        result.textContent = `✗ ${e.message}`;
        result.style.color = '#ff6b6b';
    }
});

// ── Retry all ────────────────────────────────────────────────

document.getElementById('btn-retry-all').addEventListener('click', async () => {
    try {
        const res = await api('POST', '/api/jobs/retry-all');
        console.log(`Reset ${res.count} jobs`);
    } catch (e) {
        console.error('Retry all failed:', e.message);
    }
});

// ── Log viewer ───────────────────────────────────────────────

document.querySelectorAll('.log-filter').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.log-filter').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentLogLevel = btn.dataset.level;
        loadLogs();
    });
});

document.getElementById('btn-clear-logs').addEventListener('click', async () => {
    try {
        await api('DELETE', '/api/logs');
        loadLogs();
    } catch (e) { console.error(e); }
});

async function loadLogs() {
    try {
        let url = '/api/logs?limit=300';
        if (currentLogLevel) url += `&level=${currentLogLevel}`;
        const logs = await api('GET', url);
        const output = document.getElementById('log-output');
        const wasAtBottom = output.scrollTop + output.clientHeight >= output.scrollHeight - 30;
        output.innerHTML = logs.reverse().map(l =>
            `<div class="log-line ${l.level}"><span class="log-ts">${l.timestamp}</span> <span class="log-src">[${l.source}]</span> ${escapeHtml(l.message)}</div>`
        ).join('');
        if (wasAtBottom) output.scrollTop = output.scrollHeight;
    } catch (e) {
        console.error('Log load error:', e.message);
    }
}

// Expose to onclick handlers
window.cancelJob = cancelJob;
window.retryJob = retryJob;
window.deleteJob = deleteJob;
