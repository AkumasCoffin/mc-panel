const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const basicAuth = require('express-basic-auth');
const { spawn } = require('child_process');
const cron = require('node-cron');
const { sendRconCommand } = require('./rcon');
const db = require('./db');
const { importLogs } = require('./log_importer');

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const auth = basicAuth({
  users: { [process.env.PANEL_USER || 'admin']: process.env.PANEL_PASS || 'changeme' },
  challenge: true,
  authorizeAsync: false
});

// --- one-time import on boot ---
importLogs().catch(()=>{});

// --- Helpers ---
async function listOnline() {
  try {
    const out = await sendRconCommand('list uuids');
    // "There are X of a max of Y players online: name1 (uuid), name2 (uuid)"
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

async function logRestart(kind, reason) {
  const players = await listOnline();
  const online_count = players.length;
  db.run('INSERT INTO commands(command, executed_at) VALUES(?, datetime("now"))', [`[restart:${kind}:${reason}]`]);
  // store restart in sessions-like table? We reuse commands log as history note to keep schema small.
  return online_count;
}

// --- Scheduled restarts storage in memory + DB table schedules ---
db.run('CREATE TABLE IF NOT EXISTS schedules (id INTEGER PRIMARY KEY AUTOINCREMENT, cron TEXT NOT NULL, label TEXT, enabled INTEGER DEFAULT 1)');

const jobs = new Map();
function loadSchedules() {
  for (const [, j] of jobs) j.stop();
  jobs.clear();
  db.all('SELECT * FROM schedules WHERE enabled=1', (e, rows) => {
    if (e || !rows) return;
    rows.forEach(s => {
      const job = cron.schedule(s.cron, async () => {
        try {
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
          await logRestart('scheduled', s.label || '');
          await sendRconCommand('stop');
        } catch (err) {
          console.error('Scheduled restart error:', err.message || err);
        }
      });
      jobs.set(s.id, job);
    });
  });
}
loadSchedules();

// --- Public status card ---
app.get('/api/status', async (req, res) => {
  const players = await listOnline();
  db.get('SELECT cron,label FROM schedules WHERE enabled=1 LIMIT 1', (e, row) => {
    res.json({ online: true, player_count: players.length, next_restart: row ? row.cron : null, label: row ? row.label : null });
  });
});

// --- Admin APIs (auth protected) ---
app.get('/api/online', auth, async (req, res) => {
  const players = await listOnline();
  res.json({ players, count: players.length });
});

app.post('/api/broadcast', auth, async (req, res) => {
  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });
  const out = await sendRconCommand(`broadcast ${message}`).catch(e => String(e));
  res.json({ ok: true, out });
});

app.post('/api/command', auth, async (req, res) => {
  const { command } = req.body || {};
  if (!command) return res.status(400).json({ error: 'command required' });
  const out = await sendRconCommand(command).catch(e => String(e));
  res.json({ ok: true, out });
});

app.post('/api/ban-ip', auth, async (req, res) => {
  const { ip, reason } = req.body || {};
  if (!ip) return res.status(400).json({ error: 'ip required' });
  const cmd = `ban-ip ${ip} ${reason ? ('"' + reason + '"') : ''}`.trim();
  const out = await sendRconCommand(cmd).catch(e => String(e));
  res.json({ ok: true, out });
});

// Players + details
app.get('/api/players', auth, (req, res) => {
  db.all('SELECT * FROM players ORDER BY last_seen DESC', (e, rows) => res.json(rows || []));
});
app.get('/api/player/:id', auth, (req, res) => {
  const id = req.params.id;
  db.get('SELECT * FROM players WHERE id=?', [id], (e, p) => {
    if (e || !p) return res.status(404).json({ error: 'not found' });
    db.all('SELECT ip, seen_at FROM player_ips WHERE player_id=? ORDER BY seen_at DESC', [id], (e2, ips) => {
      db.all('SELECT login_time, logout_time, duration FROM sessions WHERE player_id=? ORDER BY id DESC LIMIT 200', [id], (e3, sess) => {
        db.all('SELECT command, executed_at FROM commands WHERE player_id=? ORDER BY id DESC LIMIT 200', [id], (e4, cmds) => {
          res.json({ player: p, ips: ips || [], sessions: sess || [], commands: cmds || [] });
        });
      });
    });
  });
});

// Schedules
app.get('/api/schedules', auth, (req, res) => {
  db.all('SELECT * FROM schedules ORDER BY id', (e, rows) => res.json(rows || []));
});
app.post('/api/schedules', auth, (req, res) => {
  const { cron, label, enabled = 1 } = req.body || {};
  if (!cron) return res.status(400).json({ error: 'cron required' });
  db.run('INSERT INTO schedules(cron,label,enabled) VALUES(?,?,?)', [cron, label || null, enabled ? 1 : 0], function () {
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

// Emergency restart (short broadcast)
app.post('/api/restart-now', auth, async (req, res) => {
  try {
    await sendRconCommand('broadcast ⚠ Emergency restart now!');
    await logRestart('emergency', 'button');
    await sendRconCommand('stop');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// UI
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

const PORT = Number(process.env.PORT || 8080);
const HOST = '127.0.0.1';
app.listen(PORT, HOST, () => console.log(`Panel on http://${HOST}:${PORT}`));
