'use strict';
// Passwords, sessions and sign-in throttling.
const crypto = require('crypto');
const { promisify } = require('util');
const { bad } = require('./validate');

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'pmo_session';
const SESSION_MS = 8 * 60 * 60 * 1000;

/* ---------- passwords (salted scrypt) ---------- */

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: (await scrypt(password, salt, 64)).toString('hex') };
}

const DUMMY_SALT = '0'.repeat(32), DUMMY_HASH = '0'.repeat(128);

// Hashes even when the account is unknown, so response time doesn't reveal which emails exist.
async function verifyPassword(password, user) {
  const { hash } = await hashPassword(String(password), user && user.salt ? user.salt : DUMMY_SALT);
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(user && user.hash ? user.hash : DUMMY_HASH, 'hex');
  return !!(user && user.hash && a.length === b.length && crypto.timingSafeEqual(a, b));
}

function cleanEmail(v) {
  const email = String(v == null ? '' : v).trim().toLowerCase();
  if (email.length > 320 || !/^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/.test(email)) throw bad('Enter a valid email address');
  return email;
}
function cleanPassword(v) {
  const p = String(v == null ? '' : v);
  if (p.length < 8) throw bad('Password must be at least 8 characters');
  if (p.length > 200) throw bad('Password is too long');
  return p;
}
const cleanRole = v => (v === 'admin' ? 'admin' : 'user');

/* ---------- sessions (in memory; everyone signs in again after a restart) ---------- */

const sessions = new Map();
setInterval(() => { const now = Date.now(); for (const [t, s] of sessions) if (s.exp < now) sessions.delete(t); }, 10 * 60 * 1000).unref();

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { /* ignore a malformed cookie */ } }
  }
  return out;
}

const isSecure = req => process.env.COOKIE_SECURE === '1' || !!req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
const cookie = (req, value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isSecure(req) ? '; Secure' : ''}`;

function currentUser(req) {
  const t = parseCookies(req)[COOKIE];
  const s = t && sessions.get(t);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(t); return null; }
  return s;
}

// Returns the Set-Cookie value; the caller adds it to its response.
function startSession(req, user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { email: user.email, role: user.role, exp: Date.now() + SESSION_MS });
  return cookie(req, token, SESSION_MS / 1000);
}

function endSession(req) {
  const t = parseCookies(req)[COOKIE];
  if (t) sessions.delete(t);
  return cookie(req, '', 0);
}

// Keep signed-in people in step when an administrator changes or removes their account.
function updateSessions(email, role) { for (const s of sessions.values()) if (s.email === email) s.role = role; }
function dropSessions(email) { for (const [t, s] of sessions) if (s.email === email) sessions.delete(t); }

/* ---------- sign-in throttling: 5 failures, then 5 minutes ---------- */

const failures = new Map();
const WINDOW = 5 * 60 * 1000;
const throttled = key => { const f = failures.get(key); return !!f && f.count >= 5 && Date.now() - f.last < WINDOW; };
function noteFailure(key) {
  const f = failures.get(key);
  failures.set(key, { count: (f && Date.now() - f.last < WINDOW ? f.count : 0) + 1, last: Date.now() });
}
const clearFailures = key => failures.delete(key);

module.exports = { hashPassword, verifyPassword, cleanEmail, cleanPassword, cleanRole, currentUser, startSession, endSession, updateSessions, dropSessions, throttled, noteFailure, clearFailures };
