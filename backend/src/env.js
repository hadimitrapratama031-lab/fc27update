'use strict';

// Membaca dan memvalidasi environment variables saat start.
// Jika ada yang salah, server berhenti dengan pesan yang jelas (terlihat di log Railway).

const SAFE_NAME = /^[A-Za-z0-9_.-]+$/;
const SAFE_PATH = /^[A-Za-z0-9_./-]+$/;

const DEFAULT_ALLOWED_HOSTS = 'github.com,*.githubusercontent.com';

function loadEnv(env = process.env) {
  const errors = [];
  const get = (name) => (typeof env[name] === 'string' ? env[name].trim() : '');

  const adminPassword = env.ADMIN_PASSWORD || '';
  if (adminPassword.length < 12) errors.push('ADMIN_PASSWORD wajib diisi, minimal 12 karakter.');

  const sessionSecret = env.SESSION_SECRET || '';
  if (sessionSecret.length < 32) errors.push('SESSION_SECRET wajib diisi, minimal 32 karakter acak.');

  const githubToken = get('GITHUB_TOKEN');
  if (!githubToken) errors.push('GITHUB_TOKEN wajib diisi.');

  const owner = get('GITHUB_OWNER');
  if (!owner || !SAFE_NAME.test(owner)) errors.push('GITHUB_OWNER wajib diisi (nama akun atau organisasi GitHub).');

  const repo = get('GITHUB_REPO');
  if (!repo || !SAFE_NAME.test(repo)) errors.push('GITHUB_REPO wajib diisi (nama repository data).');

  const branch = get('GITHUB_BRANCH') || 'main';
  if (!SAFE_PATH.test(branch) || branch.includes('..')) errors.push('GITHUB_BRANCH tidak valid.');

  const configPath = get('GITHUB_CONFIG_PATH') || 'squad-config.json';
  if (!SAFE_PATH.test(configPath) || configPath.includes('..') || configPath.startsWith('/')) {
    errors.push('GITHUB_CONFIG_PATH tidak valid. Contoh: squad-config.json');
  }

  const port = Number.parseInt(get('PORT') || '3000', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('PORT tidak valid.');

  const ttl = Number.parseInt(get('CACHE_TTL_SECONDS') || '15', 10);
  if (!Number.isInteger(ttl) || ttl < 0 || ttl > 600) errors.push('CACHE_TTL_SECONDS harus 0 sampai 600.');

  const allowedHosts = (get('ALLOWED_DOWNLOAD_HOSTS') || DEFAULT_ALLOWED_HOSTS)
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (allowedHosts.length === 0) errors.push('ALLOWED_DOWNLOAD_HOSTS tidak boleh kosong.');

  if (errors.length > 0) {
    const err = new Error(`Konfigurasi environment belum benar:\n - ${errors.join('\n - ')}`);
    err.code = 'ENV_INVALID';
    throw err;
  }

  return {
    port,
    adminPassword,
    sessionSecret,
    github: { token: githubToken, owner, repo, branch, configPath },
    cacheTtlMs: ttl * 1000,
    allowedHosts,
  };
}

module.exports = { loadEnv };
