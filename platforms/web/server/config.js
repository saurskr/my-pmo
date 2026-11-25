'use strict';
// The one setting that cannot live in the database: how to reach the database.
// Kept in data/config.json (owner-only file). Everything else lives in SQL Server.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.PMO_DATA_DIR || path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

function read() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { return {}; }
}

function write(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
}

function clear() { try { fs.unlinkSync(CONFIG_FILE); } catch (e) { /* already gone */ } }

module.exports = { DATA_DIR, CONFIG_FILE, read, write, clear };
