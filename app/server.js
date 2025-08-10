// app/server.js
// MC WebGUI backend: RCON (if configured), log-driven presence, SQLite history, cron restarts, presets

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { spawn, execFile } = require('child_process');
const cron = require('node-cron');
const cronParser = require('cron-parser');

try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch {}

const { db, run, get, all, initSchema } = require('./db');
const importer = require('./log_importer');
const { sendRconCommand, rconEnabled } = require('./rcon');

// ---------- ENV ----------
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);
const TRUST_PROXY = !!Number(process.env.TRUST_PROXY || 0);

const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'changeme';

const MC_SERVER_PATH = process.env.MC_SERVER_PATH || process.env.SERVER_DIR || '/root/mc-server-backup';
const SERVER_LOG = process.env.SERVER_LOG || path.join(MC_SERVER_PATH, 'logs/latest.log');
const BANNED_PLAYERS_JSON = process.env.BANNED_PLAYERS_JSON || path.join(MC_SERVER_PATH, 'banned-players.json');
const BANNED_IPS_JSON = process.env.BANNED_IPS_JSON || path.join(MC_SERVER_PATH, 'banned-ips.json');

// ---------- APP ----------
const app = express();
if (TRUST_PROXY) app.set('trust proxy', 1);
app.use(express.json());

// Basic Auth (no dep)
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

// Static UI (no-store for index.html so proxies don’t cache old shell)
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, {
  index: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-store');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=300');
    }
  }
}));

// ---------- In-memory live state via log tail ----------
const playersByName = new Map(); // name -> record
let nextPlayerId = 1;

