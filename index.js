'use strict';

const path = require('path');
const fastify = require('fastify')({ logger: false });
const db = require('./db');
const worker = require('./worker');

// ── Plugins ──────────────────────────────────────────────────

fastify.register(require('@fastify/formbody'));
fastify.register(require('@fastify/static'), {
    root: path.join(__dirname, 'public'),
    prefix: '/'
});

// ── Mega URL validation ─────────────────────────────────────

const MEGA_FOLDER_REGEX = /^https?:\/\/(www\.)?mega\.(nz|co\.nz)\/(folder\/[^#]+#.+|#F![^!]+!.+)$/i;

function isValidMegaFolder(url) {
    return MEGA_FOLDER_REGEX.test(url);
}

// ── API Routes ───────────────────────────────────────────────

// -- Folders --

fastify.post('/api/folders', async (req, reply) => {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string') {
        return reply.status(400).send({ error: 'Missing "url" field' });
    }
    const trimmed = url.trim();
    if (!isValidMegaFolder(trimmed)) {
        return reply.status(400).send({ error: 'Invalid Mega folder URL. Expected: https://mega.nz/folder/ID#KEY' });
    }
    const folderId = db.addFolder(trimmed);
    db.addLog('INFO', 'api', `Folder submitted: ${trimmed}`);
    // Parse in background — don't await
    worker.parseMegaFolder(trimmed, folderId).catch(err => {
        db.addLog('ERROR', 'api', `Background parse failed: ${err.message}`);
    });
    return reply.status(202).send({ id: folderId, status: 'parsing' });
});

fastify.get('/api/folders', async () => {
    return db.getAllFolders();
});

// -- Jobs --

fastify.get('/api/jobs', async (req) => {
    const statusParam = req.query.status;
    if (statusParam) {
        const statuses = statusParam.split(',').map(s => s.trim()).filter(Boolean);
        return db.getAllJobs(statuses);
    }
    return db.getAllJobs();
});

fastify.get('/api/jobs/stats', async () => {
    return db.getJobStats();
});

fastify.get('/api/jobs/:id', async (req, reply) => {
    const job = db.getJob(parseInt(req.params.id, 10));
    if (!job) return reply.status(404).send({ error: 'Job not found' });
    return job;
});

fastify.post('/api/jobs/:id/retry', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    const job = db.getJob(id);
    if (!job) return reply.status(404).send({ error: 'Job not found' });
    if (job.status !== 'error' && job.status !== 'cancelled') {
        return reply.status(400).send({ error: 'Can only retry failed or cancelled jobs' });
    }
    db.resetJob(id);
    db.addLog('INFO', 'api', `Job ${id} (${job.filename}) reset for retry`);
    return { success: true };
});

fastify.post('/api/jobs/retry-all', async () => {
    const count = db.resetAllFailed();
    db.addLog('INFO', 'api', `Reset ${count} failed jobs for retry`);
    return { success: true, count };
});

fastify.post('/api/jobs/:id/cancel', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    const job = db.getJob(id);
    if (!job) return reply.status(404).send({ error: 'Job not found' });
    if (job.status === 'completed') {
        return reply.status(400).send({ error: 'Cannot cancel completed job' });
    }
    db.updateStatus(id, 'cancelled');
    db.addLog('INFO', 'api', `Job ${id} (${job.filename}) cancelled`);
    return { success: true };
});

fastify.delete('/api/jobs/:id', async (req, reply) => {
    const id = parseInt(req.params.id, 10);
    const job = db.getJob(id);
    if (!job) return reply.status(404).send({ error: 'Job not found' });
    if (!['completed', 'cancelled', 'error'].includes(job.status)) {
        return reply.status(400).send({ error: 'Can only delete completed, cancelled, or errored jobs' });
    }
    db.deleteJob(id);
    return { success: true };
});

fastify.delete('/api/jobs/clear-completed', async () => {
    const count = db.clearCompleted();
    return { success: true, count };
});

// -- Logs --

fastify.get('/api/logs', async (req) => {
    const limit = parseInt(req.query.limit || '200', 10);
    const level = req.query.level || null;
    return db.getLogs(limit, level);
});

fastify.delete('/api/logs', async () => {
    db.clearLogs();
    return { success: true };
});

// -- Config --

fastify.get('/api/config', async () => {
    const config = worker.getConfig();
    // Redact API key
    const redacted = { ...config };
    if (redacted.rd_api_key && redacted.rd_api_key.length > 4) {
        redacted.rd_api_key = '***' + redacted.rd_api_key.slice(-4);
    }
    return redacted;
});

fastify.post('/api/config', async (req, reply) => {
    const updates = req.body;
    if (!updates || typeof updates !== 'object') {
        return reply.status(400).send({ error: 'Invalid config body' });
    }
    const config = worker.getConfig();
    const allowed = ['rd_api_key', 'download_dir', 'min_wait_ms', 'max_wait_ms', 'server_port', 'max_retries', 'concurrent_downloads', 'unrestrict_batch_size', 'unrestrict_batch_delay_ms'];
    for (const key of Object.keys(updates)) {
        if (allowed.includes(key)) {
            config[key] = updates[key];
        }
    }
    const fs = require('fs');
    fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));
    db.addLog('INFO', 'api', 'Config updated');
    return { success: true };
});

// -- Worker --

fastify.get('/api/worker/status', async () => {
    return worker.getStatus();
});

fastify.post('/api/worker/pause', async () => {
    worker.pause('Manual pause via UI');
    return { success: true };
});

fastify.post('/api/worker/resume', async () => {
    worker.resume();
    return { success: true };
});

// -- User verification --

fastify.get('/api/user', async (req, reply) => {
    try {
        const user = await worker.checkUser();
        return user;
    } catch (err) {
        const msg = err.response?.data?.error || err.message;
        return reply.status(err.response?.status || 500).send({ error: msg });
    }
});

// ── Startup ──────────────────────────────────────────────────

async function main() {
    // Init DB
    db.initDb();
    db.addLog('INFO', 'system', 'Database initialized');

    // Read config
    const config = worker.getConfig();
    const port = config.server_port || 3000;
    const host = config.server_host || '127.0.0.1';

    // Start Fastify
    try {
        await fastify.listen({ port, host });
        db.addLog('INFO', 'system', `Server running at http://127.0.0.1:${port}`);
        console.log(`\n  🚀 RD-Mega-DL running at http://127.0.0.1:${port}\n`);
    } catch (err) {
        console.error('Failed to start server:', err.message);
        process.exit(1);
    }

    // Start worker
    worker.start();

    // Graceful shutdown
    const shutdown = async () => {
        console.log('\nShutting down...');
        worker.stop();
        await fastify.close();
        db.closeDb();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main();
