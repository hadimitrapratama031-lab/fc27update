'use strict';

// Semua akses jaringan aplikasi desktop ada di sini (proses main).
// Renderer tidak punya akses jaringan sama sekali (CSP connect-src 'none').

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

const MIN_FILE_SIZE = 1024;
const MAX_FILE_SIZE = 256 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const API_TIMEOUT_MS = 10000;
const IDLE_TIMEOUT_MS = 30000;

// Sumber unduhan yang diizinkan: hanya GitHub. Daftar ini sengaja ditanam di aplikasi,
// bukan diambil dari server, agar server yang salah konfigurasi tidak bisa mengarahkan unduhan ke host lain.
const ALLOWED_HOSTS = ['github.com', '*.githubusercontent.com'];

const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.dll', '.bat', '.cmd', '.com', '.msi', '.scr', '.ps1', '.vbs', '.vbe', '.js', '.jse',
  '.wsf', '.lnk', '.reg', '.jar', '.sys', '.cpl', '.zip', '.rar', '.7z', '.tar', '.gz', '.iso',
]);
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

class RemoteError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail || '';
  }
}

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

function hostAllowed(hostname) {
  const host = hostname.toLowerCase();
  return ALLOWED_HOSTS.some((entry) =>
    entry.startsWith('*.') ? host.endsWith(entry.slice(1)) && host.length > entry.length - 1 : host === entry
  );
}

function checkHop(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch (_) {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (url.port && url.port !== '443') return null;
  if (!hostAllowed(url.hostname)) return null;
  return url;
}

function isDirectDownloadUrl(urlString) {
  const url = checkHop(urlString);
  if (!url) return false;
  if (url.hostname.toLowerCase() !== 'github.com') return true;
  const parts = url.pathname.split('/').filter(Boolean);
  const kind = parts[2];
  const sub = parts[3];
  if (kind === 'releases' && sub === 'download') return parts.length >= 6;
  if (kind === 'releases' && sub === 'latest' && parts[4] === 'download') return parts.length >= 6;
  if (kind === 'raw') return parts.length >= 5;
  return false;
}

// ---------------------------------------------------------------------------
// Konfigurasi aplikasi (alamat API)
// ---------------------------------------------------------------------------

function resolveApiBase(appDir, isPackaged) {
  let value = process.env.FC27_API_URL || '';
  if (!value) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(appDir, 'config.json'), 'utf8'));
      value = typeof raw.apiBaseUrl === 'string' ? raw.apiBaseUrl : '';
    } catch (_) {
      value = '';
    }
  }
  value = value.trim().replace(/\/+$/, '');

  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw new RemoteError('NO_API', 'Alamat server update belum diatur di config.json.');
  }
  if (/GANTI-DENGAN/i.test(url.hostname)) {
    throw new RemoteError('NO_API', 'Alamat server update belum diatur. Isi apiBaseUrl di config.json lalu build ulang.');
  }
  const localDev = !isPackaged && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.protocol !== 'https:' && !localDev) {
    throw new RemoteError('NO_API', 'Alamat server update harus memakai HTTPS.');
  }
  return url.origin;
}

// ---------------------------------------------------------------------------
// Ambil konfigurasi dari API
// ---------------------------------------------------------------------------

function sanitizeConfig(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const s = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);

  const name = s(raw.name, 80);
  const version = s(raw.version, 40);
  const squadDate = s(raw.squadDate, 10);
  const description = s(raw.description ?? '', 500);
  const downloadUrl = s(raw.downloadUrl ?? '', 2048);
  const fileName = s(raw.fileName ?? '', 100);
  const checksum = s(raw.checksum ?? '', 64);
  if ([name, version, squadDate, description, downloadUrl, fileName, checksum].includes(null)) return null;
  if (!name || !version || !/^\d{4}-\d{2}-\d{2}$/.test(squadDate)) return null;
  if (checksum && !/^[0-9a-f]{64}$/.test(checksum)) return null;

  let fileSize = null;
  if (raw.fileSize !== null && raw.fileSize !== undefined) {
    if (!Number.isInteger(raw.fileSize) || raw.fileSize < MIN_FILE_SIZE || raw.fileSize > MAX_FILE_SIZE) return null;
    fileSize = raw.fileSize;
  }

  const updatedAt = typeof raw.updatedAt === 'string' && !Number.isNaN(Date.parse(raw.updatedAt)) ? raw.updatedAt : null;
  const enabled = raw.enabled === true;

  if (enabled) {
    if (!isDirectDownloadUrl(downloadUrl)) return null;
    if (!isSafeFileName(fileName)) return null;
  }

  return { name, version, squadDate, updatedAt, description, downloadUrl, fileName, fileSize, checksum, enabled };
}

