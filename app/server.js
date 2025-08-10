// server.js — Minecraft RCON Panel (w/ SSE, perf, watchdog, audit, kick, SVG badge, oEmbed)
const path = require('path');
const fs = require('fs');
const express = require('express');
const basicAuth = require('basic-auth');
const { Rcon } = require('rcon-client');
const sqlite3 = require('sqlite3').verbose();
const cronParser = require('cron-parser');
require('dotenv').config({ path: path.join(__dirname, '.env') });

/* ===== Config ===== */
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);
const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'changeme';

const RCON_HOST = process.env.RCON_HOST || '127.0.0.1';
const RCON_PORT = Number(process.env.RCON_PORT || 25575);
const RCON_PASSWORD = process.env.RCON_PASSWORD || '';
const ALLOW_AUTORESTART = process.env.ALLOW_AUTORESTART === '1'; // optional safeguard

const DB_FILE = path.join(__dirname, 'webgui.sqlite');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ===== Auth (Basic) ===== */
function requireAuth(req, res, next) {
  const creds = basicAuth(req);
  if (!creds || creds.name !== PANEL_USER || creds.pass !== PANEL_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="MC Panel"');
    return res.status(401).send('Authentication required.');
  }
  req._panelUser = creds.name;
  next();
}

/* ===== DB ===== */
const db = new sqlite3.Database(DB_FILE);
const run = (sql, p=[]) => new Promise((ok, no)=>db.run(sql, p, function(e){ e?no(e):ok(this); }));
const all = (sql, p=[]) => new Promise((ok, no)=>db.all(sql, p, (e,r)=>e?no(e):ok(r)));
const get = (sql, p=[]) => new Promise((ok, no)=>db.get(sql, p, (e,r)=>e?no(e):ok(r)));
db.serialize(()=>{
  db.run(`PRAGMA journal_mode=WAL`);
  db.run(`CREATE TABLE IF NOT EXISTS players(
    id INTEGER PRIMARY KEY, username TEXT UNIQUE, uuid TEXT,
    first_seen DATETIME, last_seen DATETIME, last_ip TEXT, total_playtime INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS player_ips(
    id INTEGER PRIMARY KEY, player_id INTEGER NOT NULL, ip TEXT NOT NULL,
    seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(player_id, ip, date(seen_at)), FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sessions(
    id INTEGER PRIMARY KEY, player_id INTEGER NOT NULL,
    login_time DATETIME NOT NULL, logout_time DATETIME, duration INTEGER,
    FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE CASCADE
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS commands(
    id INTEGER PRIMARY KEY, player_id INTEGER, username TEXT, command TEXT,
    executed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(player_id) REFERENCES players(id) ON DELETE SET NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS schedules(
    id INTEGER PRIMARY KEY, cron TEXT NOT NULL, label TEXT, enabled INTEGER DEFAULT 1
  )`);
  // new tables created via migration script; indexes too
});

/* ===== RCON helpers & timing ===== */
async function withRconTimed(fn){
  const start = Date.now();
  const r = await Rcon.connect({ host: RCON_HOST, port: RCON_PORT, password: RCON_PASSWORD });
  try {
    const out = await fn(r);
    return { out, ms: Date.now() - start };
  } finally {
    r.end();
  }
}
async function sendRconCommand(command){
  const { out, ms } = await withRconTimed(r => r.send(command));
  return { out, ms };
}
async function listOnline(){
  try{
    const { out, ms } = await sendRconCommand('list uuids');
    const colon = out.indexOf(':');
    const part = colon >= 0 ? out.slice(colon+1).trim() : '';
    const players = !part ? [] : part.split(',').map(s=>{
      const t = s.trim(); const m = /(.*) \((.*)\)/.exec(t);
      return { username: m ? m[1] : t, uuid: m ? m[2] : null };
    }).filter(Boolean);
    return { players, latency: ms };
  }catch{
    return { players: [], latency: null, failed: true };
  }
}

/* ===== Audit helper ===== */
async function audit(req, action, detailsObj){
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
    const details = JSON.stringify(detailsObj||{});
    await run(`INSERT INTO audit(action, username, ip, details) VALUES(?,?,?,?)`, [action, req._panelUser||'', ip, details]);
  } catch {}
}

/* ===== Schedules: compute next run ===== */
async function computeNextRun(){
  const rows = await all(`SELECT cron FROM schedules WHERE enabled=1`);
  if (!rows.length) return { iso:null, seconds:null };
  let soonest=null; const now=new Date();
  for (const r of rows){
    try{ const it = cronParser.parseExpression(r.cron, { currentDate: now }); const next = it.next().toDate();
      if (!soonest || next < soonest) soonest=next;
    }catch{}
  }
  return soonest ? { iso: soonest.toISOString(), seconds: Math.max(0, Math.floor((soonest-now)/1000)) } : { iso:null, seconds:null };
}

