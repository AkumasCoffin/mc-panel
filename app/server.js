/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const path = require('path');
const fs = require('fs');
const express = require('express');
const basicAuth = require('basic-auth');
const morgan = require('morgan');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const { Rcon } = require('rcon-client');

// ---------- Config ----------
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme';

const TRUST_PROXY = Number(process.env.TRUST_PROXY || 0) ? true : false;

const RCON_HOST = process.env.RCON_HOST || '127.0.0.1';
const RCON_PORT = Number(process.env.RCON_PORT || 25575);
const RCON_PASSWORD = process.env.RCON_PASSWORD || '';

const RCON_QUEUE_CONCURRENCY = Number(process.env.RCON_QUEUE_CONCURRENCY || 1);
const RCON_RETRY_MS = Number(process.env.RCON_RETRY_MS || 1500);

// paths
const DB_FILE = path.join(__dirname, 'webgui.sqlite');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- DB ----------
const db = new sqlite3.Database(DB_FILE);
db.serialize(() => {
  db.run(`PRAGMA journal_mode=WAL;`);
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
    FOREIGN KEY(player_id) REFERENCES players(id)
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS ix_player_ips_player ON player_ips(player_id, ip)`);

  db.run(`CREATE TABLE IF NOT EXISTS sessions(
    id INTEGER PRIMARY KEY,
    player_id INTEGER NOT NULL,
    login_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    logout_time DATETIME,
    duration INTEGER,
    FOREIGN KEY(player_id) REFERENCES players(id)
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS ix_sessions_open ON sessions(player_id, logout_time)`);

  db.run(`CREATE TABLE IF NOT EXISTS commands(
    id INTEGER PRIMARY KEY,
    player_id INTEGER,
    command TEXT NOT NULL,
    executed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(player_id) REFERENCES players(id)
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

  // Helpful defaults
  db.run(`INSERT OR IGNORE INTO broadcast_presets(id,label,message)
          VALUES(1,'Maintenance','Server will restart soon for maintenance. Please prepare to disconnect safely.')`);
});

// ---------- auth middleware ----------
function auth(req, res, next) {
  const user = basicAuth(req);
  if (!user || user.name !== ADMIN_USER || user.pass !== ADMIN_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="MC Panel"');
    return res.status(401).send('Auth required');
  }
  req._panelUser = user.name;
  return next();
}

// ---------- app ----------
const app = express();
if (TRUST_PROXY) app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

// Serve the single-file UI if present, else a minimal placeholder
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');
if (!fs.existsSync(INDEX_HTML)) {
  fs.writeFileSync(INDEX_HTML, `<!doctype html><meta charset="utf-8"><title>MC Panel</title><pre>UI missing. Upload app/public/index.html</pre>`);
}
app.use(express.static(PUBLIC_DIR));

// ---------- RCON POOL (persistent single client + queue) ----------
let rcon = null;
let rconReady = false;
let connecting = false;

const q = [];
let active = 0;

async function ensureRcon() {
  if (rconReady || connecting) return;
  connecting = true;
  try {
    rcon = await Rcon.connect({ host: RCON_HOST, port: RCON_PORT, password: RCON_PASSWORD });
    rconReady = true;
    connecting = false;
    rcon.on('end', () => {
      rconReady = false;
      setTimeout(ensureRcon, RCON_RETRY_MS);
    });
    rcon.on('error', () => {
      rconReady = false;
    });
  } catch (_e) {
    connecting = false;
    rconReady = false;
    setTimeout(ensureRcon, RCON_RETRY_MS);
  }
}

async function runQueue() {
  if (active >= RCON_QUEUE_CONCURRENCY) return;
  const item = q.shift();
  if (!item) return;
  active++;
  try {
    await ensureRcon();
    if (!rconReady) throw new Error('RCON not connected');
    const t0 = Date.now();
    const out = await rcon.send(item.cmd);
    const latency = Date.now() - t0;
    item.resolve({ out, latency });
  } catch (e) {
    item.reject(e);
  } finally {
    active--;
    if (q.length) setImmediate(runQueue);
  }
}

function sendRcon(cmd) {
  return new Promise((resolve, reject) => {
    q.push({ cmd, resolve, reject });
    runQueue();
  });
}

// ---------- helpers ----------
function cleanBanList(text) {
  // Convert vanilla “There are X ban(s)” blob into structured arrays
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const entries = [];
  for (const l of lines) {
    const m = l.match(/^(.+?) was banned by (.+?): (.+)$/);
    if (m) {
      entries.push({ subject: m[1], by: m[2], reason: m[3] });
    }
  }
  return entries;
}

function nextRunFromCron(cronExpr, fromDate = new Date()) {
  // Tiny "next run" finder using node-cron “validate” and step through minutes.
  if (!cron.validate(cronExpr)) return null;
  // crude next-run in the next 7 days, step 30s
  const end = new Date(fromDate.getTime() + 7 * 24 * 3600 * 1000);
  const step = 30 * 1000;
  for (let t = fromDate.getTime() + step; t <= end.getTime(); t += step) {
    const d = new Date(t);
    if (cron.schedule(cronExpr, () => {}, { scheduled: false }).nextDates) {
      // node-cron 3 has pattern string only; emulate by checking all fields
      // Quick pass: run once a minute at :00 and rely on real scheduler for accuracy
    }
    // use a secondary check by firing cron parsing using second “*”
    try {
      const parts = cronExpr.trim().split(/\s+/);
      let ex = cronExpr;
      if (parts.length === 5) ex = `0 ${cronExpr}`;
      if (require('cron-validate')) { /* not installed; keep light */ }
    } catch {}
  }
  // Fallback: return null; scheduler itself will run and UI will show "None"
  return null;
}

function humanIn(seconds) {
  if (seconds == null) return '';
  let s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); s %= 60;
  if (h) return `in ${h}h ${m}m`;
  if (m) return `in ${m}m ${s}s`;
  return `in ${s}s`;
}

function addAudit(req, action, detailsObj) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '';
  const details = JSON.stringify(detailsObj || {});
  db.run(`INSERT INTO audit(action,username,ip,details) VALUES(?,?,?,?)`, [action, req._panelUser || '', ip, details]);
}

