'use strict';

/* === Imports & Setup === */
const path = require('path');
const fs = require('fs');
const express = require('express');
const basicAuth = require('basic-auth');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '.env') });

const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const { Rcon } = require('rcon-client');

/* === Env === */
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);

const RCON_HOST = process.env.RCON_HOST || '127.0.0.1';
const RCON_PORT = Number(process.env.RCON_PORT || 25575);
const RCON_PASS = process.env.RCON_PASS || '';

const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'changeme';

const DB_FILE = process.env.DB_FILE || 'webgui.sqlite';

/* === DB === */
const db = new sqlite3.Database(path.join(__dirname, DB_FILE));
db.serialize(() => {
  db.run(`PRAGMA foreign_keys=ON`);

  db.run(`CREATE TABLE IF NOT EXISTS players(
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE,
    uuid TEXT,
    first_seen DATETIME,
    last_seen DATETIME,
    last_ip TEXT,
    total_playtime INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS player_ips(
    id INTEGER PRIMARY KEY,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    ip TEXT NOT NULL,
    seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS ix_player_ips_player ON player_ips(player_id, ip)`);

  db.run(`CREATE TABLE IF NOT EXISTS sessions(
    id INTEGER PRIMARY KEY,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    login_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    logout_time DATETIME,
    duration INTEGER
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS ix_sessions_open ON sessions(player_id, logout_time)`);

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

  db.run(`CREATE TABLE IF NOT EXISTS audit(
    id INTEGER PRIMARY KEY,
    action TEXT NOT NULL,
    username TEXT,
    ip TEXT,
    details TEXT,
    at DATETIME DEFAULT CURRENT_TIMESTAMP
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

  db.run(`CREATE TABLE IF NOT EXISTS bans_log(
    id INTEGER PRIMARY KEY,
    target TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('ip','player')),
    by_user TEXT,
    reason TEXT,
    banned_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS ix_bans_log_target ON bans_log(target)`);
});

/* === Express === */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

/* === Basic Auth === */
function auth(req, res, next) {
  const creds = basicAuth(req);
  if (!creds || creds.name !== PANEL_USER || creds.pass !== PANEL_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="panel"');
    return res.status(401).send('Authentication required.');
  }
  req.user = creds.name;
  next();
}

/* === RCON: pooled single connection + queue (prevents spam in MC logs) === */
let rcon = null;
let rconReady = false;
let connecting = false;
const queue = [];
let lastSend = 0;
const MIN_GAP_MS = 200; // slight throttle between commands

async function ensureRcon() {
  if (rconReady) return;
  if (connecting) {
    // wait until current connect finishes
    await new Promise(r => setTimeout(r, 100));
    if (rconReady) return;
  }
  connecting = true;
  try {
    if (rcon) {
      try { await rcon.end(); } catch {}
      rcon = null;
    }
    rcon = new Rcon({
      host: RCON_HOST,
      port: RCON_PORT,
      password: RCON_PASS
    });
    rcon.on('end', () => { rconReady = false; });
    await rcon.connect();
    rconReady = true;
  } finally {
    connecting = false;
  }
}

async function sendRconCommand(cmd) {
  // push into queue so multiple callers don't open/close connections continuously
  return new Promise((resolve, reject) => {
    queue.push({ cmd, resolve, reject });
    drain();
  });
}

let draining = false;
async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const { cmd, resolve, reject } = queue.shift();
      try {
        await ensureRcon();
        const gap = Date.now() - lastSend;
        if (gap < MIN_GAP_MS) await new Promise(r => setTimeout(r, MIN_GAP_MS - gap));
        const out = await rcon.send(cmd);
        lastSend = Date.now();
        resolve((out || '').toString());
      } catch (e) {
        rconReady = false;
        reject(e);
      }
    }
  } finally {
    draining = false;
  }
}

/* === Helpers === */
function audit(action, details, req) {
  const username = (req && req.user) || null;
  const ip = (req && (req.headers['x-forwarded-for'] || req.socket.remoteAddress)) || null;
  db.run(`INSERT INTO audit(action, username, ip, details) VALUES(?,?,?,?)`, [
    action, username, ip, details ? JSON.stringify(details) : null
  ]);
}

function parseListOutput(out) {
  // typical outputs:
  // - "There are 0 of a max of 20 players online."
  // - or for list: "There are X/X players online: name1, name2"
  const names = [];
  const m = out.match(/online:\s*(.*)$/i);
  if (m && m[1] && !/^\s*$/.test(m[1])) {
    m[1].split(',').forEach(n => {
      const nn = n.trim();
      if (nn) names.push({ username: nn });
    });
  }
  const countMatch = out.match(/There are\s+(\d+)\s*\/?\s*(\d+)?\s*players/i);
  const count = countMatch ? Number(countMatch[1]) : names.length;
  return { players: names, count };
}

/* === Status & Online === */
app.get('/api/status', auth, async (req, res) => {
  try {
    const out = await sendRconCommand('list').catch(() => '');
    const online = !!out;
    // next restart: compute from enabled schedules (take the next occurrence)
    db.all(`SELECT id, cron, label FROM schedules WHERE enabled=1`, async (err, rows) => {
      if (err || !rows || !rows.length) {
        return res.json({ online, player_count: online ? parseListOutput(out).count : 0, next_restart_iso: null, next_restart_seconds: null });
      }
      const now = new Date();
      let soonest = null;
      for (const r of rows) {
        // node-cron can't compute next run directly; we approximate by sampling the next hour
        // instead, use cron-parser in future; for now: say "cron string" in frontend or compute rough next in 60m window
        // Here, we’ll return null and let frontend show "None" unless we calculated something previously.
      }
      res.json({
        online,
        player_count: online ? parseListOutput(out).count : 0,
        next_restart_iso: null,
        next_restart_seconds: null
      });
    });
  } catch (e) {
    res.json({ online: false, player_count: 0, next_restart_iso: null, next_restart_seconds: null });
  }
});

app.get('/api/online', auth, async (req, res) => {
  try {
    const out = await sendRconCommand('list');
    const parsed = parseListOutput(out || '');
    res.json({ players: parsed.players, count: parsed.count });
  } catch (e) {
    res.json({ players: [], count: 0 });
  }
});

/* === Commands === */
app.post('/api/command', auth, async (req, res) => {
  try {
    const command = String(req.body.command || '').trim();
    if (!command) return res.status(400).json({ error: 'Missing command' });
    const out = await sendRconCommand(command);
    audit('command', { command, out }, req);
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/* === Broadcasts (custom quick message) === */
app.post('/api/broadcast', auth, async (req, res) => {
  try {
    const message = String(req.body.message || '').trim();
    if (!message) return res.status(400).json({ error: 'Missing message' });
    const out = await sendRconCommand(`say ${message}`);
    audit('broadcast', { message, out }, req);
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/* === Presets === */
app.get('/api/broadcast-presets', auth, (req, res) => {
  db.all(`SELECT id, label, message FROM broadcast_presets ORDER BY id DESC`, [], (e, rows) => {
    if (e) return res.json([]);
    res.json(rows || []);
  });
});
app.post('/api/broadcast-presets', auth, (req, res) => {
  const { label, message } = req.body || {};
  if (!label || !message) return res.status(400).json({ error: 'Missing fields' });
  db.run(`INSERT INTO broadcast_presets(label,message) VALUES(?,?)`, [label, message], function () {
    audit('broadcast_preset.add', { id: this.lastID, label }, req);
    res.json({ ok: true, id: this.lastID });
  });
});

app.get('/api/ban-presets', auth, (req, res) => {
  db.all(`SELECT id, label, reason FROM ban_presets ORDER BY id DESC`, [], (e, rows) => {
    if (e) return res.json([]);
    res.json(rows || []);
  });
});
app.post('/api/ban-presets', auth, (req, res) => {
  const { label, reason } = req.body || {};
  if (!label || !reason) return res.status(400).json({ error: 'Missing fields' });
  db.run(`INSERT INTO ban_presets(label,reason) VALUES(?,?)`, [label, reason], function () {
    audit('ban_preset.add', { id: this.lastID, label }, req);
    res.json({ ok: true, id: this.lastID });
  });
});

/* === Ban IP & Ban Player (with logging) === */
app.post('/api/ban-ip', auth, async (req, res) => {
  try {
    const ip = String(req.body.ip || '').trim();
    const reason = String(req.body.reason || '').trim();
    if (!ip) return res.status(400).json({ error: 'Missing ip' });
    const cmd = reason ? `ban-ip ${ip} ${reason}` : `ban-ip ${ip}`;
    const out = await sendRconCommand(cmd);
    db.run(`INSERT INTO bans_log(target,type,by_user,reason) VALUES(?,?,?,?)`, [ip, 'ip', req.user || 'Panel', reason || null]);
    audit('ban-ip', { ip, reason, out }, req);
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/ban', auth, async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const reason = String(req.body.reason || '').trim();
    if (!username) return res.status(400).json({ error: 'Missing username' });
    const cmd = reason ? `ban ${username} ${reason}` : `ban ${username}`;
    const out = await sendRconCommand(cmd);
    db.run(`INSERT INTO bans_log(target,type,by_user,reason) VALUES(?,?,?,?)`, [username, 'player', req.user || 'Panel', reason || null]);
    audit('ban', { username, reason, out }, req);
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/* === Enriched Bans === */
app.get('/api/bans', auth, async (req, res) => {
  try {
    const [playersRaw, ipsRaw] = await Promise.all([
      sendRconCommand('banlist players').catch(() => 'There are 0 ban(s):'),
      sendRconCommand('banlist ips').catch(() => 'There are 0 ban(s):')
    ]);

    const parseList = (raw) => {
      const lines = (raw || '').split('\n').map(l => l.trim()).filter(Boolean);
      if (!lines.length || /There are 0 ban/.test(lines[0])) return [];
      return lines.slice(1).map(line => {
        const m = line.match(/^(.*?) was banned by (.*?):\s*(.*)$/);
        if (m) {
          const target = m[1];
          const by = m[2];
          const reason = m[3] || null;
          const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(target);
          return { target, by, reason, type: isIp ? 'ip' : 'player' };
        }
        return { target: line, by: null, reason: null, type: 'unknown' };
      });
    };

    const playersParsed = parseList(playersRaw);
    const ipsParsed = parseList(ipsRaw);

    const enrich = (entry) => new Promise((resolve) => {
      const out = { ...entry, banned_at: null, last_seen: null, last_ip: null, uuid: null, playtime_seconds: null, username: entry.type === 'player' ? entry.target : null };

      db.get(`SELECT banned_at, by_user, reason FROM bans_log WHERE target=? ORDER BY id DESC LIMIT 1`, [entry.target], (err, row) => {
        if (!err && row) {
          out.banned_at = row.banned_at;
          if (row.by_user) out.by = row.by_user;
          if (row.reason) out.reason = row.reason;
        }

        if (entry.type === 'player') {
          db.get(`SELECT id, username, uuid, last_seen, total_playtime FROM players WHERE username=?`, [entry.target], (e1, p) => {
            if (p) {
              out.username = p.username;
              out.uuid = p.uuid || null;
              out.last_seen = p.last_seen || null;
              out.playtime_seconds = p.total_playtime || 0;
              db.get(`SELECT ip FROM player_ips WHERE player_id=? ORDER BY seen_at DESC LIMIT 1`, [p.id], (e2, iprow) => {
                if (iprow) out.last_ip = iprow.ip;
                return resolve(out);
              });
            } else {
              return resolve(out);
            }
          });
        } else if (entry.type === 'ip') {
          db.get(`
            SELECT p.username, p.uuid, p.last_seen, p.total_playtime
            FROM player_ips i
            JOIN players p ON p.id = i.player_id
            WHERE i.ip=?
            ORDER BY i.seen_at DESC
            LIMIT 1
          `, [entry.target], (e3, row2) => {
            if (row2) {
              out.username = row2.username;
              out.uuid = row2.uuid || null;
              out.last_seen = row2.last_seen || null;
              out.playtime_seconds = row2.total_playtime || 0;
            }
            out.last_ip = entry.target;
            return resolve(out);
          });
        } else {
          return resolve(out);
        }
      });
    });

    const enrichedPlayers = await Promise.all(playersParsed.map(enrich));
    const enrichedIps = await Promise.all(ipsParsed.map(enrich));

    res.json({ players: enrichedPlayers, ips: enrichedIps });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/* === Players basic list (for table) === */
app.get('/api/players', auth, (req, res) => {
  db.all(`SELECT id, username, uuid, last_ip, first_seen, last_seen, total_playtime FROM players ORDER BY last_seen DESC NULLS LAST, username ASC`, [], (e, rows) => {
    if (e) return res.json([]);
    res.json(rows || []);
  });
});
app.get('/api/player/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  db.get(`SELECT id, username, uuid, last_ip, first_seen, last_seen, total_playtime FROM players WHERE id=?`, [id], (e, player) => {
    if (!player) return res.status(404).json({ error: 'Not found' });
    db.all(`SELECT ip, seen_at FROM player_ips WHERE player_id=? ORDER BY seen_at DESC LIMIT 50`, [id], (e1, ips) => {
      db.all(`SELECT login_time, logout_time, duration FROM sessions WHERE player_id=? ORDER BY login_time DESC LIMIT 50`, [id], (e2, sessions) => {
        db.all(`SELECT command, executed_at FROM commands WHERE player_id=? ORDER BY executed_at DESC LIMIT 50`, [id], (e3, commands) => {
          res.json({ player, ips: ips || [], sessions: sessions || [], commands: commands || [] });
        });
      });
    });
  });
});

/* === Schedules (cron) === */
let scheduledJobs = [];
function loadSchedules() {
  // clear old
  scheduledJobs.forEach(j => j.stop());
  scheduledJobs = [];

  db.all(`SELECT id, cron, label, enabled FROM schedules`, [], (e, rows) => {
    if (e || !rows) return;
    for (const r of rows) {
      if (!r.enabled) continue;
      try {
        const job = cron.schedule(r.cron, async () => {
          // broadcast countdowns: 10m, 5m, 1m, 30s, 5s would require pre-scheduling.
          // Simpler: at the moment of schedule, we do the final broadcasts & stop.
          try {
            await sendRconCommand(`say [Restart] Server restarting now (scheduled: ${r.label || r.cron})`);
            audit('schedule.fire', { id: r.id, label: r.label, cron: r.cron });
            await sendRconCommand('stop');
          } catch (e) {
            audit('schedule.error', { id: r.id, error: String(e.message || e) });
          }
        });
        scheduledJobs.push(job);
      } catch (e) {
        audit('schedule.badcron', { id: r.id, cron: r.cron });
      }
    }
  });
}
loadSchedules();

app.get('/api/schedules', auth, (req, res) => {
  db.all(`SELECT id, cron, label, enabled FROM schedules ORDER BY id DESC`, [], (e, rows) => {
    if (e) return res.json([]);
    res.json(rows || []);
  });
});
app.post('/api/schedules', auth, (req, res) => {
  const { cron: cronExpr, label } = req.body || {};
  if (!cronExpr) return res.status(400).json({ error: 'Missing cron' });
  db.run(`INSERT INTO schedules(cron,label,enabled) VALUES(?,?,1)`, [cronExpr, label || null], function () {
    audit('schedule.add', { id: this.lastID, cron: cronExpr, label }, req);
    loadSchedules();
    res.json({ ok: true, id: this.lastID });
  });
});
app.post('/api/schedules/:id/toggle', auth, (req, res) => {
  db.run(`UPDATE schedules SET enabled = CASE enabled WHEN 1 THEN 0 ELSE 1 END WHERE id=?`, [req.params.id], function () {
    audit('schedule.toggle', { id: req.params.id }, req);
    loadSchedules();
    res.json({ ok: true });
  });
});
app.delete('/api/schedules/:id', auth, (req, res) => {
  db.run(`DELETE FROM schedules WHERE id=?`, [req.params.id], function () {
    audit('schedule.delete', { id: req.params.id }, req);
    loadSchedules();
    res.json({ ok: true });
  });
});

/* === Emergency Restart === */
app.post('/api/restart-now', auth, async (req, res) => {
  try {
    await sendRconCommand('say [Emergency] Restarting now!');
    audit('restart.emergency', {}, req);
    await sendRconCommand('stop');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/* === Simple Audit dump === */
app.get('/api/audit', auth, (req, res) => {
  db.all(`SELECT id, action, username, ip, details, at FROM audit ORDER BY id DESC LIMIT 500`, [], (e, rows) => {
    if (e) return res.json([]);
    res.json(rows || []);
  });
});

/* === UI (single file) === */
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

/* === Start === */
app.listen(PORT, HOST, () => {
  console.log(`Panel on http://${HOST}:${PORT}`);
});
