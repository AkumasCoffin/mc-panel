// app/server.js
// MC RCON Panel — using npm "rcon" (event-based) with a promise wrapper.

require('dotenv').config(); // harmless if no .env
const path = require('path');
const fs = require('fs');
const express = require('express');
const basicAuth = require('basic-auth');
const Rcon = require('rcon'); // <-- npm i rcon

const app = express();

// ---------- Config ----------
const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'changeme';

const RCON_HOST = process.env.RCON_HOST || '127.0.0.1';
const RCON_PORT = Number(process.env.RCON_PORT || 25575);
const RCON_PASS = process.env.RCON_PASS || '';
const RCON_TCP  = process.env.RCON_TCP === '1' ? true : false; // some servers require TCP mode
const RCON_TIMEOUT_MS = Number(process.env.RCON_TIMEOUT_MS || 4000);
const RCON_IDLE_CLOSE_MS = Number(process.env.RCON_IDLE_CLOSE_MS || 5000);

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

// ---------- RCON connection mgmt (event-based -> promise) ----------
let rcon = null;
let connected = false;
let busy = false;
let lastUse = 0;
let idleTimer = null;

function newRcon() {
  const opts = { tcp: RCON_TCP, challenge: true };
  const c = new Rcon(RCON_HOST, RCON_PORT, RCON_PASS, opts);
  c.on('end', () => { connected = false; });
  c.on('error', () => { connected = false; });
  return c;
}

function connectRcon() {
  return new Promise((resolve, reject) => {
    const c = newRcon();
    let done = false;

    const to = setTimeout(() => {
      if (done) return;
      done = true;
      try { c.disconnect(); } catch {}
      reject(new Error('RCON connect timeout'));
    }, RCON_TIMEOUT_MS);

    c.on('auth', () => {
      if (done) return;
      clearTimeout(to);
      done = true;
      rcon = c;
      connected = true;
      lastUse = Date.now();
      scheduleIdleClose();
      resolve();
    });

    c.on('error', (e) => {
      if (done) return;
      clearTimeout(to);
      done = true;
      try { c.disconnect(); } catch {}
      reject(e instanceof Error ? e : new Error(String(e)));
    });

    c.connect();
  });
}

function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (rcon && connected && Date.now() - lastUse >= RCON_IDLE_CLOSE_MS) {
      try { rcon.disconnect(); } catch {}
      rcon = null;
      connected = false;
    }
  }, RCON_IDLE_CLOSE_MS + 250);
}

async function ensureRcon() {
  if (rcon && connected) return;
  await connectRcon();
}

function rconSendOnce(cmd) {
  // Wrap a single request/response
  return new Promise(async (resolve, reject) => {
    try {
      await ensureRcon();
    } catch (e) {
      return reject(e);
    }

    let completed = false;
    const onResponse = (str) => {
      if (completed) return;
      completed = true;
      cleanup();
      lastUse = Date.now();
      scheduleIdleClose();
      resolve(String(str || ''));
    };
    const onError = (e) => {
      if (completed) return;
      completed = true;
      cleanup();
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const onEnd = () => {
      if (completed) return;
      completed = true;
      cleanup();
      reject(new Error('RCON connection ended'));
    };

    function cleanup() {
      if (!rcon) return;
      rcon.removeListener('response', onResponse);
      rcon.removeListener('error', onError);
      rcon.removeListener('end', onEnd);
    }

    // one-time listeners for this request
    rcon.once('response', onResponse);
    rcon.once('error', onError);
    rcon.once('end', onEnd);

    // timeout guard
    const t = setTimeout(() => {
      if (completed) return;
      completed = true;
      cleanup();
      try { rcon.disconnect(); } catch {}
      rcon = null; connected = false;
      reject(new Error('RCON command timeout'));
    }, RCON_TIMEOUT_MS + 500);

    // send
    try {
      rcon.send(cmd);
    } catch (e) {
      clearTimeout(t);
      cleanup();
      return reject(e);
    }
  });
}

async function rconQuery(cmd) {
  while (busy) {
    await new Promise(r => setTimeout(r, 15));
  }
  busy = true;
  try {
    const out = await rconSendOnce(cmd);
    return out;
  } finally {
    busy = false;
  }
}

// ---------- Helpers ----------
function parseList(raw) {
  // Typical output:
  // "There are 2 of a max of 50 players online: name1, name2"
  const out = { count: 0, players: [] };
  if (!raw) return out;

  const m = raw.match(/There are\s+(\d+)\s+of/i);
  if (m) out.count = Number(m[1] || 0);

  const parts = raw.split('players online:');
  if (parts.length > 1) {
    const names = parts[1].trim();
    if (names) {
      names
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .forEach(n => out.players.push({ username: n }));
    }
  }
  return out;
}

// ---------- API (authenticated) ----------
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

api.get('/online', async (_req, res) => {
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

// Players list: derived from live "list" (DB optional)
api.get('/players', async (_req, res) => {
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

api.post('/restart-now', async (_req, res) => {
  try { await rconQuery('say [Panel] Restarting now...'); } catch (_) {}
  res.json({ ok: true });
});

app.use('/api', api);

// ---------- Static UI from /app/public ----------
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

// Fallback to index.html for non-API routes
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
