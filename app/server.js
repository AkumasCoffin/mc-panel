/* MC RCON WebGUI — full server with sessions, schedules, metrics, audit, badge */
const path = require('path');
const fs = require('fs');
const express = require('express');
const authParser = require('basic-auth');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const { Rcon } = require('rcon-client');

// ------- Config (env with sensible defaults) -------
const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'changeme';

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

const RCON_HOST = process.env.RCON_HOST || '127.0.0.1';
const RCON_PORT = Number(process.env.RCON_PORT || 25575);
const RCON_PASS = process.env.RCON_PASS || 'change-me';

// Announce times for scheduled restarts (seconds before stop)
const ANNOUNCE_S = [600, 300, 60, 30, 5]; // 10m,5m,1m,30s,5s
// Poll intervals
const POLL_LIST_MS = 5000;   // track players online
const METRIC_SAMPLE_MS = 60000; // insert metrics

// ------- App & DB -------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const dbFile = path.join(__dirname, 'webgui.sqlite');
const db = new sqlite3.Database(dbFile);
db.serialize(() => {
  db.run(`PRAGMA journal_mode=WAL`);
  db.run(`PRAGMA foreign_keys=ON`);

  db.run(`CREATE TABLE IF NOT EXISTS players(
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL,
    uuid TEXT,
    first_seen DATETIME,
    last_seen DATETIME,
    total_playtime INTEGER DEFAULT 0,  -- seconds
    last_ip TEXT
  )`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS ux_players_username ON players(username)`);

  db.run(`CREATE TABLE IF NOT EXISTS player_ips(
    id INTEGER PRIMARY KEY,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    ip TEXT NOT NULL,
    seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS ix_player_ips ON player_ips(player_id, ip, seen_at)`);

  db.run(`CREATE TABLE IF NOT EXISTS sessions(
    id INTEGER PRIMARY KEY,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    login_time DATETIME NOT NULL,
    logout_time DATETIME,
    duration INTEGER
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS ix_sessions ON sessions(player_id, logout_time)`);

  db.run(`CREATE TABLE IF NOT EXISTS commands(
    id INTEGER PRIMARY KEY,
    player_id INTEGER,
    command TEXT NOT NULL,
    executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS schedules(
    id INTEGER PRIMARY KEY,
    cron TEXT NOT NULL,
    label TEXT,
    enabled INTEGER DEFAULT 1
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS broadcast_presets(
    id INTEGER PRIMARY KEY,
    label TEXT NOT NULL,
    message TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS ban_presets(
    id INTEGER PRIMARY KEY,
    label TEXT NOT NULL,
    reason TEXT NOT NULL
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

// ------- Auth middleware (Basic) -------
function auth(req, res, next) {
  const creds = authParser(req);
  const ok = creds && creds.name === PANEL_USER && creds.pass === PANEL_PASS;
  if (!ok) {
    res.set('WWW-Authenticate', 'Basic realm="MC Panel"');
    return res.status(401).send('Auth required');
  }
  req.user = creds.name;
  next();
}

// ------- RCON helper -------
async function withRcon(fn) {
  const client = new Rcon({
    host: RCON_HOST,
    port: RCON_PORT,
    password: RCON_PASS
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try { await client.end(); } catch {}
  }
}
async function sendRconCommand(cmd) {
  return withRcon(c => c.send(cmd));
}

// ------- Audit helper -------
function logAudit(action, req, detailsObj) {
  try {
    const username = req?.user || null;
    const ip = (req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '').toString();
    const details = detailsObj ? JSON.stringify(detailsObj) : null;
    db.run(`INSERT INTO audit(action, username, ip, details) VALUES(?,?,?,?)`,
      [action, username, ip, details]);
  } catch {}
}

// ------- Status & Online parsing -------
function parseList(out) {
  // Example: "There are 2 of a max of 20 players online: Steve, Alex"
  let count = 0;
  let names = [];
  const m = String(out).match(/There are\s+(\d+)\s+of/i);
  if (m) count = parseInt(m[1], 10);
  const list = String(out).split(':');
  if (list.length > 1) {
    names = list[1].split(',').map(s => s.trim()).filter(Boolean);
  }
  return { count, names };
}

// ------- Runtime: player tracking state -------
const currentOnline = new Map(); // username -> { since: Date }
let recentPlayers = [];

// ------- Sessions & players tracking via polling -------
async function updatePlayers() {
  try {
    const t0 = Date.now();
    const out = await sendRconCommand('list');
    const latency = Date.now() - t0;
    const { count, names } = parseList(out);

    // Store metrics
    db.run(`INSERT INTO metrics_online(online_count, rcon_latency_ms) VALUES(?,?)`, [count, latency]);

    const nowISO = new Date().toISOString();
    const set = new Set(names);

    // Handle joins
    for (const username of names) {
      if (!currentOnline.has(username)) {
        currentOnline.set(username, { since: Date.now() });
        // ensure player exists
        db.get(`SELECT id FROM players WHERE username=?`, [username], (e, row) => {
          if (e) return;
          if (row) {
            db.run(`UPDATE players SET last_seen=? WHERE id=?`, [nowISO, row.id]);
          } else {
            db.run(`INSERT INTO players(username, first_seen, last_seen) VALUES(?,?,?)`,
              [username, nowISO, nowISO]);
          }
          // open session
          db.get(`SELECT id FROM players WHERE username=?`, [username], (e2, p) => {
            if (p) db.run(`INSERT INTO sessions(player_id, login_time) VALUES(?,?)`, [p.id, nowISO]);
          });
        });
        recentPlayers.unshift({ username, at: nowISO });
        if (recentPlayers.length > 20) recentPlayers.pop();
      }
    }
    // Handle leaves
    for (const [username, info] of Array.from(currentOnline.entries())) {
      if (!set.has(username)) {
        currentOnline.delete(username);
        const leftISO = new Date().toISOString();
        db.get(`SELECT id FROM players WHERE username=?`, [username], (e, p) => {
          if (!p) return;
          db.get(`SELECT id, login_time FROM sessions WHERE player_id=? AND logout_time IS NULL ORDER BY id DESC LIMIT 1`,
            [p.id],
            (e2, s) => {
              if (!s) return;
              const dur = Math.max(0, (Date.now() - new Date(s.login_time).getTime()) / 1000 | 0);
              db.run(`UPDATE sessions SET logout_time=?, duration=? WHERE id=?`, [leftISO, dur, s.id]);
              db.run(`UPDATE players SET total_playtime=COALESCE(total_playtime,0)+? , last_seen=? WHERE id=?`,
                [dur, leftISO, p.id]);
            });
        });
      }
    }
  } catch {
    // If list fails, record 0 online
    db.run(`INSERT INTO metrics_online(online_count, rcon_latency_ms) VALUES(?,NULL)`, [0]);
  }
}
setInterval(updatePlayers, POLL_LIST_MS);
setInterval(() => {}, METRIC_SAMPLE_MS); // schedule already done by updatePlayers

// ------- Schedules runtime loader -------
const scheduledJobs = new Map(); // id -> { task, cron, label }
function humanNextOf(cronExp) {
  // Simple "next in X" using node-cron nextDates
  try {
    const task = cron.schedule(cronExp, ()=>{});
    const next = task.nextDates().toDate();
    task.stop();
    const sec = Math.max(0, (next.getTime() - Date.now())/1000|0);
    return { iso: next.toISOString(), seconds: sec };
  } catch {
    return { iso: null, seconds: null };
  }
}
async function announceAndRestart(label) {
  try {
    for (const s of ANNOUNCE_S) {
      await sendRconCommand(`broadcast Server restart in ${s >= 60 ? (s/60)+' minute(s)' : s+' second(s)' }`);
      await new Promise(r => setTimeout(r, (s === 5 ? 0 : 1000))); // no wait, we’ll sleep between steps below
    }
    // Honor countdown spacing
    const steps = [...ANNOUNCE_S].sort((a,b)=>b-a);
    for (let i=0;i<steps.length-1;i++) {
      const wait = (steps[i]-steps[i+1])*1000;
      await new Promise(r=>setTimeout(r, wait));
    }
    await sendRconCommand('broadcast Restarting now...');
    await sendRconCommand('stop');
  } catch {}
}
function loadSchedules() {
  // clear old
  for (const [,job] of scheduledJobs) { try{ job.task.stop(); }catch{} }
  scheduledJobs.clear();
  db.all(`SELECT id,cron,label,enabled FROM schedules WHERE enabled=1`, [], (e, rows) => {
    if (e) return;
    for (const r of rows) {
      try {
        const task = cron.schedule(r.cron, () => {
          announceAndRestart(r.label || 'Scheduled');
          logAudit('schedule.fire', null, { id: r.id, label: r.label, cron: r.cron });
        });
        task.start();
        scheduledJobs.set(r.id, { task, cron: r.cron, label: r.label });
      } catch {}
    }
  });
}
loadSchedules();

// ------- API -------

// Status (with next schedule)
app.get('/api/status', async (req, res) => {
  try {
    const pong = await sendRconCommand('list');
    const { count } = parseList(pong);
    // find earliest next time among schedules
    let next = { iso: null, seconds: null };
    for (const [,job] of scheduledJobs) {
      const n = humanNextOf(job.cron);
      if (!n.iso) continue;
      if (!next.iso || n.iso < next.iso) next = n;
    }
    res.json({ online: true, player_count: count, next_restart_iso: next.iso, next_restart_seconds: next.seconds });
  } catch {
    res.json({ online: false, player_count: 0, next_restart_iso: null, next_restart_seconds: null });
  }
});

// Who’s online (from last poll)
app.get('/api/online', auth, (req, res) => {
  const players = Array.from(currentOnline.keys()).map(username => ({ username }));
  res.json({ players, count: players.length });
});

// Players table
app.get('/api/players', auth, (req, res) => {
  db.all(`SELECT id,username,uuid,last_ip,first_seen,last_seen,total_playtime FROM players ORDER BY last_seen DESC NULLS LAST, first_seen DESC`, [], (e, rows) => {
    if (e) return res.status(500).json({ error: String(e) });
    res.json(rows);
  });
});

// Player detail (IPs, sessions, commands)
app.get('/api/player/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  db.get(`SELECT id,username,uuid,last_ip,first_seen,last_seen,total_playtime FROM players WHERE id=?`, [id], (e, player) => {
    if (e || !player) return res.status(404).json({ error: 'not found' });
    db.all(`SELECT ip,seen_at FROM player_ips WHERE player_id=? ORDER BY seen_at DESC`, [id], (e2, ips) => {
      db.all(`SELECT login_time,logout_time,duration FROM sessions WHERE player_id=? ORDER BY login_time DESC LIMIT 100`, [id], (e3, sessions) => {
        db.all(`SELECT command,executed_at FROM commands WHERE player_id=? OR player_id IS NULL ORDER BY executed_at DESC LIMIT 100`, [id], (e4, commands) => {
          res.json({ player, ips: ips||[], sessions: sessions||[], commands: commands||[] });
        });
      });
    });
  });
});

// Run a raw command (audit + log)
app.post('/api/command', auth, async (req, res) => {
  const { command } = req.body || {};
  if (!command) return res.status(400).json({ error: 'command required' });
  try {
    const out = await sendRconCommand(String(command));
    db.run(`INSERT INTO commands(player_id, command) VALUES(NULL, ?)`, [String(command)]);
    logAudit('command', req, { command, out });
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Broadcasts
app.post('/api/broadcast', auth, async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    const out = await sendRconCommand(`broadcast ${message}`);
    logAudit('broadcast', req, { message, out });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
app.get('/api/broadcast-presets', auth, (req, res) => {
  db.all(`SELECT id,label,message FROM broadcast_presets ORDER BY id DESC`, [], (e, rows) =>
    e ? res.status(500).json({ error: String(e) }) : res.json(rows));
});
app.post('/api/broadcast-presets', auth, (req, res) => {
  const { label, message } = req.body || {};
  if (!label || !message) return res.status(400).json({ error: 'label and message required' });
  db.run(`INSERT INTO broadcast_presets(label,message) VALUES(?,?)`, [label, message], function (e) {
    if (e) return res.status(500).json({ error: String(e) });
    logAudit('broadcast.preset.add', req, { id: this.lastID, label });
    res.json({ ok: true, id: this.lastID });
  });
});

// Bans (clean JSON)
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
app.get('/api/bans', auth, async (req, res) => {
  try {
    const rawPlayers = await sendRconCommand('banlist players');
    const rawIps = await sendRconCommand('banlist ips');
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
    const out = await sendRconCommand(`ban-ip ${ip}${reason ? ' ' + reason : ''}`);
    logAudit('ban-ip', req, { ip, reason: reason || null, out });
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Kick
app.post('/api/kick', auth, async (req, res) => {
  const { username, reason } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username required' });
  try {
    const out = await sendRconCommand(`kick ${username}${reason ? ' ' + reason : ''}`);
    logAudit('kick', req, { username, reason: reason || null, out });
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Audit log read
app.get('/api/audit', auth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
  const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
  db.all(`SELECT id,at,action,username,ip,details FROM audit ORDER BY id DESC LIMIT ? OFFSET ?`,
    [limit, offset],
    (e, rows) => {
      if (e) return res.status(500).json({ error: String(e) });
      res.json(rows.map(r => ({ ...r, details: r.details ? JSON.parse(r.details) : null })));
    });
});

// Metrics API
function parseRange(range) {
  if (!range) return { sql: "datetime('now','-1 hour')" };
  const m = String(range).match(/^(\d+)([smhd])$/i);
  if (!m) return { sql: "datetime('now','-1 hour')" };
  const n = parseInt(m[1],10);
  const unit = { s:'seconds', m:'minutes', h:'hours', d:'days' }[m[2].toLowerCase()];
  return { sql: `datetime('now','-${n} ${unit}')` };
}
app.get('/api/metrics/online', auth, (req, res) => {
  const { sql } = parseRange(req.query.range || '1h');
  db.all(
    `SELECT strftime('%Y-%m-%dT%H:%M:%SZ',at) as at, online_count, rcon_latency_ms
     FROM metrics_online
     WHERE at >= ${sql}
     ORDER BY at ASC`,
    [],
    (e, rows) => e ? res.status(500).json({ error: String(e) }) : res.json(rows)
  );
});

// Schedules CRUD
app.get('/api/schedules', auth, (req, res) => {
  db.all(`SELECT id,cron,label,enabled FROM schedules ORDER BY id DESC`, [], (e, rows) => {
    if (e) return res.status(500).json({ error: String(e) });
    res.json(rows);
  });
});
app.post('/api/schedules', auth, (req, res) => {
  const { cron: expr, label } = req.body || {};
  if (!expr) return res.status(400).json({ error: 'cron required' });
  // validate cron
  if (!cron.validate(expr)) return res.status(400).json({ error: 'invalid cron' });
  db.run(`INSERT INTO schedules(cron,label,enabled) VALUES(?,?,1)`, [expr, label || null], function (e) {
    if (e) return res.status(500).json({ error: String(e) });
    logAudit('schedule.add', req, { id: this.lastID, cron: expr, label: label||null });
    loadSchedules();
    res.json({ ok: true, id: this.lastID });
  });
});
app.post('/api/schedules/:id/toggle', auth, (req, res) => {
  const id = Number(req.params.id);
  db.run(`UPDATE schedules SET enabled = CASE enabled WHEN 1 THEN 0 ELSE 1 END WHERE id=?`, [id], function (e) {
    if (e) return res.status(500).json({ error: String(e) });
    logAudit('schedule.toggle', req, { id });
    loadSchedules();
    res.json({ ok: true });
  });
});
app.delete('/api/schedules/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  db.run(`DELETE FROM schedules WHERE id=?`, [id], function (e) {
    if (e) return res.status(500).json({ error: String(e) });
    logAudit('schedule.delete', req, { id });
    loadSchedules();
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
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// oEmbed + Badge
app.get('/api/status/oembed.json', (req, res) => {
  res.json({
    version: '1.0',
    type: 'rich',
    provider_name: 'MC RCON Panel',
    title: 'Minecraft Server Status',
    html: `<iframe src="/badge.svg" width="220" height="28" frameborder="0"></iframe>`
  });
});
app.get('/badge.svg', async (req, res) => {
  res.setHeader('Content-Type','image/svg+xml');
  let online = false, count = 0;
  try {
    const out = await sendRconCommand('list');
    const p = parseList(out);
    online = true; count = p.count;
  } catch {}
  const label = online ? `online ${count}` : 'offline';
  const color = online ? '#2ecc71' : '#ff4d57';
  const w=220,h=28;
  res.send(
`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" role="img" aria-label="mc: ${label}">
  <rect width="${w}" height="${h}" fill="#0f172a" rx="6"/>
  <text x="12" y="19" fill="#cfe2ff" font-family="Segoe UI,Roboto,Ubuntu" font-size="13">mc</text>
  <text x="45" y="19" fill="${color}" font-family="Segoe UI,Roboto,Ubuntu" font-weight="600" font-size="13">${label}</text>
</svg>`);
});

// Fallback to SPA
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

// Start
app.listen(PORT, HOST, () => {
  console.log(`Panel on http://${HOST}:${PORT}`);
});
