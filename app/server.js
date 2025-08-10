// server.js - Express API + scheduler + importer + UI
const express = require('express');
const basicAuth = require('express-basic-auth');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const cron = require('node-cron');
const cronParser = require('cron-parser');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { run, get, all, initSchema } = require('./db');
const { sendRconCommand } = require('./rcon');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Auth (HTTP Basic) ----
const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'changeme';
const auth = basicAuth({ users: { [PANEL_USER]: PANEL_PASS }, challenge: true });

// ---- Utility helpers ----
const nowISO = () => new Date().toISOString();

async function upsertPlayer({ username, uuid = null, ip = null, seenAt = null }) {
  const first = seenAt || nowISO();
  const last = seenAt || nowISO();
  await run(
    `INSERT INTO players (username, uuid, first_seen, last_seen, last_ip)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET
       uuid = COALESCE(excluded.uuid, players.uuid),
       last_seen = excluded.last_seen,
       last_ip = COALESCE(excluded.last_ip, players.last_ip)`,
    [username, uuid, first, last, ip]
  );
  const row = await get(`SELECT id FROM players WHERE username=?`, [username]);
  if (ip) await run(`INSERT INTO player_ips (player_id, ip, seen_at) VALUES (?,?,?)`, [row.id, ip, last]).catch(() => {});
  return row.id;
}

async function openSession(playerId, loginISO) {
  const open = await get(`SELECT id FROM sessions WHERE player_id=? AND logout_time IS NULL`, [playerId]);
  if (!open) await run(`INSERT INTO sessions (player_id, login_time) VALUES (?,?)`, [playerId, loginISO]);
}

async function closeSession(playerId, logoutISO) {
  const s = await get(`SELECT id, login_time FROM sessions WHERE player_id=? AND logout_time IS NULL ORDER BY id DESC LIMIT 1`, [playerId]);
  if (s) {
    const dur = Math.max(0, Math.floor((Date.parse(logoutISO) - Date.parse(s.login_time)) / 1000));
    await run(`UPDATE sessions SET logout_time=?, duration=? WHERE id=?`, [logoutISO, dur, s.id]);
    await run(`UPDATE players SET total_playtime = COALESCE(total_playtime,0) + ? WHERE id=?`, [dur, playerId]);
  }
}

async function recordCommand(username, command, tsISO) {
  const p = await get(`SELECT id FROM players WHERE username=?`, [username]);
  if (!p) return;
  await run(`INSERT INTO commands (player_id, command, executed_at) VALUES (?,?,?)`, [p.id, command, tsISO]);
}

