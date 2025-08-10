// app/server.js
// MC panel backend: log-driven presence, SQLite history, cron restarts

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { execFile, spawn } = require('child_process');
const cron = require('node-cron');
const cronParser = require('cron-parser');

const { db, run, get, all, initSchema } = require('./db');
const importer = require('./log_importer');

// ---------- ENV ----------
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);

const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'changeme';

// Prefer MC_SERVER_PATH (what install.sh writes), then fall back
const MC_SERVER_PATH = process.env.MC_SERVER_PATH || process.env.SERVER_DIR || '/root/mc-server-backup';
const SERVER_LOG = process.env.SERVER_LOG || path.join(MC_SERVER_PATH, 'logs/latest.log');
const BANNED_PLAYERS_JSON = process.env.BANNED_PLAYERS_JSON || path.join(MC_SERVER_PATH, 'banned-players.json');
const BANNED_IPS_JSON = process.env.BANNED_IPS_JSON || path.join(MC_SERVER_PATH, 'banned-ips.json');

// ---------- EXPRESS ----------
const app = express();
app.use(express.json());

// Basic Auth
function basicAuth(req, res, next) {
  const hdr = req.headers.authorization || '';
  if (!hdr.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="panel"');
    return res.status(401).send('Authentication required.');
  }
  const raw = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
  const i = raw.indexOf(':');
  const user = i >= 0 ? raw.slice(0, i) : raw;
  const pass = i >= 0 ? raw.slice(i + 1) : '';
  if (user === PANEL_USER && pass === PANEL_PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="panel"');
  return res.status(401).send('Authentication required.');
}

// Serve static UI
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, { index: false }));

// ---------- In-memory online tracking via log tail ----------
const playersByName = new Map(); // name -> record
let nextPlayerId = 1;

function nowIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
function ensurePlayer(name) {
  let p = playersByName.get(name);
  if (!p) {
    p = {
      id: nextPlayerId++,
      username: name,
      uuid: null,
      last_ip: null,
      first_seen: null,
      last_seen: null,
      total_playtime: 0, // seconds
      online: false,
      _login_ts: null
    };
    playersByName.set(name, p);
  }
  return p;
}
function parseLogLine(line) {
  // UUID line
  let m = line.match(/\bUUID of player ([\w.\-+]+) is ([0-9a-fA-F\-]{32,36})/);
  if (m) {
    const [, name, uuid] = m;
    ensurePlayer(name).uuid = (uuid || '').toLowerCase();
    return;
  }
  // login with IP
  m = line.match(/:\s*([A-Za-z0-9_\-\.]+)\[\/([0-9\.]+):\d+\]\s+logged in/i);
  if (m) {
    const [, name, ip] = m;
    const p = ensurePlayer(name);
    const ts = nowIso();
    p.last_ip = ip;
    p.first_seen = p.first_seen || ts;
    p.last_seen = ts;
    p._login_ts = Date.now();
    p.online = true;
    return;
  }
  // joined the game
  m = line.match(/:\s*([A-Za-z0-9_\-\.]+)\s+joined the game/);
  if (m) {
    const [, name] = m;
    const p = ensurePlayer(name);
    p.last_seen = nowIso();
    p._login_ts = p._login_ts || Date.now();
    p.online = true;
    return;
  }
  // left the game
  m = line.match(/:\s*([A-Za-z0-9_\-\.]+)\s+left the game/);
  if (m) {
    const [, name] = m;
    const p = ensurePlayer(name);
    const nowMs = Date.now();
    if (p._login_ts) {
      p.total_playtime += Math.max(0, Math.floor((nowMs - p._login_ts) / 1000));
      p._login_ts = null;
    }
    p.online = false;
    p.last_seen = nowIso();
  }
}

// Bootstrap + tail for in-memory live view
function bootstrapFromLog(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    const start = Math.max(0, stat.size - 300 * 1024); // last 300KB
    const len = stat.size - start;
    if (len > 0) {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      buf.toString('utf8').split(/\r?\n/).forEach(parseLogLine);
    }
    fs.closeSync(fd);
  } catch (e) {
    console.warn('[panel] bootstrapFromLog failed:', e.message);
  }
}
function startTail(file) {
  let lastSize = 0;
  try { lastSize = fs.statSync(file).size; } catch {}
  fs.watch(path.dirname(file), { persistent: true }, (evt, fname) => {
    if (!fname || fname !== path.basename(file)) return;
    try {
      const stat = fs.statSync(file);
      if (stat.size < lastSize) lastSize = 0; // rotated
      const len = stat.size - lastSize;
      if (len > 0) {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, lastSize);
        fs.closeSync(fd);
        buf.toString('utf8').split(/\r?\n/).forEach(parseLogLine);
      }
      lastSize = stat.size;
    } catch {}
  });
}
if (SERVER_LOG && fs.existsSync(SERVER_LOG)) {
  console.log('[panel] Tracking players from log:', SERVER_LOG);
  bootstrapFromLog(SERVER_LOG);
  startTail(SERVER_LOG);
} else {
  console.warn('[panel] SERVER_LOG missing or unreadable:', SERVER_LOG);
}

