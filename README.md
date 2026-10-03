# Simple Upload

Server + UI upload file sederhana. **Tanpa dependency** — cuma butuh Node.js 18+ (dites di Node 24).

File yang di-upload disimpan ke folder `uploads/` di dalam project ini.

## Jalankan

```bash
npm start          # atau: node server.js
```

Buka <http://localhost:3000>. Saat pertama kali dijalankan kamu akan diminta **membuat akun** — isi username dan password. Setelah itu kamu langsung masuk, dan seluruh halaman (upload, daftar file, download, hapus) baru bisa diakses setelah login.

Untuk upload: klik atau tarik file ke kotak drop. Bisa banyak file sekaligus, ada progress bar per file.

## Login

**Satu akun saja.** User pertama yang mendaftar jadi satu-satunya user. Begitu akun itu dibuat, form pendaftaran hilang dari UI dan `POST /api/auth/register` langsung menolak dengan status 403 — jadi tidak ada cara membuat akun kedua, baik lewat UI maupun lewat API.

Detail:

- Password di-hash dengan **scrypt** + salt acak (parameter N=16384), disimpan di `data/auth.json` dengan permission `600`. Password asli tidak pernah disimpan.
- Sesi pakai **cookie bertanda tangan HMAC-SHA256** (`HttpOnly`, `SameSite=Lax`, umur 7 hari). Karena stateless, kamu tetap login setelah server di-restart.
- Login gagal 10 kali dari satu IP akan dikunci 5 menit.
- Registrasi diserialkan, jadi dua request yang datang bersamaan tidak bisa membuat dua akun.

**Lupa password?** Tidak ada fitur reset. Hapus file `data/auth.json`, lalu restart server — kamu bisa mendaftar ulang dari nol. Konsekuensinya semua sesi lama ikut hangus.

```bash
rm -rf data/ && npm start
```

## Konfigurasi

Lewat environment variable:

| Variabel | Default | Keterangan |
|---|---|---|
| `PORT` | `3000` | Port server |
| `HOST` | `0.0.0.0` | Bind address (default bisa diakses dari LAN) |
| `UPLOAD_DIR` | `./uploads` | Folder tujuan file tersimpan |
| `MAX_FILE_SIZE` | `1073741824` (1 GB) | Batas ukuran per file, dalam byte |

Contoh:

```bash
PORT=8080 UPLOAD_DIR=/data/inbox node server.js
```

Mau file-nya langsung di root project (bukan `uploads/`)? Ganti `server.js:17`:

```js
: path.join(__dirname, 'uploads');   →   : __dirname;
```

## API

Semua endpoint di bawah `Auth`, kecuali `/api/auth/status`, `/api/auth/register`, dan `/api/auth/login`, **wajib login** — tanpa cookie sesi yang valid akan dijawab `401`.

| Method | Endpoint | Keterangan |
|---|---|---|
| `GET` | `/` | UI (menampilkan form login, atau aplikasi kalau sudah masuk) |
| `GET` | `/api/auth/status` | `{ registered, username }` — `username` terisi kalau sesi valid |
| `POST` | `/api/auth/register` | `{ username, password }` — hanya berhasil sekali, selanjutnya 403 |
| `POST` | `/api/auth/login` | `{ username, password }` — set cookie sesi |
| `POST` | `/api/auth/logout` | Hapus cookie sesi |
| `POST` | `/api/upload` | Terima `multipart/form-data`, field bernama `file` (boleh diulang) |
| `GET` | `/api/files` | Daftar file: nama, ukuran, mtime |
| `GET` | `/files/<nama>` | Lihat file inline; tambahkan `?download=1` untuk unduh |
| `DELETE` | `/api/files/<nama>` | Hapus file |

Contoh pakai curl:

```bash
# simpan cookie sesi ke cookies.txt
curl -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"username":"dehya","password":"rahasia123"}' http://localhost:3000/api/auth/login

curl -b cookies.txt -F "file=@foto.png" http://localhost:3000/api/upload
curl -b cookies.txt http://localhost:3000/api/files
curl -b cookies.txt -O "http://localhost:3000/files/foto.png?download=1"
curl -b cookies.txt -X DELETE http://localhost:3000/api/files/foto.png
```

## Catatan

- **Streaming.** Body multipart di-parse sambil jalan dan langsung ditulis ke disk, jadi file besar tidak menumpuk di memori. Backpressure socket ikut dijaga.
- **Nama bentrok** otomatis jadi `nama(1).ext`, `nama(2).ext`, dst.
- **Nama file disanitasi** (`path.basename`, karakter kontrol dibuang), dan endpoint file dilindungi dari path traversal — hanya file di dalam `UPLOAD_DIR` yang bisa diakses.
- **Akun pertama siapa pun yang menembak duluan.** Karena `HOST` default `0.0.0.0`, siapa pun di jaringan yang sama bisa membuka halaman dan mendaftarkan akun pertama sebelum kamu. Kalau belum sempat daftar, jalankan dengan `HOST=127.0.0.1 npm start`, atau daftar dulu sebelum server dibuka ke jaringan.
- **Tidak ada HTTPS.** Cookie sesi dikirim polos di jaringan lokal. Untuk pemakaian pribadi di LAN ini memadai; kalau mau diekspos ke internet, taruh di belakang reverse proxy dengan TLS.
- File yang gagal di tengah jalan akan dihapus, tidak menyisakan file setengah jadi.
