// app/server.js
// MC RCON Panel – self-contained RCON (no external rcon deps)

'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const express = require('express');
const basicAuth = require('basic-auth');
try { require('dotenv').config(); } catch (_) { /* optional */ }

// ---------- Config ----------
const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'changeme';

const RCON_HOST = process.env.RCON_HOST || '127.0.0.1';
const RCON_PORT = Number(process.env.RCON_PORT || 25575);
const RCON_PASS = process.env.RCON_PASS || '';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);

// ---------- Tiny logger ----------
function log(...args){ console.log(new Date().toISOString(), ...args); }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// ---------- Raw RCON client (Source RCON protocol) ----------
/*
  Packet:
  int32 length (little endian, excludes this int32)
  int32 requestId
  int32 type (3=auth, 2=command, 0=resp)
  payload (ASCII)
  0x00
  0x00

  Returns { ok, out, err } and throws on TCP errors/timeouts.
*/
async function rconSend(command, {timeoutMs = 4000} = {}) {
  const socket = new net.Socket();
  const reqId = Math.floor(Math.random()*0x7fffffff);

  const connectP = new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.connect(RCON_PORT, RCON_HOST, resolve);
  });

  // connect with timeout
  await Promise.race([
    connectP,
    (async ()=>{ await sleep(timeoutMs); throw new Error('RCON connect timeout'); })()
  ]);

  function writePacket(id, type, payload) {
    const p = Buffer.from(payload || '', 'utf8');
    const len = 4 + 4 + p.length + 2; // id + type + payload + 2x null
    const buf = Buffer.alloc(4 + len);
    buf.writeInt32LE(len, 0);
    buf.writeInt32LE(id, 4);
    buf.writeInt32LE(type, 8);
    p.copy(buf, 12);
    buf.writeInt8(0, 12 + p.length);
    buf.writeInt8(0, 13 + p.length);
    socket.write(buf);
  }

  function readPacket() {
    return new Promise((resolve, reject) => {
      let needed = null, chunks = [];
      function onData(chunk){
        chunks.push(chunk);
        const buf = Buffer.concat(chunks);
        if (needed == null) {
          if (buf.length < 4) return;
          needed = 4 + buf.readInt32LE(0);
        }
        if (buf.length >= needed) {
          socket.off('data', onData);
          resolve(buf.subarray(0, needed));
        }
      }
      const t = setTimeout(() => {
        socket.off('data', onData);
        reject(new Error('RCON read timeout'));
      }, timeoutMs);
      socket.on('data', (c)=>{ clearTimeout(t); onData(c); });
    });
  }

  // auth
  writePacket(reqId, 3, RCON_PASS);
  const authResp = await readPacket();
  const authId = authResp.readInt32LE(4);
  if (authId !== reqId) {
    socket.destroy();
    return { ok:false, out:'', err:'RCON auth failed' };
  }

  // command
  writePacket(reqId, 2, command);
  const resp = await readPacket();

  // Some servers split responses; a very small merge:
  // If payload seems empty, try one more read quickly.
  let payload = resp.subarray(12, resp.length - 2).toString('utf8');
  if (!payload) {
    try {
      const resp2 = await Promise.race([readPacket(), sleep(150)]);
      if (resp2 && Buffer.isBuffer(resp2)) {
        payload = resp2.subarray(12, resp2.length - 2).toString('utf8');
      }
    } catch {}
  }

  socket.destroy();
  return { ok:true, out: payload, err: '' };
}

// ---------- Auth middleware ----------
function requireAuth(req, res, next){
  const cred = basicAuth(req);
  if (!cred || cred.name !== PANEL_USER || cred.pass !== PANEL_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="panel"');
    return res.status(401).send('Authentication required.');
  }
  next();
}

// ---------- App ----------
const app = express();
app.use(express.json());

// Serve the UI
const uiDir = path.join(__dirname, 'public');
app.use(express.static(uiDir));
app.get('/', (req,res) => {
  const file = path.join(uiDir, 'index.html');
  if (fs.existsSync(file)) return res.sendFile(file);
  res.status(200).send('MC RCON Panel\nUI file not found. Place index.html in /opt/mc-rcon-webgui/app/public.');
});

// All API needs basic auth
app.use('/api', requireAuth);

// Status
app.get('/api/status', async (req,res) => {
  try {
    // A very quick ping: many servers respond to an empty command with ""
    // Using "list" is reliable but heavier; we’ll just say "online" if we can auth.
    const auth = await rconSend(''); // no-op
    res.json({ online: !!auth.ok, next_restart_iso: null, next_restart_seconds: null });
  } catch (e) {
    res.json({ online: false, next_restart_iso: null, next_restart_seconds: null, error: String(e.message||e) });
  }
});

// Online (players + count)
app.get('/api/online', async (req,res) => {
  try {
    const { ok, out, err } = await rconSend('list');
    if (!ok) return res.status(502).json({ ok, out, err });

    // Forge servers typically: "There are 2 of a max of 50 players online: a, b"
    // Vanilla: "There are 0 of a max of 20 players online:"
    const names = [];
    let count = 0;

    const m = out.match(/There are\s+(\d+)\s+of a max/i);
    if (m) count = parseInt(m[1],10) || 0;

    const i = out.indexOf(':');
    if (i !== -1) {
      const list = out.slice(i+1).trim();
      if (list.length > 0) {
        list.split(',').forEach(n => {
          const nn = n.trim();
          if (nn) names.push({ username: nn });
        });
      }
    }
    res.json({ players: names, count });
  } catch (e) {
    res.status(502).json({ ok:false, err:String(e.message||e) });
  }
});

// Run any command
app.post('/api/command', async (req,res) => {
  const cmd = (req.body && req.body.command || '').trim();
  if (!cmd) return res.status(400).json({ ok:false, err:'Missing command' });
  try {
    const { ok, out, err } = await rconSend(cmd);
    res.json({ ok, out, err });
  } catch (e) {
    res.status(502).json({ ok:false, err:String(e.message||e) });
  }
});

// Simple health
app.get('/api/healthz', (_req,res)=>res.json({ok:true}));

app.listen(PORT, HOST, () => {
  log(`Panel on http://${HOST}:${PORT}`);
  if (!RCON_PASS) log('WARNING: RCON_PASS is empty.');
});
