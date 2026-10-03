# Simple Upload

Server + UI upload file sederhana. **Tanpa dependency** — cuma butuh Node.js 18+ (dites di Node 24).

File yang di-upload disimpan ke folder `uploads/` di dalam project ini.

## Jalankan

```bash
npm start          # atau: node server.js
```

Buka <http://localhost:3000>, lalu klik atau tarik file ke kotak drop. Bisa banyak file sekaligus, ada progress bar per file.

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

| Method | Endpoint | Keterangan |
|---|---|---|
| `GET` | `/` | UI upload |
| `POST` | `/api/upload` | Terima `multipart/form-data`, field bernama `file` (boleh diulang) |
| `GET` | `/api/files` | Daftar file: nama, ukuran, mtime |
| `GET` | `/files/<nama>` | Lihat file inline; tambahkan `?download=1` untuk unduh |
| `DELETE` | `/api/files/<nama>` | Hapus file |

Contoh pakai curl:

```bash
curl -F "file=@foto.png" http://localhost:3000/api/upload
curl http://localhost:3000/api/files
curl -O "http://localhost:3000/files/foto.png?download=1"
curl -X DELETE http://localhost:3000/api/files/foto.png
```

## Catatan

- **Streaming.** Body multipart di-parse sambil jalan dan langsung ditulis ke disk, jadi file besar tidak menumpuk di memori. Backpressure socket ikut dijaga.
- **Nama bentrok** otomatis jadi `nama(1).ext`, `nama(2).ext`, dst.
- **Nama file disanitasi** (`path.basename`, karakter kontrol dibuang), dan endpoint file dilindungi dari path traversal — hanya file di dalam `UPLOAD_DIR` yang bisa diakses.
- **Belum ada autentikasi.** Cocok untuk jaringan lokal / pemakaian pribadi. Kalau dipublikasikan, pasang dulu reverse proxy dengan auth dan/atau batasi bind ke `127.0.0.1`.
- File yang gagal di tengah jalan akan dihapus, tidak menyisakan file setengah jadi.
