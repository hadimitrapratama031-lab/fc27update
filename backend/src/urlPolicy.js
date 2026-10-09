'use strict';

// Aturan link unduhan: HTTPS, host diizinkan, dan harus link unduhan langsung
// (bukan halaman repository GitHub).

function hostAllowed(hostname, allowedHosts) {
  const host = hostname.toLowerCase();
  return allowedHosts.some((entry) => {
    if (entry.startsWith('*.')) return host.endsWith(entry.slice(1)) && host.length > entry.length - 1;
    return host === entry;
  });
}

// Pemeriksaan ringan untuk tiap lompatan redirect (hanya skema dan host).
function checkHop(urlString, allowedHosts) {
  let url;
  try {
    url = new URL(urlString);
  } catch (_) {
    return { ok: false, message: 'Link tidak valid.' };
  }
  if (url.protocol !== 'https:') return { ok: false, message: 'Link harus memakai HTTPS.' };
  if (url.username || url.password) return { ok: false, message: 'Link tidak boleh berisi username atau password.' };
  if (url.port && url.port !== '443') return { ok: false, message: 'Link memakai port yang tidak diizinkan.' };
  if (!hostAllowed(url.hostname, allowedHosts)) {
    return { ok: false, message: `Host ${url.hostname} tidak diizinkan sebagai sumber unduhan.` };
  }
  return { ok: true, url };
}

// Pemeriksaan lengkap untuk link yang diisi admin.
function checkDownloadUrl(urlString, allowedHosts) {
  if (typeof urlString !== 'string' || urlString.length === 0) {
    return { ok: false, message: 'Link unduhan wajib diisi.' };
  }
  if (urlString.length > 2048) return { ok: false, message: 'Link terlalu panjang.' };

  const hop = checkHop(urlString, allowedHosts);
  if (!hop.ok) return hop;

  const { url } = hop;
  if (url.hostname.toLowerCase() === 'github.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    const [, , kind, sub] = parts;
    const isReleaseAsset = kind === 'releases' && (sub === 'download' || (sub === 'latest' && parts[4] === 'download'));
    const isRaw = kind === 'raw' && parts.length >= 5;

    if (!isReleaseAsset && !isRaw) {
      const hint =
        kind === 'blob'
          ? 'Link /blob/ adalah halaman pratinjau. Ganti "blob" menjadi "raw", atau pakai link aset di Releases.'
          : 'Itu link halaman GitHub, bukan link unduhan langsung. Pakai link aset dari Releases (.../releases/download/...) atau link Raw.';
      return { ok: false, message: hint };
    }
    if (isReleaseAsset) {
      // Bentuk: /owner/repo/releases/download/<tag>/<aset> atau /owner/repo/releases/latest/download/<aset>
      if (parts.length < 6) {
        return { ok: false, message: 'Link Releases harus menunjuk ke satu file aset, bukan halaman rilis.' };
      }
    }
  }

  return { ok: true, url };
}

module.exports = { hostAllowed, checkHop, checkDownloadUrl };
