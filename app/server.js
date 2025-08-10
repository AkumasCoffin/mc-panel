// MC RCON WebGUI (fixed: dotenv, online cache, safer list parser, debug route)
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const path = require('path');
const basicAuth = require('basic-auth');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const { Rcon } = require('rcon-client');

// --- ENV & defaults ---
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);

const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'changeme';

const RCON_HOST = process.env.RCON_HOST || '127.0.0.1';
const RCON_PORT = Number(process.env.RCON_PORT || 25575);
const RCON_PASS = process.env.RCON_PASS || '';

const TRUST_PROXY = ['1', 'true', 'yes'].includes(String(process.env.TRUST_PROXY || '').toLowerCase());

// --- App & DB ---
const app = express();
if (TRUST_PROXY) app.set('trust proxy', true);
app.use(express.json());

const dbPath = path.join(__dirname, 'webgui.sqlite');
const db = new sqlite3.Database(dbPath);

// --- Auth middleware (HTTP Basic) ---
function auth(req, res, next) {
  const creds = basicAuth(req);
  if (!creds || creds.name !== PANEL_USER || creds.pass !== PANEL_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="panel"');
    return res.status(401).send('Authentication required.');
  }
  req.panelUser = creds.name;
  next();
}

// --- DB schema bootstrap ---
db.serialize(() => {
  db.run(`PRAGMA journal_mode=WAL`);
  db.run(`CREATE TABLE IF NOT EXISTS players(
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL,
    uuid TEXT,
    first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME,
    last_ip TEXT,
    total_playtime INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS player_ips(
    id INTEGER PRIMARY KEY,
    player_id INTEGER NOT NULL,
    ip TEXT,
    seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(player_id) REFERENCES players(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sessions(
    id INTEGER PRIMARY KEY,
    player_id INTEGER NOT NULL,
    login_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    logout_time DATETIME,
    duration INTEGER,
    FOREIGN KEY(player_id) REFERENCES players(id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS commands(
    id INTEGER PRIMARY KEY,
    player_id INTEGER,
    command TEXT,
    executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS schedules(
    id INTEGER PRIMARY KEY,
    cron TEXT NOT NULL,
    label TEXT,
    enabled INTEGER DEFAULT 1
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS broadcast_presets(
    id INTEGER PRIMARY KEY,
    label TEXT NOT NULL,
    message TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS ban_presets(
    id INTEGER PRIMARY KEY,
    label TEXT NOT NULL,
    reason TEXT NOT NULL
  )`);
});

// --- RCON helper (single-shot client) ---
async function sendRcon(cmd) {
  const c = await Rcon.connect({ host: RCON_HOST, port: RCON_PORT, password: RCON_PASS });
  try {
    const resp = await c.send(cmd);
    return resp || '';
  } finally {
    c.end();
  }
}

