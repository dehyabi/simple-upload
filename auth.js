'use strict';

// Auth satu-akun: user pertama yang mendaftar jadi satu-satunya user.
// Setelah itu registrasi ditutup permanen.
//
// Password di-hash dengan scrypt + salt acak, sesi pakai cookie bertanda tangan
// HMAC (stateless, jadi tetap login setelah server restart).

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, 'data');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');

const COOKIE_NAME = 'sid';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 hari

const MIN_USERNAME = 3;
const MAX_USERNAME = 32;
const MIN_PASSWORD = 8;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ── Penyimpanan ──────────────────────────────────────────────────────────────
// State di-cache di memori; file hanya dibaca sekali saat start.
let state = null;

function loadState() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch {
    state = {};
  }
  if (!state.secret) {
    state.secret = crypto.randomBytes(32).toString('hex');
    persist();
  }
  return state;
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = AUTH_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, AUTH_FILE); // tulis atomik, hindari file korup
}

// Registrasi & perubahan state lain diserialkan supaya dua request
// yang datang bersamaan tidak bisa membuat dua akun.
let lock = Promise.resolve();
function withLock(fn) {
  const run = lock.then(fn, fn);
  lock = run.then(
    () => {},
    () => {}
  );
  return run;
}

// ── Password ─────────────────────────────────────────────────────────────────
function scryptAsync(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT.keylen, SCRYPT, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ── Sesi ─────────────────────────────────────────────────────────────────────
function signToken(username) {
  const payload = `${username}\n${Date.now() + SESSION_TTL_MS}`;
  const mac = crypto
    .createHmac('sha256', loadState().secret)
    .update(payload)
    .digest('base64url');
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${mac}`;
}

function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;

  let payload;
  try {
    payload = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const expected = crypto
    .createHmac('sha256', loadState().secret)
    .update(payload)
    .digest('base64url');
  if (!timingSafeEqualStr(token.slice(dot + 1), expected)) return null;

  const sep = payload.lastIndexOf('\n');
  if (sep < 0) return null;
  const username = payload.slice(0, sep);
  const expires = Number(payload.slice(sep + 1));
  if (!Number.isFinite(expires) || Date.now() > expires) return null;

  const user = loadState().user;
  if (!user || user.username !== username) return null; // akun sudah tidak ada
  return username;
}

// ── Cookie ──────────────────────────────────────────────────────────────────
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (key) out[key] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
    SESSION_TTL_MS / 1000
  )}`;
}

function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// ── API ──────────────────────────────────────────────────────────────────────
function status() {
  const user = loadState().user;
  return { registered: Boolean(user), username: user ? user.username : null };
}

async function register(rawUsername, rawPassword) {
  const username = String(rawUsername || '').trim();
  const password = String(rawPassword || '');

  if (!new RegExp(`^[A-Za-z0-9._-]{${MIN_USERNAME},${MAX_USERNAME}}$`).test(username)) {
    throw new AuthError(
      400,
      `Username harus ${MIN_USERNAME}-${MAX_USERNAME} karakter (huruf, angka, . _ -)`
    );
  }
  if (password.length < MIN_PASSWORD) {
    throw new AuthError(400, `Password minimal ${MIN_PASSWORD} karakter`);
  }

  return withLock(async () => {
    if (loadState().user) {
      throw new AuthError(403, 'Registrasi sudah ditutup — akun sudah pernah dibuat');
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = (await scryptAsync(password, salt)).toString('hex');
    state.user = { username, salt, hash, createdAt: Date.now() };
    persist();
    return { username, token: signToken(username) };
  });
}

async function login(rawUsername, rawPassword) {
  const username = String(rawUsername || '').trim();
  const password = String(rawPassword || '');

  const user = loadState().user;
  // Selalu jalankan scrypt walau user tidak ada, supaya waktu respons tidak
  // membocorkan username mana yang terdaftar.
  const salt = user ? user.salt : '0'.repeat(32);
  const hash = (await scryptAsync(password, salt)).toString('hex');

  if (!user || user.username !== username || !timingSafeEqualStr(hash, user.hash)) {
    return null;
  }
  return { username, token: signToken(username) };
}

module.exports = {
  AuthError,
  status,
  register,
  login,
  verifyToken,
  parseCookies,
  sessionCookie,
  clearCookie,
  COOKIE_NAME,
  MIN_PASSWORD,
};
