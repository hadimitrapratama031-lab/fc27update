# FC27 Squad Update: auto installer

Tiga bagian dalam satu folder:

| Folder | Isi | Dijalankan di |
| --- | --- | --- |
| `fc27-squad-update/` | Aplikasi desktop Electron (portable EXE) | Komputer pengguna |
| `backend/` | API Express + Admin Web (`/admin`) | Railway |
| `github-data/` | Contoh `squad-config.json` untuk repository data | GitHub |

Tidak ada database. Konfigurasi hidup di satu file JSON di GitHub. Railway hanya menjalankan API dan menyimpan cache singkat di memori; restart atau deploy ulang tidak menghilangkan data.

```
Admin Web ──PUT──▶ Railway API ──commit──▶ GitHub (squad-config.json)
                        ▲                         
Aplikasi desktop ──GET──┘   lalu unduh file langsung dari GitHub Releases
```

## 1. Siapkan GitHub

1. Buat repository **publik** untuk data, misalnya `fc27-squad-data`. File squad harus bisa diunduh tanpa login, dan Releases di repository privat tidak bisa diunduh anonim.
2. Salin `github-data/squad-config.json` ke root repository itu lalu commit. (Opsional: jika file tidak ada, backend membuatnya saat admin menyimpan pertama kali.)
3. Buat **fine-grained personal access token**: *Settings → Developer settings → Fine-grained tokens*.
   - Repository access: **Only select repositories**, pilih repository data saja.
   - Permissions: **Contents = Read and write**. Tidak perlu yang lain.
   - Simpan tokennya untuk langkah Railway. Token tidak pernah masuk ke aplikasi desktop atau source code.
4. Untuk tiap squad baru: buat **Release**, unggah file squad sebagai aset, lalu salin link aset (bentuk `https://github.com/<owner>/<repo>/releases/download/<tag>/<nama-file>`).

## 2. Deploy backend ke Railway

1. Push folder ini ke repository GitHub (boleh repository kode terpisah dari repository data).
2. Railway: **New Project → Deploy from GitHub repo**. Di *Settings → Source*, isi **Root Directory** dengan `backend`. Start command `npm start` terbaca otomatis dari `package.json`.
3. Tab **Variables**, isi:

| Variabel | Wajib | Keterangan |
| --- | --- | --- |
| `ADMIN_PASSWORD` | ya | Password login Admin Web, minimal 12 karakter |
| `SESSION_SECRET` | ya | String acak minimal 32 karakter. Buat: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `GITHUB_TOKEN` | ya | Token dari langkah 1 |
| `GITHUB_OWNER` | ya | Akun atau organisasi pemilik repository data |
| `GITHUB_REPO` | ya | Nama repository data |
| `GITHUB_BRANCH` | tidak | Default `main` |
| `GITHUB_CONFIG_PATH` | tidak | Default `squad-config.json` |
| `ALLOWED_DOWNLOAD_HOSTS` | tidak | Default `github.com,*.githubusercontent.com` |
| `CACHE_TTL_SECONDS` | tidak | Default `15` |

   `PORT` diisi Railway otomatis. Contoh lengkap ada di `backend/.env.example`.
4. *Settings → Networking → Generate Domain* untuk mendapatkan alamat API, misalnya `https://fc27-squad.up.railway.app`.
5. *Settings → Deploy → Healthcheck Path*: `/health`.
6. Buka `https://<domain>/admin/`, masuk dengan `ADMIN_PASSWORD`.

Jika variabel kurang atau salah, server berhenti saat start dan log Railway menampilkan variabel mana yang bermasalah.

## 3. Mengatur squad update (Admin Web)

1. Isi nama, versi, **tanggal squad update**, dan deskripsi.
2. Tempel link aset Releases di **Link unduhan**, lalu klik **Periksa link**. Server mengunduh file sekali untuk mengisi ukuran dan checksum SHA-256 otomatis.
3. Isi **Nama file tujuan** (nama file yang dipasang di folder settings game).
4. Nyalakan **Update aktif**, lalu klik **Simpan Update**.

Tanggal squad update dan "Terakhir diperbarui" adalah dua hal terpisah. Tanggal squad hanya berubah jika admin mengubah kolomnya. "Terakhir diperbarui" diisi server setiap kali konfigurasi disimpan. Tombol simpan hanya menampilkan "tersimpan" jika GitHub benar-benar menerima commit.

## 4. Build aplikasi desktop

1. Buka `fc27-squad-update/config.json` dan ganti `apiBaseUrl` dengan domain Railway (harus HTTPS).
2. Di folder `fc27-squad-update/`:

