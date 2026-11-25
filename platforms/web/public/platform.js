// Web platform for the shared app: storage and sign-in are provided by the Node server in this folder.
// Core pages read everything platform-specific from window.pmoPlatform:
//   api(method, path, body)  talk to the data store; resolves with JSON, rejects with an Error (.status = HTTP status)
//   ready                    resolves with the signed-in person {email, role}; if nobody is signed in the browser is sent to sign in
//   nav                      extra sidebar links [{href, label, adminOnly}]
//   signOut()                end the session (omit it if the platform has no sign-out)
(() => {
  const goTo = url => { location.href = url; };

  async function api(method, path, body) {
    const r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) { goTo('/login.html'); throw Object.assign(new Error('Signed out'), { status: 401 }); }
    if (r.status === 503 && data.setupRequired) { goTo('/setup.html'); throw Object.assign(new Error(data.error), { status: 503 }); }
    if (!r.ok) throw Object.assign(new Error(data.error || `Request failed (${r.status})`), { status: r.status });
    return data;
  }

  const ready = api('GET', '/api/me');
  ready.catch(() => {}); // a failure is shown by whoever awaits it; this only avoids an "unhandled" warning

  window.pmoPlatform = {
    name: 'web',
    api,
    ready,
    nav: [{ href: 'admin.html', label: 'Administration', adminOnly: true }],
    async signOut() { await fetch('/api/logout', { method: 'POST' }); goTo('/login.html'); },
  };
})();
