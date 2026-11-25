(() => {
  const $ = id => document.getElementById(id);
  const show = (id, text, kind) => { const m = $(id); m.hidden = !text; m.textContent = text || ''; m.className = 'msg ' + (kind || 'info'); };
  let info = null; // what the last connection test found

  const conn = () => ({
    token: $('token').value.trim(), server: $('server').value, database: $('database').value,
    user: $('user').value, password: $('password').value, encrypt: true, trustServerCertificate: $('trust').checked,
  });

  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
    return d;
  }

  // Already set up? Then this page has nothing to do.
  fetch('/api/setup/status').then(r => r.json()).then(s => {
    if (s.configured) location.href = '/login.html';
    if (s.downloadUrl) $('dl').href = s.downloadUrl;
  }).catch(() => {});

  function describe(r) {
    const bits = [`Connected to ${r.edition || 'SQL Server'} ${r.serverVersion || ''}.`.replace(/\s+\./, '.')];
    if (!r.databaseExists) bits.push(`The database "${$('database').value}" doesn't exist yet${r.canCreateDatabase ? ' — setup can create it.' : ', and this login is not allowed to create databases. Ask your SQL Server administrator to create it, or use a login with the dbcreator role.'}`);
    else if (!r.schemaInstalled) bits.push('The database exists but has no my-pmo tables.');
    else bits.push(`Found a my-pmo database (schema version ${r.schemaVersion})${r.hasData ? ' with data' : ''}${r.needsUpdate ? '; it will be updated in place, your data is kept' : ''}.`);
    return bits.join(' ');
  }

  function offerChoices(r) {
    info = r;
    $('s3').hidden = false;
    const createOk = !(r.schemaInstalled && r.hasData) && (r.databaseExists || r.canCreateDatabase);
    const existingOk = r.databaseExists && r.schemaInstalled;
    $('m-create').disabled = !createOk; $('m-existing').disabled = !existingOk;
    $('d-create').textContent = !createOk
      ? (r.schemaInstalled && r.hasData ? 'Not available: that database already holds my-pmo data.' : 'Not available: the database does not exist and this login cannot create it.')
      : r.databaseExists ? 'Adds the my-pmo tables to the existing empty database.' : 'Creates the database and the my-pmo tables.';
    $('d-existing').textContent = existingOk
      ? `Keeps everything in it${r.userCount ? ` (${r.userCount} account${r.userCount === 1 ? '' : 's'})` : ''}${r.needsUpdate ? ' and brings it up to date' : ''}.`
      : 'Not available: no my-pmo database was found.';
    (existingOk ? $('m-existing') : $('m-create')).checked = createOk || existingOk;
    refresh();
  }

  const mode = () => (document.querySelector('input[name=mode]:checked') || {}).value;

  function refresh() {
    const m = mode();
    const needAdmin = m === 'create' || (m === 'existing' && info && !info.adminCount);
    $('s4').hidden = !(m && needAdmin);
    $('s5').hidden = !m;
  }
  document.querySelectorAll('input[name=mode]').forEach(i => i.addEventListener('change', refresh));
  // Changing the connection invalidates what we found.
  ['token', 'server', 'database', 'user', 'password'].forEach(id => $(id).addEventListener('input', () => { info = null; $('s3').hidden = $('s4').hidden = $('s5').hidden = true; show('test-msg', ''); }));

  $('s2').addEventListener('submit', async e => {
    e.preventDefault();
    show('test-msg', 'Connecting…');
    $('test').disabled = true;
    try { const r = await post('/api/setup/test', conn()); show('test-msg', describe(r), 'ok'); offerChoices(r); }
    catch (err) { show('test-msg', err.message, 'err'); }
    finally { $('test').disabled = false; }
  });

  $('finish').addEventListener('click', async () => {
    show('finish-msg', 'Setting up… this can take a few seconds.');
    $('finish').disabled = true;
    try {
      const body = { ...conn(), mode: mode(), admin: { email: $('a-email').value, password: $('a-password').value } };
      const r = await post('/api/setup/complete', body);
      show('finish-msg', r.steps.join('\n') + '\n\nAll set.', 'ok');
      setTimeout(() => { location.href = r.signedIn ? '/' : '/login.html'; }, 1500);
    } catch (err) { show('finish-msg', err.message, 'err'); $('finish').disabled = false; }
  });
})();
