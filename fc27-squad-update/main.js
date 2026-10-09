'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Menu,
  session,
  nativeTheme,
} = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const remote = require('./lib/remote');

// ---------------------------------------------------------------------------
// Konstanta
// ---------------------------------------------------------------------------

const GAME_FOLDER = 'EA SPORTS FC 27';
const SETTINGS_FOLDER = 'settings';
const BACKUP_FOLDER = 'FC27SquadUpdate_Backup';

const MIN_FILE_SIZE = 1024; // 1 KB
const MAX_FILE_SIZE = 256 * 1024 * 1024; // 256 MB

const EXECUTABLE_EXTENSIONS = new Set([
  '.exe', '.dll', '.bat', '.cmd', '.com', '.msi', '.scr', '.ps1', '.vbs',
  '.vbe', '.js', '.jse', '.wsf', '.lnk', '.reg', '.jar', '.sys', '.cpl',
]);
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.iso']);

const APP_ID = 'com.fc27.squadupdate';

// ---------------------------------------------------------------------------
// State proses main
// ---------------------------------------------------------------------------

let mainWindow = null;
let selectedFile = null; // { path, name, size, mtimeMs }
let installing = false;
let apiBase = null; // alamat API Railway (diisi saat siap)
let apiConfigError = null;

// ---------------------------------------------------------------------------
// Helper umum
// ---------------------------------------------------------------------------

