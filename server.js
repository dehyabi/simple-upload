#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const auth = require('./auth');

// ── Konfigurasi ──────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Folder tempat file hasil upload disimpan.
// Mau file-nya langsung nongol di folder project ini? Ganti jadi: __dirname
const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, 'uploads');

const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE) || 1024 * 1024 * 1024; // 1 GB / file
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
};

const MAX_JSON_BODY = 8 * 1024;

// ── Helper ───────────────────────────────────────────────────────────────────
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BODY) {
        reject(Object.assign(new Error('Body terlalu besar'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(Object.assign(new Error('JSON tidak valid'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// Batasi percobaan login per IP: 10 gagal -> kunci 5 menit.
const LOGIN_MAX_FAILS = 10;
const LOGIN_LOCK_MS = 5 * 60 * 1000;
const loginFails = new Map();

function loginLockRemaining(ip) {
  const entry = loginFails.get(ip);
  if (!entry) return 0;
  if (entry.until && entry.until > Date.now()) return entry.until - Date.now();
  return 0;
}

function noteLoginFail(ip) {
  const entry = loginFails.get(ip) || { count: 0, until: 0 };
  entry.count += 1;
  if (entry.count >= LOGIN_MAX_FAILS) {
    entry.until = Date.now() + LOGIN_LOCK_MS;
    entry.count = 0;
  }
  loginFails.set(ip, entry);
}

// Mengembalikan username kalau cookie sesi valid, atau null (tanpa merespons).
function currentUser(req) {
  const token = auth.parseCookies(req.headers.cookie)[auth.COOKIE_NAME];
  return auth.verifyToken(token);
}

// Gerbang auth. Kalau tidak login: API dapat 401 JSON, halaman dapat redirect.
function requireAuth(req, res, { isApi }) {
  const username = currentUser(req);
  if (username) return username;
  if (isApi) {
    sendJson(res, 401, { error: 'Belum login' });
  } else {
    res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
    res.end();
  }
  return null;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sanitizeName(name) {
  const base = path.basename(String(name))
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (!base) return 'file';
  return base.slice(0, 180);
}

// Nama unik: foto.png -> foto(1).png
function uniquePathSync(name, taken) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = name;
  let i = 1;
  while (taken.has(candidate) || fs.existsSync(path.join(UPLOAD_DIR, candidate))) {
    candidate = `${stem}(${i++})${ext}`;
  }
  taken.add(candidate);
  return candidate;
}

// Cegah path traversal: hanya boleh file di dalam UPLOAD_DIR
function resolveInUploadDir(name) {
  const target = path.resolve(UPLOAD_DIR, name);
  if (target === UPLOAD_DIR || !target.startsWith(UPLOAD_DIR + path.sep)) return null;
  return target;
}

// ── Parser multipart/form-data (streaming, tanpa dependency) ─────────────────
function handleUpload(req, res) {
  const ctype = req.headers['content-type'] || '';
  const match = /^multipart\/form-data;.*boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
  if (!match) {
    sendJson(res, 400, { error: 'Content-Type harus multipart/form-data' });
    return;
  }

  const DELIM = Buffer.from('\r\n--' + (match[1] || match[2]).trim());
  const HEADER_END = Buffer.from('\r\n\r\n');

  let buffer = Buffer.from('\r\n'); // pancing supaya boundary pertama ikut kebaca
  let state = 'delim'; // delim -> headers -> body
  let done = false; // ketemu penutup --boundary--
  let failed = false;
  let responded = false;
  let totalBytes = 0;
  let pendingDrains = 0;

  let current = null; // { name, size, ws, dest, done }
  const saved = [];
  const taken = new Set();

  function respond(status, payload) {
    if (responded) return;
    responded = true;
    sendJson(res, status, payload);
  }

  function cleanup() {
    if (current && current.ws) {
      current.ws.destroy();
      if (current.dest) fs.promises.unlink(current.dest).catch(() => {});
    }
    for (const f of saved) {
      if (f.dest) fs.promises.unlink(f.dest).catch(() => {});
    }
  }

  function fail(status, message) {
    if (failed) return;
    failed = true;
    cleanup();
    respond(status, { error: message });
  }

  function parseHeaders(text) {
    const headers = {};
    for (const line of text.split('\r\n')) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    return headers;
  }

  function startPart(headerText) {
    const headers = parseHeaders(headerText);
    const cd = headers['content-disposition'] || '';
    const filename = /filename\*?=(?:UTF-8''|")?([^";]*)/i.exec(cd);
    const rawName = filename ? decodeURIComponent(filename[1]) : '';
    const name = rawName ? sanitizeName(rawName) : '';
    const size = Number(headers['content-length']);
    if (!name) {
      current = { field: true }; // field biasa, isinya dibuang
      return;
    }
    if (Number.isFinite(size) && size > MAX_FILE_SIZE) {
      fail(413, `File "${name}" melebihi batas ${MAX_FILE_SIZE} byte`);
      return;
    }
    const safe = uniquePathSync(name, taken);
    const dest = path.join(UPLOAD_DIR, safe);
    const ws = fs.createWriteStream(dest);
    const entry = { name: safe, size: 0, ws, dest, done: null, field: false };
    entry.done = new Promise((resolve, reject) => {
      ws.on('finish', resolve);
      ws.on('error', reject);
    });
    ws.on('error', (err) => fail(500, `Gagal menulis "${safe}": ${err.message}`));
    current = entry;
  }

  function writeChunk(chunk) {
    if (!current || current.field || !current.ws || chunk.length === 0) return;
    current.size += chunk.length;
    savedSizeCheck(current);
    if (!current.ws.write(chunk)) {
      pendingDrains++;
      if (pendingDrains === 1) req.pause();
      current.ws.once('drain', () => {
        if (--pendingDrains === 0) req.resume();
      });
    }
  }

  function savedSizeCheck(entry) {
    if (entry.size > MAX_FILE_SIZE) fail(413, `File "${entry.name}" melebihi batas`);
  }

  function endPart() {
    if (!current) return;
    if (!current.field && current.ws) {
      current.ws.end();
      saved.push(current);
    }
    current = null;
  }

  function process() {
    for (;;) {
      if (failed) return;

      if (state === 'delim') {
        const idx = buffer.indexOf(DELIM);
        if (idx === -1) return;
        const rest = idx + DELIM.length;
        if (buffer.length < rest + 2) return; // tunggu 2 byte penentu
        const isEnd = buffer[rest] === 0x2d && buffer[rest + 1] === 0x2d;
        if (isEnd) {
          buffer = buffer.subarray(rest + 2);
          done = true;
          return;
        }
        if (buffer[rest] !== 0x0d || buffer[rest + 1] !== 0x0a) {
          fail(400, 'Format multipart tidak valid');
          return;
        }
        buffer = buffer.subarray(rest + 2);
        state = 'headers';
        continue;
      }

      if (state === 'headers') {
        const idx = buffer.indexOf(HEADER_END);
        if (idx === -1) {
          if (buffer.length > 64 * 1024) {
            fail(400, 'Header part terlalu panjang');
          }
          return;
        }
        const headerText = buffer.subarray(0, idx).toString('utf8');
        buffer = buffer.subarray(idx + HEADER_END.length);
        startPart(headerText);
        if (failed) return;
        state = 'body';
        continue;
      }

      // state === 'body'
      const idx = buffer.indexOf(DELIM);
      if (idx === -1) {
        const keep = DELIM.length - 1;
        if (buffer.length > keep) {
          writeChunk(buffer.subarray(0, buffer.length - keep));
          buffer = buffer.subarray(buffer.length - keep);
        }
        return;
      }
      writeChunk(buffer.subarray(0, idx));
      buffer = buffer.subarray(idx);
      endPart();
      state = 'delim';
    }
  }

  req.on('data', (chunk) => {
    if (failed) return;
    totalBytes += chunk.length;
    if (totalBytes > MAX_FILE_SIZE * 100) {
      fail(413, 'Request terlalu besar');
      return;
    }
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    process();
  });

  req.on('end', async () => {
    if (failed) return;
    if (!done) {
      fail(400, 'Upload terputus / format multipart tidak lengkap');
      return;
    }
    endPart();
    try {
      await Promise.all(saved.map((f) => f.done));
      respond(200, {
        dir: UPLOAD_DIR,
        files: saved.map((f) => ({ name: f.name, size: f.size })),
      });
    } catch (err) {
      fail(500, `Gagal menyimpan file: ${err.message}`);
    }
  });

  req.on('aborted', () => {
    failed = true;
    cleanup();
  });

  req.on('error', () => {
    failed = true;
    cleanup();
  });
}

// ── Route ────────────────────────────────────────────────────────────────────
async function listFiles() {
  const entries = await fsp.readdir(UPLOAD_DIR, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    const stat = await fsp.stat(path.join(UPLOAD_DIR, entry.name));
    files.push({ name: entry.name, size: stat.size, mtime: stat.mtimeMs });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files;
}

async function serveStatic(res, filePath) {
  const data = await fsp.readFile(filePath);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-cache',
  });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    // UI — halaman menentukan sendiri mau menampilkan form login atau aplikasi
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      await serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
      return;
    }

    // ── Auth ────────────────────────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/auth/status') {
      sendJson(res, 200, { ...auth.status(), username: currentUser(req) });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/auth/register') {
      const body = await readJson(req);
      const { username, token } = await auth.register(body.username, body.password);
      res.setHeader('Set-Cookie', auth.sessionCookie(token));
      sendJson(res, 200, { username });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/auth/login') {
      const ip = req.socket.remoteAddress || '?';
      const wait = loginLockRemaining(ip);
      if (wait > 0) {
        sendJson(res, 429, {
          error: `Terlalu banyak percobaan. Coba lagi dalam ${Math.ceil(wait / 1000)} detik.`,
        });
        return;
      }
      const body = await readJson(req);
      const result = await auth.login(body.username, body.password);
      if (!result) {
        noteLoginFail(ip);
        sendJson(res, 401, { error: 'Username atau password salah' });
        return;
      }
      loginFails.delete(ip);
      res.setHeader('Set-Cookie', auth.sessionCookie(result.token));
      sendJson(res, 200, { username: result.username });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/auth/logout') {
      res.setHeader('Set-Cookie', auth.clearCookie());
      sendJson(res, 200, { ok: true });
      return;
    }

    // ── Semua endpoint di bawah ini wajib login ─────────────────────────────
    if (pathname === '/api/files' || pathname === '/api/upload' ||
        pathname.startsWith('/api/files/') || pathname.startsWith('/files/')) {
      const api = pathname.startsWith('/api/');
      if (!requireAuth(req, res, { isApi: api })) return;
    }

    // Daftar file
    if (req.method === 'GET' && pathname === '/api/files') {
      sendJson(res, 200, { dir: UPLOAD_DIR, files: await listFiles() });
      return;
    }

    // Upload
    if (req.method === 'POST' && pathname === '/api/upload') {
      handleUpload(req, res);
      return;
    }

    // Ambil / lihat file
    if (req.method === 'GET' && pathname.startsWith('/files/')) {
      const name = pathname.slice('/files/'.length);
      const target = resolveInUploadDir(name);
      if (!target) {
        sendJson(res, 400, { error: 'Nama file tidak valid' });
        return;
      }
      let stat;
      try {
        stat = await fsp.stat(target);
      } catch {
        sendJson(res, 404, { error: 'File tidak ditemukan' });
        return;
      }
      if (!stat.isFile()) {
        sendJson(res, 404, { error: 'Bukan file' });
        return;
      }
      const inline = url.searchParams.get('download') !== '1';
      const disposition = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`;
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': disposition,
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(target).pipe(res);
      return;
    }

    // Hapus file
    if (req.method === 'DELETE' && pathname.startsWith('/api/files/')) {
      const name = pathname.slice('/api/files/'.length);
      const target = resolveInUploadDir(name);
      if (!target) {
        sendJson(res, 400, { error: 'Nama file tidak valid' });
        return;
      }
      try {
        await fsp.unlink(target);
      } catch {
        sendJson(res, 404, { error: 'File tidak ditemukan' });
        return;
      }
      sendJson(res, 200, { ok: true, name: path.basename(target) });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    sendJson(res, err.status || 500, { error: err.message });
  }
});

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

server.listen(PORT, HOST, () => {
  console.log(`\n  Upload server jalan di:`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  File tersimpan di: ${UPLOAD_DIR}\n`);
});
