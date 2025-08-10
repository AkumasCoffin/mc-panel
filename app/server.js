// app/server.js
// MC RCON Panel - minimal, stable server with working endpoints.
// Uses `rcon` (npm) instead of rcon-client to avoid version resolution issues.

'use strict';

/* -------------------- Optional .env -------------------- */
try {
  // Don't crash if dotenv isn't installed; just skip.
  require('dotenv').config();
} catch {}

/* -------------------- Imports -------------------- */
const path = require('path');
const fs = require('fs');
const express = require('express');
const basicAuth = require('express-basic-auth');
const Rcon = require('rcon');               // <-- stable, widely available
const Database = require('better-sqlite3'); // used; ok if db doesn't have all tables
const morgan = require('morgan');

/* -------------------- Env -------------------- */
const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'changeme';

const RCON_HOST = process.env.RCON_HOST || '127.0.0.1';
const RCON_PORT = Number(process.env.RCON_PORT || 25575);
const RCON_PASS = process.env.RCON_PASS || '';
const RCON_TIMEOUT_MS = Number(process.env.RCON_TIMEOUT_MS || 5000);

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'webgui.sqlite');
const SERVER_LOG = process.env.SERVER_LOG || ''; // optional: /opt/minecraft/server/logs/latest.log

/* -------------------- App -------------------- */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

/* -------------------- Auth -------------------- */
app.use(
  basicAuth({
    challenge: true,
    realm: 'panel',
    users: { [PANEL_USER]: PANEL_PASS },
  })
);

