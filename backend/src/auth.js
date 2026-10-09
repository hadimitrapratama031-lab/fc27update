'use strict';

const crypto = require('crypto');

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCK_WINDOW_MS = 15 * 60 * 1000;

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function safeEqual(a, b) {
  // Hash dulu agar panjang sama dan perbandingan tetap waktu-konstan.
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function createAuth({ adminPassword, sessionSecret }) {
  const failures = new Map(); // ip -> { count, resetAt }

  function sign(payload) {
    return b64url(crypto.createHmac('sha256', sessionSecret).update(payload).digest());
  }

  function issueToken() {
    const payload = b64url(JSON.stringify({ exp: Date.now() + TOKEN_TTL_MS, n: crypto.randomBytes(8).toString('hex') }));
    return { token: `${payload}.${sign(payload)}`, expiresInSeconds: TOKEN_TTL_MS / 1000 };
  }

  function verifyToken(token) {
    if (typeof token !== 'string' || token.length > 512) return false;
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return false;
    const expected = sign(payload);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return typeof data.exp === 'number' && data.exp > Date.now();
    } catch (_) {
      return false;
    }
  }

  function lockState(ip) {
    const entry = failures.get(ip);
    if (!entry) return { locked: false };
    if (entry.resetAt <= Date.now()) {
      failures.delete(ip);
      return { locked: false };
    }
    return { locked: entry.count >= MAX_FAILURES, retryAfter: Math.ceil((entry.resetAt - Date.now()) / 1000) };
  }

  function login(ip, password) {
    const lock = lockState(ip);
    if (lock.locked) return { ok: false, status: 429, retryAfter: lock.retryAfter };

    if (typeof password === 'string' && password.length <= 256 && safeEqual(password, adminPassword)) {
      failures.delete(ip);
      return { ok: true, ...issueToken() };
    }

    const entry = failures.get(ip) || { count: 0, resetAt: Date.now() + LOCK_WINDOW_MS };
    entry.count += 1;
    failures.set(ip, entry);
    return { ok: false, status: 401 };
  }

  function requireAdmin(req, res, next) {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!verifyToken(token)) {
      res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: 'Sesi admin tidak valid atau sudah berakhir. Masuk lagi.' });
      return;
    }
    next();
  }

  // Bersihkan catatan percobaan login lama agar memori tidak membengkak.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of failures) if (entry.resetAt <= now) failures.delete(ip);
  }, 10 * 60 * 1000);
  sweeper.unref();

  return { login, requireAdmin };
}

module.exports = { createAuth };