function getLocalAppData() {
  // Selalu ikuti pengguna Windows yang sedang aktif.
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

function getDestDir() {
  return path.join(getLocalAppData(), GAME_FOLDER, SETTINGS_FOLDER);
}

async function statOrNull(target) {
  try {
    return await fsp.stat(target);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    throw err;
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toLocaleString('id-ID', { maximumFractionDigits: 1 })} KB`;
  const mb = kb / 1024;
  return `${mb.toLocaleString('id-ID', { maximumFractionDigits: 1 })} MB`;
}

function formatDate(ms) {
  return new Date(ms).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function samePath(a, b) {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function describeError(err) {
  const code = err && err.code;
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return 'Windows menolak akses ke folder tujuan. Tutup game jika sedang berjalan, lalu coba lagi.';
    case 'EBUSY':
      return 'File sedang dipakai program lain. Tutup EA SPORTS FC 27 lalu coba lagi.';
    case 'ENOSPC':
      return 'Ruang penyimpanan tidak cukup untuk menyalin file.';
    case 'EROFS':
      return 'Folder tujuan hanya bisa dibaca (read-only).';
    case 'ENOENT':
      return 'File atau folder tidak ditemukan saat pemasangan. Pilih ulang file lalu coba lagi.';
    case 'VERIFY_FAILED':
      return 'Verifikasi gagal: salinan tidak sama dengan file asli. File lama tidak diubah.';
    default:
      return 'Pemasangan gagal karena kesalahan yang tidak terduga.';
  }
}

function errorDetail(err) {
  if (!err) return '';
  return [err.code, err.message].filter(Boolean).join(': ');
}

// ---------------------------------------------------------------------------
// Validasi file sumber
// ---------------------------------------------------------------------------

async function validateSource(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0 || !path.isAbsolute(filePath)) {
    return { ok: false, error: 'Lokasi file tidak valid. Pilih file lewat tombol Pilih File.' };
  }

  let st;
  try {
    st = await fsp.stat(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ok: false, error: 'File tidak ditemukan. Mungkin sudah dipindahkan atau dihapus.' };
    }
    return { ok: false, error: 'File tidak bisa dibaca. Periksa izin akses file tersebut.' };
  }

  if (!st.isFile()) {
    return { ok: false, error: 'Yang dipilih adalah folder, bukan file. Pilih satu file squad update.' };
  }

  const name = path.basename(filePath);
  const ext = path.extname(name).toLowerCase();

  if (EXECUTABLE_EXTENSIONS.has(ext)) {
    return { ok: false, error: `File ${ext} adalah program, bukan file squad update, jadi tidak dipasang.` };
  }
  if (ARCHIVE_EXTENSIONS.has(ext)) {
    return { ok: false, error: `File ${ext} masih terkompres. Ekstrak dulu, lalu pilih file squad di dalamnya.` };
  }
  if (st.size < MIN_FILE_SIZE) {
    return { ok: false, error: 'File terlalu kecil untuk file squad update, kemungkinan rusak atau tidak lengkap.' };
  }
  if (st.size > MAX_FILE_SIZE) {
    return { ok: false, error: `File terlalu besar (${formatBytes(st.size)}). File squad update jauh lebih kecil dari itu.` };
  }

  try {
    await fsp.access(filePath, fs.constants.R_OK);
  } catch (_) {
    return { ok: false, error: 'File tidak bisa dibaca. Periksa izin akses file tersebut.' };
  }

  const warnings = [];
  if (!/^squads/i.test(name)) {
    warnings.push('Nama file tidak diawali "squads". Pastikan ini file squad update yang benar.');
  }

  return {
    ok: true,
    file: {
      path: filePath,
      name,
      ext,
      size: st.size,
      mtimeMs: st.mtimeMs,
    },
    warnings,
  };
}

function publicFileInfo(file) {
  return {
    name: file.name,
    ext: file.ext,
    size: file.size,
    modifiedMs: file.mtimeMs,
    dir: path.dirname(file.path),
  };
}

async function acceptFile(filePath) {
  const result = await validateSource(filePath);
  if (!result.ok) return { ok: false, error: result.error };
  selectedFile = result.file;
  return { ok: true, file: publicFileInfo(result.file), warnings: result.warnings };
}

// ---------------------------------------------------------------------------
// Proses pemasangan
// ---------------------------------------------------------------------------

function sendProgress(step, percent, text) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('install:progress', { step, percent, text });
  }
}

async function copyWithProgress(src, dest, total, onFraction) {
  let copied = 0;
  let lastPercent = -1;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      copied += chunk.length;
      const fraction = total > 0 ? Math.min(1, copied / total) : 1;
      const percent = Math.floor(fraction * 100);
      if (percent !== lastPercent) {
        lastPercent = percent;
        onFraction(fraction);
      }
      cb(null, chunk);
    },
  });
  await pipeline(fs.createReadStream(src), counter, fs.createWriteStream(dest, { flags: 'wx' }));
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

function failure(message, extra = {}) {
  return { ok: false, code: 'FAILED', message, ...extra };
}

// Memasang satu file sumber ke folder settings game (dipakai oleh mode online dan mode manual).
// Pemanggil yang memegang kunci `installing`.
async function installFromSource(expected, { confirmOverwrite = true, report = sendProgress } = {}) {
  let tmpPath = null;

  try {
    // 1. Validasi ulang file sumber (jangan percaya state lama).
    report('validate', 5, 'Memeriksa file');
    const check = await validateSource(expected.path);
    if (!check.ok) return failure(check.error);
    if (check.file.size !== expected.size || check.file.mtimeMs !== expected.mtimeMs) {
      return failure('File berubah setelah dipilih. Pilih ulang file tersebut.');
    }
    const source = check.file;

    // 2. Folder tujuan.
    report('folder', 15, 'Memeriksa folder tujuan');
    const destDir = getDestDir();
    const destStat = await statOrNull(destDir);

    if (!destStat) {
      const choice = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'FC27 Squad Update',
        message: 'Folder settings FC 27 belum ditemukan',
        detail:
          `${destDir}\n\n` +
          'Folder ini biasanya dibuat game saat pertama kali dijalankan. ' +
          'Jika game belum pernah dibuka, jalankan dulu sampai menu utama.\n\n' +
          'Buat folder ini sekarang dan lanjutkan pemasangan?',
        buttons: ['Buat Folder dan Lanjut', 'Batal'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (choice.response !== 0) {
        return {
          ok: false,
          code: 'CANCELLED',
          message: 'Pemasangan dibatalkan karena folder tujuan belum ada.',
        };
      }
      await fsp.mkdir(destDir, { recursive: true });
    } else if (!destStat.isDirectory()) {
      return failure('Lokasi tujuan ada, tetapi bukan folder. Pemasangan dihentikan.', { detail: destDir });
    }

    // 3. Tentukan file tujuan (hanya nama file, tidak ada traversal).
    const targetPath = path.join(destDir, source.name);
    const rel = path.relative(destDir, targetPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
      return failure('Nama file tidak aman untuk dipasang.');
    }
    if (samePath(source.path, targetPath)) {
      return failure('File ini sudah berada di folder tujuan. Pilih file dari lokasi lain.');
    }

    // 4. Konfirmasi timpa + backup.
    let backupPath = null;
    const existing = await statOrNull(targetPath);
    if (existing) {
      if (!existing.isFile()) {
        return failure('Di folder tujuan ada item bernama sama yang bukan file. Pemasangan dihentikan.', {
          detail: targetPath,
        });
      }

      const choice = !confirmOverwrite ? { response: 0 } : await dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: 'FC27 Squad Update',
        message: 'File dengan nama yang sama sudah ada',
        detail:
          `${source.name}\n\n` +
          `Di folder game: ${formatBytes(existing.size)}, diubah ${formatDate(existing.mtimeMs)}\n` +
          `File baru: ${formatBytes(source.size)}, diubah ${formatDate(source.mtimeMs)}\n\n` +
          `File lama akan dicadangkan ke subfolder ${BACKUP_FOLDER} sebelum ditimpa.`,
        buttons: ['Timpa dan Cadangkan', 'Batal'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (choice.response !== 0) {
        return {
          ok: false,
          code: 'CANCELLED',
          message: 'Pemasangan dibatalkan. File lama tidak diubah.',
        };
      }

      report('backup', 30, 'Mencadangkan file lama');
      const backupDir = path.join(destDir, BACKUP_FOLDER);
      await fsp.mkdir(backupDir, { recursive: true });
      const suffix = crypto.randomBytes(2).toString('hex');
      backupPath = path.join(backupDir, `${source.name}.${timestamp()}-${suffix}.bak`);
      await fsp.copyFile(targetPath, backupPath, fs.constants.COPYFILE_EXCL);
      const backupStat = await fsp.stat(backupPath);
      if (backupStat.size !== existing.size) {
        const err = new Error('Ukuran cadangan tidak sama dengan file asli.');
        err.code = 'VERIFY_FAILED';
        throw err;
      }
    }

    // 5. Salin ke file sementara di folder tujuan, lalu ganti nama (atomik).
    tmpPath = path.join(destDir, `.${source.name}.${crypto.randomBytes(4).toString('hex')}.fc27tmp`);
    report('copy', 40, 'Menyalin file');
    await copyWithProgress(source.path, tmpPath, source.size, (fraction) => {
      report('copy', 40 + Math.round(fraction * 45), 'Menyalin file');
    });

    // 6. Verifikasi isi salinan.
    report('verify', 90, 'Memverifikasi salinan');
    const [srcHash, tmpHash] = await Promise.all([hashFile(source.path), hashFile(tmpPath)]);
    if (srcHash !== tmpHash) {
      const err = new Error('Hash salinan tidak cocok.');
      err.code = 'VERIFY_FAILED';
      throw err;
    }

    // 7. Pasang.
    report('install', 96, 'Memasang file');
    await fsp.rename(tmpPath, targetPath);
    tmpPath = null;

    report('done', 100, 'Selesai');
    return {
      ok: true,
      code: 'OK',
      message: 'Squad berhasil dipasang.',
      fileName: source.name,
      targetPath,
      replaced: Boolean(existing),
      backupPath,
    };
  } catch (err) {
    return failure(describeError(err), { detail: errorDetail(err) });
  } finally {
    if (tmpPath) {
      try {
        await fsp.unlink(tmpPath);
      } catch (_) {
        /* file sementara sudah tidak ada */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Riwayat pemasangan (disimpan lokal di folder data aplikasi, bukan di game)
// ---------------------------------------------------------------------------

const installedFile = () => path.join(app.getPath('userData'), 'installed.json');
const downloadRoot = () => path.join(app.getPath('userData'), 'downloads');

function fingerprint(config) {
  const parts = [config.version, config.squadDate, config.downloadUrl, config.fileName, config.checksum, config.fileSize];
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

async function readInstalled() {
  try {
    const data = JSON.parse(await fsp.readFile(installedFile(), 'utf8'));
    if (data && typeof data.fingerprint === 'string' && typeof data.version === 'string') return data;
  } catch (_) {
    /* belum pernah memasang, atau file rusak: dianggap belum terpasang */
  }
  return null;
}

async function writeInstalled(record) {
  try {
    const file = installedFile();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(record), 'utf8');
    await fsp.rename(tmp, file);
  } catch (_) {
    /* riwayat hanya untuk label status; kegagalan menulisnya tidak membatalkan pemasangan */
  }
}

// ---------------------------------------------------------------------------
// Informasi update dari API
// ---------------------------------------------------------------------------

async function fetchUpdateInfo() {
  if (apiConfigError) throw apiConfigError;
  return remote.fetchSquadConfig(apiBase);
}

async function loadUpdateInfo() {
  try {
    const { config, stale } = await fetchUpdateInfo();
    const installed = await readInstalled();
    let state = 'none';
    if (installed) state = installed.fingerprint === fingerprint(config) ? 'current' : 'outdated';
    return {
      ok: true,
      config,
      stale,
      installed: installed ? { state, version: installed.version, at: installed.installedAt } : { state: 'none' },
    };
  } catch (err) {
    if (err instanceof remote.RemoteError) return { ok: false, code: err.code, message: err.message };
    return { ok: false, code: 'UNKNOWN', message: 'Info update tidak bisa dimuat karena kesalahan yang tidak terduga.' };
  }
}

// ---------------------------------------------------------------------------
// Pemasangan: dua jalur, satu mesin pemasangan
// ---------------------------------------------------------------------------

const BUSY_RESULT = { ok: false, code: 'BUSY', message: 'Pemasangan sedang berjalan. Tunggu sampai selesai.' };

// Jalur manual: file yang dipilih pengguna.
async function performLocalInstall() {
  if (installing) return BUSY_RESULT;
  if (!selectedFile) {
    return { ok: false, code: 'NO_FILE', message: 'Belum ada file yang dipilih. Klik Pilih File dulu.' };
  }
  installing = true;
  try {
    return await installFromSource(selectedFile, { confirmOverwrite: true });
  } finally {
    installing = false;
  }
}

// Jalur online: ambil config, unduh, validasi, lalu pasang.
async function performRemoteInstall() {
  if (installing) return BUSY_RESULT;
  installing = true;

  let workDir = null;
  try {
    sendProgress('config', 2, 'Mengambil data update');
    const { config } = await fetchUpdateInfo();

    if (!config.enabled) {
      return { ok: false, code: 'DISABLED', message: 'Update sedang dinonaktifkan oleh admin. Coba lagi nanti.' };
    }
    if (!remote.isDirectDownloadUrl(config.downloadUrl)) {
      return failure('Link unduhan dari server tidak valid. Hubungi admin.');
    }

    sendProgress('config', 5, 'Menyiapkan unduhan');
    await fsp.mkdir(downloadRoot(), { recursive: true });
    workDir = await fsp.mkdtemp(path.join(downloadRoot(), 'dl-'));
    const tmpFile = path.join(workDir, config.fileName);

    // Unduh (5% sampai 60%).
    let lastTick = 0;
    const download = await remote.downloadFile(config.downloadUrl, tmpFile, {
      expectedSize: config.fileSize,
      onProgress: (received, total) => {
        const now = Date.now();
        if (now - lastTick < 80 && received !== total) return;
        lastTick = now;
        const fraction = total > 0 ? Math.min(1, received / total) : 0;
        const text =
          total > 0
            ? `Mengunduh ${formatBytes(received)} dari ${formatBytes(total)}`
            : `Mengunduh ${formatBytes(received)}`;
        sendProgress('download', 5 + Math.round(fraction * 55), text);
      },
    });

    // Validasi ukuran, format, dan checksum sebelum menyentuh folder game.
    sendProgress('validate', 62, 'Memeriksa file unduhan');
    await remote.inspectDownloaded(tmpFile, config, download);

    const st = await fsp.stat(tmpFile);
    const result = await installFromSource(
      { path: tmpFile, size: st.size, mtimeMs: st.mtimeMs },
      {
        confirmOverwrite: false, // file lama selalu dicadangkan otomatis
        report: (step, percent, text) => sendProgress(step, 62 + Math.round(percent * 0.38), text),
      }
    );

    if (result.ok) {
      await writeInstalled({
        fingerprint: fingerprint(config),
        version: config.version,
        name: config.name,
        squadDate: config.squadDate,
        installedAt: new Date().toISOString(),
      });
      return { ...result, version: config.version, name: config.name };
    }
    return result;
  } catch (err) {
    if (err instanceof remote.RemoteError) return failure(err.message, { detail: err.detail || err.code });
    return failure(describeError(err), { detail: errorDetail(err) });
  } finally {
    if (workDir) await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    installing = false;
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function trusted(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents);
}

function registerIpc() {
  ipcMain.handle('app:info', (event) => {
    if (!trusted(event)) return null;
    return { version: app.getVersion(), apiHost: apiBase ? new URL(apiBase).host : null };
  });

  ipcMain.handle('update:fetch', async (event) => {
    if (!trusted(event)) return { ok: false, code: 'DENIED', message: 'Permintaan ditolak.' };
    return loadUpdateInfo();
  });

  ipcMain.handle('dest:check', async (event) => {
    if (!trusted(event)) return null;
    const destDir = getDestDir();
    try {
      const st = await statOrNull(destDir);
      return { destDir, exists: Boolean(st && st.isDirectory()), notDirectory: Boolean(st && !st.isDirectory()) };
    } catch (err) {
      return { destDir, exists: false, notDirectory: false, errorCode: err && err.code };
    }
  });

  ipcMain.handle('dest:open', async (event) => {
    if (!trusted(event)) return { ok: false };
    const destDir = getDestDir();
    const st = await statOrNull(destDir).catch(() => null);
    if (!st || !st.isDirectory()) return { ok: false, message: 'Folder tujuan belum ada.' };
    const error = await shell.openPath(destDir);
    return error ? { ok: false, message: 'Folder tidak bisa dibuka.' } : { ok: true };
  });

  ipcMain.handle('file:choose', async (event) => {
    if (!trusted(event)) return { ok: false, error: 'Permintaan ditolak.' };
    if (installing) return { ok: false, error: 'Tunggu pemasangan selesai sebelum mengganti file.' };

    const picked = await dialog.showOpenDialog(mainWindow, {
      title: 'Pilih file squad update',
      defaultPath: app.getPath('downloads'),
      properties: ['openFile'],
      filters: [{ name: 'Semua file', extensions: ['*'] }],
    });
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, canceled: true };
    return acceptFile(picked.filePaths[0]);
  });

  ipcMain.handle('file:set', async (event, filePath) => {
    if (!trusted(event)) return { ok: false, error: 'Permintaan ditolak.' };
    if (installing) return { ok: false, error: 'Tunggu pemasangan selesai sebelum mengganti file.' };
    return acceptFile(filePath);
  });

  ipcMain.handle('install:start', async (event) => {
    if (!trusted(event)) return { ok: false, code: 'DENIED', message: 'Permintaan ditolak.' };
    return performLocalInstall();
  });

  ipcMain.handle('install:remote', async (event) => {
    if (!trusted(event)) return { ok: false, code: 'DENIED', message: 'Permintaan ditolak.' };
    return performRemoteInstall();
  });
}

// ---------------------------------------------------------------------------
// Jendela
// ---------------------------------------------------------------------------

function createWindow() {
  nativeTheme.themeSource = 'dark';

  mainWindow = new BrowserWindow({
    width: 1040,
    height: 700,
    minWidth: 780,
    minHeight: 600,
    show: false,
    backgroundColor: '#09080c',
    title: 'FC27 Squad Update',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  mainWindow.on('close', (event) => {
    if (installing) {
      event.preventDefault();
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'FC27 Squad Update',
        message: 'Pemasangan masih berjalan',
        detail: 'Tunggu sampai selesai agar file game tidak rusak, lalu tutup aplikasi.',
        buttons: ['OK'],
        noLink: true,
      });
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// Siklus hidup aplikasi
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId(APP_ID);
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    try {
      apiBase = remote.resolveApiBase(__dirname, app.isPackaged);
    } catch (err) {
      apiConfigError = err;
    }
    // Sisa unduhan dari sesi yang terhenti mendadak dibersihkan.
    fsp.rm(downloadRoot(), { recursive: true, force: true }).catch(() => {});
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
