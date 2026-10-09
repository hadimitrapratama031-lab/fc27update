# FC27 Squad Update

Aplikasi Windows desktop (Electron) untuk memasang file squad update ke folder settings EA SPORTS FC 27.
Mengambil info dan file squad dari server update (Railway) dan GitHub. Tidak memakai database.

## Menjalankan

Butuh Node.js 18 atau lebih baru di komputer developer (tidak dibutuhkan di komputer pengguna akhir).

```bash
npm install
npm start
```

## Build portable EXE

```bash
npm install
npm run build
```

Hasil build:

```
dist/FC27-Squad-Update-1.1.0-Portable.exe
```

File ini berdiri sendiri: tidak perlu installer, Node.js, atau source code. Cukup salin ke komputer Windows mana pun lalu jalankan.
Saat dibuka, EXE portable mengekstrak dirinya ke folder sementara, jadi peluncuran pertama bisa terasa sedikit lebih lama.

## Cara kerja

1. Saat dibuka, aplikasi mengambil info squad terbaru dari server (nama, versi, tanggal squad, waktu terakhir diperbarui) dan memperbaruinya tiap menit.
2. Klik **Pasang**. Aplikasi mengunduh file dari GitHub, menampilkan progress, lalu memeriksa ukuran, format, dan SHA-256 (jika admin mengisinya).
3. Jika valid, file dicadangkan (bila sudah ada), disalin ke file sementara, diverifikasi, lalu diganti dengan rename.

Pemasangan manual tetap tersedia: **Pilih File Manual** atau seret file ke jendela.

Alamat server ada di `config.json` (`apiBaseUrl`). Isi sebelum build. Panduan lengkap deployment ada di `../README.md`.

Folder tujuan dibaca dari variabel lingkungan Windows, jadi otomatis mengikuti pengguna yang sedang aktif:

```
%LOCALAPPDATA%\EA SPORTS FC 27\settings
```

- Jika folder belum ada, aplikasi menanyakan dulu sebelum membuatnya.
- File lama dicadangkan ke subfolder `FC27SquadUpdate_Backup` di dalam folder settings sebelum ditimpa. Pada mode manual, aplikasi meminta konfirmasi dulu.
- File lain di folder game tidak disentuh.

## Struktur

| File | Fungsi |
| --- | --- |
| `main.js` | Proses utama Electron: validasi, backup, penyalinan, alur pasang, IPC |
| `lib/remote.js` | Akses jaringan: ambil config, unduh aman, validasi file unduhan |
| `config.json` | Alamat API Railway (bukan rahasia) |
| `preload.js` | Jembatan IPC sempit ke renderer (`contextIsolation` aktif) |
| `index.html`, `style.css`, `renderer.js` | Antarmuka |
| `assets/bg-stadium.jpg` | Background bawaan, ikut terbungkus di dalam EXE |
| `build/icon.ico` | Ikon aplikasi |

## Catatan build

`package.json` memakai `signAndEditExecutable: false` agar build berjalan tanpa hak administrator atau Developer Mode di Windows.
Akibatnya ikon `.ico` tidak ditanam ke dalam file EXE (Explorer menampilkan ikon bawaan Electron), tetapi ikon tetap tampil di jendela aplikasi.
Jika ingin ikon ikut tertanam, ubah nilainya menjadi `true`, lalu jalankan terminal sebagai Administrator atau aktifkan Developer Mode Windows.
