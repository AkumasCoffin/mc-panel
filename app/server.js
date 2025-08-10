// MC RCON WebGUI — full backend
// Features: basic auth, players list, bans (clean JSON), broadcasts, command runner,
// schedules with countdowns (10m/5m/1m/30s/5s), emergency restart, audit log,
// metrics sampler (players+latency), SVG badge + oEmbed.

const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const basicAuth = require('basic-auth');
const sqlite3 = require('sqlite3').verbose();
const { Rcon } = require('rcon-client');
const cronParser = require('cron-parser');

// ----- Config (.env optional) -----
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath });
  }
} catch {}
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);
const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'changeme';

const RCON_HOST = process.env.RCON_HOST || '127.0.0.1';
const RCON_PORT = Number(process.env.RCON_PORT || 25575);
const RCON_PASSWORD = process.env.RCON_PASSWORD || 'changeme';

// ----- App/DB -----
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.startAt = Date.now(); next(); });

const dbPath = path.join(__dirname, 'webgui.sqlite');
const db = new sqlite3.Database(dbPath);

// Migrate tables
db.serialize(() => {
  db.run(`PRAGMA foreign_keys=ON`);

  db.run(`CREATE TABLE IF NOT EXISTS players(
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL,
    uuid TEXT,
    first_seen DATETIME,
    last_seen DATETIME,
    last_ip TEXT,
    total_playtime INTEGER DEFAULT 0
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
    login_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    logout_time DATETIME,
    duration INTEGER,
    FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS ix_sessions_open ON sessions(player_id, logout_time)`);

  db.run(`CREATE TABLE IF NOT EXISTS commands(
    id INTEGER PRIMARY KEY,
    player_id INTEGER,
    command TEXT NOT NULL,
    output TEXT,
    executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS schedules(
    id INTEGER PRIMARY KEY,
    cron TEXT NOT NULL,
    label TEXT,
    enabled INTEGER DEFAULT 1
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

  db.run(`CREATE TABLE IF NOT EXISTS audit(
    id INTEGER PRIMARY KEY,
    at DATETIME DEFAULT CURRENT_TIMESTAMP,
    action TEXT NOT NULL,
    username TEXT,
    ip TEXT,
    details TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS metrics_online(
    id INTEGER PRIMARY KEY,
    at DATETIME DEFAULT CURRENT_TIMESTAMP,
    online_count INTEGER NOT NULL,
    rcon_latency_ms INTEGER
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS ix_metrics_online_at ON metrics_online(at)`);
});

// ----- Auth -----
function auth(req, res, next) {
  const creds = basicAuth(req);
  if (!creds || creds.name !== PANEL_USER || creds.pass !== PANEL_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="MC Panel"');
    return res.status(401).send('Auth required');
  }
  req.auth = { user: creds.name };
  next();
}

// ----- RCON helper -----
async function sendRconCommand(cmd) {
  const client = new Rcon({ host: RCON_HOST, port: RCON_PORT, password: RCON_PASSWORD, timeout: 5000 });
  await client.connect();
  try {
    const res = await client.send(cmd);
    await client.end();
    return res;
  } catch (e) {
    try { await client.end(); } catch {}
    throw e;
  }
}

// ----- Audit helper -----
function logAudit(action, req, detailsObj) {
  try {
    const username = (req && req.auth && req.auth.user) || null;
    const ip = req ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString() : null;
    const details = detailsObj ? JSON.stringify(detailsObj) : null;
    db.run('INSERT INTO audit(action, username, ip, details) VALUES(?,?,?,?)',
      [action, username, ip, details]);
  } catch {}
}

// ----- Ban list parser -----
function parseBanList(raw) {
  const lines = (raw || '').split('\n').map(l => l.trim()).filter(Boolean);
  const clean = [];
  for (const l of lines) {
    if (/^There are \d+ ban\(s\)/i.test(l)) continue;
    const m = l.match(/^(.+?) was banned by (.*?): ?(.*)$/i);
    if (m) clean.push({ subject: m[1], by: m[2], reason: m[3] || null });
  }
  return clean;
}

// ----- Schedules / countdown planner -----
let scheduleState = { timers: [], nextFire: null };

function clearScheduleTimers() {
  scheduleState.timers.forEach(t => clearTimeout(t));
  scheduleState = { timers: [], nextFire: null };
}

// compute next upcoming time from all enabled cron rows
function computeNextFire(crons) {
  let soonest = null, meta = null;
  for (const row of crons) {
    try {
      const it = cronParser.parseExpression(row.cron, { utc: false });
      const next = it.next().toDate();
      if (!soonest || next < soonest) { soonest = next; meta = row; }
    } catch {}
  }
  return soonest ? { when: soonest, row: meta } : null;
}

function scheduleCountdowns() {
  clearScheduleTimers();
  db.all('SELECT * FROM schedules WHERE enabled=1', [], (err, rows) => {
    if (err) return;
    const next = computeNextFire(rows || []);
    if (!next) return; // nothing scheduled
    scheduleState.nextFire = next.when;

    const diffs = [
      { sec: 600, msg: 'Server restart in 10 minutes' },
      { sec: 300, msg: 'Server restart in 5 minutes' },
      { sec: 60,  msg: 'Server restart in 1 minute' },
      { sec: 30,  msg: 'Server restart in 30 seconds' },
      { sec: 5,   msg: 'Server restart in 5 seconds' },
      { sec: 0,   msg: 'Restarting now' }
    ];
    const now = Date.now();
    for (const d of diffs) {
      const fireAt = next.when.getTime() - d.sec*1000;
      if (fireAt <= now) continue;
      const t = setTimeout(async () => {
        try {
          if (d.sec > 0) {
            await sendRconCommand(`broadcast ${d.msg}`);
            logAudit('restart.countdown', null, { seconds_before: d.sec, label: next.row.label, cron: next.row.cron });
          } else {
            await sendRconCommand('broadcast Restarting now');
            logAudit('restart.now', null, { label: next.row.label, cron: next.row.cron });
            await sendRconCommand('stop');
          }
        } catch {}
        if (d.sec === 0) setTimeout(scheduleCountdowns, 2000); // recompute next cycle after restart
      }, fireAt - now);
      scheduleState.timers.push(t);
    }
  });
}

// periodically recompute next restart (in case rows changed, time drift, etc.)
setInterval(scheduleCountdowns, 60_000);
scheduleCountdowns();

// compute seconds until next restart for status card
function secondsUntilNext() {
  if (!scheduleState.nextFire) return null;
  const s = Math.floor((scheduleState.nextFire.getTime() - Date.now())/1000);
  return s >= 0 ? s : null;
}

// ----- Metrics sampler (every 60s) -----
setInterval(async () => {
  const t0 = Date.now();
  try {
    const out = await sendRconCommand('list');
    const latency = Date.now() - t0;
    let count = 0;
    const m = String(out).match(/There are\s+(\d+)\s+of/i);
    if (m) count = parseInt(m[1], 10);
    db.run('INSERT INTO metrics_online(online_count, rcon_latency_ms) VALUES(?,?)', [count, latency]);
  } catch {
    db.run('INSERT INTO metrics_online(online_count, rcon_latency_ms) VALUES(?,NULL)', [0]);
  }
}, 60_000);

// ----- Routes -----
// Static UI
app.use(express.static(path.join(__dirname, 'public')));

// Status
app.get('/api/status', async (req, res) => {
  let online = false, player_count = 0;
  try {
    const out = await sendRconCommand('list');
    const m = String(out).match(/There are\s+(\d+)\s+of/i);
    if (m) player_count = parseInt(m[1], 10);
    online = true;
  } catch {}
  res.json({
    online,
    player_count,
    next_restart_iso: scheduleState.nextFire ? scheduleState.nextFire.toISOString() : null,
    next_restart_seconds: secondsUntilNext()
  });
});

// Online players (simple parse of `list`)
app.get('/api/online', async (req, res) => {
  try {
    const out = await sendRconCommand('list');
    // typical: "There are X of a max of Y players online: name1, name2, ..."
    const names = [];
    const seg = out.split(':')[1] || '';
    seg.split(',').forEach(s => {
      const name = s.trim();
      if (name) names.push({ username: name });
    });
    res.json({ players: names, count: names.length });
  } catch (e) {
    res.json({ players: [], count: 0 });
  }
});

// Run arbitrary command
app.post('/api/command', auth, async (req, res) => {
  const { command } = req.body || {};
  if (!command) return res.status(400).json({ error: 'command required' });
  try {
    const out = await sendRconCommand(command);
    db.run('INSERT INTO commands(command, output) VALUES(?,?)', [command, out]);
    logAudit('command', req, { command, out });
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Broadcast & presets
app.post('/api/broadcast', auth, async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });
  try { 
    const out = await sendRconCommand(`broadcast ${message}`);
    logAudit('broadcast', req, { message });
    res.json({ ok: true, out });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/api/broadcast-presets', auth, (req, res) => {
  db.all('SELECT id,label,message FROM broadcast_presets ORDER BY id DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: String(err) });
    res.json(rows);
  });
});
app.post('/api/broadcast-presets', auth, (req, res) => {
  const { label, message } = req.body || {};
  if (!label || !message) return res.status(400).json({ error: 'label and message required' });
  db.run('INSERT INTO broadcast_presets(label,message) VALUES(?,?)', [label, message], function(err){
    if (err) return res.status(500).json({ error: String(err) });
    logAudit('broadcast.preset.add', req, { id: this.lastID, label });
    res.json({ ok: true, id: this.lastID });
  });
});

// Bans (clean JSON)
app.get('/api/bans', auth, async (req, res) => {
  try {
    const rawPlayers = await sendRconCommand('banlist players');
    const rawIps     = await sendRconCommand('banlist ips');
    const players = parseBanList(rawPlayers).map(x => ({ name: x.subject, by: x.by, reason: x.reason }));
    const ips = parseBanList(rawIps).map(x => ({ ip: x.subject, by: x.by, reason: x.reason }));
    logAudit('bans.list', req, { players: players.length, ips: ips.length });
    res.json({ players, ips });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/ban-ip', auth, async (req, res) => {
  const { ip, reason } = req.body || {};
  if (!ip) return res.status(400).json({ error: 'ip required' });
  try {
    const cmd = reason ? `ban-ip ${ip} ${reason}` : `ban-ip ${ip}`;
    const out = await sendRconCommand(cmd);
    logAudit('ban-ip', req, { ip, reason: reason || null });
    res.json({ ok: true, out });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Ban presets
app.get('/api/ban-presets', auth, (req, res) => {
  db.all('SELECT id,label,reason FROM ban_presets ORDER BY id DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: String(err) });
    res.json(rows);
  });
});
app.post('/api/ban-presets', auth, (req, res) => {
  const { label, reason } = req.body || {};
  if (!label || !reason) return res.status(400).json({ error: 'label and reason required' });
  db.run('INSERT INTO ban_presets(label,reason) VALUES(?,?)', [label, reason], function(err){
    if (err) return res.status(500).json({ error: String(err) });
    logAudit('ban.preset.add', req, { id: this.lastID, label });
    res.json({ ok: true, id: this.lastID });
  });
});

// Kick
app.post('/api/kick', auth, async (req, res) => {
  const { username, reason } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username required' });
  const outStr = reason ? `kick ${username} ${String(reason).replace(/\s+/g,' ')}` : `kick ${username}`;
  try {
    const out = await sendRconCommand(outStr);
    logAudit('kick', req, { username, reason: reason || null, out });
    res.json({ ok: true, out });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Schedules CRUD
function rowToSchedule(r){ return { id:r.id, cron:r.cron, label:r.label, enabled: !!r.enabled }; }

app.get('/api/schedules', auth, (req, res) => {
  db.all('SELECT * FROM schedules ORDER BY id ASC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: String(err) });
    res.json(rows.map(rowToSchedule));
  });
});
app.post('/api/schedules', auth, (req, res) => {
  const { cron, label } = req.body || {};
  if (!cron) return res.status(400).json({ error: 'cron required' });
  // validate cron
  try { cronParser.parseExpression(cron); } catch { return res.status(400).json({ error: 'invalid cron' }); }
  db.run('INSERT INTO schedules(cron,label,enabled) VALUES(?,?,1)', [cron, label || null], function(err){
    if (err) return res.status(500).json({ error: String(err) });
    logAudit('schedule.add', req, { id: this.lastID, cron, label });
    scheduleCountdowns();
    res.json({ ok: true, id: this.lastID });
  });
});
app.post('/api/schedules/:id/toggle', auth, (req, res) => {
  db.run('UPDATE schedules SET enabled = CASE enabled WHEN 1 THEN 0 ELSE 1 END WHERE id=?', [req.params.id], function(err){
    if (err) return res.status(500).json({ error: String(err) });
    logAudit('schedule.toggle', req, { id: req.params.id });
    scheduleCountdowns();
    res.json({ ok: true });
  });
});
app.delete('/api/schedules/:id', auth, (req, res) => {
  db.run('DELETE FROM schedules WHERE id=?', [req.params.id], function(err){
    if (err) return res.status(500).json({ error: String(err) });
    logAudit('schedule.delete', req, { id: req.params.id });
    scheduleCountdowns();
    res.json({ ok: true });
  });
});

// Emergency restart
app.post('/api/restart-now', auth, async (req, res) => {
  try {
    await sendRconCommand('broadcast ⚠ Emergency restart now!');
    logAudit('restart.emergency', req, {});
    await sendRconCommand('stop');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Players (DB-backed list; if you later wire login/logout hooks, update these tables)
app.get('/api/players', auth, (req, res) => {
  db.all('SELECT * FROM players ORDER BY last_seen DESC NULLS LAST, first_seen DESC NULLS LAST, username ASC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: String(err) });
    res.json(rows);
  });
});
app.get('/api/player/:id', auth, (req, res) => {
  const id = req.params.id;
  db.get('SELECT * FROM players WHERE id=?', [id], (err, player) => {
    if (err) return res.status(500).json({ error: String(err) });
    if (!player) return res.status(404).json({ error: 'not found' });
    db.all('SELECT ip,seen_at FROM player_ips WHERE player_id=? ORDER BY seen_at DESC', [id], (e2, ips) => {
      if (e2) return res.status(500).json({ error: String(e2) });
      db.all('SELECT login_time,logout_time,duration FROM sessions WHERE player_id=? ORDER BY login_time DESC', [id], (e3, sessions) => {
        if (e3) return res.status(500).json({ error: String(e3) });
        db.all('SELECT executed_at,command FROM commands WHERE player_id=? ORDER BY executed_at DESC LIMIT 100', [id], (e4, commands) => {
          if (e4) return res.status(500).json({ error: String(e4) });
          res.json({ player, ips, sessions, commands });
        });
      });
    });
  });
});

// Metrics API
function parseRange(range) {
  if (!range) return { sql: "datetime('now','-1 hour')" };
  const m = String(range).match(/^(\d+)([smhd])$/i);
  if (!m) return { sql: "datetime('now','-1 hour')" };
  const n = parseInt(m[1],10), u = m[2].toLowerCase();
  const unit = { s:'seconds', m:'minutes', h:'hours', d:'days' }[u] || 'hours';
  return { sql: `datetime('now','-${n} ${unit}')` };
}
app.get('/api/metrics/online', auth, (req, res) => {
  const { sql } = parseRange(req.query.range || '1h');
  db.all(
    `SELECT strftime('%Y-%m-%dT%H:%M:%SZ',at) as at, online_count, rcon_latency_ms
     FROM metrics_online WHERE at >= ${sql} ORDER BY at ASC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: String(err) });
      res.json(rows);
    }
  );
});

