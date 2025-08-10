'use strict';

/* =========================
 * Imports & setup
 * ========================= */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const basicAuth = require('basic-auth');
const morgan = require('morgan');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const { Rcon } = require('rcon-client');

/* =========================
 * Environment
 * ========================= */
const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'changeme';

const RCON_HOST = process.env.RCON_HOST || '127.0.0.1';
const RCON_PORT = Number(process.env.RCON_PORT || 25575);
const RCON_PASS = process.env.RCON_PASS || 'minecraft';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);

const SERVER_LOG = process.env.SERVER_LOG || ''; // e.g. /opt/minecraft/server/logs/latest.log
const METRICS_POLL_SEC = Number(process.env.METRICS_POLL_SEC || 0); // 0 = disabled

/* =========================
 * App & DB
 * ========================= */
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(morgan('tiny'));

const dbPath = path.join(__dirname, 'webgui.sqlite');
const db = new sqlite3.Database(dbPath);

/* Ensure tables exist */
db.serialize(() => {
  db.run(`PRAGMA foreign_keys=ON;`);

  db.run(`CREATE TABLE IF NOT EXISTS players(
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE,
    uuid TEXT,
    first_seen DATETIME,
    last_seen DATETIME,
    total_playtime INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS player_ips(
    id INTEGER PRIMARY KEY,
    player_id INTEGER NOT NULL,
    ip TEXT NOT NULL,
    seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(player_id) REFERENCES players(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS sessions(
    id INTEGER PRIMARY KEY,
    player_id INTEGER NOT NULL,
    login_time DATETIME NOT NULL,
    logout_time DATETIME,
    duration INTEGER,
    FOREIGN KEY(player_id) REFERENCES players(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS commands(
    id INTEGER PRIMARY KEY,
    command TEXT,
    executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

  db.run(`CREATE TABLE IF NOT EXISTS metrics_online(
    id INTEGER PRIMARY KEY,
    online_count INTEGER NOT NULL,
    rcon_latency_ms INTEGER,
    at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS ix_metrics_online_at ON metrics_online(at)`);
  db.run(`CREATE INDEX IF NOT EXISTS ix_player_ips_player ON player_ips(player_id, ip)`);
  db.run(`CREATE INDEX IF NOT EXISTS ix_sessions_open ON sessions(player_id, logout_time)`);
});

/* =========================
 * Basic auth middleware
 * ========================= */
function requireAuth(req, res, next) {
  const creds = basicAuth(req);
  if (!creds || creds.name !== PANEL_USER || creds.pass !== PANEL_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="panel"');
    return res.status(401).send('Authentication required.');
  }
  next();
}

/* =========================
 * Shared RCON client + queue
 * ========================= */
let rcon = null;
let connecting = null; // promise
const queue = [];
let processing = false;

async function getRcon() {
  if (rcon && rcon.connected) return rcon;
  if (connecting) return connecting;

  connecting = (async () => {
    try {
      const client = await Rcon.connect({
        host: RCON_HOST,
        port: RCON_PORT,
        password: RCON_PASS,
        // challenge: true  // default for rcon-client >= 6
      });
      client.on('end', () => {
        rcon = null;
      });
      rcon = client;
      return rcon;
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

async function rconSend(cmd) {
  const start = Date.now();
  const client = await getRcon();
  const out = await client.send(cmd);
  const latency = Date.now() - start;
  return { out, latency };
}

// Simple request queue to avoid burst connects
function enqueueRcon(cmd) {
  return new Promise((resolve, reject) => {
    queue.push({ cmd, resolve, reject });
    pump();
  });
}
async function pump() {
  if (processing) return;
  processing = true;
  while (queue.length) {
    const item = queue.shift();
    try {
      const res = await rconSend(item.cmd);
      item.resolve(res);
      // slight gap to be gentle
      await new Promise(r => setTimeout(r, 50));
    } catch (e) {
      item.reject(e);
    }
  }
  processing = false;
}

/* =========================
 * Helpers
 * ========================= */
function parseListOutput(out) {
  // Vanilla-like: "There are 2 of a max of 50 players online: name1, name2"
  const m = out.match(/There are\s+(\d+)\s+of.*players online:\s*(.*)$/i);
  let count = 0, names = [];
  if (m) {
    count = parseInt(m[1], 10);
    if (m[2]) {
      names = m[2].split(',').map(s => s.trim()).filter(Boolean);
    }
  } else {
    // Fallback for Paper variants
    const m2 = out.match(/players online:\s*(.*)$/i);
    if (m2) names = m2[1].split(',').map(s => s.trim()).filter(Boolean);
    count = names.length;
  }
  return { count, names };
}

function parseBanList(out, type) {
  // Example vanilla outputs vary. We'll try to normalize.
  // Lines like: "X was banned by Server: Reason..."
  const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const arr = [];
  for (const line of lines) {
    const m = line.match(/^(.+?)\s+was banned by\s+([^:]+):\s*(.+)$/i);
    if (m) {
      arr.push({
        type,
        target: m[1].trim(),
        by: m[2].trim(),
        reason: m[3].trim()
      });
    } else if (/There are \d+ ban/.test(line)) {
      // header line, ignore
    } else if (line) {
      // Unknown format; include raw minimally
      arr.push({ type, target: line });
    }
  }
  return arr;
}

/* =========================
 * REST: status, online, command
 * ========================= */
app.get('/api/status', requireAuth, async (req, res) => {
  try {
    // Check live by sending a cheap command
    let online = true;
    let player_count = 0;
    try {
      const { out } = await enqueueRcon('list');
      const { count } = parseListOutput(out);
      player_count = count;
    } catch {
      online = false;
    }

    // Next restart from first enabled schedule in DB
    const row = await new Promise((resolve, reject) => {
      db.get('SELECT cron FROM schedules WHERE enabled=1 ORDER BY id LIMIT 1', (e, r) => e ? reject(e) : resolve(r));
    });

    let next_restart_iso = null;
    let next_restart_seconds = null;
    if (row && row.cron) {
      try {
        const it = cron.schedule(row.cron, () => {}, { scheduled: false }).nextDates().toDate();
        next_restart_iso = it.toISOString();
        next_restart_seconds = Math.max(0, Math.floor((it.getTime() - Date.now()) / 1000));
      } catch {
        // invalid cron in DB
      }
    }

    res.json({ online, player_count, next_restart_iso, next_restart_seconds });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/online', requireAuth, async (req, res) => {
  try {
    const { out } = await enqueueRcon('list');
    const { count, names } = parseListOutput(out);

    // Attach basic player records if known
    const players = await new Promise((resolve) => {
      if (!names.length) return resolve([]);
      const placeholders = names.map(() => '?').join(',');
      db.all(`SELECT id, username, uuid, last_seen, total_playtime,
              (SELECT ip FROM player_ips WHERE player_id=players.id ORDER BY seen_at DESC LIMIT 1) AS last_ip
              FROM players WHERE username IN (${placeholders})`, names, (e, rows) => {
        if (e) return resolve(names.map(n => ({ username: n })));
        // ensure ordering roughly
        const byName = new Map(rows.map(r => [r.username, r]));
        resolve(names.map(n => {
          const r = byName.get(n);
          return r ? {
            id: r.id, username: r.username, uuid: r.uuid, last_seen: r.last_seen, total_playtime: r.total_playtime, last_ip: r.last_ip
          } : { username: n };
        }));
      });
    });

    res.json({ players, count });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post('/api/command', requireAuth, async (req, res) => {
  try {
    const c = (req.body && req.body.command || '').trim();
    if (!c) return res.status(400).json({ error: 'Missing command' });

    db.run('INSERT INTO commands(command) VALUES(?)', [c], () => { /* ignore */ });

    const { out } = await enqueueRcon(c);
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/* =========================
 * Bans, ban-ip, broadcast
 * ========================= */
app.get('/api/bans', requireAuth, async (req, res) => {
  try {
    const p = enqueueRcon('banlist players').catch(() => ({ out: '' }));
    const i = enqueueRcon('banlist ips').catch(() => ({ out: '' }));
    const [{ out: playersRaw }, { out: ipsRaw }] = await Promise.all([p, i]);

    const players = parseBanList(playersRaw || '', 'player');
    const ips = parseBanList(ipsRaw || '', 'ip');

    // Enrich with last known info from DB when possible
    async function enrich(arr) {
      return await Promise.all(arr.map(b => new Promise(resolve => {
        if (b.type === 'ip') {
          // last player seen with this IP
          db.get(
            `SELECT p.username, p.uuid, p.last_seen, p.total_playtime
             FROM player_ips pi
             JOIN players p ON p.id=pi.player_id
             WHERE pi.ip=? ORDER BY pi.seen_at DESC LIMIT 1`,
            [b.target],
            (e, row) => {
              if (row) {
                b.username = row.username;
                b.uuid = row.uuid;
                b.last_seen = row.last_seen;
                b.playtime_seconds = row.total_playtime || 0;
              }
              resolve(b);
            }
          );
        } else {
          // player ban
          db.get(
            `SELECT id, uuid, last_seen, total_playtime,
               (SELECT ip FROM player_ips WHERE player_id=players.id ORDER BY seen_at DESC LIMIT 1) AS last_ip
             FROM players WHERE username=?`,
            [b.target],
            (e, row) => {
              if (row) {
                b.username = b.target;
                b.uuid = row.uuid;
                b.last_seen = row.last_seen;
                b.playtime_seconds = row.total_playtime || 0;
                b.last_ip = row.last_ip || null;
              }
              resolve(b);
            }
          );
        }
      })));
    }

    res.json({
      players: await enrich(players),
      ips: await enrich(ips)
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post('/api/ban-ip', requireAuth, async (req, res) => {
  try {
    const ip = (req.body && req.body.ip || '').trim();
    const reason = (req.body && req.body.reason || '').trim();
    if (!ip) return res.status(400).json({ error: 'Missing ip' });
    const cmd = reason ? `ban-ip ${ip} ${reason.replace(/\s+/g,' ')}` : `ban-ip ${ip}`;
    const { out } = await enqueueRcon(cmd);
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post('/api/broadcast', requireAuth, async (req, res) => {
  try {
    const message = (req.body && req.body.message || '').trim();
    if (!message) return res.status(400).json({ error: 'Missing message' });
    const cmd = `say ${message.replace(/\n/g, ' ').slice(0, 200)}`;
    const { out } = await enqueueRcon(cmd);
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/api/ban-presets', requireAuth, (req, res) => {
  db.all('SELECT id,label,reason FROM ban_presets ORDER BY id DESC', (e, rows) => {
    if (e) return res.status(500).json({ error: String(e) });
    res.json(rows);
  });
});
app.post('/api/ban-presets', requireAuth, (req, res) => {
  const { label, reason } = req.body || {};
  if (!label || !reason) return res.status(400).json({ error: 'label and reason required' });
  db.run('INSERT INTO ban_presets(label,reason) VALUES(?,?)', [label, reason], function (e) {
    if (e) return res.status(500).json({ error: String(e) });
    res.json({ ok: true, id: this.lastID });
  });
});

/* =========================
 * Players
 * ========================= */
app.get('/api/players', requireAuth, (req, res) => {
  db.all(
    `SELECT id, username, uuid, last_seen, first_seen, total_playtime,
       (SELECT ip FROM player_ips WHERE player_id=players.id ORDER BY seen_at DESC LIMIT 1) AS last_ip
     FROM players
     ORDER BY COALESCE(last_seen, first_seen) DESC NULLS LAST, username COLLATE NOCASE ASC`,
    (e, rows) => {
      if (e) return res.status(500).json({ error: String(e) });
      res.json(rows);
    }
  );
});

app.get('/api/player/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  db.get('SELECT * FROM players WHERE id=?', [id], (e, player) => {
    if (e) return res.status(500).json({ error: String(e) });
    if (!player) return res.status(404).json({ error: 'not found' });
    db.all('SELECT ip, seen_at FROM player_ips WHERE player_id=? ORDER BY seen_at DESC LIMIT 50', [id], (e2, ips) => {
      if (e2) return res.status(500).json({ error: String(e2) });
      db.all('SELECT login_time, logout_time, duration FROM sessions WHERE player_id=? ORDER BY login_time DESC LIMIT 50', [id], (e3, sessions) => {
        if (e3) return res.status(500).json({ error: String(e3) });
        db.all('SELECT executed_at, command FROM commands ORDER BY executed_at DESC LIMIT 50', (e4, commands) => {
          if (e4) return res.status(500).json({ error: String(e4) });
          res.json({ player, ips, sessions, commands });
        });
      });
    });
  });
});

/* =========================
 * Schedules
 * ========================= */
const activeTasks = new Map();

function loadSchedulesIntoCron() {
  // clear existing
  for (const [, task] of activeTasks) try { task.stop(); } catch {}
  activeTasks.clear();

  db.all('SELECT id,cron,label,enabled FROM schedules', (e, rows) => {
    if (e) return console.error('loadSchedulesIntoCron', e);
    rows.forEach(row => {
      if (!row.enabled) return;
      try {
        const task = cron.schedule(row.cron, async () => {
          try {
            await enqueueRcon('say [Panel] Scheduled restart now');
            await enqueueRcon('stop');
          } catch (err) {
            console.error('schedule run error', err);
          }
        });
        activeTasks.set(row.id, task);
      } catch (err) {
        console.error('Invalid cron', row.id, row.cron, err.message);
      }
    });
  });
}

app.get('/api/schedules', requireAuth, (req, res) => {
  db.all('SELECT id,cron,label,enabled FROM schedules ORDER BY id DESC', (e, rows) => {
    if (e) return res.status(500).json({ error: String(e) });
    res.json(rows);
  });
});

app.post('/api/schedules', requireAuth, (req, res) => {
  const { cron: cronExpr, label } = req.body || {};
  if (!cronExpr) return res.status(400).json({ error: 'cron required' });
  // validate
  if (!cron.validate(cronExpr)) return res.status(400).json({ error: 'invalid cron' });

  db.run('INSERT INTO schedules(cron,label,enabled) VALUES(?,?,1)', [cronExpr, label || null], function (e) {
    if (e) return res.status(500).json({ error: String(e) });
    loadSchedulesIntoCron();
    res.json({ ok: true, id: this.lastID });
  });
});

app.post('/api/schedules/:id/toggle', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  db.get('SELECT enabled FROM schedules WHERE id=?', [id], (e, row) => {
    if (e) return res.status(500).json({ error: String(e) });
    if (!row) return res.status(404).json({ error: 'not found' });
    const next = row.enabled ? 0 : 1;
    db.run('UPDATE schedules SET enabled=? WHERE id=?', [next, id], (e2) => {
      if (e2) return res.status(500).json({ error: String(e2) });
      loadSchedulesIntoCron();
      res.json({ ok: true, enabled: !!next });
    });
  });
});

app.delete('/api/schedules/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  db.run('DELETE FROM schedules WHERE id=?', [id], (e) => {
    if (e) return res.status(500).json({ error: String(e) });
    const t = activeTasks.get(id);
    if (t) { try { t.stop(); } catch {} activeTasks.delete(id); }
    res.json({ ok: true });
  });
});

app.post('/api/restart-now', requireAuth, async (req, res) => {
  try {
    await enqueueRcon('say [Panel] Restarting now…');
    const { out } = await enqueueRcon('stop');
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/* =========================
 * Broadcast presets (simple)
 * ========================= */
app.get('/api/broadcast-presets', requireAuth, (req, res) => {
  db.all('SELECT id,label,message FROM broadcast_presets ORDER BY id DESC', (e, rows) => {
    if (e) return res.status(500).json({ error: String(e) });
    res.json(rows);
  });
});
app.post('/api/broadcast-presets', requireAuth, (req, res) => {
  const { label, message } = req.body || {};
  if (!label || !message) return res.status(400).json({ error: 'label and message required' });
  db.run('INSERT INTO broadcast_presets(label,message) VALUES(?,?)', [label, message], function (e) {
    if (e) return res.status(500).json({ error: String(e) });
    res.json({ ok: true, id: this.lastID });
  });
});

/* =========================
 * Metrics
 * ========================= */
async function takeMetricsSnapshot() {
  try {
    const t0 = Date.now();
    const { out } = await enqueueRcon('list');
    const { count } = parseListOutput(out);
    const latency = Date.now() - t0;

    await new Promise((resolve, reject) => {
      db.run('INSERT INTO metrics_online(online_count, rcon_latency_ms) VALUES(?,?)', [count, latency], (e) => e ? reject(e) : resolve());
    });
    return { ok: true, count, latency };
  } catch (e) {
    // still record failed latency? skip
    return { ok: false, error: String(e) };
  }
}

app.post('/api/metrics/snap', requireAuth, async (req, res) => {
  const r = await takeMetricsSnapshot();
  if (!r.ok) return res.status(500).json(r);
  res.json(r);
});

app.get('/api/metrics/online', requireAuth, (req, res) => {
  const range = String(req.query.range || '1h').toLowerCase();
  // support 15m, 1h, 6h, 24h, 7d
  const m = range.match(/^(\d+)([mhds])$/);
  let minutes = 60;
  if (m) {
    const n = parseInt(m[1], 10);
    const u = m[2];
    if (u === 'm') minutes = n;
    if (u === 'h') minutes = n * 60;
    if (u === 'd') minutes = n * 60 * 24;
    if (u === 's') minutes = Math.ceil(n / 60);
  }
  db.all(
    `SELECT online_count, rcon_latency_ms, at
     FROM metrics_online
     WHERE at >= datetime('now', ?)
     ORDER BY at ASC`,
    [`-${minutes} minutes`],
    (e, rows) => {
      if (e) return res.status(500).json({ error: String(e) });
      res.json(rows);
    }
  );
});

/* =========================
 * Log ingester: players, IPs, sessions
 * ========================= */
function ensurePlayer(username, uuid) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM players WHERE username=?', [username], (err, row) => {
      if (err) return reject(err);
      if (row) {
        if (uuid && !row.uuid) {
          db.run('UPDATE players SET uuid=? WHERE id=?', [uuid, row.id], (e2) => {
            if (e2) return reject(e2);
            db.get('SELECT * FROM players WHERE id=?', [row.id], (e3, r2) => e3 ? reject(e3) : resolve(r2));
          });
        } else {
          resolve(row);
        }
        return;
      }
      db.run('INSERT INTO players(username, uuid, first_seen, last_seen) VALUES (?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',
        [username, uuid || null],
        function (insErr) {
          if (insErr) return reject(insErr);
          db.get('SELECT * FROM players WHERE id=?', [this.lastID], (e2, row2) => e2 ? reject(e2) : resolve(row2));
        });
    });
  });
}

function addPlayerIp(playerId, ip) {
  return new Promise((resolve, reject) => {
    db.run('INSERT INTO player_ips(player_id, ip) VALUES(?,?)', [playerId, ip], (err) => err ? reject(err) : resolve());
  });
}

function openSession(playerId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT id FROM sessions WHERE player_id=? AND logout_time IS NULL', [playerId], (err, row) => {
      if (err) return reject(err);
      if (row) return resolve(); // already open
      db.run('INSERT INTO sessions(player_id, login_time) VALUES(?,CURRENT_TIMESTAMP)', [playerId], (err2) => err2 ? reject(err2) : resolve());
    });
  });
}

function closeSession(playerId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT id, strftime("%s", login_time) AS ts FROM sessions WHERE player_id=? AND logout_time IS NULL ORDER BY id DESC LIMIT 1',
      [playerId],
      (err, row) => {
        if (err) return reject(err);
        if (!row) return resolve();
        const loginTs = Number(row.ts || 0);
        const dur = Math.max(0, Math.floor(Date.now() / 1000 - loginTs));
        db.run('UPDATE sessions SET logout_time=CURRENT_TIMESTAMP, duration=? WHERE id=?', [dur, row.id], (e2) => {
          if (e2) return reject(e2);
          db.run('UPDATE players SET total_playtime = COALESCE(total_playtime,0) + ?, last_seen=CURRENT_TIMESTAMP WHERE id=?', [dur, playerId], (e3) => e3 ? reject(e3) : resolve());
        });
      });
  });
}

function parseLogin(line) {
  // [12:34:56] [Server thread/INFO]: Player[/1.2.3.4:54321] logged in with entity id ...
  const m = /\]:\s*([A-Za-z0-9_]{1,16})\[/i.exec(line);
  const ipm = /\[\/(\d+\.\d+\.\d+\.\d+):\d+\]/.exec(line);
  if (!m || !ipm) return null;
  return { username: m[1], ip: ipm[1] };
}
function parseUuid(line) {
  // [User Authenticator #1/INFO]: UUID of player Player is 1234-...
  const m = /UUID of player\s+([A-Za-z0-9_]{1,16})\s+is\s+([0-9a-fA-F-]{32,36})/i.exec(line);
  return m ? { username: m[1], uuid: m[2] } : null;
}
function parseQuit(line) {
  // [12:34:56] [Server thread/INFO]: Player lost connection: ...
  const m = /\]:\s*([A-Za-z0-9_]{1,16})\s+lost connection/i.exec(line);
  return m ? { username: m[1] } : null;
}

async function handleLogLine(line) {
  try {
    const u = parseUuid(line);
    if (u) {
      await ensurePlayer(u.username, u.uuid);
      return;
    }
    const j = parseLogin(line);
    if (j) {
      const row = await ensurePlayer(j.username, null);
      await addPlayerIp(row.id, j.ip);
      await openSession(row.id);
      return;
    }
    const q = parseQuit(line);
    if (q) {
      const row = await ensurePlayer(q.username, null);
      await closeSession(row.id);
      return;
    }
  } catch (e) {
    console.error('log ingest error:', e);
  }
}

function startLogIngest() {
  if (!SERVER_LOG) {
    console.log('Log ingest disabled: set SERVER_LOG=/path/to/latest.log');
    return;
  }
  const file = path.resolve(SERVER_LOG);
  console.log('Ingesting server log:', file);

  let pos = 0;
  try {
    const st = fs.statSync(file);
    pos = st.size; // start tailing new data only
  } catch (_) {}

  function readNew() {
    try {
      const st = fs.statSync(file);
      if (st.size < pos) pos = 0; // rotated
      if (st.size > pos) {
        const stream = fs.createReadStream(file, { start: pos, end: st.size });
        let buf = '';
        stream.on('data', (chunk) => { buf += chunk.toString('utf8'); });
        stream.on('end', () => {
          pos = st.size;
          buf.split(/\r?\n/).forEach(line => line && handleLogLine(line));
        });
      }
    } catch (_) {}
  }

  try {
    fs.watch(path.dirname(file), { persistent: true }, (evt, fname) => {
      if (!fname || fname !== path.basename(file)) return;
      readNew();
    });
  } catch (_) { /* fs.watch not fatal */ }

  setInterval(readNew, 2000);
}

/* =========================
 * Static files (UI)
 * ========================= */
app.use('/', express.static(path.join(__dirname, 'public'), { fallthrough: true }));

/* =========================
 * Boot
 * ========================= */
app.listen(PORT, HOST, () => {
  console.log(`Panel on http://${HOST}:${PORT}`);
  loadSchedulesIntoCron();
  startLogIngest();

  // Optional background metrics snapshot
  if (METRICS_POLL_SEC > 0) {
    setInterval(() => { takeMetricsSnapshot().catch(()=>{}); }, Math.max(5, METRICS_POLL_SEC) * 1000);
  }
});
