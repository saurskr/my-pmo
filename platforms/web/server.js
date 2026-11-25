'use strict';
// my-pmo web platform: serves the shared app (core/) plus sign-in, setup and administration,
// and keeps everything in SQL Server Express.
//
//   node server.js                              start (first run opens the setup wizard)
//   node server.js add-user <email> <pw> [admin]  create or reset an account (recovery)
//   node server.js reconfigure                  forget the database connection and run setup again
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const config = require('./server/config');
const auth = require('./server/auth');
const saml = require('./server/saml');
const setup = require('./server/setup');
const sqlserver = require('./server/sqlserver');
const { send, redirect, readJson, readForm, serveFile } = require('./server/http');
const { bad, cleanState, cleanSync, cleanJournalSync } = require('./server/validate');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1'; // set HOST=0.0.0.0 to let other computers reach it
const ROOTS = [path.join(__dirname, 'public'), path.join(__dirname, '..', '..', 'core')];
const BIG_JSON = 5 * 1024 * 1024;

const app = { store: null, storeError: null, configured: false, setupToken: crypto.randomBytes(9).toString('base64url'), lastTry: 0 };

async function openStore(cfg) {
  const store = new sqlserver.SqlStore(cfg);
  await store.init();
  app.store = store; app.storeError = null;
}

// If the database was unreachable at start-up (or dropped later), try again now and then.
async function ensureStore() {
  if (app.store || !app.configured || Date.now() - app.lastTry < 5000) return;
  app.lastTry = Date.now();
  try { await openStore(config.read().sql); } catch (e) { app.storeError = e.message; }
}

/* ---------- which files may be fetched without signing in ---------- */

const PUBLIC_PATHS = new Set(['/login.html', '/login.js', '/setup.html', '/setup.js', '/platform.css', '/logo.png', '/theme-init.js']);
const isPublic = p => PUBLIC_PATHS.has(p) || p.startsWith('/design-system/');

const unavailablePage = msg => `<!doctype html><meta charset="utf-8"><title>my-pmo</title><link rel="stylesheet" href="/design-system/all.css">
<div class="login-page"><div class="login-card"><h1>my-pmo can't reach its database</h1><div class="msg err">${String(msg).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</div>
<p class="muted">Check that SQL Server is running, then reload this page. To change the connection, stop the server and run <code>node server.js reconfigure</code>.</p></div></div>`;

/* ---------- routes ---------- */

