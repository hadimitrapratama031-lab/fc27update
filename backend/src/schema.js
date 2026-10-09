'use strict';

const { checkDownloadUrl } = require('./urlPolicy');

const SCHEMA_VERSION = 1;
const MAX_FILE_SIZE = 256 * 1024 * 1024;

const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);
const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.dll', '.bat', '.cmd', '.com', '.msi', '.scr', '.ps1', '.vbs', '.vbe', '.js', '.jse',
  '.wsf', '.lnk', '.reg', '.jar', '.sys', '.cpl', '.zip', '.rar', '.7z', '.tar', '.gz', '.iso',
]);

const MONTHS_ID = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

const FIELDS = [
  'name', 'version', 'downloadUrl', 'squadDate', 'description', 'fileName', 'fileSize', 'checksum', 'enabled',
];

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Mengubah input mentah (dari admin atau dari file GitHub) menjadi bentuk standar.
// Tidak pernah melempar error; kesalahan ditangkap oleh validate().
function coerce(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  let fileSize = null;
  if (src.fileSize !== null && src.fileSize !== undefined && src.fileSize !== '') {
    const n = Number(src.fileSize);
    fileSize = Number.isFinite(n) ? Math.trunc(n) : Number.NaN;
  }

  return {
    name: str(src.name),
    version: str(src.version),
    downloadUrl: str(src.downloadUrl),
    squadDate: str(src.squadDate),
    description: typeof src.description === 'string' ? src.description.trim() : '',
    fileName: str(src.fileName),
    fileSize,
    checksum: str(src.checksum).toLowerCase(),
    enabled: src.enabled === true,
    updatedAt: str(src.updatedAt),
  };
}

function isRealDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number);
  if (y < 2000 || y > 2100) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function formatDateLabel(iso) {
  if (!isRealDate(iso)) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return `${String(d).padStart(2, '0')} ${MONTHS_ID[m - 1]} ${y}`;
}

function extensionOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}

// Mengembalikan objek { field: pesan }. Kosong berarti valid.
function validate(config, { allowedHosts }) {
  const errors = {};

  if (!config.name) errors.name = 'Nama squad update wajib diisi.';
  else if (config.name.length > 80) errors.name = 'Nama maksimal 80 karakter.';

  if (!config.version) errors.version = 'Versi wajib diisi.';
  else if (config.version.length > 40) errors.version = 'Versi maksimal 40 karakter.';

  if (!config.squadDate) errors.squadDate = 'Tanggal squad update wajib diisi.';
  else if (!isRealDate(config.squadDate)) errors.squadDate = 'Tanggal tidak valid.';

  if (config.description.length > 500) errors.description = 'Deskripsi maksimal 500 karakter.';

  if (config.downloadUrl || config.enabled) {
    const urlCheck = checkDownloadUrl(config.downloadUrl, allowedHosts);
    if (!urlCheck.ok) errors.downloadUrl = urlCheck.message;
  }

  if (config.fileName || config.enabled) {
    const base = config.fileName.split('.')[0].toLowerCase();
    if (!config.fileName) errors.fileName = 'Nama file tujuan wajib diisi.';
    else if (!FILE_NAME_RE.test(config.fileName) || config.fileName.endsWith('.')) {
      errors.fileName = 'Nama file hanya boleh huruf, angka, titik, strip, dan garis bawah (maksimal 100 karakter).';
    } else if (WINDOWS_RESERVED.has(base)) {
      errors.fileName = 'Nama file ini dicadangkan oleh Windows. Pakai nama lain.';
    } else if (BLOCKED_EXTENSIONS.has(extensionOf(config.fileName))) {
      errors.fileName = 'Ekstensi ini bukan file squad (program atau arsip) dan tidak akan dipasang.';
    }
  }

  if (config.fileSize !== null) {
    if (!Number.isInteger(config.fileSize) || config.fileSize < 1024 || config.fileSize > MAX_FILE_SIZE) {
      errors.fileSize = 'Ukuran harus antara 1 KB dan 256 MB (dalam byte).';
    }
  }

  if (config.checksum && !/^[0-9a-f]{64}$/.test(config.checksum)) {
    errors.checksum = 'Checksum harus SHA-256: 64 karakter heksadesimal.';
  }

  return errors;
}

// Bentuk yang disimpan ke GitHub.
function toStored(config, updatedAtIso) {
  return {
    schemaVersion: SCHEMA_VERSION,
    name: config.name,
    version: config.version,
    squadDate: config.squadDate,
    updatedAt: updatedAtIso,
    description: config.description,
    downloadUrl: config.downloadUrl,
    fileName: config.fileName,
    fileSize: config.fileSize,
    checksum: config.checksum,
    enabled: config.enabled,
  };
}

// Bentuk yang dikirim ke klien (tanpa sha GitHub atau data internal).
function toPublic(config) {
  return {
    name: config.name,
    version: config.version,
    squadDate: config.squadDate,
    squadDateLabel: formatDateLabel(config.squadDate),
    updatedAt: config.updatedAt || null,
    description: config.description,
    downloadUrl: config.downloadUrl,
    fileName: config.fileName,
    fileSize: config.fileSize,
    checksum: config.checksum,
    enabled: config.enabled,
  };
}

function emptyConfig() {
  return coerce({});
}

module.exports = {
  FIELDS,
  MAX_FILE_SIZE,
  coerce,
  validate,
  toStored,
  toPublic,
  emptyConfig,
  formatDateLabel,
  isRealDate,
};