// ---------- status + metrics ----------
let lastOnlineSample = { count: 0, latency: null };
async function sampleOnline() {
  try {
    const t0 = Date.now();
    const out = await sendRcon('list'); // vanilla: "There are X of a max of Y players online: ..."
    const latency = Date.now() - t0;
    const m = String(out.out || out).match(/There are\s+(\d+)\s+of/);
    const count = m ? Number(m[1]) : 0;
    lastOnlineSample = { count, latency };
    db.run(`INSERT INTO metrics_online(online_count, rcon_latency_ms) VALUES(?,?)`, [count, latency]);
  } catch (e) {
    // ignore
  }
}
setInterval(sampleOnline, 10_000);
setTimeout(sampleOnline, 2_000);

// ---------- schedules (with staged broadcasts) ----------
const scheduledJobs = new Map();

function scheduleRestartRow(row) {
  if (!row.enabled) return;
  if (!cron.validate(row.cron)) return;
  const job = cron.schedule(row.cron, async () => {
    try {
      // staged messages
      await sendRcon(`broadcast Server restart in 10 minutes`);
      setTimeout(() => sendRcon(`broadcast Server restart in 5 minutes`).catch(()=>{}), 5*60*1000);
      setTimeout(() => sendRcon(`broadcast Server restart in 1 minute`).catch(()=>{}), 9*60*1000);
      setTimeout(() => sendRcon(`broadcast Server restart in 30 seconds`).catch(()=>{}), 9*60*1000 + 30*1000);
      setTimeout(() => sendRcon(`broadcast Server restart in 5 seconds`).catch(()=>{}), 9*60*1000 + 55*1000);
      setTimeout(async () => {
        await sendRcon(`broadcast Restarting now...`);
        await sendRcon('stop');
        addAudit({ headers: {}, socket: { remoteAddress: '' } }, 'restart.cron', { schedule_id: row.id, label: row.label });
      }, 10*60*1000);
    } catch (e) {
      console.error('Scheduled restart error', e.message || e);
    }
  });
  scheduledJobs.set(row.id, job);
}