const needAdmin = (user, res) => {
  if (!user) { send(res, 401, { error: 'Sign in required' }); return false; }
  if (user.role !== 'admin') { send(res, 403, { error: 'Administrators only' }); return false; }
  return true;
};

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (await setup.handle(app, req, res, url)) return;

  /* not set up yet: everything leads to the wizard */
  if (!app.configured) {
    if (p.startsWith('/api/')) return send(res, 503, { error: 'my-pmo has not been set up yet.', setupRequired: true });
    if (req.method !== 'GET') return send(res, 405, 'Method not allowed', 'text/plain');
    if (p !== '/login.html' && p !== '/login.js' && isPublic(p)) { if (serveFile(res, ROOTS, p)) return; return send(res, 404, 'Not found', 'text/plain'); }
    return redirect(res, '/setup.html');
  }

  await ensureStore();
  if (!app.store) {
    if (p.startsWith('/api/')) return send(res, 503, { error: `my-pmo can't reach its database: ${app.storeError || 'unknown problem'}` });
    if (p.startsWith('/design-system/') && serveFile(res, ROOTS, p)) return;
    return send(res, 503, unavailablePage(app.storeError || 'unknown problem'), 'text/html; charset=utf-8');
  }
  const store = app.store;
  const user = auth.currentUser(req);

  /* ---- sign in / out ---- */
  if (p === '/api/login' && req.method === 'POST') {
    const body = await readJson(req);
    const key = `${req.socket.remoteAddress}|${String(body.email).toLowerCase()}`;
    if (auth.throttled(key)) return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    const u = await store.getUser(String(body.email || '').trim().toLowerCase());
    if (!(await auth.verifyPassword(body.password, u))) { auth.noteFailure(key); return send(res, 401, { error: 'Incorrect email or password.' }); }
    auth.clearFailures(key);
    store.touchLogin(u.email).catch(() => {});
    res.setHeader('Set-Cookie', auth.startSession(req, u));
    return send(res, 200, { email: u.email, role: u.role });
  }
  if (p === '/api/logout' && req.method === 'POST') {
    res.setHeader('Set-Cookie', auth.endSession(req));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/me' && req.method === 'GET') {
    return user ? send(res, 200, { email: user.email, role: user.role }) : send(res, 401, { error: 'Sign in required' });
  }

  /* ---- SAML 2.0 ---- */
  if (p === '/api/sso/status' && req.method === 'GET') {
    return send(res, 200, { enabled: (await saml.load(store)).enabled });
  }
  if (p === '/api/sso/metadata' && req.method === 'GET') {
    const s = await saml.load(store);
    if (!(s.loginUrl && s.idpIssuer && s.certificate)) return send(res, 404, 'Single sign-on is not configured.', 'text/plain');
    return send(res, 200, saml.metadata(s, saml.baseUrl(req, s)), 'application/xml');
  }
  if (p === '/api/sso/login' && req.method === 'GET') {
    const s = await saml.load(store);
    if (!s.enabled) return redirect(res, '/login.html?sso=off');
    return redirect(res, await saml.loginUrl(s, saml.baseUrl(req, s)));
  }
  if (p === '/api/sso/acs' && req.method === 'POST') {
    const s = await saml.load(store);
    if (!s.enabled) return redirect(res, '/login.html?sso=off');
    try {
      const email = await saml.acceptResponse(s, saml.baseUrl(req, s), await readForm(req));
      let u = await store.getUser(email);
      if (!u) {
        if (!s.autoProvision) return redirect(res, '/login.html?sso=noaccount');
        await store.saveUser({ email, role: 'user', source: 'saml' });
        u = { email, role: 'user' };
      }
      store.touchLogin(email).catch(() => {});
      return redirect(res, '/', { 'Set-Cookie': auth.startSession(req, u) });
    } catch (e) {
      console.error(`SAML sign-in refused: ${e.message}`);
      return redirect(res, `/login.html?sso=${e.status === 403 ? 'domain' : 'failed'}`);
    }
  }

  /* ---- shared project data (any signed-in user) ---- */
  if (p === '/api/data' || p === '/api/data/sync') {
    if (!user) return send(res, 401, { error: 'Sign in required' });
    if (p === '/api/data' && req.method === 'GET') return send(res, 200, { ...(await store.getAll()), storage: store.describe() });
    if (p === '/api/data' && req.method === 'PUT') { await store.replace(cleanState(await readJson(req, BIG_JSON))); return send(res, 200, { ok: true }); }
    if (p === '/api/data/sync' && req.method === 'POST') { await store.sync(cleanSync(await readJson(req, BIG_JSON))); return send(res, 200, { ok: true }); }
  }

  /* ---- general notes: private to each signed-in user ---- */
  if (p === '/api/journal' || p === '/api/journal/sync') {
    if (!user) return send(res, 401, { error: 'Sign in required' });
    if (p === '/api/journal' && req.method === 'GET') return send(res, 200, { notes: await store.getJournal(user.email) });
    if (p === '/api/journal/sync' && req.method === 'POST') { await store.syncJournal(user.email, cleanJournalSync(await readJson(req))); return send(res, 200, { ok: true }); }
  }

  /* ---- administration ---- */
  if (p.startsWith('/api/admin/')) {
    if (!needAdmin(user, res)) return;
    return admin(req, res, p, user, store);
  }

  if (p.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
  if (req.method !== 'GET') return send(res, 405, 'Method not allowed', 'text/plain');

  /* ---- pages and assets ---- */
  if (!isPublic(p) && !user) {
    if (p === '/' || p.endsWith('.html')) return redirect(res, '/login.html');
    return send(res, 401, { error: 'Sign in required' });
  }
  if (p === '/admin.html' && user && user.role !== 'admin') return redirect(res, '/');
  if ((p === '/login.html' || p === '/setup.html') && user) return redirect(res, '/');
  if (!serveFile(res, ROOTS, p)) return send(res, 404, 'Not found', 'text/plain');
}

