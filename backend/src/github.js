'use strict';

const { coerce, validate, toStored } = require('./schema');

const API = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 12000;
const STALE_MAX_MS = 10 * 60 * 1000;

class StoreError extends Error {
  constructor(code, message, status = 502, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

// Penyimpanan konfigurasi: satu file JSON di repository GitHub.
// Tidak ada database dan tidak ada file lokal; memori hanya dipakai sebagai cache singkat.
class GitHubConfigStore {
  constructor({ github, cacheTtlMs, allowedHosts }) {
    this.gh = github;
    this.ttl = cacheTtlMs;
    this.allowedHosts = allowedHosts;
    this.cache = null; // { exists, config, sha, problems, fetchedAt }
    this.inflight = null;
    this.writeChain = Promise.resolve();
  }

  _contentsUrl() {
    const encodedPath = this.gh.configPath.split('/').map(encodeURIComponent).join('/');
    return `${API}/repos/${encodeURIComponent(this.gh.owner)}/${encodeURIComponent(this.gh.repo)}/contents/${encodedPath}`;
  }

  async _request(method, url, body) {
    try {
      return await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.gh.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'fc27-squad-backend',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (err && err.name === 'TimeoutError') {
        throw new StoreError('GITHUB_TIMEOUT', 'GitHub tidak merespons tepat waktu. Coba lagi sebentar lagi.', 504);
      }
      throw new StoreError('GITHUB_UNREACHABLE', 'Server tidak bisa terhubung ke GitHub. Coba lagi sebentar lagi.', 502);
    }
  }

  async _failure(res, { writing }) {
    let message = '';
    try {
      const data = await res.json();
      message = typeof data.message === 'string' ? data.message : '';
    } catch (_) {
      /* tubuh respons bukan JSON */
    }
    const lower = message.toLowerCase();
    const remaining = res.headers.get('x-ratelimit-remaining');

    if (res.status === 429 || (res.status === 403 && (remaining === '0' || lower.includes('rate limit')))) {
      let retryAfter = Number.parseInt(res.headers.get('retry-after') || '', 10);
      if (!Number.isFinite(retryAfter)) {
        const reset = Number.parseInt(res.headers.get('x-ratelimit-reset') || '', 10);
        retryAfter = Number.isFinite(reset) ? Math.max(1, reset - Math.floor(Date.now() / 1000)) : 60;
      }
      return new StoreError('GITHUB_RATE_LIMIT', 'Batas permintaan GitHub tercapai. Coba lagi beberapa saat lagi.', 503, { retryAfter });
    }
    if (res.status === 401) {
      return new StoreError('GITHUB_AUTH', 'GitHub menolak token server. Periksa GITHUB_TOKEN di Railway (mungkin kedaluwarsa).', 502);
    }
    if (res.status === 403) {
      return new StoreError('GITHUB_FORBIDDEN', 'Token GitHub tidak punya izin Contents (read and write) untuk repository ini.', 502);
    }
    if (writing && (res.status === 409 || (res.status === 422 && lower.includes('sha')))) {
      return new StoreError('CONFLICT', 'Konfigurasi sudah diubah di tempat lain. Muat ulang halaman, lalu simpan lagi.', 409);
    }
    if (res.status === 404) {
      return new StoreError('GITHUB_NOT_FOUND', 'Repository atau branch tidak ditemukan. Periksa GITHUB_OWNER, GITHUB_REPO, dan GITHUB_BRANCH.', 502);
    }
    if (res.status === 422) {
      return new StoreError('GITHUB_REJECTED', 'GitHub menolak permintaan penyimpanan.', 502);
    }
    return new StoreError('GITHUB_ERROR', `GitHub mengembalikan kesalahan (${res.status}).`, 502);
  }

  async _fetchRemote() {
    const url = `${this._contentsUrl()}?ref=${encodeURIComponent(this.gh.branch)}`;
    const res = await this._request('GET', url);

    if (res.status === 404) {
      // File belum ada: wajar sebelum admin menyimpan pertama kali.
      return { exists: false, config: coerce({}), sha: null, problems: null, fetchedAt: Date.now() };
    }
    if (!res.ok) throw await this._failure(res, { writing: false });

    let data;
    try {
      data = await res.json();
    } catch (_) {
      throw new StoreError('GITHUB_ERROR', 'Respons GitHub tidak bisa dibaca.', 502);
    }
    if (!data || Array.isArray(data) || typeof data.sha !== 'string' || data.encoding !== 'base64') {
      throw new StoreError('CONFIG_INVALID', 'File konfigurasi di GitHub tidak bisa dibaca (bukan file JSON biasa).', 502);
    }

    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    } catch (_) {
      return {
        exists: true,
        config: coerce({}),
        sha: data.sha,
        problems: { _file: 'Isi squad-config.json di GitHub bukan JSON yang valid.' },
        fetchedAt: Date.now(),
      };
    }

    const config = coerce(parsed);
    const problems = validate(config, { allowedHosts: this.allowedHosts });
    return {
      exists: true,
      config,
      sha: data.sha,
      problems: Object.keys(problems).length > 0 ? problems : null,
      fetchedAt: Date.now(),
    };
  }

  // Membaca konfigurasi. Memakai cache singkat; jika GitHub gagal, data lama yang masih
  // baru (maksimal 10 menit) dikembalikan dengan tanda stale.
  async read({ force = false } = {}) {
    const now = Date.now();
    if (!force && this.cache && now - this.cache.fetchedAt < this.ttl) {
      return { ...this.cache, stale: false };
    }

    if (!this.inflight) {
      this.inflight = this._fetchRemote()
        .then((entry) => {
          this.cache = entry;
          return entry;
        })
        .finally(() => {
          this.inflight = null;
        });
    }

    try {
      return { ...(await this.inflight), stale: false };
    } catch (err) {
      if (!force && this.cache && Date.now() - this.cache.fetchedAt < STALE_MAX_MS) {
        console.warn(`[github] gagal membaca (${err.code}); memakai cache lama`);
        return { ...this.cache, stale: true };
      }
      throw err;
    }
  }

  // Menyimpan konfigurasi ke GitHub. Hanya berhasil jika GitHub benar-benar menerima commit.
  write(config, sha) {
    const run = async () => {
      const stored = toStored(config, new Date().toISOString());
      const body = {
        message: `Update squad config: ${config.name} ${config.version}`.slice(0, 200),
        content: Buffer.from(`${JSON.stringify(stored, null, 2)}\n`, 'utf8').toString('base64'),
        branch: this.gh.branch,
      };
      if (sha) body.sha = sha;

      const res = await this._request('PUT', this._contentsUrl(), body);
      if (!res.ok) throw await this._failure(res, { writing: true });

      let data;
      try {
        data = await res.json();
      } catch (_) {
        data = null;
      }
      const newSha = data && data.content && typeof data.content.sha === 'string' ? data.content.sha : null;
      if (!newSha) {
        // Commit diterima tetapi respons tidak lengkap: paksa baca ulang dari GitHub.
        this.cache = null;
        const fresh = await this.read({ force: true });
        return { config: fresh.config, sha: fresh.sha };
      }

      const saved = coerce(stored);
      this.cache = { exists: true, config: saved, sha: newSha, problems: null, fetchedAt: Date.now() };
      return { config: saved, sha: newSha };
    };

    // Penyimpanan diproses satu per satu agar tidak saling bertabrakan di server yang sama.
    const result = this.writeChain.then(run, run);
    this.writeChain = result.catch(() => {});
    return result;
  }
}

module.exports = { GitHubConfigStore, StoreError };
