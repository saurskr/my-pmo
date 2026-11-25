(() => {
  const $ = id => document.getElementById(id);
  const api = (...a) => window.pmoPlatform.api(...a);
  const show = (id, text, kind) => { const m = $(id); m.hidden = !text; m.textContent = text || ''; m.className = 'msg ' + (kind || 'info'); };
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };

  /* ---------- users ---------- */

  let me = '';
  async function loadUsers() {
    try {
      const d = await api('GET', '/api/admin/users');
      me = d.you;
      const host = $('users');
      host.replaceChildren(el('div', { className: 'urow head' }, el('span', { textContent: 'Email' }), el('span', { textContent: 'Role' }), el('span', { textContent: 'Sign-in' }), el('span', { textContent: 'Last signed in' }), el('span')));
      for (const u of d.users) host.append(userRow(u));
    } catch (e) { show('users-msg', e.message, 'err'); }
  }

  function userRow(u) {
    const isMe = u.email === me;
    const role = el('select', { className: 'role', ariaLabel: `Role of ${u.email}` }, el('option', { value: 'user', textContent: 'User' }), el('option', { value: 'admin', textContent: 'Administrator' }));
    role.value = u.role;
    role.addEventListener('change', () => change(u.email, { role: role.value }, 'Role changed.', () => { role.value = u.role; }));
    const row = el('div', { className: 'urow' },
      el('span', { className: 'em', title: u.email, textContent: u.email + (isMe ? ' (you)' : '') }),
      role,
      el('span', { className: 'src', textContent: u.source === 'saml' ? 'Single sign-on' : 'Password' }),
      el('span', { className: 'last muted', textContent: u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'Never' }));
    const acts = el('span', { className: 'acts' });
    const setPw = el('button', { type: 'button', textContent: u.hasPassword ? 'Reset password' : 'Set password' });
    setPw.addEventListener('click', () => {
      const input = el('input', { type: 'password', placeholder: 'New password (8+ characters)', autocomplete: 'new-password', ariaLabel: 'New password' });
      const save = el('button', { type: 'button', className: 'primary', textContent: 'Save' });
      const cancel = el('button', { type: 'button', textContent: 'Cancel' });
      const box = el('div', { className: 'pw' }, input, save, cancel);
      row.append(box); input.focus();
      cancel.addEventListener('click', () => box.remove());
      save.addEventListener('click', () => change(u.email, { password: input.value }, 'Password changed.'));
    });
    acts.append(setPw);
    if (!isMe) {
      const del = el('button', { type: 'button', className: 'danger', textContent: 'Delete' });
      del.addEventListener('click', async () => {
        if (!confirm(`Delete the account ${u.email}? Their notes stay in the database but they can no longer sign in.`)) return;
        try { await api('DELETE', '/api/admin/users/' + encodeURIComponent(u.email)); show('users-msg', 'Deleted.', 'ok'); loadUsers(); }
        catch (e) { show('users-msg', e.message, 'err'); }
      });
      acts.append(del);
    }
    row.append(acts);
    return row;
  }

  async function change(email, body, okText, undo) {
    try { await api('PUT', '/api/admin/users/' + encodeURIComponent(email), body); show('users-msg', okText, 'ok'); loadUsers(); }
    catch (e) { show('users-msg', e.message, 'err'); if (undo) undo(); }
  }

  $('add-user').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('POST', '/api/admin/users', { email: $('u-email').value, password: $('u-pw').value, role: $('u-role').value });
      $('u-email').value = $('u-pw').value = ''; show('users-msg', 'Added.', 'ok'); loadUsers();
    } catch (err) { show('users-msg', err.message, 'err'); }
  });

  /* ---------- single sign-on ---------- */

  const FIELDS = ['loginUrl', 'idpIssuer', 'certificate', 'emailClaim', 'allowedDomains', 'baseUrl'];
  const HELP = {
    entra: {
      give: 'In the Azure portal: Microsoft Entra ID → Enterprise applications → New application → Create your own application → Single sign-on → SAML. Paste these into "Basic SAML Configuration". In "SAML Certificates" keep "Sign SAML assertion" on (the default).',
      get: 'From "Set up my-pmo" in Entra: Login URL, Microsoft Entra Identifier, and download "Certificate (Base64)", then paste its text below.',
      issuer: 'Microsoft Entra Identifier',
    },
    saml: {
      give: "Create a SAML 2.0 application in your identity provider and paste these values into its service provider settings. The assertion must be signed.",
      get: "From your identity provider: its single sign-on URL, its entity ID (issuer), and its signing certificate.",
      issuer: 'Identity provider entity ID (issuer)',
    },
  };
  const helpFor = () => { const h = HELP[$('provider').value]; $('help-give').textContent = h.give; $('help-get').textContent = h.get; $('l-issuer').textContent = h.issuer; };
  $('provider').addEventListener('change', helpFor);

  function fillSso(d) {
    $('enabled').checked = d.sso.enabled; $('provider').value = d.sso.provider; $('autoProvision').checked = d.sso.autoProvision;
    for (const f of FIELDS) $(f).value = d.sso[f];
    $('d-entity').value = d.derived.entityId; $('d-reply').value = d.derived.replyUrl; $('d-signon').value = d.derived.signOnUrl;
    helpFor();
  }
  api('GET', '/api/admin/sso').then(fillSso).catch(e => show('sso-msg', e.message, 'err'));

  $('sso-form').addEventListener('submit', async e => {
    e.preventDefault();
    const body = { enabled: $('enabled').checked, provider: $('provider').value, autoProvision: $('autoProvision').checked };
    for (const f of FIELDS) body[f] = $(f).value;
    try { fillSso(await api('PUT', '/api/admin/sso', body)); show('sso-msg', 'Saved.', 'ok'); }
    catch (err) { show('sso-msg', err.message, 'err'); }
  });

  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    try { await navigator.clipboard.writeText($(b.dataset.copy).value); b.textContent = 'Copied'; } catch (err) { $(b.dataset.copy).select(); b.textContent = 'Press Ctrl+C'; }
    setTimeout(() => { b.textContent = 'Copy'; }, 1500);
  });

  /* ---------- database ---------- */

  async function loadDb() {
    try {
      const d = await api('GET', '/api/admin/database');
      const rows = [['Server', d.server], ['Database', d.database], ['SQL login', d.user], ['SQL Server', `${d.edition || ''} ${d.serverVersion || ''}`.trim()],
        ['Schema', d.schemaInstalled ? `version ${d.schemaVersion}${d.needsUpdate ? ` (latest is ${d.latestSchema})` : ' — up to date'}` : 'not installed']];
      $('db').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v })]));
      $('db-update').hidden = !d.needsUpdate;
      show('db-msg', d.needsUpdate ? 'The database needs an update. Your data is kept.' : '', 'info');
    } catch (e) { show('db-msg', e.message, 'err'); }
  }
  $('db-update').addEventListener('click', async () => {
    $('db-update').disabled = true;
    try { const r = await api('POST', '/api/admin/database/update-schema'); show('db-msg', r.steps.join('\n'), 'ok'); await loadDb(); }
    catch (e) { show('db-msg', e.message, 'err'); }
    finally { $('db-update').disabled = false; }
  });

  window.pmoPlatform.ready.then(() => { loadUsers(); loadDb(); }).catch(() => {});
})();
