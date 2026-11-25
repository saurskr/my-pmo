'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const item = (id, over = {}) => ({ id, type: 'project', parentId: null, name: 'Entry ' + id, team: 'T', status: 'ontrack', start: '2026-01-01', end: '2026-02-01', effort: '', focus: false, focusWhy: '', summary: 's', details: '', notes: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over });
const sqlHost = () => { const [host, port] = h.sqlConn('x').server.split(','); return { server: host, port: Number(port) || 1433 }; };

describe('before setup', () => {
  let server;
  before(async () => { server = await h.startServer(); });
  after(() => server.stop());

  it('sends every page to the setup wizard and refuses the API', async () => {
    const c = h.client(server.base);
    for (const p of ['/', '/index.html', '/notes.html', '/admin.html', '/login.html']) {
      const r = await c.get(p); assert.equal(r.status, 302, p); assert.equal(r.location, '/setup.html', p);
    }
    const api = await c.get('/api/data'); assert.equal(api.status, 503); assert.equal(api.json.setupRequired, true);
    assert.equal((await c.get('/setup.html')).status, 200);
    assert.equal((await c.get('/design-system/all.css')).status, 200);
    assert.equal((await c.get('/platform.css')).status, 200);
  });

  it('does not expose the app files before setup', async () => {
    assert.equal((await h.client(server.base).get('/app.js')).status, 302);
  });

  it('refuses setup without the code printed in the terminal', async () => {
    const c = h.client(server.base);
    assert.equal((await c.post('/api/setup/test', { token: 'guess' })).status, 403);
    assert.equal((await c.post('/api/setup/complete', {})).status, 403);
    assert.equal((await c.get('/api/setup/status')).json.configured, false);
  });
});

