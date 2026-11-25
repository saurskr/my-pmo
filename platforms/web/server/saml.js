'use strict';
// SAML 2.0 single sign-on (service provider). Settings live in pmo.Setting under the key "saml".
// Works with Microsoft Entra ID and any SAML 2.0 identity provider that signs its assertions.
const { SAML, ValidateInResponseTo } = require('@node-saml/node-saml');
const { bad } = require('./validate');

const KEY = 'saml';
const CLAIM_EMAIL = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress';

const DEFAULTS = {
  enabled: false,
  provider: 'entra',
  loginUrl: '',        // the identity provider's sign-on URL (Entra: "Login URL")
  idpIssuer: '',       // the identity provider's identifier (Entra: "Microsoft Entra Identifier")
  certificate: '',     // the identity provider's signing certificate, Base64
  emailClaim: '',      // attribute holding the email address; blank = try the usual ones, then the NameID
  allowedDomains: '',  // blank = any; otherwise only these email domains may sign in
  baseUrl: '',         // blank = the address the browser used
  autoProvision: true, // create an account the first time someone signs in through the identity provider
};

function validate(input) {
  input = input || {};
  const str = (k, max) => {
    const v = input[k] == null ? '' : String(input[k]).trim();
    if (v.length > max) throw bad(`${k} is too long`);
    return v;
  };
  const s = { ...DEFAULTS };
  s.enabled = input.enabled === true;
  s.autoProvision = input.autoProvision !== false;
  s.provider = ['entra', 'saml'].includes(input.provider) ? input.provider : 'entra';
  s.loginUrl = str('loginUrl', 1000);
  s.idpIssuer = str('idpIssuer', 1000);
  s.emailClaim = str('emailClaim', 500);
  s.baseUrl = str('baseUrl', 300).replace(/\/+$/, '');
  s.allowedDomains = str('allowedDomains', 1000);
  s.certificate = str('certificate', 20000).replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  if (s.loginUrl && !/^https:\/\/[^\s]+$/i.test(s.loginUrl)) throw bad('Login URL must start with https://');
  if (s.baseUrl && !/^https?:\/\/[^\s/]+(\/\S*)?$/i.test(s.baseUrl)) throw bad('Application URL must be a valid http(s) address');
  if (s.certificate && !/^[A-Za-z0-9+/=]+$/.test(s.certificate)) throw bad('Certificate must be Base64 text');
  const domains = s.allowedDomains.split(/[\s,;]+/).filter(Boolean).map(d => d.toLowerCase());
  if (domains.some(d => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))) throw bad('Allowed domains must look like example.com');
  s.allowedDomains = domains.join(', ');
  if (s.enabled && !(s.loginUrl && s.idpIssuer && s.certificate)) throw bad('To enable single sign-on, fill in Login URL, Identifier and Certificate');
  return s;
}

async function load(store) {
  try { return { ...DEFAULTS, ...JSON.parse((await store.getSetting(KEY)) || '{}') }; } catch (e) { return { ...DEFAULTS }; }
}
async function save(store, settings) {
  await store.setSetting(KEY, JSON.stringify(settings));
  cached = null; // rebuild with the new settings
}

// The address people use for the app (needed to build the URLs the identity provider calls back).
function baseUrl(req, settings) {
  if (settings.baseUrl) return settings.baseUrl;
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers.host}`;
}

const derived = base => ({ entityId: `${base}/api/sso/metadata`, replyUrl: `${base}/api/sso/acs`, signOnUrl: `${base}/` });

// One instance is kept so that it remembers which requests it issued and which assertions it has already accepted.
let cached = null;
function client(settings, base) {
  const key = JSON.stringify([settings, base]);
  if (cached && cached.key === key) return cached.saml;
  const d = derived(base);
  const saml = new SAML({
    callbackUrl: d.replyUrl,
    entryPoint: settings.loginUrl,
    issuer: d.entityId,
    audience: d.entityId,
    idpCert: settings.certificate,
    idpIssuer: settings.idpIssuer,
    identifierFormat: null,
    disableRequestedAuthnContext: true,
    wantAssertionsSigned: true,          // the assertion itself must carry a valid signature (Entra's default)
    wantAuthnResponseSigned: false,
    validateInResponseTo: ValidateInResponseTo.ifPresent, // answers to our own requests are matched; IdP-initiated ones are allowed
    rejectReplayedAssertions: true,
    acceptedClockSkewMs: 60 * 1000,
    maxAssertionAgeMs: 10 * 60 * 1000,
  });
  cached = { key, saml };
  return saml;
}

async function loginUrl(settings, base) {
  return client(settings, base).getAuthorizeUrlAsync('', undefined, {});
}

function metadata(settings, base) {
  return client(settings, base).generateServiceProviderMetadata(null, null);
}

const FALLBACK_CLAIMS = [CLAIM_EMAIL, 'email', 'mail', 'urn:oid:0.9.2342.19200300.100.1.3', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn'];
const looksLikeEmail = v => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

function emailFrom(profile, settings) {
  const names = settings.emailClaim ? [settings.emailClaim] : FALLBACK_CLAIMS;
  for (const n of names) {
    const v = Array.isArray(profile[n]) ? profile[n][0] : profile[n];
    if (looksLikeEmail(v)) return v.trim().toLowerCase();
  }
  if (!settings.emailClaim && looksLikeEmail(profile.nameID)) return profile.nameID.trim().toLowerCase();
  return null;
}

// Checks the identity provider's response and returns the email address of the person it vouches for.
async function acceptResponse(settings, base, form) {
  if (!form.SAMLResponse) throw bad('No SAML response was received');
  let result;
  try { result = await client(settings, base).validatePostResponseAsync({ SAMLResponse: form.SAMLResponse, RelayState: form.RelayState || '' }); }
  catch (e) { throw Object.assign(new Error('The identity provider\'s response could not be verified. ' + e.message), { status: 401 }); }
  if (!result.profile) throw Object.assign(new Error('The identity provider\'s response did not identify anyone.'), { status: 401 });
  const email = emailFrom(result.profile, settings);
  if (!email) throw Object.assign(new Error('The response did not include an email address. Set the email attribute under Administration, or have the identity provider send it.'), { status: 401 });
  const domains = settings.allowedDomains.split(/[\s,]+/).filter(Boolean);
  if (domains.length && !domains.includes(email.split('@')[1])) throw Object.assign(new Error(`${email} is not in an allowed domain.`), { status: 403 });
  return email;
}

module.exports = { DEFAULTS, validate, load, save, baseUrl, derived, loginUrl, metadata, acceptResponse };
