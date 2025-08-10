/* MC RCON WebGUI – Persistent RCON (no spam) + full API
 * Drop-in for /opt/mc-rcon-webgui/app/server.js
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const basicAuth = require('basic-auth');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const { Rcon } = require('rcon-client');

/* ----------------------- Config ----------------------- */
require('dotenv').config({ path: path.join(__dirname, '.env') });

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);

// RCON
const RCON_HOST = process.env.RCON_HOST || '127.0.0.1';
const RCON_PORT = Number(process.env.RCON_PORT || 25575);
const RCON_PASS = process.env.RCON_PASS || 'change-me';

// HTTP Basic auth
const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'changeme';

// Polling
const POLL_LIST_MS = Number(process.env.POLL_LIST_MS || 10000); // 10s

// DB
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'webgui.sqlite');

/* ----------------------- App ----------------------- */
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Basic auth middleware
function auth(req, res, next) {
  const cred = basicAuth(req);
  if (!cred || cred.name !== PANEL_USER || cred.pass !== PANEL_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="Panel"');
    return res.status(401).send('Auth required');
  }
  req._authUser = cred.name;
  next();
}

// Static index (single-file frontend already baked into public/index.html)
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', extensions: ['html'] }));

/* ----------------------- DB Init ----------------------- */
const db = new sqlite3.Database(DB_FILE);
db.serialize(() => {
  db.run('PRAGMA foreign_keys = ON');

  db.run(`CREATE TABLE IF NOT EXISTS players(
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL,
    uuid TEXT,
    first_seen DATETIME,
    last_seen DATETIME,
    total_playtime INTEGER DEFAULT 0,
    last_ip TEXT
  )`);

  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS ux_players_username ON players(username)`);

  db.run(`CREATE TABLE IF NOT EXISTS player_ips(
    id INTEGER PRIMARY KEY,
    player_id INTEGER NOT NULL,
    ip TEXT NOT NULL,
    seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS ix_player_ips_player ON player_ips(player_id, ip)`);

  db.run(`CREATE TABLE IF NOT EXISTS sessions(
    id INTEGER PRIMARY KEY,
    player_id INTEGER NOT NULL,
    login_time DATETIME,
    logout_time DATETIME,
    duration INTEGER,
    FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS ix_sessions_open ON sessions(player_id, logout_time)`);

  db.run(`CREATE TABLE IF NOT EXISTS commands(
    id INTEGER PRIMARY KEY,
    player_id INTEGER,
    username TEXT,
    command TEXT NOT NULL,
    executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS schedules(
    id INTEGER PRIMARY KEY,
    cron TEXT NOT NULL,
    label TEXT,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS ban_presets(
    id INTEGER PRIMARY KEY,
    label TEXT NOT NULL,
    reason TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS broadcast_presets(
    id INTEGER PRIMARY KEY,
    label TEXT NOT NULL,
    message TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS metrics_online(
    id INTEGER PRIMARY KEY,
    at DATETIME DEFAULT CURRENT_TIMESTAMP,
    online_count INTEGER NOT NULL,
    rcon_latency_ms INTEGER
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS ix_metrics_online_at ON metrics_online(at)`);

  db.run(`CREATE TABLE IF NOT EXISTS audit(
    id INTEGER PRIMARY KEY,
    at DATETIME DEFAULT CURRENT_TIMESTAMP,
    action TEXT NOT NULL,
    username TEXT,
    ip TEXT,
    details TEXT
  )`);
});

/* ----------------------- RCON (persistent) ----------------------- */
let rconClient = null;
let rconReady = false;
let rconConnecting = false;
const rconQueue = [];
let backoffMs = 1000; // 1s -> 30s

async function rconConnect() {
  if (rconReady || rconConnecting) return;
  rconConnecting = true;
  try {
    const c = new Rcon({ host: RCON_HOST, port: RCON_PORT, password: RCON_PASS });
    await c.connect();
    rconClient = c;
    rconReady = true;
    rconConnecting = false;
    backoffMs = 1000;

    c.on('end', () => handleRconEnd('end'));
    c.on('error', () => handleRconEnd('error'));

    flushQueue();
  } catch (e) {
    rconReady = false;
    rconConnecting = false;
    setTimeout(rconConnect, Math.min(backoffMs, 30000));
    backoffMs = Math.min(backoffMs * 2, 30000);
  }
}

function handleRconEnd() {
  rconReady = false;
  rconClient = null;
  if (!rconConnecting) {
    setTimeout(rconConnect, Math.min(backoffMs, 30000));
    backoffMs = Math.min(backoffMs * 2, 30000);
  }
}

function flushQueue() {
  if (!rconReady || !rconClient) return;
  const runNext = async () => {
    const item = rconQueue.shift();
    if (!item) return;
    try {
      const out = await rconClient.send(item.cmd);
      item.resolve(out);
    } catch (e) {
      item.reject(e);
    } finally {
      setImmediate(runNext);
    }
  };
  setImmediate(runNext);
}

async function sendRconCommand(cmd) {
  if (!rconReady) rconConnect();
  return new Promise((resolve, reject) => {
    rconQueue.push({ cmd: String(cmd), resolve, reject });
    flushQueue();
  });
}

rconConnect();

/* ----------------------- Helpers ----------------------- */
function parseListOutput(out) {
  // Vanilla format: "There are X of a max of Y players online: name, name"
  const m = out.match(/There are\s+(\d+)\s+of\s+a\s+max\s+of\s+\d+\s+players online:?\s*(.*)/i);
  const count = m ? parseInt(m[1], 10) : 0;
  const names = (m && m[2]) ? m[2].split(',').map(s => s.trim()).filter(Boolean) : [];
  return { count, names };
}

function parseBanList(out) {
  // Example: "There are N ban(s):\nIP was banned by <who>: <reason>\n..."
  const lines = (out || '').split('\n').map(s => s.trim()).filter(Boolean);
  const items = [];
  for (const line of lines) {
    const lm = line.match(/^(.+?) was banned by (.+?)(?::\s*(.*))?$/i);
    if (lm) {
      items.push({
        target: lm[1],
        by: lm[2],
        reason: lm[3] || ''
      });
    }
  }
  return items;
}

function audit(req, action, detailsObj = {}) {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
    db.run(
      'INSERT INTO audit(action,username,ip,details) VALUES(?,?,?,?)',
      [action, req._authUser || null, ip, JSON.stringify(detailsObj)],
    );
  } catch {}
}

function nextFromSchedules() {
  // Walk enabled schedules, compute nearest upcoming run using node-cron
  const now = new Date();
  let best = null;
  return new Promise((resolve) => {
    db.all('SELECT id,cron,enabled FROM schedules WHERE enabled=1', [], (err, rows) => {
      if (err || !rows || !rows.length) return resolve(null);
      for (const r of rows) {
        try {
          const task = cron.schedule(r.cron, () => {}, { scheduled: false });
          const next = task.nextDates().toDate();
          if (!best || next < best) best = next;
        } catch {}
      }
      resolve(best);
    });
  });
}

function relSeconds(a, b) {
  return Math.max(0, Math.floor((a.getTime() - b.getTime()) / 1000));
}

/* ----------------------- Player/session tracking ----------------------- */
async function updatePlayersAndMetrics() {
  const t0 = Date.now();
  let out;
  try {
    out = await sendRconCommand('list');
  } catch {
    // Not fatal; record offline metric
  }
  const latency = Date.now() - t0;

  let parsed = { count: 0, names: [] };
  if (out) parsed = parseListOutput(out);

  // metrics_online
  db.run('INSERT INTO metrics_online(online_count, rcon_latency_ms) VALUES(?,?)', [parsed.count, latency]);

  // sessions & players
  const nowIso = new Date().toISOString().slice(0, 19).replace('T', ' ');
  // Load current open sessions
  db.all('SELECT p.username, s.id, s.player_id FROM sessions s JOIN players p ON p.id=s.player_id WHERE s.logout_time IS NULL', [], (e, openRows) => {
    const openMap = new Map();
    if (openRows) for (const r of openRows) openMap.set(r.username, r);

    const current = new Set(parsed.names);

    // Start sessions for newly seen
    for (const username of current) {
      if (!openMap.has(username)) {
        db.get('SELECT id FROM players WHERE username=?', [username], (e3, pr) => {
          function start(playerId) {
            db.run('INSERT INTO sessions(player_id, login_time) VALUES(?,?)', [playerId, nowIso]);
            db.run('UPDATE players SET last_seen=?, first_seen=COALESCE(first_seen, ?), username=? WHERE id=?',
              [nowIso, nowIso, username, playerId]);
          }
          if (pr?.id) start(pr.id);
          else {
            db.run('INSERT INTO players(username, first_seen, last_seen) VALUES(?,?,?)', [username, nowIso, nowIso], function () {
              start(this.lastID);
            });
          }
        });
      } else {
        const r = openMap.get(username);
        db.run('UPDATE players SET last_seen=? WHERE id=?', [nowIso, r.player_id]);
      }
    }

    // Close sessions for players who left
    for (const [username, row] of openMap) {
      if (!current.has(username)) {
        const endIso = nowIso;
        db.get('SELECT login_time FROM sessions WHERE id=?', [row.id], (e4, srow) => {
          const loginTs = srow?.login_time ? new Date(srow.login_time) : new Date();
          const dur = Math.max(0, Math.floor((new Date(endIso) - loginTs) / 1000));
          db.run('UPDATE sessions SET logout_time=?, duration=? WHERE id=?', [endIso, dur, row.id]);
          db.run('UPDATE players SET total_playtime = COALESCE(total_playtime,0) + ? WHERE id=?', [dur, row.player_id]);
        });
      }
    }
  });
}

// Background poll
setInterval(updatePlayersAndMetrics, POLL_LIST_MS);

/* ----------------------- Schedules engine ----------------------- */
const scheduleTasks = new Map();

function clearSchedules() {
  for (const [id, task] of scheduleTasks) try { task.stop(); } catch {}
  scheduleTasks.clear();
}

function scheduleCountdownAndStop(label) {
  // 10m / 5m / 1m / 30s / 5s  → stop
  const steps = [
    { t: 10 * 60, msg: 'Server restarting in 10 minutes.' },
    { t: 5 * 60, msg: 'Server restarting in 5 minutes.' },
    { t: 60, msg: 'Server restarting in 1 minute.' },
    { t: 30, msg: 'Server restarting in 30 seconds.' },
    { t: 5, msg: 'Server restarting in 5 seconds.' }
  ];
  const total = steps[0].t; // 10 minutes

  (async () => {
    try {
      await sendRconCommand(`broadcast ${label ? '[' + label + '] ' : ''}Scheduled restart in 10 minutes.`);
    } catch {}
  })();

  for (const s of steps.slice(1)) {
    setTimeout(() => {
      sendRconCommand(`broadcast ${label ? '[' + label + '] ' : ''}${s.msg}`).catch(() => {});
    }, (total - s.t) * 1000);
  }

  setTimeout(async () => {
    try {
      await sendRconCommand('broadcast Restarting now!');
      await sendRconCommand('stop');
      logRestart('scheduled', label || '');
    } catch {}
  }, total * 1000);
}

function loadSchedules() {
  clearSchedules();
  db.all('SELECT * FROM schedules WHERE enabled=1', [], (err, rows) => {
    if (err || !rows) return;
    for (const r of rows) {
      try {
        const t = cron.schedule(r.cron, () => scheduleCountdownAndStop(r.label || ''), { scheduled: true });
        scheduleTasks.set(r.id, t);
      } catch (e) {
        console.error('Invalid cron', r.id, r.cron);
      }
    }
  });
}

function logRestart(kind, note) {
  db.run('INSERT INTO audit(action, username, ip, details) VALUES(?,?,?,?)',
    ['restart.' + kind, 'system', '', JSON.stringify({ note, at: new Date().toISOString() })]);
}

// boot
loadSchedules();

/* ----------------------- API ----------------------- */

// Status
app.get('/api/status', async (req, res) => {
  let online = false, pcount = 0;
  try {
    const out = await sendRconCommand('list');
    const parsed = parseListOutput(out);
    online = true; pcount = parsed.count;
  } catch {}

  const next = await nextFromSchedules();
  res.json({
    online,
    player_count: pcount,
    next_restart_iso: next ? next.toISOString() : null,
    next_restart_seconds: next ? relSeconds(next, new Date()) : null
  });
});

// Online snapshot (last poll + names)
app.get('/api/online', auth, async (req, res) => {
  try {
    const out = await sendRconCommand('list');
    const parsed = parseListOutput(out);
    const players = parsed.names.map(n => ({ username: n }));
    res.json({ players, count: parsed.count });
  } catch (e) {
    res.json({ players: [], count: 0 });
  }
});

// Players list
app.get('/api/players', auth, (req, res) => {
  db.all('SELECT * FROM players ORDER BY last_seen DESC NULLS LAST, username ASC', [], (e, rows) => {
    res.json(rows || []);
  });
});

// Player details
app.get('/api/player/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  db.get('SELECT * FROM players WHERE id=?', [id], (e, player) => {
    if (!player) return res.status(404).json({ error: 'not found' });
    db.all('SELECT ip, seen_at FROM player_ips WHERE player_id=? ORDER BY seen_at DESC', [id], (e2, ips) => {
      db.all('SELECT login_time, logout_time, duration FROM sessions WHERE player_id=? ORDER BY login_time DESC LIMIT 200', [id], (e3, sessions) => {
        db.all('SELECT command, executed_at FROM commands WHERE player_id=? OR username=? ORDER BY executed_at DESC LIMIT 200', [id, player.username], (e4, commands) => {
          res.json({ player, ips: ips || [], sessions: sessions || [], commands: commands || [] });
        });
      });
    });
  });
});

// Run arbitrary command
app.post('/api/command', auth, async (req, res) => {
  const cmd = String(req.body.command || '').trim();
  if (!cmd) return res.status(400).json({ error: 'command required' });
  try {
    const out = await sendRconCommand(cmd);
    db.run('INSERT INTO commands(username, command) VALUES(?,?)', [req._authUser || null, cmd]);
    audit(req, 'command', { cmd, out });
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Broadcast (quick)
app.post('/api/broadcast', auth, async (req, res) => {
  const message = String(req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    const out = await sendRconCommand(`broadcast ${message}`);
    audit(req, 'broadcast', { message, out });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Kick
app.post('/api/kick', auth, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const reason = String(req.body.reason || '').trim();
  if (!username) return res.status(400).json({ error: 'username required' });
  try {
    const out = await sendRconCommand(`kick ${username} ${reason ? `"${reason}"` : ''}`.trim());
    audit(req, 'kick', { username, reason, out });
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Bans (cleaned)
app.get('/api/bans', auth, async (req, res) => {
  try {
    const playersRaw = await sendRconCommand('banlist players');
    const ipsRaw = await sendRconCommand('banlist ips');
    res.json({
      players: parseBanList(playersRaw),
      ips: parseBanList(ipsRaw)
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Ban IP
app.post('/api/ban-ip', auth, async (req, res) => {
  const ip = String(req.body.ip || '').trim();
  const reason = String(req.body.reason || '').trim();
  if (!ip) return res.status(400).json({ error: 'ip required' });
  try {
    const out = await sendRconCommand(`ban-ip ${ip} ${reason ? `"${reason}"` : ''}`.trim());
    audit(req, 'ban-ip', { ip, reason, out });
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Ban presets
app.get('/api/ban-presets', auth, (req, res) => {
  db.all('SELECT id,label,reason FROM ban_presets ORDER BY id DESC', [], (e, rows) => res.json(rows || []));
});
app.post('/api/ban-presets', auth, (req, res) => {
  const label = String(req.body.label || '').trim();
  const reason = String(req.body.reason || '').trim();
  if (!label || !reason) return res.status(400).json({ error: 'label & reason required' });
  db.run('INSERT INTO ban_presets(label,reason) VALUES(?,?)', [label, reason], function () {
    audit(req, 'ban-preset.add', { id: this.lastID, label });
    res.json({ ok: true, id: this.lastID });
  });
});

// Broadcast presets
app.get('/api/broadcast-presets', auth, (req, res) => {
  db.all('SELECT id,label,message FROM broadcast_presets ORDER BY id DESC', [], (e, rows) => res.json(rows || []));
});
app.post('/api/broadcast-presets', auth, (req, res) => {
  const label = String(req.body.label || '').trim();
  const message = String(req.body.message || '').trim();
  if (!label || !message) return res.status(400).json({ error: 'label & message required' });
  db.run('INSERT INTO broadcast_presets(label,message) VALUES(?,?)', [label, message], function () {
    audit(req, 'broadcast-preset.add', { id: this.lastID, label });
    res.json({ ok: true, id: this.lastID });
  });
});

// Schedules CRUD
app.get('/api/schedules', auth, (req, res) => {
  db.all('SELECT * FROM schedules ORDER BY id DESC', [], (e, rows) => res.json(rows || []));
});
app.post('/api/schedules', auth, (req, res) => {
  const cronStr = String(req.body.cron || '').trim();
  const label = String(req.body.label || '').trim() || null;
  try { cron.validate(cronStr) || (() => { throw new Error('Invalid cron'); })(); } catch (e) {
    return res.status(400).json({ error: 'invalid cron' });
  }
  db.run('INSERT INTO schedules(cron,label,enabled) VALUES(?,?,1)', [cronStr, label], function () {
    audit(req, 'schedule.add', { id: this.lastID, cron: cronStr, label });
    loadSchedules();
    res.json({ ok: true, id: this.lastID });
  });
});
app.post('/api/schedules/:id/toggle', auth, (req, res) => {
  const id = Number(req.params.id);
  db.run('UPDATE schedules SET enabled = CASE enabled WHEN 1 THEN 0 ELSE 1 END WHERE id=?', [id], function () {
    audit(req, 'schedule.toggle', { id });
    loadSchedules();
    res.json({ ok: true });
  });
});
app.delete('/api/schedules/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  db.run('DELETE FROM schedules WHERE id=?', [id], function () {
    audit(req, 'schedule.delete', { id });
    loadSchedules();
    res.json({ ok: true });
  });
});

// Emergency restart now
app.post('/api/restart-now', auth, async (req, res) => {
  try {
    await sendRconCommand('broadcast ⚠ Emergency restart now!');
    logRestart('emergency', 'button');
    await sendRconCommand('stop');
    audit(req, 'restart.emergency', {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Metrics API (simple)
app.get('/api/metrics/online', auth, (req, res) => {
  const range = String(req.query.range || '1h');
  let since = new Date(Date.now() - 3600 * 1000);
  if (range.endsWith('m')) since = new Date(Date.now() - Number(range.slice(0, -1)) * 60 * 1000);
  else if (range.endsWith('h')) since = new Date(Date.now() - Number(range.slice(0, -1)) * 3600 * 1000);
  else if (range.endsWith('d')) since = new Date(Date.now() - Number(range.slice(0, -1)) * 24 * 3600 * 1000);
  const iso = since.toISOString().slice(0, 19).replace('T', ' ');
  db.all('SELECT at, online_count, rcon_latency_ms FROM metrics_online WHERE at >= ? ORDER BY at ASC', [iso], (e, rows) => {
    res.json(rows || []);
  });
});

// Audit log
app.get('/api/audit', auth, (req, res) => {
  db.all('SELECT * FROM audit ORDER BY id DESC LIMIT 500', [], (e, rows) => res.json(rows || []));
});

// oEmbed & SVG status badge
app.get('/status/oembed.json', async (req, res) => {
  let online = false, pcount = 0;
  try { const out = await sendRconCommand('list'); const p = parseListOutput(out); online = true; pcount = p.count; } catch {}
  res.json({
    type: 'rich',
    version: '1.0',
    provider_name: 'MC Panel',
    provider_url: 'http://localhost',
    title: 'Server Status',
    html: `<div style="font:14px system-ui;padding:8px;border:1px solid #ddd;border-radius:8px;width:280px">
      <b>${online ? 'Online' : 'Offline'}</b> • Players: ${pcount}
    </div>`,
    width: 300,
    height: 60
  });
});

app.get('/status.svg', async (req, res) => {
  let online = false, pcount = 0;
  try { const out = await sendRconCommand('list'); const p = parseListOutput(out); online = true; pcount = p.count; } catch {}
  const label = online ? `ONLINE • ${pcount}` : 'OFFLINE';
  const fill = online ? '#2ecc71' : '#ff4d57';
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="170" height="28" role="img" aria-label="MC:${label}">
  <rect width="170" height="28" fill="#0f1524" rx="6"/>
  <rect x="60" width="110" height="28" fill="${fill}" rx="6"/>
  <text x="12" y="19" fill="#fff" font-family="system-ui,Segoe UI,Roboto" font-size="12">MC</text>
  <text x="70" y="19" fill="#fff" font-family="system-ui,Segoe UI,Roboto" font-size="12">${label}</text>
</svg>`;
  res.setHeader('Content-Type', 'image/svg+xml'); res.send(svg);
});

/* ----------------------- Catch-all UI ----------------------- */
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

/* ----------------------- Start ----------------------- */
app.listen(PORT, HOST, () => {
  console.log(`Panel on http://${HOST}:${PORT}`);
});