describe('setup, sign-in and data', { skip: !h.haveSql && 'set PMO_TEST_SQL to run' }, () => {
  let server, admin, dbs = [];
  before(async () => { server = await h.startServer(); });
  after(async () => { await server.stop(); for (const d of dbs) await h.dropDatabase(d); });

  it('explains a wrong SQL password and an unreachable server', async () => {
    const c = h.client(server.base);
    const wrong = await c.post('/api/setup/test', { token: server.token, ...h.sqlConn('whatever'), password: 'not the password' });
    assert.equal(wrong.status, 400);
    assert.match(wrong.json.error, /Login failed/);
    const { server: host } = sqlHost();
    const down = await c.post('/api/setup/test', { token: server.token, ...h.sqlConn('whatever'), server: `${host},1` });
    assert.equal(down.status, 400);
    assert.match(down.json.error, /reach SQL Server/);
    const noDb = await c.post('/api/setup/test', { token: server.token, ...h.sqlConn('9bad name!') });
    assert.equal(noDb.status, 400);
  });

  it('inspects a database that does not exist yet', async () => {
    const r = await h.client(server.base).post('/api/setup/test', { token: server.token, ...h.sqlConn(h.uniqueDb()) });
    assert.equal(r.status, 200);
    assert.equal(r.json.databaseExists, false);
    assert.equal(r.json.canCreateDatabase, true);
  });

  it('rejects a weak administrator password without changing anything', async () => {
    const db = h.uniqueDb(); dbs.push(db);
    const c = h.client(server.base);
    const r = await c.post('/api/setup/complete', { token: server.token, ...h.sqlConn(db), mode: 'create', admin: { email: 'a@example.com', password: 'short' } });
    assert.equal(r.status, 400);
    assert.equal((await c.get('/api/setup/status')).json.configured, false, 'still not configured');
  });

  it('creates a new database and the first administrator, and signs them in', async () => {
    admin = await h.setUp(server);
    dbs.push(admin.database);
    assert.equal(admin.result.signedIn, true);
    assert.ok(admin.result.steps.some(s => /Created database/.test(s)));
    assert.deepEqual((await admin.c.get('/api/me')).json, { email: 'admin@example.com', role: 'admin' });
  });

  it('locks the setup once it is done', async () => {
    const c = h.client(server.base);
    assert.equal((await c.post('/api/setup/test', { token: server.token, ...h.sqlConn('x') })).status, 403);
    assert.equal((await c.post('/api/setup/complete', { token: server.token })).status, 403);
    assert.equal((await c.get('/api/setup/status')).json.configured, true);
    assert.equal((await c.get('/setup.html')).status, 200); // the page itself is harmless; it sends you on
  });

  it('keeps the database password out of anything served to the browser', async () => {
    const all = [await admin.c.get('/api/admin/database'), await admin.c.get('/api/admin/sso'), await admin.c.get('/api/admin/users'), await admin.c.get('/api/data')];
    for (const r of all) assert.ok(!r.text.includes('Test-Only-Pw'), r.text.slice(0, 80));
  });

  it('keeps pages and data behind sign-in', async () => {
    const c = h.client(server.base);
    for (const p of ['/', '/index.html', '/notes.html', '/admin.html']) { const r = await c.get(p); assert.equal(r.status, 302, p); assert.equal(r.location, '/login.html', p); }
    assert.equal((await c.get('/app.js')).status, 401);
    for (const p of ['/api/data', '/api/journal', '/api/me', '/api/admin/users', '/api/admin/sso']) assert.equal((await c.get(p)).status, 401, p);
    assert.equal((await c.get('/login.html')).status, 200);
    assert.equal((await c.get('/design-system/components/status/status.js')).status, 200);
    assert.equal((await c.get('/../server.js')).status, 401);
  });

  it('signs in with the right password and refuses the wrong one', async () => {
    const c = h.client(server.base);
    const bad = await c.post('/api/login', { email: 'admin@example.com', password: 'wrong wrong' });
    assert.equal(bad.status, 401); assert.equal(c.hasSession(), false);
    const unknown = await c.post('/api/login', { email: 'nobody@example.com', password: 'wrong wrong' });
    assert.equal(unknown.status, 401); assert.equal(unknown.json.error, bad.json.error, 'does not reveal which emails exist');
    const ok = await c.post('/api/login', { email: 'Admin@Example.com', password: admin.password });
    assert.equal(ok.status, 200); assert.equal(ok.json.role, 'admin');
    assert.equal((await c.get('/api/me')).json.email, 'admin@example.com');
    assert.equal((await c.post('/api/logout', {})).status, 200);
    assert.equal((await c.get('/api/me')).status, 401, 'signed out');
  });

  it('only accepts JSON for changes, so other sites cannot post to it', async () => {
    const c = h.client(server.base);
    const r = await c.post('/api/login', 'email=a&password=b', { contentType: 'text/plain' });
    assert.equal(r.status, 400);
    assert.equal((await admin.c.post('/api/data/sync', '{}', { contentType: 'text/plain' })).status, 400);
  });

  it('slows down repeated wrong passwords', async () => {
    const c = h.client(server.base);
    let last;
    for (let i = 0; i < 7; i++) last = await c.post('/api/login', { email: 'throttle@example.com', password: 'wrong wrong ' + i });
    assert.equal(last.status, 429);
  });

  it('stores entries and returns them, with their notes and labels', async () => {
    assert.equal((await admin.c.get('/api/data')).json.initialized, false, 'a new database starts empty');
    const n = { id: 'n1', at: '2026-01-02T00:00:00.000Z', label: 'Risk', text: 'watch this' };
    const r = await admin.c.post('/api/data/sync', { upserts: [item('a1', { notes: [n], focus: true, focusWhy: 'now' }), item('b2', { type: 'quickwin', effort: 12.5 })], deletes: [], labels: ['Risk', 'Update'] });
    assert.equal(r.status, 200);
    const d = (await admin.c.get('/api/data')).json;
    assert.equal(d.initialized, true);
    assert.deepEqual(d.labels, ['Risk', 'Update']);
    const a1 = d.items.find(i => i.id === 'a1');
    assert.equal(a1.focus, true); assert.equal(a1.notes[0].text, 'watch this'); assert.equal(a1.start, '2026-01-01');
    assert.equal(d.items.find(i => i.id === 'b2').effort, 12.5);
    assert.match(d.storage, /SQL Server/);
  });

  it('updates and deletes entries, and replaces everything on import', async () => {
    await admin.c.post('/api/data/sync', { upserts: [item('a1', { name: 'Renamed', status: 'atrisk' })], deletes: ['b2'] });
    let d = (await admin.c.get('/api/data')).json;
    assert.equal(d.items.length, 1); assert.equal(d.items[0].name, 'Renamed'); assert.equal(d.items[0].status, 'atrisk');
    assert.equal((await admin.c.put('/api/data', { items: [item('z9'), item('y8')], labels: ['Only'] })).status, 200);
    d = (await admin.c.get('/api/data')).json;
    assert.deepEqual(d.items.map(i => i.id).sort(), ['y8', 'z9']); assert.deepEqual(d.labels, ['Only']);
  });

  it('rejects malformed entries instead of storing them', async () => {
    for (const bad of [{ id: 'bad id!' }, { id: 'ok1', start: '2026-13-45' }, { id: 'ok2', effort: -3 }]) {
      const r = await admin.c.post('/api/data/sync', { upserts: [item('x', bad)], deletes: [] });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
  });

  it('keeps each person\'s diary private to them', async () => {
    await admin.c.post('/api/admin/users', { email: 'second@example.com', password: 'second pass 1', role: 'user' });
    const second = h.client(server.base);
    assert.equal((await second.post('/api/login', { email: 'second@example.com', password: 'second pass 1' })).status, 200);
    const note = (id, text) => ({ id, date: '2026-03-01', label: 'Idea', meeting: 'Weekly sync', text, createdAt: '2026-03-01T10:00:00.000Z', updatedAt: '2026-03-01T10:00:00.000Z' });
    await admin.c.post('/api/journal/sync', { upserts: [note('j1', 'admin private')], deletes: [] });
    await second.post('/api/journal/sync', { upserts: [note('j2', 'second private')], deletes: [] });
    assert.deepEqual((await admin.c.get('/api/journal')).json.notes.map(n => n.text), ['admin private']);
    assert.deepEqual((await second.get('/api/journal')).json.notes.map(n => n.text), ['second private']);
    assert.equal((await admin.c.get('/api/journal')).json.notes[0].meeting, 'Weekly sync');
    // one person cannot edit or delete the other's note by guessing its id
    await second.post('/api/journal/sync', { upserts: [note('j1', 'overwritten')], deletes: ['j1'] });
    assert.deepEqual((await admin.c.get('/api/journal')).json.notes.map(n => n.text), ['admin private']);
  });

  describe('administration', () => {
    let second;
    before(async () => { second = h.client(server.base); await second.post('/api/login', { email: 'second@example.com', password: 'second pass 1' }); });

    it('is for administrators only', async () => {
      for (const [m, p, b] of [['GET', '/api/admin/users'], ['GET', '/api/admin/sso'], ['GET', '/api/admin/database'], ['POST', '/api/admin/users', { email: 'e@example.com', password: 'password 12' }]]) {
        assert.equal((await second.req(m, p, b)).status, 403, p);
      }
      const page = await second.get('/admin.html'); assert.equal(page.status, 302); assert.equal(page.location, '/');
    });

    it('lists, adds, changes and removes accounts', async () => {
      assert.equal((await admin.c.post('/api/admin/users', { email: 'dup@example.com', password: 'password 12' })).status, 200);
      assert.equal((await admin.c.post('/api/admin/users', { email: 'DUP@example.com', password: 'password 12' })).status, 400, 'no duplicates');
      assert.equal((await admin.c.post('/api/admin/users', { email: 'not-an-email', password: 'password 12' })).status, 400);
      assert.equal((await admin.c.post('/api/admin/users', { email: 'f@example.com', password: 'short' })).status, 400);
      const list = (await admin.c.get('/api/admin/users')).json;
      assert.equal(list.you, 'admin@example.com');
      assert.ok(list.users.every(u => !('hash' in u) && !('salt' in u)), 'no password data is sent to the browser');
      const dup = h.client(server.base);
      assert.equal((await dup.post('/api/login', { email: 'dup@example.com', password: 'password 12' })).status, 200);
      // resetting the password signs them out and the new one works
      assert.equal((await admin.c.put('/api/admin/users/dup%40example.com', { password: 'brand new pass 5' })).status, 200);
      assert.equal((await dup.get('/api/me')).status, 401);
      assert.equal((await h.client(server.base).post('/api/login', { email: 'dup@example.com', password: 'password 12' })).status, 401);
      assert.equal((await h.client(server.base).post('/api/login', { email: 'dup@example.com', password: 'brand new pass 5' })).status, 200);
      assert.equal((await admin.c.del('/api/admin/users/dup%40example.com')).status, 200);
      assert.equal((await h.client(server.base).post('/api/login', { email: 'dup@example.com', password: 'brand new pass 5' })).status, 401);
    });

    it('applies a role change to someone who is already signed in', async () => {
      assert.equal((await admin.c.put('/api/admin/users/second%40example.com', { role: 'admin' })).status, 200);
      assert.equal((await second.get('/api/me')).json.role, 'admin');
      assert.equal((await second.get('/api/admin/users')).status, 200);
      assert.equal((await admin.c.put('/api/admin/users/second%40example.com', { role: 'user' })).status, 200);
      assert.equal((await second.get('/api/admin/users')).status, 403);
    });

    it('never leaves the app without an administrator', async () => {
      assert.equal((await admin.c.del('/api/admin/users/admin%40example.com')).status, 400, 'cannot delete yourself');
      assert.equal((await admin.c.put('/api/admin/users/admin%40example.com', { role: 'user' })).status, 400, 'cannot demote the last admin');
      assert.equal((await admin.c.get('/api/me')).json.role, 'admin');
    });

    it('saves single sign-on settings and checks them', async () => {
      const bad = await admin.c.put('/api/admin/sso', { enabled: false, loginUrl: 'http://not-https.example' });
      assert.equal(bad.status, 400);
      const ok = await admin.c.put('/api/admin/sso', { enabled: false, provider: 'saml', loginUrl: 'https://idp.example/sso', allowedDomains: 'Example.com, example.org' });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.sso.allowedDomains, 'example.com, example.org');
      assert.equal(ok.json.derived.replyUrl, `${server.base}/api/sso/acs`);
      assert.equal((await admin.c.get('/api/admin/sso')).json.sso.loginUrl, 'https://idp.example/sso');
    });

    it('shows the database and its schema version', async () => {
      const d = (await admin.c.get('/api/admin/database')).json;
      assert.equal(d.schemaInstalled, true); assert.equal(d.needsUpdate, false); assert.equal(d.schemaVersion, d.latestSchema);
      assert.equal((await admin.c.get('/api/admin/database')).text.includes('password'), false);
    });
  });

  it('remembers everything after a restart, and everyone signs in again', async () => {
    await server.stop();
    server = await h.startServer(server.dataDir);
    const c = h.client(server.base);
    assert.equal((await c.get('/api/me')).status, 401, 'sessions are not kept across restarts');
    assert.equal((await c.get('/')).location, '/login.html', 'configured, so it goes to sign-in and not setup');
    assert.equal((await c.post('/api/login', { email: 'admin@example.com', password: admin.password })).status, 200);
    const d = (await c.get('/api/data')).json;
    assert.deepEqual(d.items.map(i => i.id).sort(), ['y8', 'z9']);
    assert.equal((await c.get('/api/journal')).json.notes.length, 1);
  });

  it('can reset a forgotten administrator password from the command line', async () => {
    await server.stop();
    const { execFileSync } = require('child_process');
    const out = execFileSync(process.execPath, [require('path').join(__dirname, '..', 'server.js'), 'add-user', 'admin@example.com', 'recovered pass 7', 'admin'], { env: { ...process.env, PMO_DATA_DIR: server.dataDir } }).toString();
    assert.match(out, /Saved admin@example.com/);
    server = await h.startServer(server.dataDir);
    assert.equal((await h.client(server.base).post('/api/login', { email: 'admin@example.com', password: 'recovered pass 7' })).status, 200);
  });
});

