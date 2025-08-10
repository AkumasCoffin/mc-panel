const express = require('express');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const basicAuth = require('express-basic-auth');
const cron = require('node-cron');
const cronParser = require('cron-parser');
const { sendRconCommand } = require('./rcon');
const db = require('./db');
const { importLogs } = require('./log_importer');

// Load .env explicitly from this folder regardless of WorkingDirectory
dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Auth (HTTP Basic) ----
const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'changeme';
const auth = basicAuth({
  users: { [PANEL_USER]: PANEL_PASS },
  challenge: true
});

// ---- DB bootstrap (extra tables) ----
db.run(`CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cron TEXT NOT NULL,
  label TEXT,
  enabled INTEGER DEFAULT 1
)`);

db.run(`CREATE TABLE IF NOT EXISTS ban_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT UNIQUE,
  reason TEXT NOT NULL
)`);

db.run(`CREATE TABLE IF NOT EXISTS broadcast_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT UNIQUE,
  message TEXT NOT NULL
)`);

// ---- Helpers ----
async function listOnline() {
  try {
    const out = await sendRconCommand('list uuids');
    const idx = out.indexOf(':');
    const names = idx > -1 ? out.slice(idx + 1).trim() : '';
    const arr = names ? names.split(',').map(s => s.trim()).filter(Boolean) : [];
    return arr.map(p => {
      const m = /(.*) \((.*)\)/.exec(p);
      return { username: m ? m[1] : p, uuid: m ? m[2] : null };
    });
  } catch {
    return [];
  }
}

function getNextRunISO() {
  // compute earliest next run across enabled schedules (or null)
  return new Promise((resolve) => {
    db.all('SELECT cron FROM schedules WHERE enabled=1', (e, rows) => {
      if (e || !rows || rows.length === 0) return resolve(null);
      let soonest = null;
      const now = new Date();
      for (const r of rows) {
        try {
          const it = cronParser.parseExpression(r.cron, { currentDate: now });
          const next = it.next().toDate();
          if (!soonest || next < soonest) soonest = next;
        } catch {}
      }
      resolve(soonest ? soonest.toISOString() : null);
    });
  });
}

// importer (history from logs) once on boot
importLogs().catch(()=>{});

// ---- Scheduled restarts (with auto-broadcasts) ----
const jobs = new Map();
function clearJobs() { for (const [,j] of jobs) j.stop(); jobs.clear(); }

function scheduleWithWarnings(cronExpr, label) {
  return cron.schedule(cronExpr, async () => {
    try {
      // 10m, 5m, 1m, 30s, 5s warnings then stop
      await sendRconCommand('broadcast Server restarting in 10 minutes!');
      await new Promise(r => setTimeout(r, 5 * 60 * 1000));
      await sendRconCommand('broadcast Server restarting in 5 minutes!');
      await new Promise(r => setTimeout(r, 4 * 60 * 1000));
      await sendRconCommand('broadcast Server restarting in 1 minute!');
      await new Promise(r => setTimeout(r, 30 * 1000));
      await sendRconCommand('broadcast Server restarting in 30 seconds!');
      await new Promise(r => setTimeout(r, 25 * 1000));
      await sendRconCommand('broadcast Server restarting in 5 seconds!');
      await new Promise(r => setTimeout(r, 5 * 1000));
      await sendRconCommand('stop');
    } catch (e) {
      console.error('Scheduled restart error:', e.message || e);
    }
  });
}

function loadSchedules() {
  clearJobs();
  db.all('SELECT * FROM schedules WHERE enabled=1', (e, rows) => {
    if (e || !rows) return;
    rows.forEach(s => {
      try {
        const job = scheduleWithWarnings(s.cron, s.label || '');
        jobs.set(s.id, job);
      } catch (err) {
        console.error('Invalid cron', s.cron, err.message || err);
      }
    });
  });
}
loadSchedules();

// ---- Public status card ----
app.get('/api/status', async (req, res) => {
  try {
    const players = await listOnline();
    const nextISO = await getNextRunISO();
    res.json({ online: true, player_count: players.length, next_restart: nextISO });
  } catch {
    res.json({ online: false, player_count: 0, next_restart: null });
  }
});

// ---- Admin APIs ----

// RCON: online
app.get('/api/online', auth, async (req, res) => {
  const players = await listOnline();
  res.json({ players, count: players.length });
});

