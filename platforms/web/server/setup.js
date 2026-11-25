'use strict';
// First-run setup: connect to SQL Server Express, then either create a new my-pmo database
// or load an existing one, and create the first administrator.
// Protected by a one-time code printed in the terminal, so only the person who started the server can run it.
const crypto = require('crypto');
const { send, readJson } = require('./http');
const { bad } = require('./validate');
const auth = require('./auth');
const sqlserver = require('./sqlserver');
const config = require('./config');

const DOWNLOAD_URL = 'https://www.microsoft.com/en-us/sql-server/sql-server-downloads';

function tokenOk(app, given) {
  const a = Buffer.from(String(given || '')), b = Buffer.from(app.setupToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Returns true when it handled the request.
async function handle(app, req, res, url) {
  if (!url.pathname.startsWith('/api/setup/')) return false;
  const route = url.pathname.slice('/api/setup/'.length);

  if (route === 'status' && req.method === 'GET') {
    send(res, 200, { configured: app.configured, downloadUrl: DOWNLOAD_URL });
    return true;
  }
  if (req.method !== 'POST') { send(res, 405, { error: 'Method not allowed' }); return true; }
  if (app.configured) { send(res, 403, { error: 'Setup is already complete.' }); return true; }

  const body = await readJson(req);
  if (!tokenOk(app, body.token)) { send(res, 403, { error: 'That setup code is not right. It is printed in the terminal where the server was started.' }); return true; }

  if (route === 'test') {
    const cfg = sqlserver.cleanConnection(body);
    send(res, 200, { ok: true, ...(await sqlserver.inspect(cfg)) });
    return true;
  }

  if (route === 'complete') {
    const cfg = sqlserver.cleanConnection(body);
    const mode = body.mode === 'existing' ? 'existing' : 'create';
    const info = await sqlserver.inspect(cfg);
    const steps = [];

    // Check what we can before touching the database. A new database, or one with no administrator yet, needs one.
    let newAdmin = null;
    if (mode === 'create' || !info.adminCount) {
      const a = body.admin || {};
      newAdmin = { email: auth.cleanEmail(a.email), password: auth.cleanPassword(a.password) };
    }

    if (mode === 'create') {
      if (info.schemaInstalled && info.hasData) throw bad(`The database "${cfg.database}" already holds my-pmo data. Choose "Use an existing database" to keep it.`);
      steps.push(...(await sqlserver.createSchema(cfg, true)).steps);
    } else {
      if (!info.databaseExists || !info.schemaInstalled) throw bad(`No my-pmo tables were found in "${cfg.database}". Choose "Create a new database" instead.`);
      if (info.needsUpdate) steps.push(...(await sqlserver.createSchema(cfg, false)).steps);
      else steps.push('Found a my-pmo database that is up to date');
    }

    const store = new sqlserver.SqlStore(cfg);
    await store.init();
    try {
      let user = null;
      if ((await store.countAdmins()) === 0) {
        if (!newAdmin) throw bad('Enter the email and password for the first administrator.');
        await store.saveUser({ email: newAdmin.email, role: 'admin', ...(await auth.hashPassword(newAdmin.password)), source: 'local' });
        steps.push(`Created the administrator ${newAdmin.email}`);
        user = { email: newAdmin.email, role: 'admin' };
      } else {
        steps.push('The database already has an administrator, so no new account was created');
      }
      config.write({ sql: cfg }); // only now, once everything has worked
      app.store = store; app.storeError = null; app.configured = true;
      if (user) res.setHeader('Set-Cookie', auth.startSession(req, user));
      send(res, 200, { ok: true, steps, signedIn: !!user });
    } catch (e) { await store.close(); throw e; }
    return true;
  }

  send(res, 404, { error: 'Not found' });
  return true;
}

module.exports = { handle, DOWNLOAD_URL };
