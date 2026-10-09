'use strict';

const crypto = require('crypto');
const { checkHop } = require('./urlPolicy');
const { MAX_FILE_SIZE } = require('./schema');

const MAX_REDIRECTS = 5;
const TOTAL_TIMEOUT_MS = 120000;

class InspectError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Mengunduh file dari link admin hanya untuk menghitung ukuran dan SHA-256.
// Setiap lompatan redirect diperiksa ulang terhadap daftar host yang diizinkan.
async function inspectRemoteFile(startUrl, allowedHosts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);

  try {
    let current = startUrl;
    let res = null;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const check = checkHop(current, allowedHosts);
      if (!check.ok) throw new InspectError(check.message);

      try {
        res = await fetch(check.url, {
          redirect: 'manual',
          headers: { 'User-Agent': 'fc27-squad-backend', Accept: 'application/octet-stream,*/*' },
          signal: controller.signal,
        });
      } catch (err) {
        if (err && err.name === 'AbortError') throw new InspectError('Pemeriksaan link melewati batas waktu.', 504);
        throw new InspectError('Link tidak bisa dijangkau dari server.', 502);
      }

      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location'), check.url).toString();
        if (res.body) await res.body.cancel().catch(() => {});
        res = null;
        continue;
      }
      break;
    }

    if (!res) throw new InspectError('Link terlalu banyak dialihkan (redirect).');
    if (res.status === 404) throw new InspectError('File tidak ditemukan di link ini (404). Periksa link dan pastikan repository atau rilis bersifat publik.');
    if (!res.ok) throw new InspectError(`Link mengembalikan kesalahan ${res.status}.`, 502);

    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (type.startsWith('text/html')) {
      throw new InspectError('Link ini mengarah ke halaman web, bukan file. Pakai link unduhan langsung.');
    }
    const declared = Number.parseInt(res.headers.get('content-length') || '', 10);
    if (Number.isFinite(declared) && declared > MAX_FILE_SIZE) {
      throw new InspectError('File lebih besar dari batas 256 MB.');
    }

    const hash = crypto.createHash('sha256');
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > MAX_FILE_SIZE) {
        controller.abort();
        throw new InspectError('File lebih besar dari batas 256 MB.');
      }
      hash.update(chunk);
    }

    if (size === 0) throw new InspectError('File kosong.');
    return { size, sha256: hash.digest('hex') };
  } catch (err) {
    if (err instanceof InspectError) throw err;
    if (err && err.name === 'AbortError') throw new InspectError('Pemeriksaan link melewati batas waktu.', 504);
    throw new InspectError('Pemeriksaan link gagal.', 502);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { inspectRemoteFile, InspectError };
