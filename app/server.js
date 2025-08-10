// server.js — Minecraft RCON Panel (clean bans + schedules + players + cmds)
//
// Requires: express, basic-auth, rcon-client, sqlite3, cron-parser
// Optional: node-cron (for actual timed restarts if you enabled it earlier)
//
// ENV (.env in app/):
// HOST=0.0.0.0
// PORT=8080
// PANEL_USER=admin
// PANEL_PASS=changeme
// RCON_HOST=127.0.0.1
// RCON_PORT=25575
// RCON_PASSWORD=12KaliRoot12
// MC_ROOT=/root/mc-server-backup
// LOG_PATH=/root/mc-server-backup/logs/latest.log
//
const path = require('path');
const fs = require('fs');
const express = require('express');
const basicAuth = require('basic-auth');
const { Rcon } = require('rcon-client');
const sqlite3 = require('sqlite3').verbose();
const cronParser = require('cron-parser');
require('dotenv').config({ path: path.join(__dirname, '.env') });

/* =========================
 * Config / Constants
 * ========================= */
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);

const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'changeme';

const RCON_HOST = process.env.RCON_HOST || '127.0.0.1';
const RCON_PORT = Number(process.env.RCON_PORT || 25575);
const RCON_PASSWORD = process.env.RCON_PASSWORD || '';

const DB_FILE = path.join(__dirname, 'webgui.sqlite');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* =========================
 * Auth (HTTP Basic)
 * ========================= */
function requireAuth(req, res, next) {
  const creds = basicAuth(req);
  if (!creds || creds.name !== PANEL_USER || creds.pass !== PANEL_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="MC Panel"');
    return res.status(401).send('Authentication required.');
  }
  next();
}

/* =========================
 * DB Init
 * ========================= */
