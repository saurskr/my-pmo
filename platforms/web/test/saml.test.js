'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

describe('SAML 2.0 sign-in', { skip: !h.haveSql && 'set PMO_TEST_SQL to run' }, () => {
  let server, admin, db, idp, entityId, acs;

  const configure = patch => admin.c.put('/api/admin/sso', {
    enabled: true, provider: 'entra', loginUrl: idp.loginUrl, idpIssuer: idp.entityId, certificate: idp.certificate, autoProvision: true, ...patch,
  });
  // Plays the identity provider: ask the app to start sign-in, then answer it.
  async function signIn(opts = {}, who = h.client(server.base)) {
    const start = await who.get('/api/sso/login');
    assert.equal(start.status, 302);
    assert.ok(start.location.startsWith(idp.loginUrl), 'redirects to the identity provider');
    const response = h.samlResponse(idp, { acs, audience: entityId, inResponseTo: h.requestIdFrom(start.location), ...opts });
    const done = await who.post('/api/sso/acs', undefined, { form: { SAMLResponse: response, RelayState: '' } });
    return { who, done, response };
  }

  before(async () => {
    idp = h.makeIdp();
    server = await h.startServer();
    ({ db, ...admin } = await (async () => { const r = await h.setUp(server); return { db: r.database, ...r }; })());
    entityId = `${server.base}/api/sso/metadata`; acs = `${server.base}/api/sso/acs`;
    assert.equal((await configure({})).status, 200);
  });
  after(async () => { await server.stop(); await h.dropDatabase(db); });

  it('is advertised on the sign-in page only when switched on', async () => {
    assert.equal((await h.client(server.base).get('/api/sso/status')).json.enabled, true);
    await configure({ enabled: false });
    assert.equal((await h.client(server.base).get('/api/sso/status')).json.enabled, false);
    assert.match((await h.client(server.base).get('/api/sso/login')).location, /sso=off/);
    await configure({});
  });

  it('refuses to turn on without the identity provider details', async () => {
    const r = await admin.c.put('/api/admin/sso', { enabled: true });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Login URL, Identifier and Certificate/);
    await configure({});
  });

  it('publishes service provider metadata with the entity id and reply URL', async () => {
    const m = await h.client(server.base).get('/api/sso/metadata');
    assert.equal(m.status, 200);
    assert.match(m.text, new RegExp(`entityID="${entityId}"`));
    assert.match(m.text, new RegExp(acs.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  });

  it('signs a person in with a valid signed assertion and creates their account', async () => {
    const { who, done } = await signIn({ email: 'new.person@example.com' });
    assert.equal(done.status, 302);
    assert.equal(done.location, '/');
    assert.ok(who.hasSession());
    const me = await who.get('/api/me');
    assert.deepEqual(me.json, { email: 'new.person@example.com', role: 'user' });
    const users = (await admin.c.get('/api/admin/users')).json.users;
    const u = users.find(x => x.email === 'new.person@example.com');
    assert.ok(u && u.source === 'saml' && u.hasPassword === false);
    // an account with no password cannot be used to sign in with a password
    const bad = await h.client(server.base).post('/api/login', { email: 'new.person@example.com', password: 'anything at all' });
    assert.equal(bad.status, 401);
  });

  it('accepts an identity-provider-initiated sign-in (no request id)', async () => {
    const who = h.client(server.base);
    const response = h.samlResponse(idp, { email: 'idp.first@example.com', acs, audience: entityId });
    const done = await who.post('/api/sso/acs', undefined, { form: { SAMLResponse: response } });
    assert.equal(done.location, '/');
    assert.equal((await who.get('/api/me')).json.email, 'idp.first@example.com');
  });

  it('falls back to the name identifier when no email attribute is sent', async () => {
    const { who, done } = await signIn({ email: 'nameid.only@example.com', attrs: {} });
    assert.equal(done.location, '/');
    assert.equal((await who.get('/api/me')).json.email, 'nameid.only@example.com');
  });

  it('reads the email from a configured attribute', async () => {
    await configure({ emailClaim: 'corp-mail' });
    const { who, done } = await signIn({ email: 'x@example.com', nameId: 'opaque-id-123', attrs: { 'corp-mail': 'Attr.User@Example.com' } });
    assert.equal(done.location, '/');
    assert.equal((await who.get('/api/me')).json.email, 'attr.user@example.com');
    await configure({});
  });

  it('keeps an existing account and its role when they sign in again', async () => {
    await admin.c.put('/api/admin/users/' + encodeURIComponent('new.person@example.com'), { role: 'admin' });
    const { who } = await signIn({ email: 'new.person@example.com' });
    assert.equal((await who.get('/api/me')).json.role, 'admin');
  });

  it('rejects a replayed response', async () => {
    const { response } = await signIn({ email: 'replay@example.com' });
    const again = h.client(server.base);
    const done = await again.post('/api/sso/acs', undefined, { form: { SAMLResponse: response } });
    assert.match(done.location, /sso=failed/);
    assert.equal(again.hasSession(), false);
  });

  const refused = async (name, opts, expected = /sso=failed/) => it(`rejects ${name}`, async () => {
    const before = (await admin.c.get('/api/admin/users')).json.users.length;
    const { who, done } = await signIn(opts);
    assert.match(done.location, expected);
    assert.equal(who.hasSession(), false);
    assert.equal((await admin.c.get('/api/admin/users')).json.users.length, before, 'no account was created');
  });
  refused('an unsigned assertion', { email: 'unsigned@example.com', sign: false });
  refused('an assertion signed with the wrong key', { email: 'forged@example.com', signWith: h.makeIdp().main });
  refused('an assertion meant for another application', { email: 'wrongaud@example.com', audience: 'https://other.app/entity' });
  refused('an assertion from another issuer', { email: 'wrongiss@example.com', issuer: 'https://evil.test/entity' });
  refused('an expired assertion', { email: 'expired@example.com', lifetimeMs: -10 * 60 * 1000 });
  refused('an answer to a request we never made', { email: 'stranger@example.com', inResponseTo: '_not_ours' });

  it('rejects a response with no assertion signature even if the response claims an email', async () => {
    const who = h.client(server.base);
    const done = await who.post('/api/sso/acs', undefined, { form: { SAMLResponse: Buffer.from('<nonsense/>').toString('base64') } });
    assert.match(done.location, /sso=failed/);
    assert.equal(who.hasSession(), false);
  });

  it('enforces the allowed email domains', async () => {
    await configure({ allowedDomains: 'example.com' });
    const ok = await signIn({ email: 'inside@example.com' });
    assert.equal(ok.done.location, '/');
    const no = await signIn({ email: 'outside@elsewhere.org' });
    assert.match(no.done.location, /sso=domain/);
    assert.equal(no.who.hasSession(), false);
    await configure({});
  });

  it('can be limited to people who already have an account', async () => {
    await configure({ autoProvision: false });
    const stranger = await signIn({ email: 'not.listed@example.com' });
    assert.match(stranger.done.location, /sso=noaccount/);
    assert.equal(stranger.who.hasSession(), false);
    const known = await signIn({ email: 'new.person@example.com' });
    assert.equal(known.done.location, '/');
    await configure({});
  });

  it('does not accept SAML responses while single sign-on is off', async () => {
    await configure({ enabled: false });
    const who = h.client(server.base);
    const response = h.samlResponse(idp, { email: 'off@example.com', acs, audience: entityId });
    const done = await who.post('/api/sso/acs', undefined, { form: { SAMLResponse: response } });
    assert.match(done.location, /sso=off/);
    assert.equal(who.hasSession(), false);
    await configure({});
  });
});