// --- List parsing & online cache (the fix) ---
function parseListOutput(raw) {
  // Examples expected:
  // "There are 0 of a max of 50 players online"
  // "There are 2 of a max of 50 players online: Name1, Name2"
  const res = { count: 0, names: [] };
  if (!raw || typeof raw !== 'string') return res;

  // Count
  const m = raw.match(/There are\s+(\d+)\s+of\s+a\s+max\s+of\s+(\d+)\s+players\s+online/i);
  if (m) res.count = Number(m[1] || 0);

  // Names
  const idx = raw.indexOf(':');
  if (idx !== -1) {
    const listPart = raw.slice(idx + 1).trim();
    if (listPart) {
      res.names = listPart.split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  return res;
}

let lastOnlineCache = { count: 0, players: [], at: new Date().toISOString() };

async function rconListRaw() {
  // Some servers use "list", some "list uuids" — try "list" first.
  const out = await sendRcon('list').catch(() => '');
  return out || '';
}

async function pollOnlineAndTrack() {
  try {
    const raw = await rconListRaw();
    const parsed = parseListOutput(raw);
    const names = parsed.names || [];

    lastOnlineCache = {
      count: parsed.count || names.length || 0,
      players: names.map(n => ({ username: n })),
      at: new Date().toISOString()
    };

    // Lightweight tracking (best-effort)
    if (names.length) {
      names.forEach(username => {
        db.run(
          `INSERT INTO players(username,last_seen) VALUES(?,CURRENT_TIMESTAMP)
           ON CONFLICT(username) DO UPDATE SET last_seen=CURRENT_TIMESTAMP`,
          [username]
        );
      });
    }
  } catch (e) {
    console.error('pollOnlineAndTrack:', e.message || e);
  }
}

// start poller once
if (!global.__poll_started__) {
  setInterval(pollOnlineAndTrack, 2000);
  global.__poll_started__ = true;
  pollOnlineAndTrack().catch(() => {});
}

// --- REST API ---

// Status (shows next restart if any)
let scheduledJobs = [];
function nextRunISO() {
  let next = null;
  for (const j of scheduledJobs) {
    if (!j.nextDates) continue;
    const d = j.nextDates().toDate();
    if (d && (!next || d < next)) next = d;
  }
  return next ? next.toISOString() : null;
}
function secondsUntil(iso) {
  if (!iso) return null;
  const diff = Math.floor((new Date(iso).getTime() - Date.now()) / 1000);
  return diff >= 0 ? diff : null;
}

app.get('/api/status', auth, async (req, res) => {
  // Online: use cache
  const online = lastOnlineCache.count > 0;
  const nextIso = nextRunISO();
  res.json({
    online,
    player_count: lastOnlineCache.count,
    next_restart_iso: nextIso,
    next_restart_seconds: secondsUntil(nextIso)
  });
});

// Online (cache ONLY; this is the main fix)
app.get('/api/online', auth, (req, res) => {
  res.json(lastOnlineCache);
});

// Commands
app.post('/api/command', auth, async (req, res) => {
  try {
    const { command } = req.body || {};
    if (!command || typeof command !== 'string') return res.status(400).json({ error: 'command required' });
    const out = await sendRcon(command);
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Bans (pretty)
function parseBanList(raw) {
  // Raw lines usually like:
  // "IP was banned by Server: Reason ..."
  // We'll try to extract target, by, reason, and no time (RCON doesn't expose timestamps)
  const out = [];
  const lines = (raw || '').split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^(.+?)\s+was\s+banned\s+by\s+([^:]+):\s*(.*)$/i);
    if (m) {
      out.push({ target: m[1], by: m[2], reason: m[3] || '' });
    }
  }
  return out;
}

app.get('/api/bans', auth, async (req, res) => {
  try {
    const ipRaw = await sendRcon('banlist ips').catch(() => '');
    const pRaw = await sendRcon('banlist players').catch(() => '');
    res.json({ ips: parseBanList(ipRaw), players: parseBanList(pRaw) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/ban-ip', auth, async (req, res) => {
  try {
    const { ip, reason } = req.body || {};
    if (!ip) return res.status(400).json({ error: 'ip required' });
    const cmd = reason ? `ban-ip ${ip} ${reason}` : `ban-ip ${ip}`;
    const out = await sendRcon(cmd);
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Broadcasts
app.post('/api/broadcast', auth, async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message required' });
    const out = await sendRcon(`say ${message}`);
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/broadcast-presets', auth, (req, res) => {
  db.all(`SELECT id,label,message FROM broadcast_presets ORDER BY id DESC`, (err, rows) => {
    if (err) return res.status(500).json({ error: String(err) });
    res.json(rows || []);
  });
});

app.post('/api/broadcast-presets', auth, (req, res) => {
  const { label, message } = req.body || {};
  if (!label || !message) return res.status(400).json({ error: 'label and message required' });
  db.run(`INSERT INTO broadcast_presets(label,message) VALUES(?,?)`, [label, message], function (err) {
    if (err) return res.status(500).json({ error: String(err) });
    res.json({ ok: true, id: this.lastID });
  });
});

// Ban presets
app.get('/api/ban-presets', auth, (req, res) => {
  db.all(`SELECT id,label,reason FROM ban_presets ORDER BY id DESC`, (err, rows) => {
    if (err) return res.status(500).json({ error: String(err) });
    res.json(rows || []);
  });
});
app.post('/api/ban-presets', auth, (req, res) => {
  const { label, reason } = req.body || {};
  if (!label || !reason) return res.status(400).json({ error: 'label and reason required' });
  db.run(`INSERT INTO ban_presets(label,reason) VALUES(?,?)`, [label, reason], function (err) {
    if (err) return res.status(500).json({ error: String(err) });
    res.json({ ok: true, id: this.lastID });
  });
});

// Schedules (cron)
function loadSchedules() {
  // Clear existing
  for (const j of scheduledJobs) try { j.stop && j.stop(); } catch {}
  scheduledJobs = [];

  db.all(`SELECT * FROM schedules WHERE enabled=1`, (err, rows) => {
    if (err || !rows) return;
    rows.forEach(row => {
      const task = cron.schedule(row.cron, async () => {
        try {
          // Broadcast lead-up: 10m, 5m, 1m, 30s, 5s
          const lead = [
            { secs: 600, msg: 'Server restart in 10 minutes.' },
            { secs: 300, msg: 'Server restart in 5 minutes.' },
            { secs: 60,  msg: 'Server restart in 1 minute.' },
            { secs: 30,  msg: 'Server restart in 30 seconds.' },
            { secs: 5,   msg: 'Server restart in 5 seconds.' }
          ];
          // Fire and forget timers relative to "now" (best effort)
          for (const l of lead) setTimeout(() => sendRcon(`say ${l.msg}`).catch(()=>{}), Math.max(0, (lead[0].secs - l.secs) * 1000));
          // Do the actual restart after 10 minutes
          setTimeout(async () => {
            await sendRcon('say Restarting now!');
            await sendRcon('stop');
          }, 600000);
        } catch (e) {
          console.error('scheduled restart error:', e);
        }
      }, { scheduled: true });
      task.nextDates = () => cron.schedule(row.cron, () => {}).nextDates(); // simple accessor
      scheduledJobs.push(task);
    });
  });
}
loadSchedules();

app.get('/api/schedules', auth, (req, res) => {
  db.all(`SELECT id,cron,label,enabled FROM schedules ORDER BY id`, (err, rows) => {
    if (err) return res.status(500).json({ error: String(err) });
    res.json(rows || []);
  });
});
app.post('/api/schedules', auth, (req, res) => {
  const { cron: spec, label } = req.body || {};
  if (!spec) return res.status(400).json({ error: 'cron required' });
  db.run(`INSERT INTO schedules(cron,label,enabled) VALUES(?,?,1)`,
    [spec, label || null],
    function (err) {
      if (err) return res.status(500).json({ error: String(err) });
      loadSchedules();
      res.json({ ok: true, id: this.lastID });
    });
});
app.post('/api/schedules/:id/toggle', auth, (req, res) => {
  db.run(`UPDATE schedules SET enabled = CASE enabled WHEN 1 THEN 0 ELSE 1 END WHERE id=?`,
    [req.params.id],
    function () {
      loadSchedules();
      res.json({ ok: true });
    });
});
app.delete('/api/schedules/:id', auth, (req, res) => {
  db.run(`DELETE FROM schedules WHERE id=?`, [req.params.id], function () {
    loadSchedules();
    res.json({ ok: true });
  });
});

// Emergency restart now
app.post('/api/restart-now', auth, async (req, res) => {
  try {
    await sendRcon('say ⚠ Emergency restart now!');
    await sendRcon('stop');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Players list (minimal; uses last_seen etc.)
app.get('/api/players', auth, (req, res) => {
  db.all(`SELECT id,username,uuid,last_ip,first_seen,last_seen,total_playtime FROM players ORDER BY last_seen DESC NULLS LAST, username`, (err, rows) => {
    if (err) return res.status(500).json({ error: String(err) });
    res.json(rows || []);
  });
});
app.get('/api/player/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  db.get(`SELECT id,username,uuid,last_ip,first_seen,last_seen,total_playtime FROM players WHERE id=?`, [id], (err, player) => {
    if (err) return res.status(500).json({ error: String(err) });
    if (!player) return res.status(404).json({ error: 'not found' });
    db.all(`SELECT ip,seen_at FROM player_ips WHERE player_id=? ORDER BY seen_at DESC`, [id], (e1, ips) => {
      if (e1) return res.status(500).json({ error: String(e1) });
      db.all(`SELECT command,executed_at FROM commands WHERE player_id=? ORDER BY executed_at DESC LIMIT 100`, [id], (e2, commands) => {
        if (e2) return res.status(500).json({ error: String(e2) });
        db.all(`SELECT login_time,logout_time,duration FROM sessions WHERE player_id=? ORDER BY login_time DESC`, [id], (e3, sessions) => {
          if (e3) return res.status(500).json({ error: String(e3) });
          res.json({ player, ips, sessions, commands });
        });
      });
    });
  });
});

// Debug: inspect list parsing and cache
app.get('/api/debug/list-parse', auth, async (req, res) => {
  try {
    const raw = await rconListRaw();
    const parsed = parseListOutput(raw);
    res.json({ raw, parsed, cache: lastOnlineCache });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// UI
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

// Start
app.listen(PORT, HOST, () => {
  console.log(`Panel on http://${HOST}:${PORT}`);
});
