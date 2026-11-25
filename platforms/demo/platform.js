// Demo platform: no server, no database, no sign-in. The sample data comes from sample-data.json;
// anything a visitor changes is kept only in their own browser tab (sessionStorage) and can be reset.
// Implements the same window.pmoPlatform contract as the web platform (see docs/architecture.md).
(() => {
  const STORE_KEY = 'my-pmo-demo';
  const DAY = 86400000;
  const REPO = 'https://github.com/saurskr/my-pmo';

  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const REL = /^([+-]?\d+)d$/;

  // "2026-05-01" stays as it is; "+10d", "-40d" and "0d" are counted from today.
  const day = v => { const m = REL.exec(String(v || '')); return m ? ymd(new Date(Date.now() + Number(m[1]) * DAY)) : (v || ''); };
  const moment = v => { const m = REL.exec(String(v || '')); return m ? new Date(Date.now() + Number(m[1]) * DAY).toISOString() : new Date(v).toISOString(); };

  function fromSample(s) {
    const now = new Date().toISOString();
    const items = (s.items || []).map(i => {
      const notes = (i.notes || []).map(n => ({ id: n.id, at: moment(n.at), label: n.label || '', text: n.text || '' }));
      const latest = notes.length ? notes.map(n => n.at).sort().pop() : now;
      return {
        id: i.id, type: i.type || 'project', parentId: i.parentId || null, name: i.name || '', team: i.team || '', status: i.status || 'notstarted',
        start: day(i.start), end: day(i.end), effort: i.effort == null ? '' : i.effort,
        focus: i.focus === true, focusWhy: i.focusWhy || '', summary: i.summary || '', details: i.details || '', notes,
        createdAt: latest, updatedAt: latest,
      };
    });
    const journal = (s.journal || []).map(n => {
      const at = new Date(Date.now() + (Number(REL.exec(String(n.date))?.[1] || 0)) * DAY).toISOString();
      return { id: n.id, date: day(n.date), label: n.label || '', meeting: n.meeting || '', text: n.text, createdAt: at, updatedAt: at };
    });
    return { items, labels: s.labels || [], journal };
  }

  // Working copy: the visitor's changes if any, otherwise the sample file.
  let doc = null;
  async function load() {
    if (doc) return doc;
    try { const saved = sessionStorage.getItem(STORE_KEY); if (saved) { doc = JSON.parse(saved); return doc; } } catch (e) { /* storage unavailable; use the sample */ }
    const r = await fetch('sample-data.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error("Couldn't load sample-data.json");
    doc = fromSample(await r.json());
    return doc;
  }
  const persist = () => { try { sessionStorage.setItem(STORE_KEY, JSON.stringify(doc)); } catch (e) { /* kept in memory only */ } };

  const apply = (list, upserts, deletes) => {
    const byId = new Map(list.map(x => [x.id, x]));
    (upserts || []).forEach(x => byId.set(x.id, x));
    (deletes || []).forEach(id => byId.delete(id));
    return [...byId.values()];
  };

  async function api(method, path, body) {
    const d = await load();
    const clone = v => JSON.parse(JSON.stringify(v));
    switch (`${method} ${path}`) {
      case 'GET /api/data': return { initialized: true, items: clone(d.items), labels: clone(d.labels), storage: 'Demo sample data (kept in this browser tab only)' };
      case 'PUT /api/data': d.items = clone(body.items || []); d.labels = clone(body.labels || []); persist(); return { ok: true };
      case 'POST /api/data/sync':
        d.items = apply(d.items, clone(body.upserts), body.deletes);
        if (body.labels) d.labels = clone(body.labels);
        persist(); return { ok: true };
      case 'GET /api/journal': return { notes: clone(d.journal) };
      case 'POST /api/journal/sync': d.journal = apply(d.journal, clone(body.upserts), body.deletes); persist(); return { ok: true };
      default: throw Object.assign(new Error(`Unknown request ${method} ${path}`), { status: 404 });
    }
  }

  window.pmoPlatform = {
    name: 'demo',
    api,
    ready: Promise.resolve({ email: 'Demo visitor', role: 'user' }), // no sign-in in the demo
    nav: [],
  };

  /* ---------- a small notice, with a way back to the original sample data ---------- */

  function notice() {
    const css = document.createElement('style');
    css.textContent = '.demo-note{position:fixed;right:16px;bottom:16px;z-index:200;display:flex;gap:10px;align-items:center;flex-wrap:wrap;max-width:min(520px,calc(100vw - 32px));' +
      'padding:8px 12px;background:var(--surface);color:var(--text);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);font:13px/1.4 var(--font)}' +
      '.demo-note b{color:var(--accent)}.demo-note a{color:var(--accent)}.demo-note button{padding:3px 10px;font-size:12px}';
    document.head.append(css);
    const box = document.createElement('div');
    box.className = 'demo-note'; box.setAttribute('role', 'note');
    const text = document.createElement('span');
    const b = document.createElement('b'); b.textContent = 'Demo';
    text.append(b, ' — sample data. Your changes stay in this tab only. ');
    const link = document.createElement('a'); link.href = REPO; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'Get the code';
    text.append(link);
    const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = 'Reset demo';
    reset.addEventListener('click', () => { try { sessionStorage.removeItem(STORE_KEY); } catch (e) { /* nothing to clear */ } location.reload(); });
    box.append(text, reset);
    document.body.append(box);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', notice); else notice();
})();
