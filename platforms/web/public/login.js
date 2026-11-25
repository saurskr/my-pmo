(() => {
  const $ = id => document.getElementById(id);
  const show = (text, kind) => { const m = $('msg'); m.hidden = !text; m.textContent = text || ''; m.className = 'msg ' + (kind || 'err'); };

  // The identity provider sends people back here with ?sso=... when something went wrong.
  const REASONS = {
    off: 'Single sign-on is not turned on.',
    failed: "Single sign-on didn't work. Ask an administrator to check the identity provider settings.",
    noaccount: 'You signed in with your organisation, but you do not have an account here yet. Ask an administrator to add you.',
    domain: 'Your email address is not in a domain that is allowed to sign in here.',
  };
  const why = new URLSearchParams(location.search).get('sso');
  if (why && REASONS[why]) show(REASONS[why]);

  fetch('/api/sso/status').then(r => r.json()).then(s => { $('sso').hidden = !s.enabled; }).catch(() => {});

  $('form').addEventListener('submit', async e => {
    e.preventDefault();
    show('');
    $('go').disabled = true;
    try {
      const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('email').value, password: $('password').value }) });
      const d = await r.json().catch(() => ({}));
      if (r.status === 503 && d.setupRequired) { location.href = '/setup.html'; return; }
      if (!r.ok) { show(d.error || 'Sign-in failed.'); $('password').select(); return; }
      location.href = '/';
    } catch (err) { show("Couldn't reach the server."); }
    finally { $('go').disabled = false; }
  });
})();
