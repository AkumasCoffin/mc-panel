// app/server.js
// MC WebGUI backend: RCON (if configured), log-driven presence, SQLite history, cron restarts, presets

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const session = require('express-session');
const { spawn, execFile } = require('child_process');
const cron = require('node-cron');
const cronParser = require('cron-parser');

try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch {}

const { db, run, get, all, initSchema } = require('./db');
const importer = require('./log_importer');
const { sendRconCommand, rconEnabled } = require('./rcon');
const SystemMonitor = require('./system_monitor');
const FileMonitor = require('./file_monitor');
const Analytics = require('./analytics');

// ---------- ENV ----------
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);
const TRUST_PROXY = !!Number(process.env.TRUST_PROXY || 0);

const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'changeme';
const SESSION_SECRET = process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex');

const MC_SERVER_PATH = process.env.MC_SERVER_PATH || process.env.SERVER_DIR || '/root/mc-server-backup';
const MC_SERVICE_NAME = process.env.MC_SERVICE_NAME || 'minecraft.service';
const SERVER_LOG = process.env.SERVER_LOG || path.join(MC_SERVER_PATH, 'logs/latest.log');
const BANNED_PLAYERS_JSON = process.env.BANNED_PLAYERS_JSON || path.join(MC_SERVER_PATH, 'banned-players.json');
const BANNED_IPS_JSON = process.env.BANNED_IPS_JSON || path.join(MC_SERVER_PATH, 'banned-ips.json');

// Initialize monitoring services
const systemMonitor = new SystemMonitor();
const fileMonitor = new FileMonitor(MC_SERVER_PATH);
const analytics = new Analytics();

// ---------- APP ----------
const app = express();
if (TRUST_PROXY) app.set('trust proxy', 1);
app.use(express.json());

// Session middleware with secure configuration
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Set to true when using HTTPS in production
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 172800000 // 48 hours in milliseconds (48 * 60 * 60 * 1000)
  }
}));

// Session-based authentication middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  
  // For API requests, return JSON error
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  // For browser requests, redirect to login
  return res.redirect('/login');
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

// ---------- AUTHENTICATION ENDPOINTS ----------
// Login page
app.get('/login', (req, res) => {
  // If already authenticated, redirect to main app
  if (req.session && req.session.authenticated) {
    return res.redirect('/');
  }
  
  const loginPath = path.join(PUBLIC_DIR, 'login.html');
  if (fs.existsSync(loginPath)) {
    res.set('Cache-Control', 'no-store');
    return res.sendFile(loginPath);
  }
  res.status(500).send('Login page not found. Place login.html in app/public.');
});

// Login endpoint
app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  
  // Check credentials
  if (username === PANEL_USER && password === PANEL_PASS) {
    req.session.authenticated = true;
    req.session.username = username;
    req.session.loginTime = new Date().toISOString();
    
    // Log successful login
    audit('login', { username, ip: req.ip, at: req.session.loginTime }).catch(() => {});
    
    res.json({ success: true, message: 'Login successful' });
  } else {
    // Log failed login attempt
    audit('login_failed', { username, ip: req.ip, at: new Date().toISOString() }).catch(() => {});
    
    res.status(401).json({ error: 'Invalid username or password' });
  }
});