function nowIso() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
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
      total_playtime: 0,
      online: false,
      _login_ts: null
    };
    playersByName.set(name, p);
  }
  return p;
}
function parseLogLine(line) {
  let m = line.match(/\bUUID of player ([\w.\-+]+) is ([0-9a-fA-F\-]{32,36})/);
  if (m) { ensurePlayer(m[1]).uuid = (m[2] || '').toLowerCase(); return; }

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
  m = line.match(/:\s*([A-Za-z0-9_\-\.]+)\s+joined the game/);
  if (m) {
    const [, name] = m;
    const p = ensurePlayer(name);
    p.last_seen = nowIso();
    p._login_ts = p._login_ts || Date.now();
    p.online = true;
    return;
  }
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
function bootstrapFromLog(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    const start = Math.max(0, stat.size - 300 * 1024);
    const len = stat.size - start;
    if (len > 0) {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      buf.toString('utf8').split(/\r?\n/).forEach(parseLogLine);
    }
    fs.closeSync(fd);
  } catch (e) { console.warn('[panel] bootstrapFromLog failed:', e.message); }
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
async function audit(action, payload) {
  try { await run('INSERT INTO panel_audit(action, payload) VALUES(?,?)', [action, JSON.stringify(payload || {})]); } catch {}
}
function mcRestart(cb) {
  const candidate = '/usr/local/bin/mc-restart';
  if (fs.existsSync(candidate)) return execFile(candidate, (err, stdout, stderr) => cb && cb(err, stdout, stderr));
  const p = spawn('sudo', ['systemctl', 'restart', 'minecraft.service'], { stdio: 'inherit' });
  p.on('close', code => cb && cb(code ? new Error('systemctl exit '+code) : null, '', ''));
}

// ---------- Schedules ----------
const jobs = new Map(); // id -> cron task
function unschedule(id) { const j = jobs.get(id); if (j) { try{j.stop();}catch{} jobs.delete(id); } }
async function scheduleRow(row) {
  if (!row.enabled) return;
  if (!cron.validate(row.cron)) return;
  const task = cron.schedule(row.cron, async () => {
    await audit('schedule_fire', { id: row.id, cron: row.cron, label: row.label, fired_at: new Date().toISOString() });
    mcRestart((err) => audit('restart', { source: 'schedule', id: row.id, ok: !err }).catch(()=>{}));
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
  res.json({ online: true, rcon: rconEnabled(), ...nxt });
});

app.get('/api/online', basicAuth, (req, res) => {
  const online = [...playersByName.values()].filter(p => p.online);
  res.json({ players: online.map(p => ({ username: p.username, uuid: p.uuid || null })), count: online.length });
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

  const row = await get('SELECT id FROM players WHERE username=?', [p.username]).catch(()=>null);
  let sessions = [], commands = [], ips = [];
  if (row && row.id) {
    sessions = await all('SELECT login_time, logout_time, duration FROM sessions WHERE player_id=? ORDER BY id DESC LIMIT 200', [row.id]).catch(()=>[]);
    commands = await all('SELECT command, executed_at FROM commands WHERE player_id=? ORDER BY id DESC LIMIT 200', [row.id]).catch(()=>[]);
    ips = await all('SELECT ip, seen_at FROM player_ips WHERE player_id=? ORDER BY id DESC LIMIT 200', [row.id]).catch(()=>[]);
  } else if (p.last_ip) {
    ips = [{ ip: p.last_ip, seen_at: p.last_seen }];
  }
  res.json({ player: {
    id: p.id, username: p.username, uuid: p.uuid, first_seen: p.first_seen,
    last_seen: p.last_seen, total_playtime: p.total_playtime, last_ip: p.last_ip
  }, ips, sessions, commands });
});

// Commands
app.post('/api/command', basicAuth, async (req, res) => {
  const cmd = String((req.body && req.body.command) || '').trim();
  await audit('panel_command', { cmd, from: req.ip, at: new Date().toISOString() });
  if (!cmd) return res.json({ ok: false, out: 'No command provided.' });

  if (rconEnabled()) {
    try {
      const out = await sendRconCommand(cmd);
      return res.json({ ok: true, out: String(out || '').trim() });
    } catch (e) {
      return res.status(500).json({ ok: false, out: 'RCON error: ' + e.message });
    }
  }
  if (/^list\b/i.test(cmd)) {
    const online = [...playersByName.values()].filter(p => p.online).map(p => p.username);
    const out = `There are ${online.length} of a max of 50 players online: ${online.join(', ')}\n`;
    return res.json({ ok: true, out });
  }
  return res.status(501).json({ ok: false, out: 'RCON disabled; only "list" is emulated.' });
});

// Bans (filesystem)
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
      uuid, by, reason, banned_at,
      last_ip: pp ? pp.last_ip : null,
      last_seen: pp ? pp.last_seen : null,
      playtime_seconds: pp ? pp.total_playtime : null
    };
  });
  const ips = ijson.map(row => {
    const ip = row.ip || row.target || '';
    const by = row.source || row.by || 'Server';
    const reason = row.reason || 'No reason provided';
    const banned_at = row.created || row.banned_at || null;
    return { type: 'ip', target: ip, username: null, uuid: null, by, reason, banned_at, last_ip: ip, last_seen: null, playtime_seconds: null };
  });
  res.json({ players, ips });
});

// Presets
app.get('/api/broadcast-presets', basicAuth, async (req, res) => {
  const rows = await all('SELECT id,label,message FROM broadcast_presets ORDER BY id DESC'); res.json(rows);
});
app.post('/api/broadcast-presets', basicAuth, async (req, res) => {
  const { label, message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });
  await run('INSERT OR REPLACE INTO broadcast_presets(label,message) VALUES(?,?)', [label || null, String(message)]);
  res.status(201).json({ ok: true });
});
app.delete('/api/broadcast-presets/:id', basicAuth, async (req, res) => {
  await run('DELETE FROM broadcast_presets WHERE id=?', [Number(req.params.id)]); res.json({ ok: true });
});

