// app/server.js
// Minimal MC RCON panel backend without any RCON npm deps.
// Reads the Minecraft server log and exposes the endpoints the UI needs.

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');

// ---------- ENV ----------
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);

// Basic auth for the panel
const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'changeme';

// Where your Minecraft server log lives (MUST be readable by this service)
const SERVER_LOG = process.env.SERVER_LOG || '/opt/minecraft/server/logs/latest.log';

// ---------- EXPRESS ----------
const app = express();
app.use(express.json());

// simple Basic Auth middleware (panel realm = "panel")
function basicAuth(req, res, next) {
  const hdr = req.headers.authorization || '';
  if (!hdr.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="panel"');
    return res.status(401).send('Authentication required.');
  }
  const raw = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
  const idx = raw.indexOf(':');
  const user = idx >= 0 ? raw.slice(0, idx) : raw;
  const pass = idx >= 0 ? raw.slice(idx + 1) : '';
  if (user === PANEL_USER && pass === PANEL_PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="panel"');
  return res.status(401).send('Authentication required.');
}

// Serve static UI from app/public
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, { index: false }));

// ---------- In-memory player tracking via log tail ----------
/*
Expected lines (your log already looks like this):
[10Aug2025 20:49:22.264] ... UUID of player Akumas_Coffin_ is 2f996c05-bf96-4691-84ca-82128df5103a
[10Aug2025 20:49:24.846] ... Akumas_Coffin_[/206.83.119.86:2399] logged in with entity id ...
[10Aug2025 20:49:24.938] ... Akumas_Coffin_ joined the game
[10Aug2025 20:49:49.555] ... Akumas_Coffin_ left the game
*/

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
      _login_ts: null // internal ms
    };
    playersByName.set(name, p);
  }
  return p;
}

function parseLogLine(line) {
  // UUID assignment
  let m = line.match(/\bUUID of player ([\w.\-+]+) is ([0-9a-fA-F\-]{32,36})/);
  if (m) {
    const [, name, uuid] = m;
    ensurePlayer(name).uuid = uuid.toLowerCase();
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
    return;
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

  // Watch the directory; on change to latest.log, read the tail
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
    } catch {
      // ignore transient errors
    }
  });
}

// init tracker
if (SERVER_LOG && fs.existsSync(SERVER_LOG)) {
  console.log('[panel] Tracking players from log:', SERVER_LOG);
  bootstrapFromLog(SERVER_LOG);
  startTail(SERVER_LOG);
} else {
  console.warn('[panel] SERVER_LOG missing or unreadable:', SERVER_LOG);
}

// ---------- API ----------

// Status (we mark server online if we can run and (optionally) see the log)
app.get('/api/status', basicAuth, (req, res) => {
  const online = true; // if panel is up, assume server reachable; refine later if needed
  res.json({
    online,
    next_restart_iso: null,
    next_restart_seconds: null
  });
});

// Online roster
app.get('/api/online', basicAuth, (req, res) => {
  const online = [...playersByName.values()].filter(p => p.online);
  res.json({
    players: online.map(p => ({ username: p.username, uuid: p.uuid || null })),
    count: online.length
  });
});

// Players table (for the Players tab)
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

// One player detail
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
    sessions: [],  // left blank in log-mode
    commands: []   // left blank in log-mode
  });
});

// Run a command (log-mode: we only emulate "list")
app.post('/api/command', basicAuth, (req, res) => {
  const cmd = String((req.body && req.body.command) || '').trim();
  if (!cmd) return res.json({ ok: false, out: 'No command provided.' });

  if (/^list\b/i.test(cmd)) {
    const online = [...playersByName.values()].filter(p => p.online).map(p => p.username);
    const out = `There are ${online.length} of a max of 50 players online: ${online.join(', ')}\n`;
    return res.json({ ok: true, out });
  }

  // For other commands, RCON is not wired here (no npm rcon deps). Return 501.
  return res.status(501).json({ ok: false, out: 'RCON disabled in log-mode; only "list" is emulated.' });
});

// (Optional) Health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Fallback to UI (SPA-ish)
app.get('*', (req, res) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  res.status(500).send('UI file not found. Place index.html in app/public.');
});

// ---------- START ----------
http.createServer(app).listen(PORT, HOST, () => {
  console.log(`Panel on http://${HOST}:${PORT}`);
});