// Audit
app.get('/api/audit', auth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit||'100',10), 500);
  const offset = Math.max(parseInt(req.query.offset||'0',10), 0);
  db.all('SELECT id,at,action,username,ip,details FROM audit ORDER BY id DESC LIMIT ? OFFSET ?',
    [limit, offset],
    (err, rows) => {
      if (err) return res.status(500).json({ error: String(err) });
      res.json(rows.map(r => ({...r, details: r.details ? JSON.parse(r.details) : null })));
    });
});

// oEmbed + Badge
app.get('/api/status/oembed.json', (req, res) => {
  res.json({
    version: '1.0',
    type: 'rich',
    provider_name: 'MC RCON Panel',
    provider_url: '',
    title: 'Minecraft Server Status',
    html: `<iframe src="/badge.svg" width="220" height="28" frameborder="0"></iframe>`
  });
});
app.get('/badge.svg', async (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  let online = false, count = 0;
  try {
    const out = await sendRconCommand('list');
    const m = String(out).match(/There are\s+(\d+)\s+of/i);
    if (m) count = parseInt(m[1], 10);
    online = true;
  } catch {}
  const label = online ? `online ${count}` : 'offline';
  const color = online ? '#2ecc71' : '#ff4d57';
  const w = 220, h = 28;
  res.send(
`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" role="img" aria-label="mc: ${label}">
  <rect width="${w}" height="${h}" fill="#0f172a" rx="6"/>
  <text x="12" y="19" fill="#cfe2ff" font-family="Segoe UI,Roboto,Ubuntu" font-size="13">mc</text>
  <text x="45" y="19" fill="${color}" font-family="Segoe UI,Roboto,Ubuntu" font-weight="600" font-size="13">${label}</text>
</svg>`
  );
});

// Fallback UI
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

// Start server
app.listen(PORT, HOST, () => {
  console.log(`Panel on http://${HOST}:${PORT}`);
});