function isSafeFileName(name) {
  if (!FILE_NAME_RE.test(name) || name.endsWith('.')) return false;
  if (WINDOWS_RESERVED.test(name.split('.')[0])) return false;
  const dot = name.lastIndexOf('.');
  return !(dot > 0 && BLOCKED_EXTENSIONS.has(name.slice(dot).toLowerCase()));
}

async function fetchSquadConfig(apiBase) {
  let res;
  try {
    res = await fetch(`${apiBase}/api/squad-update`, {
      headers: { Accept: 'application/json', 'User-Agent': 'FC27-Squad-Update' },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (err) {
    const timeout = err && err.name === 'TimeoutError';
    throw new RemoteError(
      'NETWORK',
      timeout
        ? 'Server update tidak merespons. Coba muat ulang sebentar lagi.'
        : 'Tidak bisa terhubung ke server update. Periksa koneksi internet Anda.'
    );
  }

  let text = '';
  try {
    text = await res.text();
  } catch (_) {
    throw new RemoteError('NETWORK', 'Koneksi ke server update terputus. Coba muat ulang.');
  }
  if (text.length > 64 * 1024) throw new RemoteError('BAD_RESPONSE', 'Respons server update tidak valid.');

  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_) {
    /* ditangani di bawah */
  }

  if (!res.ok) {
    if (data && data.code === 'NOT_CONFIGURED') {
      throw new RemoteError('NOT_CONFIGURED', 'Admin belum mengatur squad update. Coba lagi nanti.');
    }
    if (data && typeof data.message === 'string' && data.message.length < 300) {
      throw new RemoteError('SERVER', data.message, data.code);
    }
    throw new RemoteError('SERVER', `Server update mengembalikan kesalahan (${res.status}).`);
  }

  const config = data && data.ok === true ? sanitizeConfig(data.config) : null;
  if (!config) {
    throw new RemoteError('BAD_RESPONSE', 'Data update dari server tidak valid. Hubungi admin.');
  }
  return { config, stale: data.stale === true };
}

// ---------------------------------------------------------------------------
// Unduh file
// ---------------------------------------------------------------------------

async function downloadFile(startUrl, destPath, { expectedSize, onProgress }) {
  const controller = new AbortController();
  let idleTimer = null;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
  };

  try {
    armIdle();
    let current = startUrl;
    let res = null;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const url = checkHop(current);
      if (!url) throw new RemoteError('BAD_URL', 'Link unduhan diarahkan ke alamat yang tidak diizinkan. Unduhan dihentikan.');

      try {
        res = await fetch(url, {
          redirect: 'manual',
          headers: { Accept: 'application/octet-stream,*/*', 'User-Agent': 'FC27-Squad-Update' },
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) throw new RemoteError('TIMEOUT', 'Unduhan terhenti karena tidak ada data masuk. Coba lagi.');
        throw new RemoteError('NETWORK', 'Tidak bisa terhubung ke GitHub untuk mengunduh file. Periksa koneksi internet Anda.');
      }

      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location'), url).toString();
        if (res.body) await res.body.cancel().catch(() => {});
        res = null;
        continue;
      }
      break;
    }

    if (!res) throw new RemoteError('BAD_URL', 'Link unduhan dialihkan terlalu banyak kali.');
    if (res.status === 404) {
      throw new RemoteError('NOT_FOUND', 'File squad tidak ditemukan di GitHub (404). Hubungi admin untuk memeriksa link.');
    }
    if (!res.ok || !res.body) {
      throw new RemoteError('HTTP', `GitHub menolak unduhan (kode ${res.status}). Coba lagi nanti.`);
    }

    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (type.startsWith('text/html')) {
      throw new RemoteError('NOT_A_FILE', 'Link unduhan mengarah ke halaman web, bukan file. Hubungi admin.');
    }

    const declared = Number.parseInt(res.headers.get('content-length') || '', 10);
    const total = Number.isFinite(declared) ? declared : expectedSize || 0;
    if (Number.isFinite(declared) && declared > MAX_FILE_SIZE) {
      throw new RemoteError('TOO_LARGE', 'File lebih besar dari batas yang diizinkan (256 MB).');
    }

    const hash = crypto.createHash('sha256');
    let received = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        received += chunk.length;
        if (received > MAX_FILE_SIZE) {
          cb(new RemoteError('TOO_LARGE', 'File lebih besar dari batas yang diizinkan (256 MB).'));
          return;
        }
        hash.update(chunk);
        armIdle();
        onProgress(received, total);
        cb(null, chunk);
      },
    });

    try {
      await pipeline(
        Readable.fromWeb(res.body),
        counter,
        fs.createWriteStream(destPath, { flags: 'wx', mode: 0o600 }),
        { signal: controller.signal }
      );
    } catch (err) {
      if (err instanceof RemoteError) throw err;
      if (controller.signal.aborted) throw new RemoteError('TIMEOUT', 'Unduhan terhenti karena tidak ada data masuk. Coba lagi.');
      if (err && ['ENOSPC', 'EACCES', 'EPERM', 'EBUSY', 'EROFS', 'ENOENT'].includes(err.code)) {
        throw err; // kesalahan disk dijelaskan oleh pemanggil
      }
      throw new RemoteError('NETWORK', 'Koneksi terputus saat mengunduh. Coba lagi.');
    }

    if (Number.isFinite(declared) && received !== declared) {
      throw new RemoteError('INCOMPLETE', 'Unduhan tidak lengkap. Coba lagi.');
    }
    return { size: received, sha256: hash.digest('hex') };
  } finally {
    clearTimeout(idleTimer);
  }
}