// ---------- Helpers ----------
function readJsonSafe(fp) {
  try {
    if (!fs.existsSync(fp)) return null;
    const txt = fs.readFileSync(fp, 'utf8');
    return JSON.parse(txt);
  } catch (e) {
    console.warn('[panel] Failed reading JSON:', fp, e.message);
    return null;
  }
}
function mapDurationSec(secs) {
  return typeof secs === 'number' ? secs : null;
}
function mcRestart(cb) {
  // Prefer helper script if present (installed by install.sh)
  const candidate = '/usr/local/bin/mc-restart';
  if (fs.existsSync(candidate)) {
    return execFile(candidate, (err, stdout, stderr) => cb && cb(err, stdout, stderr));
  }
  // Fallback to sudo systemctl
  const p = spawn('sudo', ['systemctl', 'restart', 'minecraft.service'], { stdio: 'inherit' });
  p.on('close', code => cb && cb(code ? new Error('systemctl exit '+code) : null, '', ''));
}
async function audit(action, payload) {
  try {
    await run('INSERT INTO panel_audit(action, payload) VALUES(?,?)', [action, JSON.stringify(payload || {})]);
  } catch {}
}

// ---------- Schedule manager ----------
const jobs = new Map(); // id -> cron task
function unschedule(id) {
  const j = jobs.get(id);
  if (j) { try { j.stop(); } catch {} jobs.delete(id); }
}
async function scheduleRow(row) {
  if (!row.enabled) return;
  if (!cron.validate(row.cron)) return;
  const task = cron.schedule(row.cron, async () => {
    await audit('schedule_fire', { id: row.id, cron: row.cron, label: row.label, fired_at: new Date().toISOString() });
    mcRestart((err) => {
      audit('restart', { source: 'schedule', id: row.id, ok: !err }).catch(()=>{});
    });
  });
  jobs.set(row.id, task);
}
async function refreshSchedulesFromDb() {
  for (const id of Array.from(jobs.keys())) unschedule(id);
  const rows = await all('SELECT * FROM schedules WHERE enabled=1');
  for (const r of rows) await scheduleRow(r);
}
async function nextRestartInfo() {
  const rows = await all('SELECT * FROM schedules WHERE enabled=1');
  let nextDate = null;
  for (const r of rows) {
    try {
      const it = cronParser.parseExpression(r.cron);
      const d = it.next().toDate();
      if (!nextDate || d < nextDate) nextDate = d;
    } catch {}
  }
  if (!nextDate) return { next_restart_iso: null, next_restart_seconds: null };
  const secs = Math.max(0, Math.floor((nextDate - new Date()) / 1000));
  return { next_restart_iso: nextDate.toISOString(), next_restart_seconds: secs };
}

// ---------- API ----------
app.get('/api/status', basicAuth, async (req, res) => {
  const nxt = await nextRestartInfo();
  res.json({ online: true, ...nxt });
});

app.get('/api/online', basicAuth, (req, res) => {
  const online = [...playersByName.values()].filter(p => p.online);
  res.json({
    players: online.map(p => ({ username: p.username, uuid: p.uuid || null })),
    count: online.length
  });
});

app.get('/api/players', basicAuth, (req, res) => {
  const allPlayers = [...playersByName.values()];
  allPlayers.sort((a, b) => String(b.last_seen || '').localeCompare(String(a.last_seen || '')));
  res.json(allPlayers.map(p => ({
    id: p.id,
    username: p.username,
    uuid: p.uuid,
    first_seen: p.first_seen,
    last_seen: p.last_seen,
    total_playtime: p.total_playtime,
    last_ip: p.last_ip
  })));
});

app.get('/api/player/:id', basicAuth, async (req, res) => {
  const id = Number(req.params.id);
  const p = [...playersByName.values()].find(x => x.id === id);
  if (!p) return res.status(404).json({ error: 'not found' });

  // Join to DB by username, then pull sessions/commands
  const row = await get('SELECT id FROM players WHERE username=?', [p.username]).catch(()=>null);
  let sessions = [], commands = [], ips = [];
  if (row && row.id) {
    sessions = await all('SELECT login_time, logout_time, duration FROM sessions WHERE player_id=? ORDER BY id DESC LIMIT 200', [row.id]).catch(()=>[]);
    commands = await all('SELECT command, executed_at FROM commands WHERE player_id=? ORDER BY id DESC LIMIT 200', [row.id]).catch(()=>[]);
    ips = await all('SELECT ip, seen_at FROM player_ips WHERE player_id=? ORDER BY id DESC LIMIT 200', [row.id]).catch(()=>[]);
  } else if (p.last_ip) {
    ips = [{ ip: p.last_ip, seen_at: p.last_seen }];
  }

  res.json({
    player: {
      id: p.id,
      username: p.username,
      uuid: p.uuid,
      first_seen: p.first_seen,
      last_seen: p.last_seen,
      total_playtime: p.total_playtime,
      last_ip: p.last_ip
    },
    ips, sessions, commands
  });
});

