'use strict';

const path = require('path');
const express = require('express');

const { loadEnv } = require('./env');
const { createAuth } = require('./auth');
const { GitHubConfigStore, StoreError } = require('./github');
const { coerce, validate, toPublic } = require('./schema');
const { checkDownloadUrl } = require('./urlPolicy');
const { inspectRemoteFile, InspectError } = require('./inspect');

function createApp(cfg) {
  const app = express();
  const auth = createAuth(cfg);
  const store = new GitHubConfigStore({
    github: cfg.github,
    cacheTtlMs: cfg.cacheTtlMs,
    allowedHosts: cfg.allowedHosts,
  });

  let inspecting = false;

  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Railway berada di belakang satu proxy.

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Strict-Transport-Security': 'max-age=15552000',
      'Content-Security-Policy':
        "default-src 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });

  app.use(express.json({ limit: '16kb' }));

  const fail = (res, status, code, message, extra = {}) =>
    res.status(status).json({ ok: false, code, message, ...extra });

  function sendStoreError(res, err) {
    if (err instanceof StoreError) {
      console.error(`[api] ${err.code}`);
      if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));
      return fail(res, err.status, err.code, err.message);
    }
    console.error('[api] kesalahan tak terduga:', err && err.message);
    return fail(res, 500, 'INTERNAL', 'Terjadi kesalahan di server.');
  }

  // ---- Publik -------------------------------------------------------------

  app.get('/health', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, service: 'fc27-squad-backend', uptime: Math.round(process.uptime()) });
  });

  // Konfigurasi aktif untuk aplikasi desktop.
  app.get('/api/squad-update', async (_req, res) => {
    try {
      const entry = await store.read();
      if (!entry.exists) {
        return fail(res, 404, 'NOT_CONFIGURED', 'Admin belum mengatur squad update.');
      }
      if (entry.problems) {
        console.error('[api] CONFIG_INVALID', Object.keys(entry.problems).join(','));
        return fail(res, 502, 'CONFIG_INVALID', 'Konfigurasi squad update di server belum valid. Hubungi admin.');
      }
      return res.json({ ok: true, stale: entry.stale, config: toPublic(entry.config) });
    } catch (err) {
      return sendStoreError(res, err);
    }
  });

  // ---- Admin --------------------------------------------------------------

  app.post('/api/admin/login', (req, res) => {
    const result = auth.login(req.ip, req.body && req.body.password);
    if (result.ok) {
      return res.json({ ok: true, token: result.token, expiresInSeconds: result.expiresInSeconds });
    }
    if (result.status === 429) {
      res.set('Retry-After', String(result.retryAfter));
      return fail(res, 429, 'TOO_MANY_ATTEMPTS', `Terlalu banyak percobaan. Coba lagi dalam ${Math.ceil(result.retryAfter / 60)} menit.`);
    }
    return fail(res, 401, 'BAD_PASSWORD', 'Password salah.');
  });

  app.get('/api/admin/squad-update', auth.requireAdmin, async (_req, res) => {
    try {
      const entry = await store.read({ force: true });
      return res.json({
        ok: true,
        exists: entry.exists,
        sha: entry.sha,
        config: toPublic(entry.config),
        problems: entry.problems,
      });
    } catch (err) {
      return sendStoreError(res, err);
    }
  });

  app.put('/api/admin/squad-update', auth.requireAdmin, async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail(res, 400, 'BAD_REQUEST', 'Data yang dikirim tidak valid.');
    }
    const sha = body.sha === null || body.sha === undefined ? null : body.sha;
    if (sha !== null && (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha))) {
      return fail(res, 400, 'BAD_REQUEST', 'Penanda versi (sha) tidak valid. Muat ulang halaman.');
    }

    const config = coerce(body);
    const errors = validate(config, { allowedHosts: cfg.allowedHosts });
    if (Object.keys(errors).length > 0) {
      return fail(res, 400, 'VALIDATION', 'Periksa kolom yang ditandai.', { fields: errors });
    }

    try {
      const saved = await store.write(config, sha);
      return res.json({ ok: true, sha: saved.sha, config: toPublic(saved.config) });
    } catch (err) {
      return sendStoreError(res, err);
    }
  });

  // Menghitung ukuran dan SHA-256 dari link unduhan agar admin tidak mengetik manual.
  app.post('/api/admin/squad-update/inspect', auth.requireAdmin, async (req, res) => {
    const url = req.body && typeof req.body.downloadUrl === 'string' ? req.body.downloadUrl.trim() : '';
    const check = checkDownloadUrl(url, cfg.allowedHosts);
    if (!check.ok) return fail(res, 400, 'VALIDATION', check.message, { fields: { downloadUrl: check.message } });

    if (inspecting) return fail(res, 429, 'BUSY', 'Pemeriksaan link lain sedang berjalan. Tunggu sebentar.');
    inspecting = true;
    try {
      const result = await inspectRemoteFile(url, cfg.allowedHosts);
      return res.json({ ok: true, fileSize: result.size, checksum: result.sha256 });
    } catch (err) {
      if (err instanceof InspectError) return fail(res, err.status, 'INSPECT_FAILED', err.message);
      return fail(res, 500, 'INTERNAL', 'Terjadi kesalahan di server.');
    } finally {
      inspecting = false;
    }
  });

  app.use('/api', (_req, res) => fail(res, 404, 'NOT_FOUND', 'Endpoint tidak ditemukan.'));

  // ---- Admin Web (berkas statis) -----------------------------------------

  app.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin'), { index: 'index.html', maxAge: 0 }));
  app.get('/', (_req, res) => res.redirect('/admin/'));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err && err.type === 'entity.parse.failed') return fail(res, 400, 'BAD_REQUEST', 'Format JSON tidak valid.');
    if (err && err.type === 'entity.too.large') return fail(res, 413, 'TOO_LARGE', 'Data terlalu besar.');
    console.error('[server] kesalahan tak terduga:', err && err.message);
    return fail(res, 500, 'INTERNAL', 'Terjadi kesalahan di server.');
  });

  return app;
}

function main() {
  let cfg;
  try {
    cfg = loadEnv();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const app = createApp(cfg);
  const server = app.listen(cfg.port, () => {
    console.log(`FC27 Squad backend berjalan di port ${cfg.port}`);
    console.log(`Config: ${cfg.github.owner}/${cfg.github.repo}@${cfg.github.branch}:${cfg.github.configPath}`);
  });

  // Railway mengirim SIGTERM saat deploy ulang.
  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  });
}

if (require.main === module) main();

module.exports = { createApp };
