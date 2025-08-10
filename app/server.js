// app/server.js
// Minimal, robust API + UI server for MC RCON Panel

require('dotenv').config(); // optional, safe if no .env present
const path = require('path');
const fs = require('fs');
const express = require('express');
const basicAuth = require('basic-auth');
const { Rcon } = require('rcon-client'); // npm i rcon-client@5.1.0 (or 5.2.x if available)

const app = express();

// ---------- Config ----------
const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'changeme';

const RCON_HOST = process.env.RCON_HOST || '127.0.0.1';
const RCON_PORT = Number(process.env.RCON_PORT || 25575);
const RCON_PASS = process.env.RCON_PASS || '';
const RCON_TIMEOUT_MS = Number(process.env.RCON_TIMEOUT_MS || 3000);
const RCON_KEEP_MS = Number(process.env.RCON_KEEP_MS || 5000); // how long to keep the connection alive

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

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

// ---------- RCON: tiny connection pool ----------
let rconConn = null;
let rconBusy = false;
let rconLastUse = 0;

async function getRcon() {
  const now = Date.now();

  // Reuse if we have a connection and it's "fresh"
  if (rconConn && (now - rconLastUse < RCON_KEEP_MS)) return rconConn;

  // Otherwise, (re)connect
  await closeRconSafe();

  const conn = new Rcon({
    host: RCON_HOST,
    port: RCON_PORT,
    password: RCON_PASS
  });

  await conn.connect();
  rconConn = conn;
  rconLastUse = now;

  // On error, drop it
  conn.on('end', () => { rconConn = null; });
  conn.on('error', () => { rconConn = null; });

  return rconConn;
}

async function closeRconSafe() {
  if (rconConn) {
    try { await rconConn.end(); } catch (_) {}
  }
  rconConn = null;
}

async function rconQuery(cmd) {
  // Simple mutex so we don’t hammer the server
  while (rconBusy) {
    await new Promise(r => setTimeout(r, 20));
  }
  rconBusy = true;
  try {
    const conn = await getRcon();
    const res = await Promise.race([
      conn.send(cmd),
      new Promise((_, rej) => setTimeout(() => rej(new Error('RCON timeout')), RCON_TIMEOUT_MS))
    ]);
    rconLastUse = Date.now();
    return String(res || '');
  } finally {
    rconBusy = false;
  }
}

// ---------- Helpers ----------
function parseList(raw) {
  // Works with vanilla/Forge “list” format:
  // "There are 2 of a max of 50 players online: name1, name2"
  const out = { count: 0, players: [] };
  if (!raw) return out;

  // count
  const mCount = raw.match(/There are\s+(\d+)\s+of/i);
  if (mCount) out.count = Number(mCount[1] || 0);

  // names
  const parts = raw.split('players online:');
  if (parts.length > 1) {
    const namesStr = parts[1].trim();
    if (namesStr.length > 0) {
      namesStr.split(',').map(s => s.trim()).filter(Boolean).forEach(n => {
        out.players.push({ username: n });
      });
    }
  }
  return out;
}

// ---------- API routes (mounted BEFORE static) ----------
const api = express.Router();
api.use(requireAuth);

// Health/basic status
api.get('/status', async (req, res) => {
  try {
    // If RCON responds to "list", consider server "online"
    let online = false;
    try {
      const raw = await rconQuery('list');
      online = raw && raw.toLowerCase().includes('players online');
    } catch (_) { online = false; }

    res.json({
      online,
      // If you later implement schedules, fill these:
      next_restart_iso: null,
      next_restart_seconds: null
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Online snapshot via RCON
api.get('/online', async (req, res) => {
  try {
    const raw = await rconQuery('list');
    const parsed = parseList(raw);
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Run an arbitrary command
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

// Players list for the UI (from live `list` only; DB optional)
api.get('/players', async (req, res) => {
  try {
    const raw = await rconQuery('list');
    const parsed = parseList(raw);
    // Shape it like the table expects
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

// One player detail (stub until DB/enriched log parsing is enabled)
api.get('/player/:id', async (req, res) => {
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ error: 'bad id' });
  // Since we're not persisting players yet, just echo minimal info
  res.json({
    player: { id, username: 'Unknown', uuid: null, first_seen: null, last_seen: null, total_playtime: 0, last_ip: null },
    ips: [],
    sessions: [],
    commands: []
  });
});

// (Optional) emergency restart hook you wire to your own script
api.post('/restart-now', async (req, res) => {
  // Example broadcast; replace with your own service control if desired
  try { await rconQuery(`say [Panel] Restarting now...`); } catch (_) {}
  res.json({ ok: true });
});

app.use('/api', api);

// ---------- Static UI (from app/public) ----------
const PUBLIC_DIR = path.join(__dirname, 'public');
const indexHtml = path.join(PUBLIC_DIR, 'index.html');

app.use(express.static(PUBLIC_DIR));
app.get('/', (_req, res) => {
  if (!fs.existsSync(indexHtml)) {
    res
      .status(200)
      .type('text/plain')
      .send(`MC RCON Panel\nUI file not found. Place index.html in ${PUBLIC_DIR}.`);
  } else {
    res.sendFile(indexHtml);
  }
});

// Fallback to index for any unmatched non-API route (single-page app)
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).send('Not found');
  if (fs.existsSync(indexHtml)) return res.sendFile(indexHtml);
  res
    .status(200)
    .type('text/plain')
    .send(`MC RCON Panel\nUI file not found. Place index.html in ${PUBLIC_DIR}.`);
});

// ---------- Start ----------
app.listen(PORT, HOST, () => {
  console.log(`Panel on http://${HOST}:${PORT}`);
});