// Logout endpoint
app.post('/logout', (req, res) => {
  if (req.session) {
    const username = req.session.username;
    req.session.destroy((err) => {
      if (err) {
        console.error('Error destroying session:', err);
        return res.status(500).json({ error: 'Logout failed' });
      }
      
      // Log logout
      audit('logout', { username, ip: req.ip, at: new Date().toISOString() }).catch(() => {});
      
      res.json({ success: true, message: 'Logout successful' });
    });
  } else {
    res.json({ success: true, message: 'Already logged out' });
  }
});

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
  // More flexible UUID pattern
  let m = line.match(/\bUUID of player ([\w.\-+]{3,16}) is ([0-9a-fA-F\-]{32,36})/i);
  if (m) { ensurePlayer(m[1]).uuid = (m[2] || '').toLowerCase(); return; }

  // Multiple login patterns for different Minecraft versions and servers
  m = line.match(/:\s*([A-Za-z0-9_\-\.]{3,16})\[\/([0-9\.]+):\d+\]\s+logged in/i) ||
      line.match(/\[.*\].*:\s*([A-Za-z0-9_\-\.]{3,16})\[\/([0-9\.]+):\d+\]\s+logged in/i) ||
      line.match(/\[.*\]\s+([A-Za-z0-9_\-\.]{3,16})\[\/([0-9\.]+):\d+\]\s+logged in/i);
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

  // Multiple join patterns
  m = line.match(/:\s*([A-Za-z0-9_\-\.]{3,16})\s+joined the game/i) ||
      line.match(/\[.*\].*:\s*([A-Za-z0-9_\-\.]{3,16})\s+joined the game/i) ||
      line.match(/\[.*\]\s+([A-Za-z0-9_\-\.]{3,16})\s+joined the game/i);
  if (m) {
    const [, name] = m;
    const p = ensurePlayer(name);
    p.last_seen = nowIso();
    p._login_ts = p._login_ts || Date.now();
    p.online = true;
    return;
  }

  // Multiple leave patterns
  m = line.match(/:\s*([A-Za-z0-9_\-\.]{3,16})\s+left the game/i) ||
      line.match(/:\s*([A-Za-z0-9_\-\.]{3,16})\s+lost connection/i) ||
      line.match(/\[.*\].*:\s*([A-Za-z0-9_\-\.]{3,16})\s+(?:left the game|lost connection)/i) ||
      line.match(/\[.*\]\s+([A-Za-z0-9_\-\.]{3,16})\s+(?:left the game|lost connection)/i);
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
  if (!fs.existsSync(file)) {
    console.warn('[panel] Log file does not exist, will wait for it to be created:', file);
    // Create the directory if it doesn't exist
    const logDir = path.dirname(file);
    if (!fs.existsSync(logDir)) {
      try {
        fs.mkdirSync(logDir, { recursive: true });
        console.log('[panel] Created log directory:', logDir);
      } catch (e) {
        console.warn('[panel] Could not create log directory:', e.message);
      }
    }
  }
  
  let lastSize = 0;
  try { lastSize = fs.statSync(file).size; } catch {}
  
  const logDir = path.dirname(file);
  const logFile = path.basename(file);
  
  fs.watch(logDir, { persistent: true }, (evt, fname) => {
    if (!fname || fname !== logFile) return;
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
    } catch (e) {
      // Log rotation or file temporarily unavailable
      console.warn('[panel] Log file read error (this is normal during rotation):', e.message);
    }
  });
}
if (SERVER_LOG && fs.existsSync(SERVER_LOG)) {
  console.log('[panel] Tracking players from log:', SERVER_LOG);
  bootstrapFromLog(SERVER_LOG);
  startTail(SERVER_LOG);
} else {
  console.warn('[panel] SERVER_LOG missing or unreadable:', SERVER_LOG);
}

