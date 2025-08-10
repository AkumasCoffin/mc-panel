// app/server.js
// MC panel backend: log-driven presence, SQLite history, cron restarts

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { execFile, spawn } = require('child_process');
const cron = require('node-cron');
const cronParser = require('cron-parser');

const { db, run, get, all, initSchema } = require('./db');
const importer = require('./log_importer');

// ---------- ENV ----------
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);

const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'changeme';

// Prefer MC_SERVER_PATH (what install.sh writes), then fall back
const MC_SERVER_PATH = process.env.MC_SERVER_PATH || process.env.SERVER_DIR || '/root/mc-server-backup';
const SERVER_LOG = process.env.SERVER_LOG || path.join(MC_SERVER_PATH, 'logs/latest.log');
const BANNED_PLAYERS_JSON = process.env.BANNED_PLAYERS_JSON || path.join(MC_SERVER_PATH, 'banned-players.json');
const BANNED_IPS_JSON = process.env.BANNED_IPS_JSON || path.join(MC_SERVER_PATH, 'banned-ips.json');

// ---------- EXPRESS ----------
const app = express();
app.use(express.json());

// Basic Auth
function basicAuth(req, res, next) {
  const hdr = req.headers.authorization || '';
  if (!hdr.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="panel"');
    return res.status(401).send('Authentication required.');
  }
  const raw = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
  const i = raw.indexOf(':');
  const user = i >= 0 ? raw.slice(0, i) : raw;
  const pass = i >= 0 ? raw.slice(i + 1) : '';
  if (user === PANEL_USER && pass === PANEL_PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="panel"');
  return res.status(401).send('Authentication required.');
}

// Serve static UI
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, { index: false }));

// ---------- In-memory online tracking via log tail ----------
const playersByName = new Map(); // name -> record
let nextPlayerId = 1;

function nowIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
function ensurePlayer(name) {
  let p = playersByName.get(name);
  if (!p) {
    p = {
      id: nextPlayerId++,
      username: name,
      uuid: null,
      last_ip: null,
      first_seen: null,
      last_seen: null,
      total_playtime: 0, // seconds
      online: false,
      _login_ts: null
    };
    playersByName.set(name, p);
  }
  return p;
}
function parseLogLine(line) {
  // UUID line
  let m = line.match(/\bUUID of player ([\w.\-+]+) is ([0-9a-fA-F\-]{32,36})/);
  if (m) {
    const [, name, uuid] = m;
    ensurePlayer(name).uuid = (uuid || '').toLowerCase();
    return;
  }
  // login with IP
  m = line.match(/:\s*([A-Za-z0-9_\-\.]+)\[\/([0-9\.]+):\d+\]\s+logged in/i);
  if (m) {
    const [, name, ip] = m;
    const p = ensurePlayer(name);
    const ts = nowIso();
    p.last_ip = ip;
    p.first_seen = p.first_seen || ts;
    p.last_seen = ts;
    p._login_ts = Date.now();
    p.online =
