'use strict';
// Test helpers: start the real server against a real SQL Server, talk to it with a cookie-keeping client,
// and play the part of a SAML identity provider.
//
//   PMO_TEST_SQL='localhost,14330|sa|<password>' npm test
//
// Without PMO_TEST_SQL the database-backed tests are skipped.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const net = require('net');

const SQL = (process.env.PMO_TEST_SQL || '').split('|');
const haveSql = SQL.length === 3 && SQL.every(Boolean);
const sqlConn = (database) => ({ server: SQL[0], user: SQL[1], password: SQL[2], database, encrypt: true, trustServerCertificate: true });

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

async function startServer(dataDir) {
  dataDir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'pmo-test-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PMO_DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const ready = new Promise((resolve, reject) => {
    const on = d => { log += d; if (/running at/.test(log)) resolve(); };
    child.stdout.on('data', on); child.stderr.on('data', d => { log += d; });
    child.on('exit', code => reject(new Error(`server exited early (${code}): ${log}`)));
    setTimeout(() => reject(new Error('server did not start: ' + log)), 15000);
  });
  await ready;
  const token = (log.match(/setup code:\s+(\S+)/) || [])[1];
  return {
    base: `http://127.0.0.1:${port}`, dataDir, token, log: () => log,
    stop: () => new Promise(resolve => { child.removeAllListeners('exit'); child.on('exit', resolve); child.kill(); }),
  };
}

// A browser-like client: keeps the session cookie, never follows redirects (so tests can look at them).
function client(base) {
  let cookie = '';
  async function req(method, p, body, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (cookie) headers.cookie = cookie;
    let payload;
    if (opts.form) { headers['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(opts.form).toString(); }
    else if (body !== undefined) { headers['content-type'] = opts.contentType || 'application/json'; payload = typeof body === 'string' ? body : JSON.stringify(body); }
    const res = await fetch(base + p, { method, headers, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const pair = c.split(';')[0];
      cookie = pair.endsWith('=') ? '' : pair; // an empty value means "forget the session"
    }
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { status: res.status, headers: res.headers, location: res.headers.get('location'), text, json };
  }
  return { req, get: (p, o) => req('GET', p, undefined, o), post: (p, b, o) => req('POST', p, b, o), put: (p, b) => req('PUT', p, b), del: p => req('DELETE', p), hasSession: () => !!cookie };
}

async function dropDatabase(name) {
  if (!haveSql) return;
  const sql = require('mssql');
  const pool = new sql.ConnectionPool({ server: SQL[0].split(',')[0], port: Number(SQL[0].split(',')[1]) || 1433, user: SQL[1], password: SQL[2], database: 'master', options: { encrypt: true, trustServerCertificate: true } });
  await pool.connect();
  try { await pool.request().batch(`IF DB_ID(N'${name}') IS NOT NULL BEGIN ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${name}]; END`); }
  finally { await pool.close(); }
}

const uniqueDb = () => 'pmo_t_' + crypto.randomBytes(4).toString('hex');

// Run setup through the real API; returns a client signed in as the new administrator.
async function setUp(server, { database = uniqueDb(), email = 'admin@example.com', password = 'correct horse 9', mode = 'create' } = {}) {
  const c = client(server.base);
  const r = await c.post('/api/setup/complete', { token: server.token, ...sqlConn(database), mode, admin: { email, password } });
  if (r.status !== 200) throw new Error(`setup failed: ${r.status} ${r.text}`);
  return { c, database, email, password, result: r.json };
}

/* ---------- a mock SAML identity provider ---------- */

function makeIdp(entityId = 'https://idp.test/entity') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmo-idp-'));
  const gen = name => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/${name}.key`, '-out', `${dir}/${name}.crt`, '-subj', `/CN=${name}`, '-days', '2'], { stdio: 'ignore' });
    return { key: fs.readFileSync(`${dir}/${name}.key`, 'utf8'), cert: fs.readFileSync(`${dir}/${name}.crt`, 'utf8') };
  };
  const main = gen('idp'), rogue = gen('rogue');
  const b64cert = c => c.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return { entityId, loginUrl: 'https://idp.test/sso', certificate: b64cert(main.cert), main, rogue, b64cert };
}

const iso = ms => new Date(ms).toISOString();

// Builds a SAML response like Entra's: an unsigned Response around a signed Assertion.
function samlResponse(idp, o) {
  const { SignedXml } = require('xml-crypto');
  const now = Date.now();
  const id = '_' + crypto.randomBytes(10).toString('hex'), aid = '_' + crypto.randomBytes(10).toString('hex');
  const email = o.email, nameId = o.nameId === undefined ? email : o.nameId;
  const attrs = o.attrs === undefined ? { 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': email } : o.attrs;
  const irt = o.inResponseTo ? ` InResponseTo="${o.inResponseTo}"` : '';
  const xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${iso(now)}" Destination="${o.acs}"${irt}>` +
    `<saml:Issuer>${o.issuer || idp.entityId}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `<saml:Assertion ID="${aid}" Version="2.0" IssueInstant="${iso(now)}"><saml:Issuer>${o.issuer || idp.entityId}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">${nameId}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${iso(now + (o.lifetimeMs ?? 300000))}" Recipient="${o.acs}"${irt}/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(now - 60000)}" NotOnOrAfter="${iso(now + (o.lifetimeMs ?? 300000))}"><saml:AudienceRestriction><saml:Audience>${o.audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="${aid}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement>${Object.entries(attrs).map(([k, v]) => `<saml:Attribute Name="${k}"><saml:AttributeValue>${v}</saml:AttributeValue></saml:Attribute>`).join('')}</saml:AttributeStatement></saml:Assertion></samlp:Response>`;
  let out = xml;
  if (o.sign !== false) {
    const signer = o.signWith || idp.main;
    const sig = new SignedXml({ privateKey: signer.key, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
    sig.addReference({ xpath: "//*[local-name(.)='Assertion']", digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256', transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'] });
    sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' } });
    out = sig.getSignedXml();
  }
  return Buffer.from(out).toString('base64');
}

// The ID of the AuthnRequest the app sent us (from the redirect to the identity provider).
function requestIdFrom(location) {
  const q = new URL(location).searchParams.get('SAMLRequest');
  return zlib.inflateRawSync(Buffer.from(q, 'base64')).toString().match(/ID="([^"]+)"/)[1];
}

module.exports = { haveSql, sqlConn, startServer, client, dropDatabase, uniqueDb, setUp, makeIdp, samlResponse, requestIdFrom };