// Input validation middleware
function validateCommandInput(req, res, next) {
  const cmd = String((req.body && req.body.command) || '').trim();
  if (!cmd) return res.status(400).json({ ok: false, out: 'No command provided.' });
  if (cmd.length > 1000) return res.status(400).json({ ok: false, out: 'Command too long (max 1000 chars).' });
  // Prevent potential command injection
  if (/[;&|`$(){}[\]<>]/.test(cmd) && !/^(list|whitelist|ban|pardon|kick|tp|give|gamemode|time|weather|seed|difficulty)\b/i.test(cmd)) {
    return res.status(400).json({ ok: false, out: 'Potentially unsafe command detected.' });
  }
  req.validatedCommand = cmd;
  next();
}

function validateStringInput(field, maxLength = 500) {
  return (req, res, next) => {
    const value = req.body && req.body[field];
    if (value !== undefined) {
      const str = String(value).trim();
      if (str.length > maxLength) {
        return res.status(400).json({ error: `${field} too long (max ${maxLength} chars)` });
      }
      req.body[field] = str;
    }
    next();
  };
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
  const p = spawn('sudo', ['systemctl', 'restart', MC_SERVICE_NAME], { stdio: 'inherit' });
  p.on('close', code => cb && cb(code ? new Error(`systemctl exit ${code}`) : null, '', ''));
  p.on('error', err => cb && cb(err, '', ''));
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
app.get('/api/status', requireAuth, async (req, res) => {
  const nxt = await nextRestartInfo();
  res.json({ online: true, rcon: rconEnabled(), ...nxt });
});

app.get('/api/online', requireAuth, (req, res) => {
  const online = [...playersByName.values()].filter(p => p.online);
  res.json({ players: online.map(p => ({ username: p.username, uuid: p.uuid || null })), count: online.length });
});

app.get('/api/players', requireAuth, (req, res) => {
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

app.get('/api/player/:id', requireAuth, async (req, res) => {
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
app.post('/api/command', requireAuth, validateCommandInput, async (req, res) => {
  const cmd = req.validatedCommand;
  await audit('panel_command', { cmd, from: req.ip, at: new Date().toISOString() });

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
app.get('/api/bans', requireAuth, (req, res) => {
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
app.get('/api/broadcast-presets', requireAuth, async (req, res) => {
  const rows = await all('SELECT id,label,message FROM broadcast_presets ORDER BY id DESC'); res.json(rows);
});
app.post('/api/broadcast-presets', requireAuth, validateStringInput('label', 100), validateStringInput('message', 1000), async (req, res) => {
  const { label, message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });
  await run('INSERT OR REPLACE INTO broadcast_presets(label,message) VALUES(?,?)', [label || null, String(message)]);
  res.status(201).json({ ok: true });
});
app.delete('/api/broadcast-presets/:id', requireAuth, async (req, res) => {
  await run('DELETE FROM broadcast_presets WHERE id=?', [Number(req.params.id)]); res.json({ ok: true });
});

app.get('/api/ban-presets', requireAuth, async (req, res) => {
  const rows = await all('SELECT id,label,reason FROM ban_presets ORDER BY id DESC'); res.json(rows);
});
app.post('/api/ban-presets', requireAuth, validateStringInput('label', 100), validateStringInput('reason', 500), async (req, res) => {
  const { label, reason } = req.body || {};
  if (!reason) return res.status(400).json({ error: 'reason required' });
  await run('INSERT OR REPLACE INTO ban_presets(label,reason) VALUES(?,?)', [label || null, String(reason)]);
  res.status(201).json({ ok: true });
});
app.delete('/api/ban-presets/:id', requireAuth, async (req, res) => {
  await run('DELETE FROM ban_presets WHERE id=?', [Number(req.params.id)]); res.json({ ok: true });
});

// Kick presets CRUD
app.get('/api/kick-presets', requireAuth, async (req, res) => {
  const rows = await all('SELECT id,label,reason FROM kick_presets ORDER BY id DESC'); res.json(rows);
});
app.post('/api/kick-presets', requireAuth, validateStringInput('label', 100), validateStringInput('reason', 500), async (req, res) => {
  const { label, reason } = req.body || {};
  if (!reason) return res.status(400).json({ error: 'reason required' });
  await run('INSERT OR REPLACE INTO kick_presets(label,reason) VALUES(?,?)', [label || null, String(reason)]);
  res.status(201).json({ ok: true });
});
app.delete('/api/kick-presets/:id', requireAuth, async (req, res) => {
  await run('DELETE FROM kick_presets WHERE id=?', [Number(req.params.id)]); res.json({ ok: true });
});

// Use presets
app.post('/api/broadcast', requireAuth, validateStringInput('message', 1000), async (req, res) => {
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

app.post('/api/ban', requireAuth, validateStringInput('username', 50), validateStringInput('reason', 500), async (req, res) => {
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

app.post('/api/kick', requireAuth, validateStringInput('username', 50), validateStringInput('reason', 500), async (req, res) => {
  const { username, reason, presetId } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username required' });
  let why = String(reason || '').trim();
  if (!why && presetId) {
    const row = await get('SELECT reason FROM kick_presets WHERE id=?', [Number(presetId)]);
    why = row ? String(row.reason || '').trim() : '';
  }
  if (!why) why = 'Kicked by an operator.';
  await audit('kick', { username, reason: why, presetId: presetId || null, by: req.ip, at: new Date().toISOString() });

  if (!rconEnabled()) return res.status(501).json({ ok: false, out: 'RCON disabled.' });
  try {
    const out = await sendRconCommand(`kick ${username} ${why}`);
    res.json({ ok: true, out: String(out || '').trim() });
  } catch (e) {
    res.status(500).json({ ok: false, out: 'RCON error: ' + e.message });
  }
});

// Schedules CRUD
app.get('/api/schedules', requireAuth, async (req, res) => {
  const rows = await all('SELECT * FROM schedules ORDER BY id DESC'); res.json(rows);
});
app.post('/api/schedules', requireAuth, validateStringInput('label', 100), async (req, res) => {
  const { cron: expr, label } = req.body || {};
  if (!expr || !cron.validate(expr)) return res.status(400).json({ error: 'bad cron' });
  const r = await run('INSERT INTO schedules(cron,label,enabled) VALUES(?,?,1)', [expr, label || null]);
  const row = await get('SELECT * FROM schedules WHERE id=?', [r.lastID]);
  await scheduleRow(row);
  res.status(201).json(row);
});
app.post('/api/schedules/:id/toggle', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const row = await get('SELECT * FROM schedules WHERE id=?', [id]); if (!row) return res.status(404).json({ error: 'not found' });
  const enabled = row.enabled ? 0 : 1;
  await run('UPDATE schedules SET enabled=? WHERE id=?', [enabled, id]);
  unschedule(id);
  if (enabled) await scheduleRow({ ...row, enabled });
  res.json({ ok: true });
});
app.delete('/api/schedules/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  unschedule(id); await run('DELETE FROM schedules WHERE id=?', [id]); res.json({ ok: true });
});

// Audit feed
app.get('/api/audit', requireAuth, async (req, res) => {
  const rows = await all('SELECT id, action, payload, created_at FROM panel_audit ORDER BY id DESC LIMIT 200');
  res.json(rows.map(r => ({ id: r.id, action: r.action, created_at: r.created_at, payload: JSON.parse(r.payload || '{}') })));
});

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

// System monitoring endpoints
app.get('/api/system/metrics', requireAuth, async (req, res) => {
  try {
    const metrics = systemMonitor.getMetrics();
    res.json(metrics);
  } catch (e) {
    res.status(500).json({ error: 'Failed to get system metrics' });
  }
});

app.get('/api/system/history', requireAuth, async (req, res) => {
  try {
    const hours = Math.min(parseInt(req.query.hours) || 24, 168); // Max 7 days
    const metrics = await all(`
      SELECT * FROM system_metrics 
      WHERE recorded_at >= datetime('now', '-${hours} hours')
      ORDER BY recorded_at ASC
    `);
    res.json(metrics);
  } catch (e) {
    res.status(500).json({ error: 'Failed to get system history' });
  }
});

// Analytics endpoints
app.get('/api/analytics/dashboard', requireAuth, async (req, res) => {
  try {
    const data = await analytics.getDashboardData();
    
    // Update with real-time online player count
    if (data && data.current_stats) {
      const online = [...playersByName.values()].filter(p => p.online);
      data.current_stats.online_players = online.length;
    }
    
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Failed to get dashboard analytics' });
  }
});

app.get('/api/analytics/player-trend', requireAuth, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 7, 30);
    const trend = await analytics.getPlayerActivityTrend(days);
    res.json(trend);
  } catch (e) {
    res.status(500).json({ error: 'Failed to get player trend' });
  }
});

app.get('/api/analytics/commands', requireAuth, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 7, 30);
    const stats = await analytics.getCommandStats(days);
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: 'Failed to get command stats' });
  }
});

app.get('/api/analytics/top-players', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const players = await analytics.getTopPlayersByPlaytime(limit);
    res.json(players);
  } catch (e) {
    res.status(500).json({ error: 'Failed to get top players' });
  }
});

app.get('/api/analytics/hourly-activity', requireAuth, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || 7, 30);
    const activity = await analytics.getHourlyActivity(days);
    res.json(activity);
  } catch (e) {
    res.status(500).json({ error: 'Failed to get hourly activity' });
  }
});

// Enhanced file monitoring endpoints
app.get('/api/files/stats', requireAuth, async (req, res) => {
  try {
    const stats = await fileMonitor.getStats();
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: 'Failed to get file stats' });
  }
});

app.get('/api/files/changes', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const changes = await all(`
      SELECT * FROM file_changes 
      ORDER BY changed_at DESC 
      LIMIT ?
    `, [limit]);
    res.json(changes);
  } catch (e) {
    res.status(500).json({ error: 'Failed to get file changes' });
  }
});

app.get('/api/whitelist', requireAuth, async (req, res) => {
  try {
    const whitelist = await all('SELECT * FROM whitelist ORDER BY username ASC');
    res.json(whitelist);
  } catch (e) {
    res.status(500).json({ error: 'Failed to get whitelist' });
  }
});

app.get('/api/operators', requireAuth, async (req, res) => {
  try {
    const operators = await all('SELECT * FROM operators ORDER BY level DESC, username ASC');
    res.json(operators);
  } catch (e) {
    res.status(500).json({ error: 'Failed to get operators' });
  }
});

app.get('/api/server-settings', requireAuth, async (req, res) => {
  try {
    const settings = await all('SELECT * FROM server_settings ORDER BY property_key ASC');
    res.json(settings);
  } catch (e) {
    res.status(500).json({ error: 'Failed to get server settings' });
  }
});

// Enhanced bans endpoint with database data
app.get('/api/bans/enhanced', requireAuth, async (req, res) => {
  try {
    const [dbPlayers, dbIps] = await Promise.all([
      all('SELECT * FROM banned_players ORDER BY banned_at DESC'),
      all('SELECT * FROM banned_ips ORDER BY banned_at DESC')
    ]);

    // Also get filesystem data as fallback
    const pjson = readJsonSafe(BANNED_PLAYERS_JSON) || [];
    const ijson = readJsonSafe(BANNED_IPS_JSON) || [];
    
    res.json({
      players: dbPlayers.length > 0 ? dbPlayers : pjson,
      ips: dbIps.length > 0 ? dbIps : ijson,
      source: dbPlayers.length > 0 ? 'database' : 'filesystem'
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get enhanced bans data' });
  }
});

// Store system metrics periodically
async function storeSystemMetrics() {
  try {
    const metrics = systemMonitor.getMetrics();
    if (metrics.timestamp) {
      await run(`
        INSERT INTO system_metrics (
          cpu_usage, cpu_cores, memory_used, memory_total, memory_usage,
          disk_used, disk_total, disk_usage, network_rx, network_tx,
          network_rx_rate, network_tx_rate, uptime, load_1, load_5, load_15
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        metrics.cpu.usage, metrics.cpu.cores,
        metrics.memory.used, metrics.memory.total, metrics.memory.usage,
        metrics.disk.used, metrics.disk.total, metrics.disk.usage,
        metrics.network.rx, metrics.network.tx, metrics.network.rxRate, metrics.network.txRate,
        metrics.uptime, metrics.load[1], metrics.load[5], metrics.load[15]
      ]);
    }
  } catch (e) {
    console.warn('[panel] Failed to store system metrics:', e.message);
  }
}

// Cleanup old metrics (keep only last 7 days)
async function cleanupOldMetrics() {
  try {
    await run("DELETE FROM system_metrics WHERE recorded_at < datetime('now', '-7 days')");
  } catch (e) {
    console.warn('[panel] Failed to cleanup old metrics:', e.message);
  }
}

// Fallback -> UI (also mark no-store for index shell)
app.get('*', requireAuth, (req, res) => {
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
  
  // Start monitoring services
  systemMonitor.start(5000); // Update every 5 seconds
  fileMonitor.start();
  analytics.start();
  
  // Store system metrics every minute
  setInterval(storeSystemMetrics, 60000);
  
  // Cleanup old metrics daily
  setInterval(cleanupOldMetrics, 24 * 60 * 60 * 1000);
  
  console.log('[panel] All monitoring services started');
  
  http.createServer(app).listen(PORT, HOST, () => console.log(`Panel on http://${HOST}:${PORT}`));
})();
