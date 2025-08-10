// app/server.js
// MC RCON panel backend without RCON deps.
// - Serves UI from app/public
// - Basic Auth via env
// - Tracks players by tailing Minecraft log
// - Implements /api/status, /api/online, /api/players, /api/player/:id, /api/command (list only), /api/bans

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');

// ---------- ENV ----------
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);

const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'changeme';

// Minecraft paths
const SERVER_DIR = process.env.SERVER_DIR || '/opt/minecraft/server';
const SERVER_LOG = process.env.SERVER_LOG || path.join(SERVER_DIR, 'logs/latest.log');
const BANNED_PLAYERS_JSON = process.env.BANNED_PLAYERS_JSON || path.join(SERVER_DIR, 'banned-players.json');
const BANNED_IPS_JSON = process.env.BANNED_IPS_JSON || path.join(SERVER_DIR, 'banned-ips.json');

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

// ---------- In-memory player tracking via log tail ----------
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

// ---------- API ----------
app.get('/api/status', basicAuth, (req, res) => {
  res.json({
    online: true,
    next_restart_iso: null,
    next_restart_seconds: null
  });
});

app.get('/api/online', basicAuth, (req, res) => {
  const online = [...playersByName.values()].filter(p => p.online);
  res.json({
    players: online.map(p => ({ username: p.username, uuid: p.uuid || null })),
    count: online.length
  });
});

app.get('/api/players', basicAuth, (req, res) => {
  const all = [...playersByName.values()];
  all.sort((a, b) => String(b.last_seen || '').localeCompare(String(a.last_seen || '')));
  res.json(all.map(p => ({
    id: p.id,
    username: p.username,
    uuid: p.uuid,
    first_seen: p.first_seen,
    last_seen: p.last_seen,
    total_playtime: p.total_playtime,
    last_ip: p.last_ip
  })));
});

app.get('/api/player/:id', basicAuth, (req, res) => {
  const id = Number(req.params.id);
  const p = [...playersByName.values()].find(x => x.id === id);
  if (!p) return res.status(404).json({ error: 'not found' });
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
    ips: p.last_ip ? [{ ip: p.last_ip, seen_at: p.last_seen }] : [],
    sessions: [],
    commands: []
  });
});

// Emulated command (list only)
app.post('/api/command', basicAuth, (req, res) => {
  const cmd = String((req.body && req.body.command) || '').trim();
  if (!cmd) return res.json({ ok: false, out: 'No command provided.' });
  if (/^list\b/i.test(cmd)) {
    const online = [...playersByName.values()].filter(p => p.online).map(p => p.username);
    const out = `There are ${online.length} of a max of 50 players online: ${online.join(', ')}\n`;
    return res.json({ ok: true, out });
  }
  return res.status(501).json({ ok: false, out: 'RCON disabled in log-mode; only "list" is emulated.' });
});

// NEW: Bans endpoint (reads banned-players.json and banned-ips.json)
app.get('/api/bans', basicAuth, (req, res) => {
  const pjson = readJsonSafe(BANNED_PLAYERS_JSON) || [];
  const ijson = readJsonSafe(BANNED_IPS_JSON) || [];

  // Format per frontend expectations (bubble renderer)
  const players = pjson.map(row => {
    // vanilla fields: name, uuid, created, source, expires, reason
    const name = row.name || row.user || row.target || '';
    const uuid = row.uuid || null;
    const by = row.source || row.by || 'Server';
    const reason = row.reason || 'No reason provided';
    const banned_at = row.created || row.banned_at || null;
    // enrich if we know this player
    const p = name ? playersByName.get(name) : null;
    return {
      type: 'player',
      target: name,
      username: name,
      uuid,
      by,
      reason,
      banned_at,
      last_ip: p ? p.last_ip : null,
      last_seen: p ? p.last_seen : null,
      playtime_seconds: p ? mapDurationSec(p.total_playtime) : null
    };
  });

  const ips = ijson.map(row => {
    // vanilla fields: ip, created, source, expires, reason
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

// Health
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Fallback to UI
app.get('*', (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  res.status(500).send('UI file not found. Place index.html in app/public.');
});

// ---------- START ----------
http.createServer(app).listen(PORT, HOST, () => {
  console.log(`Panel on http://${HOST}:${PORT}`);
});
