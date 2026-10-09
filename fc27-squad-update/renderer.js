'use strict';

(() => {
  const api = window.fc27;
  const $ = (id) => document.getElementById(id);

  const els = {
    drop: $('drop'),
    viewOnline: $('viewOnline'),
    viewReady: $('viewReady'),
    updStatusLine: $('updStatusLine'),
    updStatus: $('updStatus'),
    updName: $('updName'),
    updMeta: $('updMeta'),
    updVersion: $('updVersion'),
    updDate: $('updDate'),
    updAt: $('updAt'),
    updDesc: $('updDesc'),
    updNote: $('updNote'),
    btnRefresh: $('btnRefresh'),
    btnBackOnline: $('btnBackOnline'),
    apiHost: $('apiHost'),
    fileName: $('fileName'),
    fileSize: $('fileSize'),
    fileDate: $('fileDate'),
    fileDir: $('fileDir'),
    warnings: $('warnings'),
    destChip: $('destChip'),
    destChipText: $('destChipText'),
    destPath: $('destPath'),
    destNote: $('destNote'),
    btnOpenDest: $('btnOpenDest'),
    btnChoose: $('btnChoose'),
    btnInstall: $('btnInstall'),
    btnInstallLabel: $('btnInstallLabel'),
    hint: $('hint'),
    progress: $('progress'),
    bar: $('bar'),
    barFill: $('barFill'),
    progressText: $('progressText'),
    result: $('result'),
    resultTitle: $('resultTitle'),
    resultText: $('resultText'),
    resultDetail: $('resultDetail'),
    toasts: $('toasts'),
    appVersion: $('appVersion'),
  };

  const MIN_BUSY_MS = 700;

  const REFRESH_MS = 60 * 1000;

  const state = {
    mode: 'online', // 'online' (dari server) atau 'manual' (file pilihan pengguna)
    file: null, // info file manual (dari proses main)
    installing: false,
    dest: { exists: false },
    update: { status: 'loading', config: null, installed: { state: 'none' }, stale: false, error: null },
    refreshing: false,
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // -------------------------------------------------------------------------
  // Format
  // -------------------------------------------------------------------------

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toLocaleString('id-ID', { maximumFractionDigits: 1 })} KB`;
    return `${(kb / 1024).toLocaleString('id-ID', { maximumFractionDigits: 1 })} MB`;
  }

  function formatDate(ms) {
    return new Date(ms).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
  }

  const MONTHS = [
    'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
  ];

  // "2026-10-09" menjadi "09 Oktober 2026" (tanpa konversi zona waktu).
  function formatSquadDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    return m ? `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
  }

  function formatUpdatedAt(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || Number.isNaN(d.getTime())) return 'Tidak diketahui';
    return d.toLocaleString('id-ID', {
      day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  // -------------------------------------------------------------------------
  // Notifikasi (toast)
  // -------------------------------------------------------------------------

  function toast(kind, title, text) {
    while (els.toasts.children.length >= 4) els.toasts.firstElementChild.remove();

    const node = document.createElement('div');
    node.className = 'toast';
    node.dataset.kind = kind;

    const strong = document.createElement('strong');
    strong.textContent = title;
    node.appendChild(strong);

    if (text) {
      const span = document.createElement('span');
      span.textContent = text;
      node.appendChild(span);
    }

    const dismiss = () => {
      if (!node.isConnected || node.classList.contains('is-leaving')) return;
      node.classList.add('is-leaving');
      setTimeout(() => node.remove(), 200);
    };
    node.addEventListener('click', dismiss);
    els.toasts.appendChild(node);
    setTimeout(dismiss, kind === 'error' ? 8000 : 5000);
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  function setStatusView(view) {
    els.hint.hidden = view !== 'hint';
    els.progress.hidden = view !== 'progress';
    els.result.hidden = view !== 'result';
  }

  function showResult(kind, title, text, detail) {
    els.result.dataset.kind = kind;
    els.resultTitle.textContent = title;
    els.resultText.textContent = text || '';
    els.resultText.hidden = !text;
    els.resultDetail.textContent = detail || '';
    els.resultDetail.hidden = !detail;
    setStatusView('result');
  }

  function renderUpdate() {
    const u = state.update;
    const cfg = u.config;

    let kind;
    let label;
    if (u.status === 'loading' && !cfg) {
      kind = 'loading';
      label = 'Memuat info update';
    } else if (u.status === 'error') {
      kind = 'error';
      label = 'Tidak terhubung ke server update';
    } else if (!cfg.enabled) {
      kind = 'off';
      label = 'Dinonaktifkan oleh admin';
    } else if (u.installed.state === 'current') {
      kind = 'current';
      label = 'Sudah terpasang';
    } else if (u.installed.state === 'outdated') {
      kind = 'available';
      label = `Pembaruan tersedia (terpasang: ${u.installed.version})`;
    } else {
      kind = 'available';
      label = 'Siap dipasang';
    }
    els.updStatusLine.dataset.state = kind;
    els.updStatus.textContent = label;

    els.updName.textContent = cfg ? cfg.name : u.status === 'error' ? 'Info update tidak bisa dimuat' : 'Squad update';
    els.updMeta.hidden = !cfg;
    if (cfg) {
      els.updVersion.textContent = cfg.version;
      els.updDate.textContent = formatSquadDate(cfg.squadDate);
      els.updAt.textContent = formatUpdatedAt(cfg.updatedAt);
    }
    els.updDesc.textContent = cfg ? cfg.description : '';
    els.updDesc.hidden = !cfg || !cfg.description;

    let note = '';
    let noteKind = '';
    if (u.status === 'error') {
      note = u.error + (cfg ? ' Data di atas adalah data terakhir yang berhasil dimuat, bukan data terbaru.' : '');
      noteKind = 'error';
    } else if (cfg && !cfg.enabled) {
      note = 'Admin sedang menonaktifkan update ini. Tombol Pasang aktif lagi saat admin mengaktifkannya.';
      noteKind = 'warn';
    } else if (u.stale) {
      note = 'Server belum bisa membaca data terbaru dari GitHub, jadi yang tampil adalah salinan terakhir di server.';
      noteKind = 'warn';
    }
    els.updNote.textContent = note;
    els.updNote.dataset.kind = noteKind;
    els.updNote.hidden = !note;

    els.drop.dataset.state = kind === 'available' || kind === 'current' ? 'ready' : 'empty';
  }

  function renderFile() {
    const manual = state.mode === 'manual' && state.file;
    els.viewOnline.hidden = Boolean(manual);
    els.viewReady.hidden = !manual;

    if (!manual) {
      renderUpdate();
      return;
    }

    const file = state.file;
    els.drop.dataset.state = 'ready';
    els.fileName.textContent = file.name;
    els.fileName.title = file.name;
    els.fileSize.textContent = formatBytes(file.size);
    els.fileDate.textContent = formatDate(file.modifiedMs);
    els.fileDir.textContent = file.dir;

    els.warnings.textContent = '';
    const warnings = file.warnings || [];
    for (const message of warnings) {
      const li = document.createElement('li');
      li.textContent = message;
      els.warnings.appendChild(li);
    }
    els.warnings.hidden = warnings.length === 0;
  }

  function canInstall() {
    if (state.mode === 'manual') return Boolean(state.file);
    const u = state.update;
    return u.status === 'ready' && Boolean(u.config) && u.config.enabled;
  }

  function currentHint() {
    if (state.mode === 'manual') return 'Klik Pasang untuk menyalin file ke folder game.';
    const u = state.update;
    if (u.status === 'loading') return 'Memuat info update.';
    if (u.status === 'error') return 'Info update belum bisa dimuat. Klik Muat Ulang.';
    if (!u.config.enabled) return 'Update sedang dinonaktifkan oleh admin.';
    if (u.installed.state === 'current') return 'Squad ini sudah terpasang. Klik Pasang untuk memasang ulang.';
    return 'Klik Pasang untuk mengunduh dan memasang squad.';
  }

  function renderControls() {
    const busy = state.installing;
    els.btnChoose.disabled = busy;
    els.btnRefresh.disabled = busy || state.refreshing;
    els.btnRefresh.textContent = state.refreshing ? 'Memuat' : 'Muat Ulang';
    els.btnBackOnline.disabled = busy;
    els.btnInstall.disabled = busy || !canInstall();
    els.btnInstall.classList.toggle('is-busy', busy);
    els.btnInstall.setAttribute('aria-busy', String(busy));
    els.btnInstallLabel.textContent = busy ? 'Memasang' : 'Pasang';
    els.btnOpenDest.disabled = busy || !state.dest.exists;
  }

  function renderDest(info) {
    if (!info) return;
    state.dest = info;
    els.destPath.textContent = info.destDir;

    if (info.exists) {
      els.destChip.dataset.state = 'ok';
      els.destChipText.textContent = 'Folder game ditemukan';
      els.destNote.textContent = '';
    } else if (info.notDirectory) {
      els.destChip.dataset.state = 'error';
      els.destChipText.textContent = 'Lokasi tujuan bermasalah';
      els.destNote.textContent = 'Lokasi ini ada, tetapi bukan folder. Pemasangan tidak bisa dilanjutkan.';
    } else if (info.errorCode) {
      els.destChip.dataset.state = 'error';
      els.destChipText.textContent = 'Folder game tidak bisa diperiksa';
      els.destNote.textContent = 'Windows menolak akses ke lokasi ini. Coba jalankan ulang aplikasi.';
    } else {
      els.destChip.dataset.state = 'missing';
      els.destChipText.textContent = 'Folder game belum ditemukan';
      els.destNote.textContent =
        'Folder ini dibuat game saat pertama kali dijalankan. Saat memasang, Anda bisa memilih untuk membuatnya.';
    }
    renderControls();
  }

  function render() {
    renderFile();
    renderControls();
    if (state.installing) {
      setStatusView('progress');
    } else if (els.result.hidden && els.progress.hidden) {
      els.hint.textContent = currentHint();
      setStatusView('hint');
    }
  }

  async function refreshDest() {
    try {
      renderDest(await api.checkDestination());
    } catch (_) {
      els.destChip.dataset.state = 'error';
      els.destChipText.textContent = 'Folder game tidak bisa diperiksa';
    }
  }

  // -------------------------------------------------------------------------
  // Info update dari server
  // -------------------------------------------------------------------------

  async function refreshUpdate() {
    if (state.installing || state.refreshing) return;
    state.refreshing = true;
    renderControls();

    let res;
    try {
      res = await api.fetchUpdate();
    } catch (_) {
      res = { ok: false, message: 'Info update tidak bisa dimuat karena kesalahan yang tidak terduga.' };
    }
    state.refreshing = false;

    const before = state.update;
    if (res && res.ok) {
      const changed =
        before.status === 'ready' &&
        before.config &&
        (before.config.version !== res.config.version || before.config.updatedAt !== res.config.updatedAt);
      state.update = {
        status: 'ready',
        config: res.config,
        installed: res.installed || { state: 'none' },
        stale: Boolean(res.stale),
        error: null,
      };
      if (changed) toast('success', 'Update diperbarui', `${res.config.name} ${res.config.version}`);
    } else {
      state.update = {
        status: 'error',
        config: before.config,
        installed: before.installed,
        stale: false,
        error: (res && res.message) || 'Info update tidak bisa dimuat.',
      };
    }

    if (state.mode === 'online') {
      // Hasil lama (pesan sukses atau gagal) tetap tampil sampai pengguna melakukan aksi berikutnya.
      render();
    } else {
      renderControls();
    }
  }

  // -------------------------------------------------------------------------
  // Pemilihan file manual
  // -------------------------------------------------------------------------

  function clearStatus() {
    els.result.hidden = true;
    els.progress.hidden = true;
  }

  function applyFileResult(res) {
    if (!res || res.canceled) return;

    if (!res.ok) {
      toast('error', 'File tidak bisa dipakai', res.error);
      return;
    }

    state.mode = 'manual';
    state.file = { ...res.file, warnings: res.warnings || [] };
    clearStatus();
    render();

    toast('success', 'File dipilih', res.file.name);
    if (res.warnings && res.warnings.length) {
      toast('warn', 'Periksa nama file', res.warnings[0]);
    }
  }

  async function chooseFile() {
    if (state.installing) return;
    try {
      applyFileResult(await api.chooseFile());
    } catch (_) {
      toast('error', 'Dialog file gagal dibuka', 'Tutup aplikasi lalu buka lagi.');
    }
  }

  function backToOnline() {
    if (state.installing) return;
    state.mode = 'online';
    state.file = null;
    clearStatus();
    render();
    refreshUpdate();
  }

  // -------------------------------------------------------------------------
  // Pemasangan
  // -------------------------------------------------------------------------

  function onProgress({ percent, text }) {
    if (!state.installing) return;
    const value = Math.max(0, Math.min(100, Math.round(percent)));
    els.barFill.style.setProperty('width', `${value}%`);
    els.bar.setAttribute('aria-valuenow', String(value));
    els.progressText.textContent = `${text} (${value}%)`;
  }

  async function install() {
    if (state.installing || !canInstall()) return;

    const online = state.mode === 'online';
    state.installing = true;
    els.result.hidden = true;
    els.barFill.style.setProperty('width', '0%');
    els.bar.setAttribute('aria-valuenow', '0');
    els.progressText.textContent = 'Menyiapkan';
    render();

    const startedAt = performance.now();
    let res;
    try {
      res = online ? await api.installUpdate() : await api.install();
    } catch (_) {
      res = { ok: false, code: 'FAILED', message: 'Pemasangan gagal karena kesalahan yang tidak terduga.' };
    }

    // Beri waktu tampil agar proses cepat tidak berkedip.
    if (res.code !== 'CANCELLED' && res.code !== 'BUSY') {
      const elapsed = performance.now() - startedAt;
      if (elapsed < MIN_BUSY_MS) await sleep(MIN_BUSY_MS - elapsed);
    }

    state.installing = false;
    els.progress.hidden = true;

    if (res.ok) {
      const lines = [`${res.fileName} sudah ada di folder settings game.`];
      if (res.replaced) lines.push('File lama dicadangkan sebelum ditimpa.');
      const title = online && res.version ? `Squad ${res.version} berhasil dipasang` : 'Squad berhasil dipasang';
      showResult('success', title, lines.join(' '), res.backupPath ? `Cadangan: ${res.backupPath}` : '');
      toast('success', 'Squad berhasil dipasang', 'Buka game untuk memakai squad terbaru.');
    } else if (res.code === 'CANCELLED') {
      showResult('info', 'Pemasangan dibatalkan', res.message);
      toast('warn', 'Pemasangan dibatalkan');
    } else if (res.code === 'DISABLED') {
      showResult('info', 'Update dinonaktifkan', res.message);
      toast('warn', 'Update dinonaktifkan', res.message);
    } else {
      showResult('error', 'Pemasangan gagal', res.message, res.detail);
      toast('error', 'Pemasangan gagal', res.message);
    }

    render();
    await refreshDest();
    if (online) await refreshUpdate();
  }

  async function openDestination() {
    try {
      const res = await api.openDestination();
      if (!res.ok) toast('error', 'Folder tidak bisa dibuka', res.message);
    } catch (_) {
      toast('error', 'Folder tidak bisa dibuka');
    }
  }

  // -------------------------------------------------------------------------
  // Event
  // -------------------------------------------------------------------------

  els.btnChoose.addEventListener('click', chooseFile);
  els.btnInstall.addEventListener('click', install);
  els.btnOpenDest.addEventListener('click', openDestination);

  els.btnRefresh.addEventListener('click', refreshUpdate);
  els.btnBackOnline.addEventListener('click', backToOnline);

  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      chooseFile();
    }
  });

  // Seret dan lepas file ke jendela.
  let dragDepth = 0;
  const hasFiles = (event) =>
    Boolean(event.dataTransfer) && Array.from(event.dataTransfer.types || []).includes('Files');

  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    document.body.classList.add('is-dragging');
  });

  window.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = state.installing ? 'none' : 'copy';
  });

  window.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove('is-dragging');
  });

  window.addEventListener('drop', async (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('is-dragging');

    if (state.installing) {
      toast('warn', 'Pemasangan sedang berjalan', 'Tunggu sampai selesai sebelum mengganti file.');
      return;
    }

    const files = event.dataTransfer.files;
    if (!files || files.length === 0) return;
    if (files.length > 1) toast('warn', 'Hanya satu file yang dipakai', 'File pertama yang dipilih.');

    try {
      applyFileResult(await api.setFileFromDrop(files[0]));
    } catch (_) {
      toast('error', 'File tidak bisa dibaca', 'Coba pilih lewat tombol Pilih File.');
    }
  });

  api.onProgress(onProgress);

  // -------------------------------------------------------------------------
  // Mulai
  // -------------------------------------------------------------------------

  render();
  refreshDest();
  refreshUpdate();
  setInterval(refreshUpdate, REFRESH_MS);
  window.addEventListener('focus', refreshUpdate);
  api
    .getAppInfo()
    .then((info) => {
      if (!info) return;
      if (info.version) els.appVersion.textContent = `Versi ${info.version}`;
      els.apiHost.textContent = info.apiHost ? `Server update: ${info.apiHost}` : 'Server update belum diatur';
    })
    .catch(() => {});
})();
