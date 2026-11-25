'use strict';
// Request validation: the browser is never trusted. Everything a client sends is cleaned here.


const TYPES = ['project', 'vendor', 'roadmap', 'quickwin'];
const STATUSES = ['offtrack', 'atrisk', 'ontrack', 'onhold', 'notstarted', 'done'];
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/* ---------- validation (the browser is not trusted) ---------- */

// Rejected input is the caller's fault (400). Anything else that goes wrong is a server problem (5xx).
const bad = msg => Object.assign(new Error(msg), { status: 400 });

const str = (v, max) => String(v == null ? '' : v).slice(0, max);

function cleanId(v, what) {
  if (!ID_RE.test(String(v))) throw bad(`Invalid ${what} id`);
  return String(v);
}
function cleanDate(v) {
  v = String(v || '');
  if (!v) return '';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + 'T00:00:00Z') : null;
  if (!d || isNaN(d) || d.toISOString().slice(0, 10) !== v) throw bad(`Invalid date "${v.slice(0, 20)}"`);
  return v;
}
function cleanIso(v) {
  const d = new Date(v);
  return isNaN(d) ? new Date().toISOString() : d.toISOString();
}

function cleanItem(raw) {
  if (!raw || typeof raw !== 'object') throw bad('Invalid entry');
  const effort = raw.effort === '' || raw.effort == null ? '' : Number(raw.effort);
  if (effort !== '' && (!isFinite(effort) || effort < 0 || effort > 1e6)) throw bad('Invalid effort');
  const notes = Array.isArray(raw.notes) ? raw.notes.slice(0, 5000) : [];
  return {
    id: cleanId(raw.id, 'entry'),
    type: TYPES.includes(raw.type) ? raw.type : 'project',
    parentId: raw.parentId ? cleanId(raw.parentId, 'parent') : null,
    name: str(raw.name, 300),
    team: str(raw.team, 200),
    status: STATUSES.includes(raw.status) ? raw.status : 'notstarted',
    start: cleanDate(raw.start),
    end: cleanDate(raw.end),
    effort: effort === '' ? '' : Math.round(effort * 100) / 100,
    focus: raw.focus === true,
    focusWhy: str(raw.focusWhy, 400),
    summary: str(raw.summary, 400),
    details: str(raw.details, 100000),
    notes: notes.map(n => ({
      id: cleanId(n && n.id, 'note'),
      at: cleanIso(n.at),
      label: str(n.label, 100),
      text: str(n.text, 20000),
    })),
    createdAt: cleanIso(raw.createdAt),
    updatedAt: cleanIso(raw.updatedAt),
  };
}

function cleanLabels(raw) {
  if (!Array.isArray(raw)) return null;
  return [...new Set(raw.map(l => str(l, 100).trim()).filter(Boolean))].slice(0, 200);
}

// General notes (the diary). Owner is set by the server from the signed-in user, never by the browser.
function cleanJournalNote(raw) {
  if (!raw || typeof raw !== 'object') throw bad('Invalid note');
  const date = cleanDate(raw.date);
  if (!date) throw bad('A note needs a date');
  const text = str(raw.text, 50000);
  if (!text.trim()) throw bad('A note needs some text');
  return { id: cleanId(raw.id, 'note'), date, label: str(raw.label, 100), meeting: str(raw.meeting, 200).trim(), text, createdAt: cleanIso(raw.createdAt), updatedAt: cleanIso(raw.updatedAt) };
}
function cleanJournalSync(raw) {
  if (!raw || typeof raw !== 'object') throw bad('Invalid request');
  return {
    upserts: Array.isArray(raw.upserts) ? raw.upserts.slice(0, 200).map(cleanJournalNote) : [],
    deletes: Array.isArray(raw.deletes) ? raw.deletes.slice(0, 200).map(x => cleanId(x, 'note')) : [],
  };
}

function cleanState(raw) {
  if (!raw || !Array.isArray(raw.items)) throw bad('Invalid data');
  if (raw.items.length > 5000) throw bad('Too many entries');
  return { items: raw.items.map(cleanItem), labels: cleanLabels(raw.labels) || [] };
}

function cleanSync(raw) {
  if (!raw || typeof raw !== 'object') throw bad('Invalid request');
  const upserts = Array.isArray(raw.upserts) ? raw.upserts.slice(0, 500).map(cleanItem) : [];
  const deletes = Array.isArray(raw.deletes) ? raw.deletes.slice(0, 500).map(d => cleanId(d, 'entry')) : [];
  return { upserts, deletes, labels: cleanLabels(raw.labels) };
}

module.exports = { bad, str, cleanId, cleanState, cleanSync, cleanJournalSync };