// ---- Online list via RCON ----
async function listOnline() {
  try {
    const out = await sendRconCommand('list uuids'); // "There are X of a max ...: name (uuid), ..."
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

// ---- Status: compute earliest next restart ----
async function computeNextRun() {
  const rows = await all(`SELECT cron FROM schedules WHERE enabled=1`);
  if (!rows.length) return { iso: null, seconds: null };
  let soonest = null;
  const now = new Date();
  for (const r of rows) {
    try {
      const it = cronParser.parseExpression(r.cron, { currentDate: now });
      const next = it.next().toDate();
      if (!soonest || next < soonest) soonest = next;
    } catch {}
  }
  return soonest ? { iso: soonest.toISOString(), seconds: Math.max(0, Math.floor((soonest - now) / 1000)) } : { iso: null, seconds: null };
}

// ---- Public status card ----
app.get('/api/status', async (_req, res) => {
  try {
    const players = await listOnline();
    const next = await computeNextRun();
    res.json({ online: true, player_count: players.length, next_restart_iso: next.iso, next_restart_seconds: next.seconds });
  } catch {
    res.json({ online: false, player_count: 0, next_restart_iso: null, next_restart_seconds: null });
  }
});

// ---- Admin APIs ----
app.get('/api/online', auth, async (_req, res) => {
  const players = await listOnline();
  res.json({ players, count: players.length });
});

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

app.get('/api/bans', auth, async (_req, res) => {
  try {
    const players = await sendRconCommand('banlist');
    const ips = await sendRconCommand('banlist ips');
    res.json({ players, ips });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/ban-presets', auth, async (_req, res) => {
  const rows = await all(`SELECT id,label,reason FROM ban_presets ORDER BY label`);
  res.json(rows);
});
app.post('/api/ban-presets', auth, async (req, res) => {
  const { label, reason } = req.body || {};
  if (!label || !reason) return res.status(400).json({ error: 'label/reason required' });
  await run(`INSERT OR REPLACE INTO ban_presets(label,reason) VALUES(?,?)`, [label, reason]);
  res.json({ ok: true });
});
app.post('/api/ban-ip', auth, async (req, res) => {
  const { ip, reason } = req.body || {};
  if (!ip) return res.status(400).json({ error: 'ip required' });
  try {
    const out = await sendRconCommand(`ban-ip ${ip} ${reason ? `"${reason}"` : ''}`.trim());
    res.json({ ok: true, out });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Broadcast presets
app.get('/api/broadcast-presets', auth, async (_req, res) => {
  const rows = await all(`SELECT id,label,message FROM broadcast_presets ORDER BY label`);
  res.json(rows);
});
app.post('/api/broadcast-presets', auth, async (req, res) => {
  const { label, message } = req.body || {};
  if (!label || !message) return res.status(400).json({ error: 'label/message required' });
  await run(`INSERT OR REPLACE INTO broadcast_presets(label,message) VALUES(?,?)`, [label, message]);
  res.json({ ok: true });
});

// Players
app.get('/api/players', auth, async (_req, res) => {
  const rows = await all(`SELECT * FROM players ORDER BY last_seen DESC`);
  res.json(rows);
});
app.get('/api/player/:id', auth, async (req, res) => {
  const id = req.params.id;
  const p = await get(`SELECT * FROM players WHERE id=?`, [id]);
  if (!p) return res.status(404).json({ error: 'not found' });
  const ips = await all(`SELECT ip, seen_at FROM player_ips WHERE player_id=? ORDER BY seen_at DESC`, [id]);
  const sessions = await all(`SELECT login_time, logout_time, duration FROM sessions WHERE player_id=? ORDER BY id DESC LIMIT 300`, [id]);
  const commands = await all(`SELECT command, executed_at FROM commands WHERE player_id=? ORDER BY id DESC LIMIT 300`, [id]);
  res.json({ player: p, ips, sessions, commands });
});

// Schedules
const jobs = new Map();
function clearJobs() { for (const [, j] of jobs) j.stop(); jobs.clear(); }

function scheduleWithWarnings(cronExpr) {
  return cron.schedule(cronExpr, async () => {
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
      await sendRconCommand('stop');
    } catch (e) {
      console.error('Scheduled restart error:', e.message || e);
    }
  });
}

async function loadSchedules() {
  clearJobs();
  const rows = await all(`SELECT * FROM schedules WHERE enabled=1`);
  for (const s of rows) {
    try {
      const job = scheduleWithWarnings(s.cron);
      jobs.set(s.id, job);
    } catch (e) {
      console.error('Invalid cron', s.cron, e.message || e);
    }
  }
}

app.get('/api/schedules', auth, async (_req, res) => {
  res.json(await all(`SELECT * FROM schedules ORDER BY id`));
});
app.post('/api/schedules', auth, async (req, res) => {
  const { cron: cronExpr, label, enabled = 1 } = req.body || {};
  if (!cronExpr) return res.status(400).json({ error: 'cron required' });
  await run(`INSERT INTO schedules (cron,label,enabled) VALUES (?,?,?)`, [cronExpr, label || null, enabled ? 1 : 0]);
  await loadSchedules();
  res.json({ ok: true });
});
app.post('/api/schedules/:id/toggle', auth, async (req, res) => {
  await run(`UPDATE schedules SET enabled = CASE enabled WHEN 1 THEN 0 ELSE 1 END WHERE id=?`, [req.params.id]);
  await loadSchedules();
  res.json({ ok: true });
});
app.delete('/api/schedules/:id', auth, async (req, res) => {
  await run(`DELETE FROM schedules WHERE id=?`, [req.params.id]);
  await loadSchedules();
  res.json({ ok: true });
});

// Emergency restart
app.post('/api/restart-now', auth, async (_req, res) => {
  try {
    await sendRconCommand('broadcast ⚠ Emergency restart now!');
    await sendRconCommand('stop');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---- Log importer & live tail (IPs, sessions, commands) ----
const LOG_PATH = process.env.LOG_PATH || path.join(process.env.MC_ROOT || '/root/mc-server-backup', 'logs/latest.log');

function parseLine(line) {
  // timestamp ends with "] " — keep whole line safer
  // Login with IP: "username[/1.2.3.4:xxxxx] logged in with entity id ..."
  let m = line.match(/\b([A-Za-z0-9_]{3,16})\s*\[\/([0-9a-fA-F\.:]+):\d+\]\s+logged in\b/);
  if (m) return { type: 'login', username: m[1], ip: m[2] };

  // UUID line: "UUID of player Name is 1234-..."
  m = line.match(/UUID of player\s+([A-Za-z0-9_]{3,16})\s+is\s+([0-9a-fA-F-]{8,})/i);
  if (m) return { type: 'uuid', username: m[1], uuid: m[2] };

  // Left / lost connection
  m = line.match(/\b([A-Za-z0-9_]{3,16})\b\s+(left the game|lost connection)/i);
  if (m) return { type: 'logout', username: m[1] };

  // Command: "Name issued server command: /something"
  m = line.match(/\b([A-Za-z0-9_]{3,16})\b\s+issued server command:\s+(.*)$/i);
  if (m) return { type: 'command', username: m[1], command: m[2] };

  return null;
}

async function applyEvent(ev, tsISO) {
  if (ev.type === 'login') {
    const id = await upsertPlayer({ username: ev.username, ip: ev.ip, seenAt: tsISO });
    await openSession(id, tsISO);
  } else if (ev.type === 'uuid') {
    await upsertPlayer({ username: ev.username, uuid: ev.uuid, seenAt: tsISO });
  } else if (ev.type === 'logout') {
    const p = await get(`SELECT id FROM players WHERE username=?`, [ev.username]);
    if (p) await closeSession(p.id, tsISO);
  } else if (ev.type === 'command') {
    await recordCommand(ev.username, ev.command, tsISO);
  }
}

async function importLogsFull() {
  try {
    if (!fs.existsSync(LOG_PATH)) return;
    const rl = readline.createInterface({ input: fs.createReadStream(LOG_PATH, { encoding: 'utf8' }) });
    for await (const line of rl) {
      const ev = parseLine(line);
      if (!ev) continue;
      // try to parse timestamp like "2023-08-10 12:34:56" if present
      const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
      const tsISO = tsMatch ? new Date(tsMatch[1].replace(' ', 'T') + 'Z').toISOString() : nowISO();
      await applyEvent(ev, tsISO);
    }
  } catch (e) {
    console.error('importLogsFull error:', e.message || e);
  }
}

function tailLogs() {
  if (!fs.existsSync(LOG_PATH)) return;
  let lastSize = fs.statSync(LOG_PATH).size;
  fs.watchFile(LOG_PATH, { interval: 1000 }, async (cur, prev) => {
    if (cur.size <= lastSize) { lastSize = cur.size; return; }
    const stream = fs.createReadStream(LOG_PATH, { start: lastSize, end: cur.size, encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream });
    for await (const chunk of rl) {
      const line = String(chunk);
      const ev = parseLine(line);
      if (!ev) continue;
      const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
      const tsISO = tsMatch ? new Date(tsMatch[1].replace(' ', 'T') + 'Z').toISOString() : nowISO();
      await applyEvent(ev, tsISO);
    }
    lastSize = cur.size;
  });
}

// ---- UI ----
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

// ---- Boot ----
(async () => {
  await initSchema();
  // initial import (non-blocking) + start tailer
  importLogsFull().then(() => tailLogs());
  await loadSchedules();

  const PORT = Number(process.env.PORT || 8080);
  const HOST = process.env.HOST || '0.0.0.0';
  app.listen(PORT, HOST, () => console.log(`Panel on http://${HOST}:${PORT}`));
})();