describe('database problems', { skip: !h.haveSql && 'set PMO_TEST_SQL to run' }, () => {
  it('stays up with a clear message when the database is unreachable, and recovers', async () => {
    const s1 = await h.startServer();
    const { database } = await h.setUp(s1);
    await s1.stop();
    // point the same data folder at a port where nothing listens
    const fs = require('fs'), path = require('path');
    const file = path.join(s1.dataDir, 'config.json'); const real = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, real.replace(/"server": "[^"]+"/, '"server": "127.0.0.1,1"'));
    const s2 = await h.startServer(s1.dataDir);
    try {
      const c = h.client(s2.base);
      const page = await c.get('/'); assert.equal(page.status, 503); assert.match(page.text, /can't reach its database/);
      const api = await c.get('/api/data'); assert.equal(api.status, 503); assert.match(api.json.error, /can't reach its database/);
      assert.equal((await c.get('/api/setup/status')).json.configured, true, 'does not fall back to setup');
    } finally { await s2.stop(); await h.dropDatabase(database); }
  });
});

describe('loading an existing database', { skip: !h.haveSql && 'set PMO_TEST_SQL to run' }, () => {
  it('uses a database from an older version of my-pmo, upgrades it in place and keeps its data', async () => {
    const sql = require('mssql');
    const s1 = await h.startServer();
    const first = await h.setUp(s1);
    await first.c.post('/api/data/sync', { upserts: [item('keep1', { name: 'Kept through the upgrade' })], deletes: [] });
    await first.c.post('/api/journal/sync', { upserts: [{ id: 'jn1', date: '2026-03-01', label: '', meeting: '', text: 'old diary note', createdAt: '2026-03-01T10:00:00.000Z', updatedAt: '2026-03-01T10:00:00.000Z' }], deletes: [] });
    await s1.stop();
    // Turn it back into a version-3 database (what the previous server edition created): no accounts or settings tables.
    const { server: host, port } = sqlHost();
    const pool = new sql.ConnectionPool({ server: host, port, user: h.sqlConn('x').user, password: h.sqlConn('x').password, database: first.database, options: { encrypt: true, trustServerCertificate: true } });
    await pool.connect();
    await pool.request().batch(`DROP TABLE pmo.AppUser; DROP TABLE pmo.Setting; UPDATE pmo.Meta SET V = N'3' WHERE K = N'schemaVersion'`);
    await pool.close();

    const s2 = await h.startServer(); // a brand-new install, pointed at that old database
    try {
      const c = h.client(s2.base);
      const t = await c.post('/api/setup/test', { token: s2.token, ...h.sqlConn(first.database) });
      assert.equal(t.json.schemaInstalled, true); assert.equal(t.json.schemaVersion, 3); assert.equal(t.json.needsUpdate, true); assert.equal(t.json.hasData, true);
      // "create new" must not touch a database that already holds data
      const refused = await c.post('/api/setup/complete', { token: s2.token, ...h.sqlConn(first.database), mode: 'create', admin: { email: 'n@example.com', password: 'password 12' } });
      assert.equal(refused.status, 400); assert.match(refused.json.error, /already holds my-pmo data/);
      // "use existing" on a database with no accounts needs a first administrator
      const noAdmin = await c.post('/api/setup/complete', { token: s2.token, ...h.sqlConn(first.database), mode: 'existing', admin: { email: 'bad', password: 'x' } });
      assert.equal(noAdmin.status, 400);
      assert.equal((await c.get('/api/setup/status')).json.configured, false);
      const ok = await c.post('/api/setup/complete', { token: s2.token, ...h.sqlConn(first.database), mode: 'existing', admin: { email: 'new.admin@example.com', password: 'password 12' } });
      assert.equal(ok.status, 200);
      assert.ok(ok.json.steps.some(x => /Updated the schema from version 3/.test(x)), ok.json.steps.join('|'));
      assert.deepEqual((await c.get('/api/data')).json.items.map(i => i.name), ['Kept through the upgrade']);
      assert.equal((await c.get('/api/admin/database')).json.schemaVersion, 4);
      // the old diary belonged to admin@example.com, so it is theirs if they get an account again
      await c.post('/api/admin/users', { email: 'admin@example.com', password: 'password 12', role: 'user' });
      const old = h.client(s2.base); await old.post('/api/login', { email: 'admin@example.com', password: 'password 12' });
      assert.deepEqual((await old.get('/api/journal')).json.notes.map(n => n.text), ['old diary note']);
    } finally { await s2.stop(); await h.dropDatabase(first.database); }
  });

  it('does not create an administrator when the database already has one', async () => {
    const s1 = await h.startServer();
    const first = await h.setUp(s1, { email: 'existing.admin@example.com', password: 'existing pass 3' });
    await s1.stop();
    const s2 = await h.startServer();
    try {
      const c = h.client(s2.base);
      const ok = await c.post('/api/setup/complete', { token: s2.token, ...h.sqlConn(first.database), mode: 'existing' });
      assert.equal(ok.status, 200); assert.equal(ok.json.signedIn, false);
      assert.equal(c.hasSession(), false);
      assert.equal((await c.post('/api/login', { email: 'existing.admin@example.com', password: 'existing pass 3' })).status, 200);
    } finally { await s2.stop(); await h.dropDatabase(first.database); }
  });

  it('will not "use existing" on a database that has no my-pmo tables', async () => {
    const s = await h.startServer();
    try {
      const r = await h.client(s.base).post('/api/setup/complete', { token: s.token, ...h.sqlConn('master'), mode: 'existing', admin: { email: 'a@example.com', password: 'password 12' } });
      assert.equal(r.status, 400); assert.match(r.json.error, /No my-pmo tables/);
    } finally { await s.stop(); }
  });
});