// RCON: broadcast
app.post('/api/broadcast', auth, async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });
  try {
    const out = await sendRconCommand(`broadcast ${message}`);
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Broadcast presets
app.get('/api/broadcast-presets', auth, (req, res) => {
  db.all('SELECT id,label,message FROM broadcast_presets ORDER BY label', (e, rows) => res.json(rows || []));
});
app.post('/api/broadcast-presets', auth, (req, res) => {
  const { label, message } = req.body || {};
  if (!label || !message) return res.status(400).json({ error: 'label/message required' });
  db.run('INSERT OR REPLACE INTO broadcast_presets(label,message) VALUES(?,?)', [label, message], function () {
    res.json({ ok: true, id: this.lastID });
  });
});

// RCON: generic command
app.post('/api/command', auth, async (req, res) => {
  const { command } = req.body || {};
  if (!command) return res.status(400).json({ error: 'command required' });
  try {
    const out = await sendRconCommand(command);
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Bans: fetch players + IPs
app.get('/api/bans', auth, async (req, res) => {
  try {
    const players = await sendRconCommand('banlist');
    const ips = await sendRconCommand('banlist ips');
    res.json({ players, ips });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Ban presets
app.get('/api/ban-presets', auth, (req, res) => {
  db.all('SELECT id,label,reason FROM ban_presets ORDER BY label', (e, rows) => res.json(rows || []));
});
app.post('/api/ban-presets', auth, (req, res) => {
  const { label, reason } = req.body || {};
  if (!label || !reason) return res.status(400).json({ error: 'label/reason required' });
  db.run('INSERT OR REPLACE INTO ban_presets(label,reason) VALUES(?,?)', [label, reason], function () {
    res.json({ ok: true, id: this.lastID });
  });
});

// Ban IP
app.post('/api/ban-ip', auth, async (req, res) => {
  const { ip, reason } = req.body || {};
  if (!ip) return res.status(400).json({ error: 'ip required' });
  const cmd = `ban-ip ${ip} ${reason ? ('"' + reason + '"') : ''}`.trim();
  try {
    const out = await sendRconCommand(cmd);
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Players list / details (from DB populated by importer)
app.get('/api/players', auth, (req, res) => {
  db.all('SELECT * FROM players ORDER BY last_seen DESC', (e, rows) => res.json(rows || []));
});
app.get('/api/player/:id', auth, (req, res) => {
  const id = req.params.id;
  db.get('SELECT * FROM players WHERE id=?', [id], (e, p) => {
    if (e || !p) return res.status(404).json({ error: 'not found' });
    db.all('SELECT ip, seen_at FROM player_ips WHERE player_id=? ORDER BY seen_at DESC', [id], (e2, ips) => {
      db.all('SELECT login_time, logout_time, duration FROM sessions WHERE player_id=? ORDER BY id DESC LIMIT 300', [id], (e3, sess) => {
        db.all('SELECT command, executed_at FROM commands WHERE player_id=? ORDER BY id DESC LIMIT 300', [id], (e4, cmds) => {
          res.json({ player: p, ips: ips || [], sessions: sess || [], commands: cmds || [] });
        });
      });
    });
  });
});

// Schedules (CRUD)
app.get('/api/schedules', auth, (req, res) => {
  db.all('SELECT * FROM schedules ORDER BY id', (e, rows) => res.json(rows || []));
});
app.post('/api/schedules', auth, (req, res) => {
  const { cron: cronExpr, label, enabled = 1 } = req.body || {};
  if (!cronExpr) return res.status(400).json({ error: 'cron required' });
  db.run('INSERT INTO schedules(cron,label,enabled) VALUES(?,?,?)', [cronExpr, label || null, enabled ? 1 : 0], function () {
    loadSchedules();
    res.json({ ok: true, id: this.lastID });
  });
});
app.post('/api/schedules/:id/toggle', auth, (req, res) => {
  db.run('UPDATE schedules SET enabled = CASE enabled WHEN 1 THEN 0 ELSE 1 END WHERE id=?', [req.params.id], () => {
    loadSchedules();
    res.json({ ok: true });
  });
});
app.delete('/api/schedules/:id', auth, (req, res) => {
  db.run('DELETE FROM schedules WHERE id=?', [req.params.id], () => {
    loadSchedules();
    res.json({ ok: true });
  });
});

// Emergency restart now
app.post('/api/restart-now', auth, async (req, res) => {
  try {
    await sendRconCommand('broadcast ⚠ Emergency restart now!');
    await sendRconCommand('stop');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// UI
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

// Start
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => console.log(`Panel on http://${HOST}:${PORT}`));