app.get('/api/ban-presets', basicAuth, async (req, res) => {
  const rows = await all('SELECT id,label,reason FROM ban_presets ORDER BY id DESC'); res.json(rows);
});
app.post('/api/ban-presets', basicAuth, async (req, res) => {
  const { label, reason } = req.body || {};
  if (!reason) return res.status(400).json({ error: 'reason required' });
  await run('INSERT OR REPLACE INTO ban_presets(label,reason) VALUES(?,?)', [label || null, String(reason)]);
  res.status(201).json({ ok: true });
});
app.delete('/api/ban-presets/:id', basicAuth, async (req, res) => {
  await run('DELETE FROM ban_presets WHERE id=?', [Number(req.params.id)]); res.json({ ok: true });
});

// Use presets
app.post('/api/broadcast', basicAuth, async (req, res) => {
  const { message, presetId } = req.body || {};
  let msg = String(message || '').trim();
  if (!msg && presetId) {
    const row = await get('SELECT message FROM broadcast_presets WHERE id=?', [Number(presetId)]);
    msg = row ? String(row.message || '').trim() : '';
  }
  if (!msg) return res.status(400).json({ error: 'message required' });
  await audit('broadcast', { msg, presetId: presetId || null, by: req.ip, at: new Date().toISOString() });

  if (!rconEnabled()) return res.status(501).json({ ok: false, out: 'RCON disabled.' });
  try {
    const out = await sendRconCommand(`broadcast ${msg}`);
    res.json({ ok: true, out: String(out || '').trim() });
  } catch (e) {
    res.status(500).json({ ok: false, out: 'RCON error: ' + e.message });
  }
});

app.post('/api/ban', basicAuth, async (req, res) => {
  const { username, reason, presetId } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username required' });
  let why = String(reason || '').trim();
  if (!why && presetId) {
    const row = await get('SELECT reason FROM ban_presets WHERE id=?', [Number(presetId)]);
    why = row ? String(row.reason || '').trim() : '';
  }
  if (!why) why = 'Banned by an operator.';
  await audit('ban', { username, reason: why, presetId: presetId || null, by: req.ip, at: new Date().toISOString() });

  if (!rconEnabled()) return res.status(501).json({ ok: false, out: 'RCON disabled.' });
  try {
    const out = await sendRconCommand(`ban ${username} ${why}`);
    res.json({ ok: true, out: String(out || '').trim() });
  } catch (e) {
    res.status(500).json({ ok: false, out: 'RCON error: ' + e.message });
  }
});

// Schedules CRUD
app.get('/api/schedules', basicAuth, async (req, res) => {
  const rows = await all('SELECT * FROM schedules ORDER BY id DESC'); res.json(rows);
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
  const row = await get('SELECT * FROM schedules WHERE id=?', [id]); if (!row) return res.status(404).json({ error: 'not found' });
  const enabled = row.enabled ? 0 : 1;
  await run('UPDATE schedules SET enabled=? WHERE id=?', [enabled, id]);
  unschedule(id);
  if (enabled) await scheduleRow({ ...row, enabled });
  res.json({ ok: true });
});
app.delete('/api/schedules/:id', basicAuth, async (req, res) => {
  const id = Number(req.params.id);
  unschedule(id); await run('DELETE FROM schedules WHERE id=?', [id]); res.json({ ok: true });
});

// Audit feed
app.get('/api/audit', basicAuth, async (req, res) => {
  const rows = await all('SELECT id, action, payload, created_at FROM panel_audit ORDER BY id DESC LIMIT 200');
  res.json(rows.map(r => ({ id: r.id, action: r.action, created_at: r.created_at, payload: JSON.parse(r.payload || '{}') })));
});

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

// Fallback -> UI (also mark no-store for index shell)
app.get('*', (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.set('Cache-Control', 'no-store');
    return res.sendFile(indexPath);
  }
  res.status(500).send('UI file not found. Place index.html in app/public.');
});

// ---------- START ----------
(async () => {
  await initSchema();
  await importer.start({ mcPath: MC_SERVER_PATH }).catch(()=>{});
  await refreshSchedulesFromDb();
  http.createServer(app).listen(PORT, HOST, () => console.log(`Panel on http://${HOST}:${PORT}`));
})();