// ---------------------------------------------------------------------------
// Validasi file hasil unduh
// ---------------------------------------------------------------------------

function sniffProblem(head) {
  const startsWith = (bytes) => bytes.every((b, i) => head[i] === b);
  if (startsWith([0x4d, 0x5a])) return 'Isi file adalah program Windows (EXE/DLL), bukan file squad.';
  if (startsWith([0x50, 0x4b, 0x03, 0x04]) || startsWith([0x50, 0x4b, 0x05, 0x06])) {
    return 'Isi file adalah arsip ZIP yang belum diekstrak, bukan file squad.';
  }
  if (startsWith([0x52, 0x61, 0x72, 0x21]) || startsWith([0x37, 0x7a, 0xbc, 0xaf]) || startsWith([0x1f, 0x8b])) {
    return 'Isi file adalah arsip terkompres, bukan file squad.';
  }
  if (startsWith([0x7f, 0x45, 0x4c, 0x46]) || startsWith([0x23, 0x21])) return 'Isi file adalah program, bukan file squad.';
  const text = head.toString('utf8', 0, 64).trimStart().toLowerCase();
  if (text.startsWith('<!doctype') || text.startsWith('<html') || text.startsWith('<?xml') || text.startsWith('{"message"')) {
    return 'Yang terunduh adalah halaman atau pesan galat, bukan file squad.';
  }
  return null;
}

async function inspectDownloaded(filePath, config, actual) {
  if (actual.size < MIN_FILE_SIZE) {
    throw new RemoteError('INVALID_FILE', 'File yang diunduh terlalu kecil, kemungkinan rusak atau tidak lengkap.');
  }
  if (config.fileSize && actual.size !== config.fileSize) {
    throw new RemoteError(
      'SIZE_MISMATCH',
      'Ukuran file yang diunduh tidak sama dengan data admin. File tidak dipasang.',
      `diharapkan ${config.fileSize} byte, diterima ${actual.size} byte`
    );
  }

  const handle = await fs.promises.open(filePath, 'r');
  try {
    const head = Buffer.alloc(64);
    const { bytesRead } = await handle.read(head, 0, 64, 0);
    const problem = sniffProblem(head.subarray(0, bytesRead));
    if (problem) throw new RemoteError('INVALID_FILE', `${problem} File tidak dipasang.`);
  } finally {
    await handle.close();
  }

  if (config.checksum && actual.sha256 !== config.checksum) {
    throw new RemoteError(
      'CHECKSUM_MISMATCH',
      'Checksum file tidak cocok dengan data admin, jadi file tidak dipasang. Mungkin file berubah atau unduhan rusak.',
      `diharapkan ${config.checksum}, diterima ${actual.sha256}`
    );
  }
}

module.exports = {
  RemoteError,
  MAX_FILE_SIZE,
  MIN_FILE_SIZE,
  resolveApiBase,
  fetchSquadConfig,
  downloadFile,
  inspectDownloaded,
  isDirectDownloadUrl,
};