/* ===== Clean bans parser ===== */
function parseBanLines(text){
  if (!text || typeof text!=='string') return [];
  return text.split('\n').map(s=>s.trim()).filter(s=>s && !/^There are \d+ ban\(s\):/i.test(s)).map(line=>{
    const m = /^(.+?) was banned by (.+?)(?::\s*(.*))?$/.exec(line);
    if (!m) return { raw: line };
    const [, target, by, reason] = m;
    return { target, by, reason: reason||'' };
  });
}

/* ===== Public status + SVG + oEmbed ===== */
app.get('/api/status', async (_req,res)=>{
  try{
    const { players } = await listOnline();
    const next = await computeNextRun();
    res.json({ online:true, player_count: players.length, next_restart_iso: next.iso, next_restart_seconds: next.seconds });
  }catch{
    res.json({ online:false, player_count:0, next_restart_iso:null, next_restart_seconds:null });
  }
});

app.get('/api/status/card.svg', async (req,res)=>{
  res.setHeader('Content-Type','image/svg+xml');
  res.setHeader('Cache-Control','no-cache');
  const { players } = await listOnline();
  const next = await computeNextRun();
  const text = next.seconds==null ? 'No schedule' : (next.seconds<60 ? `${next.seconds}s` : `${Math.floor(next.seconds/60)}m`);
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="360" height="60">
  <rect rx="10" ry="10" width="360" height="60" fill="#0d1320" stroke="#1f2a44"/>
  <text x="16" y="24" fill="#bcd0ff" font-family="Segoe UI,Roboto" font-size="14">Minecraft Server</text>
  <text x="16" y="46" fill="#e9f0ff" font-family="Segoe UI,Roboto" font-size="16">Online ${players.length} • Next restart: ${text}</text>
</svg>`;
  res.end(svg);
});

app.get('/api/status/oembed.json', async (req,res)=>{
  const { players } = await listOnline();
  const next = await computeNextRun();
  const title = `Online ${players.length} • Next restart ${next.seconds==null?'—':(next.seconds<60?next.seconds+'s':Math.floor(next.seconds/60)+'m')}`;
  res.json({
    version: "1.0",
    type: "link",
    provider_name: "MC Panel",
    provider_url: "",
    title
  });
});

/* ===== SSE (Server-Sent Events) ===== */
const sseClients = new Set();
app.get('/api/events', (req,res)=>{
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.write('retry: 2000\n\n');
  sseClients.add(res);
  req.on('close', ()=> sseClients.delete(res));
});
function ssePush(event, data){
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) { try { c.write(payload); } catch {} }
}

/* ===== Protected routes ===== */
app.use(requireAuth);

/* Online */
app.get('/api/online', async (req,res)=>{
  const { players, latency } = await listOnline();
  res.json({ players, count: players.length, latency });
});

/* Command */
app.post('/api/command', async (req,res)=>{
  const { command } = req.body||{};
  if (!command) return res.status(400).json({error:'command required'});
  try {
    const { out, ms } = await sendRconCommand(command);
    res.json({ ok:true, out, ms });
    audit(req,'command',{ command, out, ms });
    ssePush('command', { command, at: Date.now() });
  } catch(e){
    res.status(500).json({error:String(e.message||e)});
  }
});

/* Kick with reason */
app.post('/api/kick', async (req,res)=>{
  const { username, reason } = req.body||{};
  if (!username) return res.status(400).json({error:'username required'});
  try{
    const cmd = `kick ${username} ${reason?('"'+String(reason).replace(/"/g,'\\"')+'"'):''}`.trim();
    const { out, ms } = await sendRconCommand(cmd);
    res.json({ ok:true, out, ms });
    audit(req,'kick',{ username, reason, out, ms });
    ssePush('moderation', { type:'kick', username, reason, at: Date.now() });
  }catch(e){
    res.status(500).json({error:String(e.message||e)});
  }
});

/* Ban IP (existing) */
app.post('/api/ban-ip', async (req,res)=>{
  const { ip, reason } = req.body||{};
  if (!ip) return res.status(400).json({error:'ip required'});
  try{
    const { out, ms } = await sendRconCommand(`ban-ip ${ip}${reason?(' "'+String(reason).replace(/"/g,'\\"')+'"'):''}`);
    res.json({ ok:true, out, ms });
    audit(req,'ban-ip',{ ip, reason, out, ms });
    ssePush('moderation', { type:'ban-ip', ip, reason, at: Date.now() });
  }catch(e){
    res.status(500).json({error:String(e.message||e)});
  }
});

/* Clean bans */
app.get('/api/bans', async (req,res)=>{
  try{
    const p = await sendRconCommand('banlist');
    const i = await sendRconCommand('banlist ips');
    const players = parseBanLines(p.out);
    const ips = parseBanLines(i.out);
    res.json({ players, ips });
  }catch(e){
    res.status(500).json({error:String(e.message||e)});
  }
});

/* Schedules (unchanged, but audit + SSE) */
app.get('/api/schedules', async (_req,res)=>{
  res.json(await all('SELECT * FROM schedules ORDER BY id'));
});
app.post('/api/schedules', async (req,res)=>{
  const { cron, label, enabled=1 } = req.body||{};
  if (!cron) return res.status(400).json({error:'cron required'});
  const ret = await run('INSERT INTO schedules(cron,label,enabled) VALUES(?,?,?)',[cron,label||null,enabled?1:0]);
  res.json({ ok:true, id: ret.lastID });
  ssePush('schedules', { op:'add', id: ret.lastID, cron, label, enabled: !!enabled });
  audit(req,'schedule.add',{ id: ret.lastID, cron, label, enabled: !!enabled });
});
app.post('/api/schedules/:id/toggle', async (req,res)=>{
  await run('UPDATE schedules SET enabled = CASE enabled WHEN 1 THEN 0 ELSE 1 END WHERE id=?',[req.params.id]);
  res.json({ ok:true });
  ssePush('schedules', { op:'toggle', id: Number(req.params.id) });
  audit(req,'schedule.toggle',{ id:Number(req.params.id) });
});
app.delete('/api/schedules/:id', async (req,res)=>{
  await run('DELETE FROM schedules WHERE id=?',[req.params.id]);
  res.json({ ok:true });
  ssePush('schedules', { op:'delete', id: Number(req.params.id) });
  audit(req,'schedule.delete',{ id:Number(req.params.id) });
});

/* Players & details (unchanged, with small safety) */
app.get('/api/players', async (_req,res)=>{
  res.json(await all(`SELECT id, username, uuid, last_ip, first_seen, last_seen, total_playtime FROM players ORDER BY last_seen DESC NULLS LAST, username`));
});
app.get('/api/player/:id', async (req,res)=>{
  const id = Number(req.params.id)||0;
  const player = await get(`SELECT id, username, uuid, last_ip, first_seen, last_seen, total_playtime FROM players WHERE id=?`,[id]);
  if (!player) return res.status(404).json({error:'not found'});
  const ips = await all(`SELECT ip, seen_at FROM player_ips WHERE player_id=? ORDER BY seen_at DESC`,[id]);
  const sessions = await all(`SELECT login_time, logout_time, duration FROM sessions WHERE player_id=? ORDER BY login_time DESC LIMIT 200`,[id]);
  const commands = await all(`SELECT command, executed_at FROM commands WHERE player_id=? ORDER BY executed_at DESC LIMIT 200`,[id]);
  res.json({ player, ips, sessions, commands });
});

/* Perf API (graph data) */
app.get('/api/metrics/online', async (req,res)=>{
  // ?range=1h|6h|24h (default 1h)
  const range = String(req.query.range||'1h');
  const map = { '30m': '-30 minutes', '1h': '-1 hour', '6h':'-6 hours', '24h':'-1 day', '7d':'-7 days' };
  const win = map[range] || '-1 hour';
  const rows = await all(`SELECT strftime('%s',at) AS ts, online_count, rcon_latency_ms FROM metrics_online WHERE at >= datetime('now', ?) ORDER BY at`, [win]);
  res.json(rows.map(r=>({ t: Number(r.ts)*1000, c: r.online_count, l: r.rcon_latency_ms==null?null:Number(r.rcon_latency_ms) })));
});

/* Audit viewer (simple) */
app.get('/api/audit', async (req,res)=>{
  const rows = await all(`SELECT at, action, username, ip, details FROM audit ORDER BY id DESC LIMIT 200`);
  res.json(rows.map(r=>({ ...r, details: (()=>{ try { return JSON.parse(r.details||'{}'); } catch { return r.details; } })() })));
});

/* Frontend */
app.get('*', (_req,res)=> res.sendFile(path.join(__dirname,'public','index.html')));

/* ===== Watchdog + metrics sampler ===== */
let failureStreak = 0;
async function sample(){
  const { players, latency, failed } = await listOnline();
  // store sample
  await run(`INSERT INTO metrics_online(online_count, rcon_latency_ms) VALUES(?,?)`, [players.length, latency]);
  ssePush('metrics', { at: Date.now(), count: players.length, latency });

  // failure / lag detection
  if (failed) {
    failureStreak++;
    ssePush('watchdog', { type:'rcon-fail', streak: failureStreak, at: Date.now() });
    await run(`INSERT INTO audit(action, details) VALUES('watchdog.rcon-fail', ?)`, [JSON.stringify({ streak: failureStreak })]);
    if (ALLOW_AUTORESTART && failureStreak >= 3) {
      // optional restart attempt (requires systemctl permission)
      try {
        await run(`INSERT INTO audit(action, details) VALUES('watchdog.autorestart', '{"reason":"rcon-fail-3x"}')`);
        require('child_process').exec('systemctl restart minecraft.service');
        ssePush('watchdog', { type:'autorestart', reason: 'rcon-fail-3x', at: Date.now() });
      } catch {}
      failureStreak = 0;
    }
  } else {
    failureStreak = 0;
    // lag if latency high
    if (latency!=null && latency > 1500) {
      ssePush('watchdog', { type:'lag', latency, at: Date.now() });
      await run(`INSERT INTO audit(action, details) VALUES('watchdog.lag', ?)`, [JSON.stringify({ latency })]);
    }
  }
}
setInterval(sample, 10_000); // every 10s

/* Start */
app.listen(PORT, HOST, ()=> console.log(`Panel on http://${HOST}:${PORT}`));
