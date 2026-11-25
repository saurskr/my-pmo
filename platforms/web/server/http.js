'use strict';
// Small HTTP helpers: responses, body parsing and static files.
const fs = require('fs');
const path = require('path');
const { bad } = require('./validate');

const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  // Scripts only from this origin; inline styles are needed by the design system's colour variables.
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

const redirect = (res, location, headers = {}) => { res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...headers }); res.end(); };

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// JSON only: a cross-site page cannot send this content type without the browser asking permission first.
async function readJson(req, limit = 64 * 1024) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw bad('Expected JSON');
  const text = await readBody(req, limit);
  try { return JSON.parse(text || '{}'); } catch (e) { throw bad('Invalid JSON'); }
}

// The identity provider posts a normal HTML form to the SAML reply URL.
async function readForm(req, limit = 256 * 1024) {
  if (!(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) throw bad('Expected a form post');
  return Object.fromEntries(new URLSearchParams(await readBody(req, limit)));
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// Look for the file in each root in turn (platform files first, then the shared app).
function serveFile(res, roots, pathname) {
  if (pathname === '/') pathname = '/index.html';
  for (const root of roots) {
    const file = path.normalize(path.join(root, pathname));
    if (!file.startsWith(root + path.sep)) continue;
    let data;
    try { if (!fs.statSync(file).isFile()) continue; data = fs.readFileSync(file); } catch (e) { continue; }
    return send(res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream'), true;
  }
  return false;
}

module.exports = { send, redirect, readJson, readForm, serveFile };
