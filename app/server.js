// app/server.js
// Minecraft RCON Web Panel - Express + SQLite + log tailer
// Node 18+ compatible

// Load .env if present (won't crash if missing)
try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const basicAuth = require('basic-auth');
const morgan = require('morgan');
const sqlite3 = require('sqlite3').verbose();
const { Rcon } = require('rcon-client');

// -------------------- Config (env) --------------------
const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'changeme';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);

const RCON_HOST = process.env.RCON_HOST || '127.0.0.1';
const RCON_PORT = Number(process.env.RCON_PORT || 25575);
const RCON_PASS = process.env.RCON_PASS || '';

const SERVER_LOG = process.env.SERVER_LOG || '/opt/minecraft/server/logs/latest.log';
// Optional – if your panel doesn’t scrape metrics every N seconds, leave 0
const METRICS_POLL_SEC = Number(process.env.METRICS_POLL_SEC || 0);

// -------------------- App --------------------
const app = express();
app.use(express.json());
app.use(morgan('tiny'));

// -------------------- Auth --------------------
function requireAuth(req, res, next) {
  const u = basicAuth(req);
  if (!u || u.name !== PANEL_USER || u.pass !== PANEL_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="panel"');
    return res.status(401).send('Authentication required.');
  }
  next();
}

// -------------------- DB --------------------
const DB_FILE = path.join(__dirname, 'webgui.sqlite');
const db = new sqlite3.Database(DB_FILE);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { if (err) reject(err); else resolve(this); });
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (e, r) => e ? reject(e) : resolve(r)));
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (e, r) => e ? reject(e) : resolve(r)));
}