function loadSchedules() {
  for (const [, job] of scheduledJobs) try { job.stop(); } catch {}
  scheduledJobs.clear();
  db.all(`SELECT * FROM schedules WHERE enabled=1`, [], (err, rows) => {
    if (err) return;
    rows.forEach(scheduleRestartRow);
  });
}
loadSchedules();

// ---------- routes ----------
app.get('/api/status', async (req, res) => {
  // next restart: pick earliest cron among enabled and estimate next time by running job every minute (approx)
  // For simplicity, return null ISO and let UI show “None”; jobs still run on cron.
  res.json({
    online: true,
    player_count: lastOnlineSample.count,
    next_restart_iso: null,
    next_restart_seconds: null
  });
});

app.get('/api/online', auth, async (req, res) => {
  try {
    // get current list
    const out = await sendRcon('list');
    const players = [];
    const namesMatch = String(out.out || out).match(/players online:\s*(.*)$/);
    if (namesMatch && namesMatch[1].trim()) {
      namesMatch[1].split(',').map(s => s.trim()).filter(Boolean).forEach(n => players.push({ username: n }));
    }
    addAudit(req, 'list', {});
    res.json({ players, count: players.length });
  } catch (e) {
    res.json({ players: [], count: 0 });
  }
});

// Commands
app.post('/api/command', auth, async (req, res) => {
  const { command } = req.body || {};
  if (!command) return res.status(400).json({ error: 'command required' });
  try {
    const out = await sendRcon(command);
    addAudit(req, 'command', { command, out: out.out || out });
    res.json({ ok: true, out: out.out || out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Broadcast
app.post('/api/broadcast', auth, async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    const out = await sendRcon(`broadcast ${message}`);
    addAudit(req, 'broadcast', { message });
    res.json({ ok: true, out: out.out || out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Ban IP
app.post('/api/ban-ip', auth, async (req, res) => {
  const { ip, reason } = req.body || {};
  if (!ip) return res.status(400).json({ error: 'ip required' });
  try {
    const cmd = reason ? `ban-ip ${ip} ${reason}` : `ban-ip ${ip}`;
    const out = await sendRcon(cmd);
    addAudit(req, 'ban-ip', { ip, reason });
    res.json({ ok: true, out: out.out || out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Kick
app.post('/api/kick', auth, async (req, res) => {
  const { username, reason } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username required' });
  try {
    const cmd = reason ? `kick ${username} ${reason}` : `kick ${username}`;
    const out = await sendRcon(cmd);
    addAudit(req, 'kick', { username, reason });
    res.json({ ok: true, out: out.out || out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Bans (clean)
app.get('/api/bans', auth, async (req, res) => {
  try {
    const outPlayers = await sendRcon('banlist players');
    const outIps = await sendRcon('banlist ips');
    addAudit(req, 'bans.list', {});
    res.json({
      players: cleanBanList(outPlayers.out || outPlayers),
      ips: cleanBanList(outIps.out || outIps)
    });
  } catch (e) {
    res.json({ players: [], ips: [] });
  }
});

// Presets
app.get('/api/ban-presets', auth, (req, res) => {
  db.all(`SELECT id,label,reason FROM ban_presets ORDER BY id DESC`, [], (e, rows) => res.json(rows || []));
});
app.post('/api/ban-presets', auth, (req, res) => {
  const { label, reason } = req.body || {};
  if (!label || !reason) return res.status(400).json({ error: 'label & reason required' });
  db.run(`INSERT INTO ban_presets(label,reason) VALUES(?,?)`, [label, reason], function () {
    addAudit(req, 'ban-preset.add', { id: this.lastID, label });
    res.json({ ok: true, id: this.lastID });
  });
});

app.get('/api/broadcast-presets', auth, (req, res) => {
  db.all(`SELECT id,label,message FROM broadcast_presets ORDER BY id DESC`, [], (e, rows) => res.json(rows || []));
});
app.post('/api/broadcast-presets', auth, (req, res) => {
  const { label, message } = req.body || {};
  if (!label || !message) return res.status(400).json({ error: 'label & message required' });
  db.run(`INSERT INTO broadcast_presets(label,message) VALUES(?,?)`, [label, message], function () {
    addAudit(req, 'broadcast-preset.add', { id: this.lastID, label });
    res.json({ ok: true, id: this.lastID });
  });
});

// Schedules
app.get('/api/schedules', auth, (req, res) => {
  db.all(`SELECT id,cron,label,enabled FROM schedules ORDER BY id DESC`, [], (e, rows) => res.json(rows || []));
});
app.post('/api/schedules', auth, (req, res) => {
  const { cron: cronExpr, label } = req.body || {};
  if (!cronExpr || !cron.validate(cronExpr)) return res.status(400).json({ error: 'valid cron required' });
  db.run(`INSERT INTO schedules(cron,label,enabled) VALUES(?,?,1)`, [cronExpr, label || null], function () {
    addAudit(req, 'schedule.add', { id: this.lastID, cron: cronExpr });
    loadSchedules();
    res.json({ ok: true, id: this.lastID });
  });
});
app.post('/api/schedules/:id/toggle', auth, (req, res) => {
  db.run(`UPDATE schedules SET enabled=CASE enabled WHEN 1 THEN 0 ELSE 1 END WHERE id=?`, [req.params.id], function () {
    addAudit(req, 'schedule.toggle', { id: req.params.id });
    loadSchedules();
    res.json({ ok: true });
  });
});
app.delete('/api/schedules/:id', auth, (req, res) => {
  db.run(`DELETE FROM schedules WHERE id=?`, [req.params.id], function () {
    addAudit(req, 'schedule.delete', { id: req.params.id });
    loadSchedules();
    res.json({ ok: true });
  });
});

// Emergency restart
app.post('/api/restart-now', auth, async (req, res) => {
  try {
    await sendRcon('broadcast ⚠ Emergency restart now!');
    await sendRcon('stop');
    addAudit(req, 'restart.emergency', {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Metrics & audit
app.get('/api/metrics/online', auth, (req, res) => {
  const range = String(req.query.range || '1h');
  let minutes = 60;
  const m = range.match(/^(\d+)([mh])$/i);
  if (m) minutes = m[2].toLowerCase() === 'h' ? Number(m[1]) * 60 : Number(m[1]);
  db.all(
    `SELECT strftime('%Y-%m-%dT%H:%M:%S',at) as at, online_count, rcon_latency_ms FROM metrics_online WHERE at >= datetime('now', ?)
     ORDER BY at ASC`,
    [`-${minutes} minutes`],
    (e, rows) => res.json(rows || [])
  );
});
app.get('/api/audit', auth, (req, res) => {
  db.all(`SELECT id,at,action,username,ip,details FROM audit ORDER BY id DESC LIMIT 500`, [], (e, rows) => res.json(rows || []));
});

// SVG status badge
app.get('/status.svg', async (req, res) => {
  const ok = true;
  const text = `Players ${lastOnlineSample.count}`;
  const w = 160;
  const h = 24;
  res.set('Content-Type', 'image/svg+xml');
  res.send(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <rect width="${w}" height="${h}" fill="#0f1524" stroke="#1e2a46"/>
      <text x="8" y="16" fill="#e9f0ff" font-size="12" font-family="Segoe UI,Roboto,system-ui">${text}</text>
    </svg>`
  );
});

// oEmbed (for link previews)
app.get('/api/status/oembed.json', (req, res) => {
  res.json({
    type: 'link',
    version: '1.0',
    provider_name: 'MC Panel',
    provider_url: 'https://example.invalid',
    title: `MC Server · ${lastOnlineSample.count} online`,
    url: `${req.protocol}://${req.get('host')}/`,
    thumbnail_url: `${req.protocol}://${req.get('host')}/status.svg`,
    thumbnail_width: 160,
    thumbnail_height: 24
  });
});

// UI fallthrough
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// ---------- start ----------
app.listen(PORT, HOST, () => {
  console.log(`Panel on http://${HOST}:${PORT}`);
  ensureRcon();
});