```bash
npm install
npm run build
```

Hasil: `dist/FC27-Squad-Update-1.1.0-Portable.exe`. Jalan tanpa installer dan tanpa Node.js. Untuk uji lokal dengan backend lokal: `FC27_API_URL=http://localhost:3000 npm start` (hanya berlaku saat tidak dibuild).

## 5. API

| Method | Path | Akses | Fungsi |
| --- | --- | --- | --- |
| GET | `/health` | publik | Status server |
| GET | `/api/squad-update` | publik | Konfigurasi aktif untuk aplikasi desktop |
| POST | `/api/admin/login` | publik, dibatasi percobaan | Menukar password dengan token sesi 12 jam |
| GET | `/api/admin/squad-update` | admin | Konfigurasi terbaru langsung dari GitHub, plus `sha` |
| PUT | `/api/admin/squad-update` | admin | Validasi lalu commit ke GitHub |
| POST | `/api/admin/squad-update/inspect` | admin | Hitung ukuran dan SHA-256 dari link unduhan |

Admin memakai header `Authorization: Bearer <token>`. Penyimpanan memakai `sha` file GitHub sebagai kunci konflik: jika dua admin menyimpan bersamaan, yang kedua mendapat pesan konflik dan diminta memuat ulang, bukan menimpa diam-diam.

## 6. Keamanan

- Token GitHub dan password admin hanya ada di variabel Railway.
- Aplikasi desktop tidak punya rahasia apa pun. Alamat API di `config.json` bukan rahasia.
- Unduhan hanya lewat HTTPS dari `github.com` dan `*.githubusercontent.com`. Daftar ini ditanam di aplikasi, dan setiap lompatan redirect diperiksa ulang.
- File unduhan tidak pernah dieksekusi. Aplikasi menolak file dengan tanda tangan program atau arsip (EXE, ZIP, RAR, 7z) dan halaman HTML.
- Sebelum menyentuh folder game, file diperiksa: ukuran, format, dan SHA-256 jika admin mengisinya.
- File lama dicadangkan ke `FC27SquadUpdate_Backup` di dalam folder settings. Penggantian memakai salin ke file sementara lalu rename, jadi file lama tidak pernah setengah tertimpa.
- Jendela Electron memakai `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, dan CSP yang melarang koneksi dari halaman.

## 7. Daftar uji untuk Anda

Backend dan aplikasi sudah dicek sintaksnya saja. Alur berikut belum dijalankan dan perlu Anda uji:

1. Login admin dengan password salah (5 kali berturut-turut memicu kunci 15 menit), lalu dengan password benar.
2. Ubah link dan tanggal, klik Simpan. Cek commit baru di repository data dan isi `squad-config.json`.
3. Ubah hanya deskripsi: `squadDate` harus tetap, `updatedAt` harus berubah.
4. Buka `/api/squad-update` di browser: data terbaru muncul (maksimal tertunda `CACHE_TTL_SECONDS`).
5. Buka aplikasi desktop: nama, versi, "Squad Update" (tanggal), dan "Terakhir diperbarui" cocok dengan admin.
6. Klik Pasang: progress unduhan, lalu file muncul di `%LOCALAPPDATA%\EA SPORTS FC 27\settings`. Pasang kedua kali: file lama ada di `FC27SquadUpdate_Backup`.
7. Restart service di Railway: konfigurasi tetap sama.
8. Kegagalan: matikan internet; link 404; checksum sengaja salah; link halaman repository biasa; token GitHub dicabut; simpan bersamaan dari dua tab (harus muncul pesan konflik); matikan "Update aktif".

## 8. Hal yang perlu Anda ketahui

- **Format file FC27 belum bisa diverifikasi dari sini.** Admin bebas mengisi nama file tujuan (aturan aman Windows berlaku). Pastikan nama itu sama dengan nama file squad yang benar-benar dibaca FC27. Aplikasi hanya menolak file yang jelas salah (program, arsip, halaman web).
- EXE tidak ditandatangani, jadi Windows SmartScreen bisa menampilkan peringatan pada peluncuran pertama.
- Repository tempat Releases berada harus publik.
- Admin Web yang disebut di prompt tidak ada di zip, jadi dibuat baru di `backend/public/admin` dengan bahasa visual yang sama dengan aplikasi desktop. Jika Anda punya Admin Web lain, endpoint di bagian 5 bisa dipakai langsung.
- Pemasangan manual dari file lokal (Pilih File Manual dan seret-lepas) tetap ada sebagai cadangan.