// Command endpoint: emulate "list"; log to audit
app.post('/api/command', basicAuth, async (req, res) => {
  const cmd = String((req.body && req.body.command) || '').trim();
  await audit('panel_command', { cmd, from: req.ip, at: new Date().toISOString() });
  if (!cmd) return res.json({ ok: false, out: 'No command provided.' });
  if (/^list\b/i.test(cmd)) {
    const online = [...playersByName.values()].filter(p => p.online).map(p => p.username);
    const out = `There are ${online.length} of a max of 50 players online: ${online.join(', ')}\n`;
    return res.json({ ok: true, out });
  }
  return res.status(501).json({ ok: false, out: 'RCON disabled in log-mode; only "list" is emulated.' });
});

// Bans (reads vanilla JSON files)
app.get('/api/bans', basicAuth, (req, res) => {
  const pjson = readJsonSafe(BANNED_PLAYERS_JSON) || [];
  const ijson = readJsonSafe(BANNED_IPS_JSON) || [];

  const players = pjson.map(row => {
    const name = row.name || row.user || row.target || '';
    const uuid = row.uuid || null;
    const by = row.source || row.by || 'Server';
    const reason = row.reason || 'No reason provided';
    const banned_at = row.created || row.banned_at || null;
    const pp = name ? playersByName.get(name) : null;
    return {
      type: 'player',
      target: name,
      username: name,
      uuid,
      by,
      reason,
      banned_at,
      last_ip: pp ? pp.last_ip : null,
      last_seen: pp ? pp.last_seen : null,
      playtime_seconds: pp ? mapDurationSec(pp.total_playtime) : null
    };
  });

  const ips = ijson.map(row => {
    const ip = row.ip || row.target || '';
    const by = row.source || row.by || 'Server';
    const reason = row.reason || 'No reason provided';
    const banned_at = row.created || row.banned_at || null;
    return {
      type: 'ip',
      target: ip,
      username: null,
      uuid: null,
      by,
      reason,
      banned_at,
      last_ip: ip,
      last_seen: null,
      playtime_seconds: null
    };
  });

  res.json({ players, ips });
});

// Schedules CRUD
app.get('/api/schedules', basicAuth, async (req, res) => {
  const rows = await all('SELECT * FROM schedules ORDER BY id DESC');
  res.json(rows);
});
app.post('/api/schedules', basicAuth, async (req, res) => {
  const { cron: expr, label } = req.body || {};
  if (!expr || !cron.validate(expr)) return res.status(400).json({ error: 'bad cron' });
  const r = await run('INSERT INTO schedules(cron,label,enabled) VALUES(?,?,1)', [expr, label || null]);
  const row = await get('SELECT * FROM schedules WHERE id=?', [r.lastID]);
  await scheduleRow(row);
  res.status(201).json(row);
});
app.post('/api/schedules/:id/toggle', basicAuth, async (req, res) => {
  const id = Number(req.params.id);
  const row = await get('SELECT * FROM schedules WHERE id=?', [id]);
  if (!row) return res.status(404).json({ error: 'not found' });
  const enabled = row.enabled ? 0 : 1;
  await run('UPDATE schedules SET enabled=? WHERE id=?', [enabled, id]);
  unschedule(id);
  if (enabled) await scheduleRow({ ...row, enabled });
  res.json({ ok: true });
});
app.delete('/api/schedules/:id', basicAuth, async (req, res) => {
  const id = Number(req.params.id);
  unschedule(id);
  await run('DELETE FROM schedules WHERE id=?', [id]);
  res.json({ ok: true });
});

// Audit feed
app.get('/api/audit', basicAuth, async (req, res) => {
  const rows = await all('SELECT id, action, payload, created_at FROM panel_audit ORDER BY id DESC LIMIT 200');
  res.json(rows.map(r => ({ id: r.id, action: r.action, created_at: r.created_at, payload: JSON.parse(r.payload || '{}') })));
});

// Health
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Fallback to UI
app.get('*', (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  res.status(500).send('UI file not found. Place index.html in app/public.');
});

// ---------- START ----------
(async () => {
  await initSchema();
  // Import historical logs + start DB-tail
  importer.start({ mcPath: MC_SERVER_PATH }).catch(()=>{});
  // Load schedules
  await refreshSchedulesFromDb();
  http.createServer(app).listen(PORT, HOST, () => {
    console.log(`Panel on http://${HOST}:${PORT}`);
  });
})();