/* -------------------- DB (safe open) -------------------- */
let db;
try {
  db = new Database(DB_PATH);
  // Create minimal tables if missing (won’t hurt if they already exist)
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS players(
      id INTEGER PRIMARY KEY,
      username TEXT UNIQUE,
      uuid TEXT,
      first_seen TEXT,
      last_seen TEXT,
      total_playtime INTEGER DEFAULT 0,
      last_ip TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions(
      id INTEGER PRIMARY KEY,
      player_id INTEGER,
      login_time TEXT,
      logout_time TEXT,
      duration INTEGER,
      FOREIGN KEY(player_id) REFERENCES players(id)
    );
    CREATE TABLE IF NOT EXISTS commands(
      id INTEGER PRIMARY KEY,
      player_id INTEGER,
      executed_at TEXT DEFAULT CURRENT_TIMESTAMP,
      command TEXT,
      FOREIGN KEY(player_id) REFERENCES players(id)
    );
  `);
} catch (e) {
  console.warn('[db] open failed, continuing without DB:', e.message);
  db = null;
}

/* -------------------- RCON helper -------------------- */
function rconQuery(command, timeoutMs = RCON_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const client = new Rcon(RCON_HOST, RCON_PORT, RCON_PASS, { tcp: true, challenge: false });
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { client.disconnect(); } catch {}
      reject(new Error('RCON connect timeout'));
    }, timeoutMs);

    client.on('auth', () => {
      client.send(command);
    });

    client.on('response', (str) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      try { client.disconnect(); } catch {}
      resolve(String(str || ''));
    });

    client.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      try { client.disconnect(); } catch {}
      reject(err);
    });

    client.on('end', () => {
      // if end occurs before response, let timeout or error handle it
    });

    try {
      client.connect();
    } catch (err) {
      clearTimeout(t);
      reject(err);
    }
  });
}

/* -------------------- Parse helpers -------------------- */
function parseListOutput(out) {
  // Examples:
  // "There are 2 of a max of 50 players online: Alice, Bob"
  // "There are 0 of a max of 50 players online"
  const line = String(out || '').trim();
  const m = line.match(/There are\s+(\d+)\s+of\s+a\s+max\s+of\s+\d+\s+players\s+online(?::\s*(.*))?/i);
  if (!m) {
    // Modded/other: try another loose pattern
    const names = (line.split(':')[1] || '').trim();
    const arr = names ? names.split(',').map(s => s.trim()).filter(Boolean) : [];
    return { count: arr.length, players: arr.map(n => ({ username: n, uuid: null })) };
  }
  const count = Number(m[1] || 0);
  const tail = (m[2] || '').trim();
  const players = tail
    ? tail.split(',').map(s => s.trim()).filter(Boolean).map(n => ({ username: n, uuid: null }))
    : [];
  return { count, players };
}

function cleanBanLine(s) {
  // "64.135.139.241 was banned by Server: Banned by an operator."
  // "Name was banned by X: reason"
  const txt = String(s || '').trim();
  const mm = txt.match(/^(.+?)\s+was banned by\s+([^:]+):\s*(.*)$/i);
  if (mm) {
    return { target: mm[1].trim(), by: mm[2].trim(), reason: mm[3].trim(), banned_at: null };
  }
  // Fallback: just return as one field
  return { target: txt, by: 'Server', reason: '', banned_at: null };
}

/* -------------------- API -------------------- */

// Health/status (derived from list)
app.get('/api/status', async (req, res) => {
  try {
    const out = await rconQuery('list');
    const parsed = parseListOutput(out);
    res.json({
      online: true,
      player_count: parsed.count,
      next_restart_iso: null,
      next_restart_seconds: null,
    });
  } catch {
    res.json({ online: false, player_count: 0, next_restart_iso: null, next_restart_seconds: null });
  }
});

// Online now (names)
app.get('/api/online', async (req, res) => {
  try {
    const out = await rconQuery('list');
    const parsed = parseListOutput(out);
    res.json({ players: parsed.players, count: parsed.count });
  } catch (e) {
    res.status(200).json({ players: [], count: 0 });
  }
});

// Run arbitrary command
app.post('/api/command', async (req, res) => {
  const command = (req.body && String(req.body.command || '')).trim();
  if (!command) return res.status(400).json({ ok: false, error: 'Missing command' });
  try {
    const out = await rconQuery(command);
    // Optional: store into DB.commands
    if (db) {
      try {
        db.prepare('INSERT INTO commands(command) VALUES(?)').run(command);
      } catch {}
    }
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// Players table (DB or lightweight fallback)
app.get('/api/players', (req, res) => {
  if (db) {
    try {
      const rows = db.prepare(`
        SELECT id, username, uuid, first_seen, last_seen, total_playtime, last_ip
        FROM players
        ORDER BY COALESCE(last_seen, '1970-01-01') DESC
      `).all();
      return res.json(rows);
    } catch {}
  }
  // fallback: empty list so UI doesn’t crash
  res.json([]);
});

// One player detail
app.get('/api/player/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!db) return res.json({ player: null, ips: [], sessions: [], commands: [] });
  try {
    const player = db.prepare(`SELECT * FROM players WHERE id=?`).get(id) || null;
    const ips = db.prepare(`SELECT ip, seen_at FROM player_ips WHERE player_id=? ORDER BY seen_at DESC`).all(id) || [];
    const sessions = db.prepare(`SELECT login_time, logout_time, duration FROM sessions WHERE player_id=? ORDER BY login_time DESC`).all(id) || [];
    const commands = db.prepare(`SELECT executed_at, command FROM commands WHERE player_id=? ORDER BY executed_at DESC`).all(id) || [];
    res.json({ player, ips, sessions, commands });
  } catch (e) {
    res.json({ player: null, ips: [], sessions: [], commands: [] });
  }
});

// Bans (cleaned)
app.get('/api/bans', async (req, res) => {
  const result = { players: [], ips: [] };
  try {
    const outPlayers = await rconQuery('banlist players');
    const linesP = String(outPlayers || '').split('\n').map(s => s.trim()).filter(Boolean);
    // ignore header like "There are 4 ban(s):"
    const filteredP = linesP.filter(l => !/^There are\s+\d+\s+ban/i.test(l));
    result.players = filteredP.map(cleanBanLine);
  } catch {}
  try {
    const outIps = await rconQuery('banlist ips');
    const linesI = String(outIps || '').split('\n').map(s => s.trim()).filter(Boolean);
    const filteredI = linesI.filter(l => !/^There are\s+\d+\s+ban/i.test(l));
    result.ips = filteredI.map(cleanBanLine).map(o => ({ ...o, type: 'ip' }));
  } catch {}
  res.json(result);
});

/* -------------------- Static UI -------------------- */
const staticDir = path.join(__dirname, 'public'); // <--- serve from /app/public
app.use(express.static(staticDir, { fallthrough: true }));

app.get('/', (req, res) => {
  const idx = path.join(staticDir, 'index.html');
  if (fs.existsSync(idx)) return res.sendFile(idx);
  res
    .status(200)
    .type('text/plain')
    .send(`MC RCON Panel\nUI file not found. Place index.html in ${staticDir}.`);
});

/* -------------------- Start -------------------- */
app.listen(PORT, HOST, () => {
  console.log(`Panel on http://${HOST}:${PORT}`);
});
