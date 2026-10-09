'use strict';

(() => {
  const $ = (id) => document.getElementById(id);

  const FIELD_IDS = ['name', 'version', 'squadDate', 'description', 'downloadUrl', 'fileName', 'fileSize', 'checksum'];
  const MONTHS = [
    'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
  ];

  const els = {
    viewLogin: $('viewLogin'),
    viewEditor: $('viewEditor'),
    btnLogout: $('btnLogout'),
    loginForm: $('loginForm'),
    password: $('password'),
    loginError: $('loginError'),
    btnLogin: $('btnLogin'),
    form: $('squadForm'),
    enabled: $('enabled'),
    descCount: $('descCount'),
    hintSize: $('hint-size'),
    btnInspect: $('btnInspect'),
    inspectNote: $('inspectNote'),
    btnSave: $('btnSave'),
    btnReload: $('btnReload'),
    updatedLine: $('updatedLine'),
    dirtyLine: $('dirtyLine'),
    notice: $('notice'),
    noticeText: $('noticeText'),
    btnNoticeAction: $('btnNoticeAction'),
    toasts: $('toasts'),
    pvDot: $('pvDot'),
    pvStatus: $('pvStatus'),
    pvName: $('pvName'),
    pvVersion: $('pvVersion'),
    pvDate: $('pvDate'),
    pvUpdated: $('pvUpdated'),
    pvDesc: $('pvDesc'),
    pvButton: $('pvButton'),
  };
  for (const id of FIELD_IDS) els[id] = $(id);

  const state = {
    token: null,
    sha: null,
    savedAt: null, // updatedAt dari server
    snapshot: '', // isi form saat terakhir dimuat/disimpan
    busy: false,
  };

  // ---------------------------------------------------------------------------
  // Util
  // ---------------------------------------------------------------------------

  function storeToken(token) {
    try {
      if (token) sessionStorage.setItem('fc27.admin.token', token);
      else sessionStorage.removeItem('fc27.admin.token');
    } catch (_) {
      /* penyimpanan sesi tidak tersedia; sesi tetap jalan selama tab terbuka */
    }
  }

  function loadToken() {
    try {
      return sessionStorage.getItem('fc27.admin.token');
    } catch (_) {
      return null;
    }
  }

  function dateLabel(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return '';
    return `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
  }

  function dateTimeLabel(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('id-ID', {
      day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toLocaleString('id-ID', { maximumFractionDigits: 1 })} KB`;
    return `${(kb / 1024).toLocaleString('id-ID', { maximumFractionDigits: 1 })} MB`;
  }

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

  function setBusy(button, busy) {
    button.classList.toggle('is-busy', busy);
    button.disabled = busy;
    button.setAttribute('aria-busy', String(busy));
  }

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------

  class ApiError extends Error {
    constructor(status, body) {
      super((body && body.message) || 'Permintaan gagal.');
      this.status = status;
      this.code = body && body.code;
      this.fields = (body && body.fields) || null;
    }
  }

  async function api(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
    } catch (_) {
      throw new ApiError(0, { code: 'NETWORK', message: 'Tidak bisa terhubung ke server. Periksa koneksi internet Anda.' });
    }

    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      /* tubuh respons kosong */
    }
    if (res.status === 401 && state.token) {
      showLogin('Sesi admin berakhir. Masuk lagi untuk melanjutkan.');
    }
    if (!res.ok || !data || data.ok === false) throw new ApiError(res.status, data);
    return data;
  }

  // ---------------------------------------------------------------------------
  // Tampilan masuk / editor
  // ---------------------------------------------------------------------------

  function showLogin(message) {
    state.token = null;
    storeToken(null);
    els.viewEditor.hidden = true;
    els.viewLogin.hidden = false;
    els.btnLogout.hidden = true;
    els.password.value = '';
    showLoginError(message || '');
    els.password.focus();
  }

  function showLoginError(message) {
    els.loginError.textContent = message || '';
    els.loginError.hidden = !message;
    els.password.setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  function showEditor() {
    els.viewLogin.hidden = true;
    els.viewEditor.hidden = false;
    els.btnLogout.hidden = false;
  }

  // ---------------------------------------------------------------------------
  // Form
  // ---------------------------------------------------------------------------

  function readForm() {
    const sizeText = els.fileSize.value.replace(/[\s.,]/g, '');
    return {
      name: els.name.value.trim(),
      version: els.version.value.trim(),
      squadDate: els.squadDate.value,
      description: els.description.value.trim(),
      downloadUrl: els.downloadUrl.value.trim(),
      fileName: els.fileName.value.trim(),
      fileSize: sizeText === '' ? null : sizeText,
      checksum: els.checksum.value.trim().toLowerCase(),
      enabled: els.enabled.checked,
    };
  }

  function fillForm(config) {
    els.name.value = config.name || '';
    els.version.value = config.version || '';
    els.squadDate.value = config.squadDate || '';
    els.description.value = config.description || '';
    els.downloadUrl.value = config.downloadUrl || '';
    els.fileName.value = config.fileName || '';
    els.fileSize.value = config.fileSize ? String(config.fileSize) : '';
    els.checksum.value = config.checksum || '';
    els.enabled.checked = Boolean(config.enabled);
    state.savedAt = config.updatedAt || null;
    state.snapshot = JSON.stringify(readForm());
    clearErrors();
    hideNotice();
    refreshDerived();
  }

  function clearErrors() {
    for (const id of FIELD_IDS) {
      const message = $(`err-${id}`);
      message.hidden = true;
      message.textContent = '';
      els[id].removeAttribute('aria-invalid');
    }
  }

  function showFieldErrors(fields) {
    let first = null;
    for (const id of FIELD_IDS) {
      const text = fields && fields[id];
      const message = $(`err-${id}`);
      message.textContent = text || '';
      message.hidden = !text;
      if (text) {
        els[id].setAttribute('aria-invalid', 'true');
        if (!first) first = els[id];
      } else {
        els[id].removeAttribute('aria-invalid');
      }
    }
    if (first) first.focus();
  }

  function showNotice(text, { kind = 'error', action = null, label = 'Muat versi terbaru' } = {}) {
    els.notice.dataset.kind = kind;
    els.noticeText.textContent = text;
    els.btnNoticeAction.hidden = !action;
    els.btnNoticeAction.textContent = label;
    els.btnNoticeAction.onclick = action;
    els.notice.hidden = false;
  }

  function hideNotice() {
    els.notice.hidden = true;
    els.btnNoticeAction.onclick = null;
  }

  function refreshDerived() {
    const form = readForm();

    els.descCount.textContent = `${els.description.value.length} / 500`;

    const bytes = Number(form.fileSize);
    els.hintSize.textContent = form.fileSize && Number.isFinite(bytes) ? `Sekitar ${formatBytes(bytes)}` : '';

    els.updatedLine.textContent = state.savedAt
      ? `Terakhir diperbarui: ${dateTimeLabel(state.savedAt)}`
      : 'Terakhir diperbarui: belum pernah disimpan';
    els.dirtyLine.hidden = JSON.stringify(form) === state.snapshot;

    // Pratinjau tampilan di aplikasi.
    els.pvName.textContent = form.name || 'Nama squad update';
    els.pvVersion.textContent = form.version || '–';
    els.pvDate.textContent = dateLabel(form.squadDate) || '–';
    els.pvUpdated.textContent = state.savedAt ? dateTimeLabel(state.savedAt) : '–';
    els.pvDesc.textContent = form.description;
    els.pvDesc.hidden = !form.description;

    const isEmpty = !form.name && !form.version;
    els.pvDot.dataset.state = isEmpty ? 'empty' : form.enabled ? 'on' : 'off';
    els.pvStatus.textContent = isEmpty ? 'Belum diatur' : form.enabled ? 'Tersedia' : 'Dinonaktifkan oleh admin';
    els.pvButton.dataset.off = String(!form.enabled || isEmpty);
  }

  async function loadConfig({ announce = false } = {}) {
    setBusy(els.btnReload, true);
    try {
      const data = await api('GET', '/api/admin/squad-update');
      state.sha = data.sha || null;
      fillForm(data.config);
      showEditor();

      if (data.problems) {
        const detail = Object.values(data.problems)[0];
        showNotice(`Config di GitHub belum valid: ${detail} Perbaiki lalu simpan.`, { kind: 'error' });
        showFieldErrors(data.problems);
      } else if (!data.exists) {
        showNotice('Belum ada squad-config.json di GitHub. File dibuat otomatis saat Anda menyimpan.', { kind: 'ok' });
      }
      if (announce) toast('success', 'Data terbaru dimuat');
    } catch (err) {
      if (err.status !== 401) {
        toast('error', 'Config tidak bisa dimuat', err.message);
        if (els.viewEditor.hidden) showEditor();
        showNotice(err.message, { kind: 'error', action: () => loadConfig(), label: 'Coba lagi' });
      }
    } finally {
      setBusy(els.btnReload, false);
    }
  }

  async function save(event) {
    event.preventDefault();
    if (state.busy) return;

    clearErrors();
    hideNotice();
    state.busy = true;
    setBusy(els.btnSave, true);

    try {
      const payload = { ...readForm(), sha: state.sha };
      const data = await api('PUT', '/api/admin/squad-update', payload);
      state.sha = data.sha;
      fillForm(data.config);
      toast('success', 'Update tersimpan', 'Aplikasi akan memakai data ini pada pemeriksaan berikutnya.');
    } catch (err) {
      if (err.code === 'VALIDATION' && err.fields) {
        showFieldErrors(err.fields);
        toast('error', 'Update belum tersimpan', 'Periksa kolom yang ditandai.');
      } else if (err.code === 'CONFLICT') {
        showNotice(err.message, {
          kind: 'error',
          action: () => loadConfig({ announce: true }),
        });
        toast('error', 'Update belum tersimpan', 'Config sudah diubah di tempat lain.');
      } else if (err.status !== 401) {
        showNotice(`Update belum tersimpan. ${err.message}`, { kind: 'error' });
        toast('error', 'Update belum tersimpan', err.message);
      }
    } finally {
      state.busy = false;
      setBusy(els.btnSave, false);
    }
  }

  async function inspect() {
    clearErrors();
    const url = els.downloadUrl.value.trim();
    if (!url) {
      showFieldErrors({ downloadUrl: 'Isi link unduhan dulu.' });
      return;
    }
    setBusy(els.btnInspect, true);
    els.inspectNote.textContent = 'Mengunduh file di server. File besar bisa butuh beberapa menit.';
    try {
      const data = await api('POST', '/api/admin/squad-update/inspect', { downloadUrl: url });
      els.fileSize.value = String(data.fileSize);
      els.checksum.value = data.checksum;
      els.inspectNote.textContent = `Link valid. Ukuran ${formatBytes(data.fileSize)}, checksum terisi.`;
      refreshDerived();
    } catch (err) {
      els.inspectNote.textContent = 'Mengunduh file di server untuk mengisi ukuran dan checksum.';
      if (err.fields) showFieldErrors(err.fields);
      else if (err.status !== 401) showFieldErrors({ downloadUrl: err.message });
    } finally {
      setBusy(els.btnInspect, false);
    }
  }

  async function login(event) {
    event.preventDefault();
    const password = els.password.value;
    if (!password) {
      showLoginError('Masukkan password admin.');
      return;
    }
    showLoginError('');
    setBusy(els.btnLogin, true);
    try {
      const data = await api('POST', '/api/admin/login', { password });
      state.token = data.token;
      storeToken(data.token);
      els.password.value = '';
      await loadConfig();
    } catch (err) {
      showLoginError(err.message);
    } finally {
      setBusy(els.btnLogin, false);
    }
  }

  function logout() {
    showLogin('');
    toast('success', 'Anda sudah keluar');
  }

  // ---------------------------------------------------------------------------
  // Event
  // ---------------------------------------------------------------------------

  els.loginForm.addEventListener('submit', login);
  els.form.addEventListener('submit', save);
  els.form.addEventListener('input', refreshDerived);
  els.btnInspect.addEventListener('click', inspect);
  els.btnLogout.addEventListener('click', logout);
  els.btnReload.addEventListener('click', () => {
    if (els.dirtyLine.hidden || window.confirm('Perubahan yang belum disimpan akan hilang. Lanjutkan?')) {
      loadConfig({ announce: true });
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (!els.viewEditor.hidden && !els.dirtyLine.hidden) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  // ---------------------------------------------------------------------------
  // Mulai
  // ---------------------------------------------------------------------------

  const existing = loadToken();
  if (existing) {
    state.token = existing;
    loadConfig();
  } else {
    els.password.focus();
  }
})();