async function admin(req, res, p, me, store) {
  if (p === '/api/admin/sso') {
    let s = await saml.load(store);
    if (req.method === 'PUT') { s = saml.validate(await readJson(req)); await saml.save(store, s); }
    else if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
    return send(res, 200, { sso: s, derived: saml.derived(saml.baseUrl(req, s)) });
  }

  if (p === '/api/admin/users' && req.method === 'GET') {
    return send(res, 200, { users: (await store.listUsers()).map(u => ({ email: u.email, role: u.role, source: u.source, hasPassword: !!u.hash, lastLoginAt: u.lastLoginAt })), you: me.email });
  }
  if (p === '/api/admin/users' && req.method === 'POST') {
    const b = await readJson(req);
    const email = auth.cleanEmail(b.email);
    if (await store.getUser(email)) throw bad('That email already has an account.');
    await store.saveUser({ email, role: auth.cleanRole(b.role), ...(await auth.hashPassword(auth.cleanPassword(b.password))), source: 'local' });
    return send(res, 200, { ok: true });
  }
  const m = p.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (m) {
    const email = auth.cleanEmail(decodeURIComponent(m[1]));
    const u = await store.getUser(email);
    if (!u) return send(res, 404, { error: 'No such account' });
    if (req.method === 'DELETE') {
      if (email === me.email) throw bad("You can't delete your own account.");
      if (u.role === 'admin' && (await store.countAdmins()) <= 1) throw bad('That is the only administrator.');
      await store.deleteUser(email); auth.dropSessions(email);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'PUT') {
      const b = await readJson(req);
      const role = b.role === undefined ? u.role : auth.cleanRole(b.role);
      if (u.role === 'admin' && role !== 'admin' && (await store.countAdmins()) <= 1) throw bad('That is the only administrator.');
      const pw = b.password ? await auth.hashPassword(auth.cleanPassword(b.password)) : {};
      await store.saveUser({ email, role, ...pw, source: u.source });
      auth.updateSessions(email, role);
      if (b.password && email !== me.email) auth.dropSessions(email); // someone else's password changed: sign them out
      return send(res, 200, { ok: true });
    }
  }

  if (p === '/api/admin/database' && req.method === 'GET') {
    const cfg = config.read().sql;
    return send(res, 200, { server: cfg.server, database: cfg.database, user: cfg.user, ...(await sqlserver.inspect(cfg)), latestSchema: sqlserver.SCHEMA_VERSION });
  }
  if (p === '/api/admin/database/update-schema' && req.method === 'POST') {
    const r = await sqlserver.createSchema(config.read().sql, false);
    app.store.hasV4 = false; app.store.hasJournal = false;
    return send(res, 200, { ok: true, steps: r.steps });
  }
  return send(res, 404, { error: 'Not found' });
}

// Validation problems are the caller's fault (400). Admin screens see the real reason for other
// failures; ordinary users only get a generic message (the detail is logged).
function fail(req, res, e) {
  const isAdminApi = req.url.startsWith('/api/admin') || req.url.startsWith('/api/setup'); // both are for trusted people, who need the real reason
  const status = e.status || (isAdminApi ? 400 : 500);
  let message = String(e.message).replace(/password=[^;]*/gi, 'password=***');
  if (status >= 500 && !isAdminApi) {
    console.error(`${req.method} ${req.url}: ${message}`);
    message = status === 503 ? message : 'The database had a problem. Your changes will be retried.';
  }
  if (res.headersSent) return res.end();
  send(res, status, { error: message });
}

/* ---------- start / command line ---------- */

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'reconfigure') { config.clear(); console.log('Forgot the database connection. Start the server to run setup again; your database was not touched.'); return; }

  const cfg = config.read();
  app.configured = !!cfg.sql;

  if (cmd === 'add-user') {
    const [, , , email, password, role] = process.argv;
    if (!app.configured) throw new Error('Run the server once and complete setup first.');
    await openStore(cfg.sql);
    const e = auth.cleanEmail(email || '');
    const existing = await app.store.getUser(e);
    await app.store.saveUser({ email: e, role: auth.cleanRole(role), ...(await auth.hashPassword(auth.cleanPassword(password || ''))), source: existing ? existing.source : 'local' });
    console.log(`Saved ${e} (${auth.cleanRole(role)})`);
    await app.store.close();
    return;
  }

  if (app.configured) {
    try { await openStore(cfg.sql); console.log(`Database: ${app.store.describe()}`); }
    catch (e) { app.storeError = e.message; console.error(`Can't reach the database: ${e.message}\nThe server is running and will keep trying.`); }
  }
  http.createServer((req, res) => { handle(req, res).catch(e => fail(req, res, e)); }).listen(PORT, HOST, () => {
    if (!app.configured) console.log(`\nFirst run. Open http://localhost:${PORT}/setup.html and enter this setup code:\n\n    ${app.setupToken}\n`);
    console.log(`my-pmo running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  });
}

main().catch(e => { console.error(e.message); process.exit(1); });