const db = new sqlite3.Database(DB_FILE);
db.serialize(() => {
  db.run(`PRAGMA journal_mode=WAL`);
  db.run(`CREATE TABLE IF NOT EXISTS players(
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE,
    uuid TEXT,
    first_seen DATETIME,
    last_seen DATETIME,
    last_ip TEXT,
    total_playtime INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS player_ips(
    id INTEGER PRIMARY KEY,
    player_id INTEGER NOT NULL,
    ip TEXT NOT NULL,
    seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(player_id, ip, date(seen_at)),
    FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sessions(
    id INTEGER PRIMARY KEY,
    player_id INTEGER NOT NULL,
    login_time DATETIME NOT NULL,
    logout_time DATETIME,
    duration INTEGER, -- seconds
    FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS commands(
    id INTEGER PRIMARY KEY,
    player_id INTEGER,
    username TEXT,
    command TEXT,
    executed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE SET NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS schedules(
    id INTEGER PRIMARY KEY,
    cron TEXT NOT NULL,
    label TEXT,
    enabled INTEGER DEFAULT 1
  )`);
  // helpful indexes
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS ux_players_username ON players(username)`);
  db.run(`CREATE INDEX IF NOT EXISTS ix_player_ips_player ON player_ips(player_id, ip)`);
  db.run(`CREATE INDEX IF NOT EXISTS ix_sessions_open ON sessions(player_id, logout_time)`);
});

/* =========================
 * RCON helpers
 * ========================= */
async function withRcon(fn) {
  const r = await Rcon.connect({
    host: RCON_HOST,
    port: RCON_PORT,
    password: RCON_PASSWORD
  });
  try { return await fn(r); }
  finally { r.end(); }
}

async function sendRconCommand(command) {
  return withRcon(r => r.send(command));
}

async function listOnline() {
  try {
    const res = await sendRconCommand('list uuids');
    // Example: "There are 2 of a max of 20 players online: Name1 (uuid), Name2 (uuid)"
    const colon = res.indexOf(':');
    const part = colon >= 0 ? res.slice(colon + 1).trim() : '';
    if (!part) return [];
    return part.split(',').map(s => {
      const t = s.trim();
      const m = /(.*) \((.*)\)/.exec(t);
      return { username: m ? m[1] : t, uuid: m ? m[2] : null };
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/* =========================
 * Status: compute next restart
 * ========================= */
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
}
async function computeNextRun() {
  const rows = await all(`SELECT cron FROM schedules WHERE enabled=1`);
  if (!rows.length) return { iso: null, seconds: null };
  let soonest = null;
  const now = new Date();
  for (const r of rows) {
    try {
      const it = cronParser.parseExpression(r.cron, { currentDate: now });
      const next = it.next().toDate();
      if (!soonest || next < soonest) soonest = next;
    } catch (e) {
      // invalid cron; skip
    }
  }
  return soonest
    ? { iso: soonest.toISOString(), seconds: Math.max(0, Math.floor((soonest - now) / 1000)) }
    : { iso: null, seconds: null };
}

/* =========================
 * Clean Bans Parsing
 * ========================= */
function parseBanLines(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .split('\n')
    .map(s => s.trim())
    .filter(s => s && !/^There are \d+ ban\(s\):/i.test(s))
    .map(line => {
      // "<target> was banned by <by>: <reason>"
      const m = /^(.+?) was banned by (.+?)(?::\s*(.*))?$/.exec(line);
      if (!m) return { raw: line };
      const [, target, by, reason] = m;
      return { target, by, reason: reason || '' };
    });
}

/* =========================
 * API Routes
 * ========================= */

// public status (no auth)
app.get('/api/status', async (_req, res) => {
  try {
    const players = await listOnline();
    const next = await computeNextRun();
    res.json({
      online: true,
      player_count: players.length,
      next_restart_iso: next.iso,
      next_restart_seconds: next.seconds
    });
  } catch {
    res.json({ online: false, player_count: 0, next_restart_iso: null, next_restart_seconds: null });
  }
});

// everything else behind Basic auth
app.use(requireAuth);

// online list
app.get('/api/online', async (req, res) => {
  const players = await listOnline();
  res.json({ players, count: players.length });
});

// run arbitrary command
app.post('/api/command', async (req, res) => {
  const { command } = req.body || {};
  if (!command) return res.status(400).json({ error: 'command required' });
  try {
    const out = await sendRconCommand(command);
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// IP ban
app.post('/api/ban-ip', async (req, res) => {
  const { ip, reason } = req.body || {};
  if (!ip) return res.status(400).json({ error: 'ip required' });
  try {
    const out = await sendRconCommand(`ban-ip ${ip}${reason ? ' "' + reason.replace(/"/g, '\\"') + '"' : ''}`);
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// CLEAN BANS (players + ips)
app.get('/api/bans', async (_req, res) => {
  try {
    const playersRaw = await sendRconCommand('banlist');     // players
    const ipsRaw     = await sendRconCommand('banlist ips'); // ips
    res.json({
      players: parseBanLines(playersRaw),
      ips: parseBanLines(ipsRaw)
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// schedules
app.get('/api/schedules', (_req, res) => {
  db.all('SELECT * FROM schedules ORDER BY id', (err, rows) => {
    if (err) return res.status(500).json({ error: String(err) });
    res.json(rows);
  });
});
app.post('/api/schedules', (req, res) => {
  const { cron, label, enabled = 1 } = req.body || {};
  if (!cron) return res.status(400).json({ error: 'cron required' });
  db.run('INSERT INTO schedules(cron,label,enabled) VALUES(?,?,?)',
    [cron, label || null, enabled ? 1 : 0],
    function (err) {
      if (err) return res.status(500).json({ error: String(err) });
      res.json({ ok: true, id: this.lastID });
    });
});
app.post('/api/schedules/:id/toggle', (req, res) => {
  db.run('UPDATE schedules SET enabled = CASE enabled WHEN 1 THEN 0 ELSE 1 END WHERE id=?',
    [req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: String(err) });
      res.json({ ok: true });
    });
});
app.delete('/api/schedules/:id', (req, res) => {
  db.run('DELETE FROM schedules WHERE id=?', [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: String(err) });
    res.json({ ok: true });
  });
});

// emergency restart now (broadcast + stop)
app.post('/api/restart-now', async (_req, res) => {
  try {
    await sendRconCommand('broadcast ⚠ Emergency restart now!');
    await sendRconCommand('stop');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/* =========================
 * Players: lightweight endpoints (on-demand)
 * ========================= */

// list players (basic columns)
app.get('/api/players', (_req, res) => {
  db.all(`SELECT id, username, uuid, last_ip, first_seen, last_seen, total_playtime FROM players ORDER BY last_seen DESC NULLS LAST, username`, (err, rows) => {
    if (err) return res.status(500).json({ error: String(err) });
    res.json(rows || []);
  });
});

// details for a player
app.get('/api/player/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad id' });
  db.get(`SELECT id, username, uuid, last_ip, first_seen, last_seen, total_playtime FROM players WHERE id=?`, [id], (err, player) => {
    if (err) return res.status(500).json({ error: String(err) });
    if (!player) return res.status(404).json({ error: 'not found' });
    db.all(`SELECT ip, seen_at FROM player_ips WHERE player_id=? ORDER BY seen_at DESC`, [id], (e2, ips) => {
      if (e2) return res.status(500).json({ error: String(e2) });
      db.all(`SELECT login_time, logout_time, duration FROM sessions WHERE player_id=? ORDER BY login_time DESC LIMIT 200`, [id], (e3, sessions) => {
        if (e3) return res.status(500).json({ error: String(e3) });
        db.all(`SELECT command, executed_at FROM commands WHERE player_id=? ORDER BY executed_at DESC LIMIT 200`, [id], (e4, commands) => {
          if (e4) return res.status(500).json({ error: String(e4) });
          res.json({ player, ips, sessions, commands });
        });
      });
    });
  });
});

/* =========================
 * Frontend (single file)
 * ========================= */
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* =========================
 * Start
 * ========================= */
app.listen(PORT, HOST, () => {
  console.log(`Panel on http://${HOST}:${PORT}`);
});