async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS players(
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      uuid TEXT,
      first_seen DATETIME,
      last_seen DATETIME,
      total_playtime INTEGER DEFAULT 0,
      last_ip TEXT
    )
  `);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS ux_players_username ON players(username)`);

  await run(`
    CREATE TABLE IF NOT EXISTS player_ips(
      id INTEGER PRIMARY KEY,
      player_id INTEGER NOT NULL,
      ip TEXT NOT NULL,
      seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS ix_player_ips_player ON player_ips(player_id, ip)`);

  await run(`
    CREATE TABLE IF NOT EXISTS sessions(
      id INTEGER PRIMARY KEY,
      player_id INTEGER NOT NULL,
      login_time DATETIME,
      logout_time DATETIME,
      duration INTEGER
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS ix_sessions_open ON sessions(player_id, logout_time)`);

  await run(`
    CREATE TABLE IF NOT EXISTS commands(
      id INTEGER PRIMARY KEY,
      player_id INTEGER,
      command TEXT,
      executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}
initDb().catch(err => { console.error('DB init failed:', err); process.exit(1); });

// -------------------- RCON helpers --------------------
async function rconExec(command) {
  const client = new Rcon({ host: RCON_HOST, port: RCON_PORT, password: RCON_PASS });
  await client.connect();
  try {
    const out = await client.send(command);
    await client.end();
    return out || '';
  } catch (e) {
    try { await client.end(); } catch (_) {}
    throw e;
  }
}

// Parse vanilla/Paper/Forge "list" output
function parseList(out) {
  // "There are 0 of a max of 50 players online"
  // "There are 2 of a max of 50 players online: name1, name2"
  const res = { count: 0, players: [] };
  const mc = out.match(/There are\s+(\d+)\s+of/i);
  if (mc) res.count = Number(mc[1] || 0);
  const idx = out.indexOf(':');
  if (idx !== -1) {
    const names = out.slice(idx + 1).trim();
    if (names) {
      res.players = names.split(',').map(s => s.trim()).filter(Boolean).map(n => ({ username: n }));
    }
  }
  return res;
}

// -------------------- Log tailer (Forge-style) --------------------
// You provided samples like:
// [10Aug2025 20:49:22.264] [User Authenticator #20/INFO] [net.minecraft.server.network.ServerLoginPacketListenerImpl/]: UUID of player NAME is UUID
// [10Aug2025 20:49:24.846] [Server thread/INFO] [net.minecraft.server.players.PlayerList/]: NAME[/IP:PORT] logged in with entity id ...
// [10Aug2025 20:49:24.938] [Server thread/INFO] [net.minecraft.server.MinecraftServer/]: NAME joined the game
// [10Aug2025 20:49:49.554] [Server thread/INFO] [net.minecraft.server.network.ServerGamePacketListenerImpl/]: NAME lost connection: ...
// [10Aug2025 20:49:49.555] [Server thread/INFO] [net.minecraft.server.MinecraftServer/]: NAME left the game

const nameRx = '[-A-Za-z0-9_\\.]+';

// UUID line
const reUuid = new RegExp(
  String.raw`\[\d{2}\w{3}\d{4}\s+\d{2}:\d{2}:\d{2}\.\d{3}\]\s+\[.*?/INFO\]\s+\[net\.minecraft\.server\.network\.ServerLoginPacketListenerImpl/]:\s+UUID of player\s+(${nameRx})\s+is\s+([0-9a-fA-F-]{32,36})`
);

// Login with IP
const reLogin = new RegExp(
  String.raw`\[\d{2}\w{3}\d{4}\s+\d{2}:\d{2}:\d{2}\.\d{3}\]\s+\[Server thread/INFO\]\s+\[net\.minecraft\.server\.players\.PlayerList/]:\s+(${nameRx})\[/([0-9.]+):\d+\]\s+logged in`
);

// Joined the game
const reJoined = new RegExp(
  String.raw`\[\d{2}\w{3}\d{4}\s+\d{2}:\d{2}:\d{2}\.\d{3}\]\s+\[Server thread/INFO\]\s+\[net\.minecraft\.server\.MinecraftServer/]:\s+(${nameRx})\s+joined the game`
);

// Lost connection or left the game
const reLost = new RegExp(
  String.raw`\[\d{2}\w{3}\d{4}\s+\d{2}:\d{2}:\d{2}\.\d{3}\]\s+\[Server thread/INFO\]\s+\[net\.minecraft\.server\.network\.ServerGamePacketListenerImpl/]:\s+(${nameRx})\s+lost connection`
);
const reLeft = new RegExp(
  String.raw`\[\d{2}\w{3}\d{4}\s+\d{2}:\d{2}:\d{2}\.\d{3}\]\s+\[Server thread/INFO\]\s+\[net\.minecraft\.server\.MinecraftServer/]:\s+(${nameRx})\s+left the game`
);

function nowSql() {
  const d = new Date();
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

async function ensurePlayer(username) {
  let p = await get(`SELECT * FROM players WHERE username=?`, [username]);
  if (!p) {
    await run(`INSERT INTO players(username, first_seen, last_seen) VALUES(?,?,?)`, [
      username, nowSql(), nowSql()
    ]);
    p = await get(`SELECT * FROM players WHERE username=?`, [username]);
  }
  return p;
}

async function startSession(playerId) {
  // Close any open
  await run(
    `UPDATE sessions SET logout_time=CURRENT_TIMESTAMP,
                         duration=CAST((strftime('%s','now')-strftime('%s',login_time)) AS INTEGER)
     WHERE player_id=? AND logout_time IS NULL`,
    [playerId]
  );
  await run(`INSERT INTO sessions(player_id, login_time) VALUES(?, CURRENT_TIMESTAMP)`, [playerId]);
}

async function endSession(playerId) {
  const open = await get(
    `SELECT id, login_time FROM sessions
     WHERE player_id=? AND logout_time IS NULL
     ORDER BY id DESC LIMIT 1`, [playerId]
  );
  if (open) {
    await run(
      `UPDATE sessions SET logout_time=CURRENT_TIMESTAMP,
                           duration=CAST((strftime('%s','now')-strftime('%s',login_time)) AS INTEGER)
       WHERE id=?`, [open.id]
    );
    const s = await get(`SELECT duration FROM sessions WHERE id=?`, [open.id]);
    if (s && s.duration) {
      await run(
        `UPDATE players SET total_playtime=COALESCE(total_playtime,0)+? WHERE id=?`,
        [s.duration, playerId]
      );
    }
  }
}

async function handleLogLine(line) {
  // UUID
  let m = line.match(reUuid);
  if (m) {
    const username = m[1];
    const uuid = m[2];
    const p = await ensurePlayer(username);
    await run(`UPDATE players SET uuid=? WHERE id=?`, [uuid, p.id]);
    return;
  }

  // Login with IP
  m = line.match(reLogin);
  if (m) {
    const username = m[1];
    const ip = m[2];
    const p = await ensurePlayer(username);
    await run(`UPDATE players SET last_seen=CURRENT_TIMESTAMP, last_ip=? WHERE id=?`, [ip, p.id]);
    await run(`INSERT INTO player_ips(player_id, ip) VALUES(?, ?)`, [p.id, ip]);
    await startSession(p.id);
    return;
  }

  // Joined (sometimes appears after login)
  m = line.match(reJoined);
  if (m) {
    const username = m[1];
    const p = await ensurePlayer(username);
    await run(`UPDATE players SET last_seen=CURRENT_TIMESTAMP WHERE id=?`, [p.id]);
    // Session likely already started on login, but start if missing
    await startSession(p.id);
    return;
  }

  // Lost connection / Left the game
  m = line.match(reLost) || line.match(reLeft);
  if (m) {
    const username = m[1];
    const p = await ensurePlayer(username);
    await run(`UPDATE players SET last_seen=CURRENT_TIMESTAMP WHERE id=?`, [p.id]);
    await endSession(p.id);
  }
}

function tailServerLog() {
  if (!SERVER_LOG || !fs.existsSync(SERVER_LOG)) {
    console.warn('SERVER_LOG not found or not set:', SERVER_LOG);
    return;
  }
  console.log('Watching log:', SERVER_LOG);

  // Read from EOF initially
  let pos = fs.statSync(SERVER_LOG).size;

  const readNew = () => {
    try {
      const stat = fs.statSync(SERVER_LOG);
      if (stat.size < pos) pos = 0; // rotation
      if (stat.size === pos) return;
      const stream = fs.createReadStream(SERVER_LOG, { start: pos, end: stat.size });
      let buf = '';
      stream.on('data', c => (buf += c.toString('utf8')));
      stream.on('end', async () => {
        pos = stat.size;
        const lines = buf.split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          try { await handleLogLine(line); }
          catch (e) { console.warn('log parse error:', e.message); }
        }
      });
    } catch (e) {
      console.warn('tail read error:', e.message);
    }
  };

  // Use fs.watch + periodic poll as a backup (Forge logs can rotate aggressively)
  try {
    fs.watch(SERVER_LOG, { persistent: true }, readNew);
  } catch (e) {
    console.warn('fs.watch failed, falling back to polling:', e.message);
  }
  setInterval(readNew, 2000);
}
tailServerLog();

// -------------------- Routes --------------------

// Serve SPA (index.html in repo root or ./public if you use it)
const publicDir = __dirname;
app.use(express.static(publicDir));

// RCON: run command
app.post('/api/command', requireAuth, async (req, res) => {
  const command = (req.body?.command || '').trim();
  if (!command) return res.json({ ok: false, out: '' });
  try {
    const out = await rconExec(command);
    res.json({ ok: true, out });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Status
app.get('/api/status', requireAuth, async (_req, res) => {
  try {
    const out = await rconExec('list');
    const info = parseList(out);
    res.json({
      online: true,
      player_count: info.count,
      next_restart_iso: null,
      next_restart_seconds: null
    });
  } catch (e) {
    res.json({
      online: false,
      player_count: 0,
      next_restart_iso: null,
      next_restart_seconds: null,
      error: e.message
    });
  }
});

// Online (count + names)
app.get('/api/online', requireAuth, async (_req, res) => {
  try {
    const out = await rconExec('list');
    const info = parseList(out);
    res.json({ players: info.players, count: info.count });
  } catch (e) {
    res.json({ players: [], count: 0, error: e.message });
  }
});

// Players grid
app.get('/api/players', requireAuth, async (_req, res) => {
  try {
    const rows = await all(
      `SELECT id, username, uuid, first_seen, last_seen, total_playtime, last_ip
       FROM players
       ORDER BY COALESCE(last_seen, first_seen) DESC, username COLLATE NOCASE ASC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Player detail
app.get('/api/player/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const player = await get(`SELECT * FROM players WHERE id=?`, [id]);
    if (!player) return res.status(404).json({ error: 'not found' });
    const ips = await all(
      `SELECT ip, seen_at FROM player_ips WHERE player_id=? ORDER BY seen_at DESC LIMIT 200`,
      [id]
    );
    const sessions = await all(
      `SELECT login_time, logout_time, duration FROM sessions WHERE player_id=? ORDER BY login_time DESC LIMIT 200`,
      [id]
    );
    const commands = await all(
      `SELECT command, executed_at FROM commands WHERE player_id=? ORDER BY executed_at DESC LIMIT 100`,
      [id]
    );
    res.json({ player, ips, sessions, commands });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Root -> UI (fallback if no index.html)
app.get('/', (_req, res) => {
  const f = path.join(publicDir, 'index.html');
  if (fs.existsSync(f)) return res.sendFile(f);
  res.send(`<!doctype html><meta charset="utf-8">
  <body style="font-family:system-ui;padding:20px;background:#0b0f14;color:#e9f0ff">
    <h1>MC RCON Panel</h1>
    <p>UI file not found. Place <code>index.html</code> in <code>${publicDir}</code>.</p>
  </body>`);
});

// -------------------- Start --------------------
http.createServer(app).listen(PORT, HOST, () => {
  console.log(`Panel on http://${HOST}:${PORT}`);
});
