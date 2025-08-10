// app/server.js
// Minimal, robust API + UI server for MC RCON Panel (modern-rcon edition)

require('dotenv').config(); // safe if no .env present
const path = require('path');
const fs = require('fs');
const express = require('express');
const basicAuth = require('basic-auth');
const ModernRcon = require('modern-rcon'); // npm i modern-rcon@3

const app = express();

// ---------- Config ----------
const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'changeme';

const RCON_HOST = process.env.RCON_HOST || '127.0.0.1';
const RCON_PORT = Number(process.env.RCON_PORT || 25575);
const RCON_PASS = process.env.RCON_PASS || '';
const RCON_TIMEOUT_MS = Number(process.env.RCON_TIMEOUT_MS || 3000);
const RCON_KEEP_MS = Number(process.env.RCON_KEEP_MS || 5000); // keep the socket alive for a few seconds

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);

// UI folder (serve /app/public/index.html)
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_HTML = path.join(PUBLIC_DIR, 'index.html');

app.use(express.json());

// ---------- Basic Auth (API only) ----------
function requireAuth(req, res, next) {
  const cred = basicAuth(req);
  if (!cred || cred.name !== PANEL_USER || cred.pass !== PANEL_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="panel"');
    return res.status(401).send('Authentication required.');
  }
  next();
}

// ---------- RCON small pool / keepalive ----------
let rcon = null;          // ModernRcon instance
let rconConnected = false;
let rconBusy = false;
let rconLastUse = 0;
let rconKillTimer = null;

async function ensureRcon() {
  const now = Date.now();
  if (rcon && rconConnected && (now - rconLastUse < RCON_KEEP_MS)) return rcon;

  await closeRconSafe();

  rcon = new ModernRcon(RCON_HOST, RCON_PORT, RCON_PASS, { timeout: RCON_TIMEOUT_MS });
  await rcon.connect();
  rconConnected = true;
  rconLastUse = now;

  // schedule auto-close after idle
  scheduleRconClose();
  return rcon;
}

function scheduleRconClose() {
  if (rconKillTimer) clearTimeout(rconKillTimer);
  rconKillTimer = setTimeout(() => { closeRconSafe().catch(()=>{}); }, RCON_KEEP_MS + 500);
}

async function closeRconSafe() {
  if (rcon && rconConnected) {
    try { await rcon.disconnect(); } catch (_) {}
  }
  rcon = null;
  rconConnected = false;
  if (rconKillTimer) { clearTimeout(rconKillTimer); rconKillTimer = null; }
}

async function rconQuery(cmd) {
  // simple mutex
  while (rconBusy) {
    await new Promise(r => setTimeout(r, 15));
  }
  rconBusy = true;
  try {
    const c = await ensureRcon();
    const out = await Promise.race([
      c.send(cmd),
      new Promise((_, rej) => setTimeout(() => rej(new Error('RCON timeout')), RCON_TIMEOUT_MS))
    ]);
    rconLastUse = Date.now();
    scheduleRconClose();
    return String(out || '');
  } finally {
    rconBusy = false;
  }
}

// ---------- Helpers ----------
function parseList(raw) {
  // Typical: "There are 2 of a max of 50 players online: name1, name2"
  const out = { count: 0, players: [] };
  if (!raw) return out;

  const m = raw.match(/There are\s+(\d+)\s+of/i);
  if (m) out.count = Number(m[1] || 0);

  const parts = raw.split('players online:');
  if (parts.length > 1) {
    const names = parts[1].trim();
    if (names) {
      names.split(',').map(s => s.trim()).filter(Boolean).forEach(n => out.players.push({ username: n }));
    }
  }
  return out;
}

// ---------- API (mounted BEFORE static) ----------
const api = express.Router();
api.use(requireAuth);

api.get('/status', async (req, res) => {
  try {
    let online = false;
    try {
      const raw = await rconQuery('list');
      online = raw && raw.toLowerCase().includes('players online');
    } catch (_) { online = false; }
    res.json({ online, next_restart_iso: null, next_restart_seconds: null });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

api.get('/online', async (req, res) => {
  try {
    const raw = await rconQuery('list');
    const parsed = parseList(raw);
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

api.post('/command', async (req, res) => {
  try {
    const { command } = req.body || {};
    if (!command || typeof command !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing command' });
    }
    const out = await rconQuery(command);
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// Basic players table from live list (DB optional)
api.get('/players', async (req, res) => {
  try {
    const raw = await rconQuery('list');
    const parsed = parseList(raw);
    const rows = parsed.players.map((p, i) => ({
      id: i + 1,
      username: p.username,
      uuid: null,
      first_seen: null,
      last_seen: null,
      total_playtime: 0,
      last_ip: null
    }));
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Player detail stub (until DB/log parsing is enabled)
api.get('/player/:id', (req, res) => {
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ error: 'bad id' });
  res.json({
    player: { id, username: 'Unknown', uuid: null, first_seen: null, last_seen: null, total_playtime: 0, last_ip: null },
    ips: [],
    sessions: [],
    commands: []
  });
});

api.post('/restart-now', async (req, res) => {
  try { await rconQuery('say [Panel] Restarting now...'); } catch (_) {}
  res.json({ ok: true });
});

app.use('/api', api);

// ---------- Static UI ----------
app.use(express.static(PUBLIC_DIR));

app.get('/', (_req, res) => {
  if (!fs.existsSync(INDEX_HTML)) {
    return res
      .status(200)
      .type('text/plain')
      .send(`MC RCON Panel\nUI file not found. Place index.html in ${PUBLIC_DIR}.`);
  }
  res.sendFile(INDEX_HTML);
});

// SPA fallback (but not for /api/*)
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).send('Not found');
  if (fs.existsSync(INDEX_HTML)) return res.sendFile(INDEX_HTML);
  res
    .status(200)
    .type('text/plain')
    .send(`MC RCON Panel\nUI file not found. Place index.html in ${PUBLIC_DIR}.`);
});

// ---------- Start ----------
app.listen(PORT, HOST, () => {
  console.log(`Panel on http://${HOST}:${PORT}`);
});
