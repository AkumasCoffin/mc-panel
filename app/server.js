// app/server.js
// MC RCON Panel - minimal, stable server with tidy APIs and one RCON connection.
//
// What this file does:
// - Loads config from env (or .env if present)
// - Keeps ONE shared RCON connection with backoff, queued commands (prevents log spam)
// - Serves UI from /app/public/index.html
// - Basic auth for all /api/* routes
// - Endpoints:
//     GET  /api/status      -> { online, player_count, next_restart_iso, next_restart_seconds }
//     GET  /api/online      -> { count, players:[{username, uuid}] }
//     POST /api/command     -> { ok, out }
//     GET  /api/bans        -> { players:[...], ips:[...] }
//     GET  /api/players     -> rows from DB (if present) else []
//     GET  /api/player/:id  -> { player, ips, sessions, commands } (DB-backed if present)
//
// Notes:
// - Works with rcon-client ^5.x (e.g. 5.2.4). If your package.json was pointing to ^6 or 4.3.6, set it to "^5.2.4".
// - If SQLite tables aren't present, player-related endpoints just return empty lists (no crashes).
// - UI lives in /app/public (index.html must be there).

"use strict";

const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const basicAuth = require("basic-auth");

// Optional .env
try { require("dotenv").config(); } catch (_) {}

const {
  PANEL_USER = "admin",
  PANEL_PASS = "changeme",
  HOST = "0.0.0.0",
  PORT = "8080",

  RCON_HOST = "127.0.0.1",
  RCON_PORT = "25575",
  RCON_PASS = "password",

  // Optional: for “next restart” if you wire a scheduler later
  NEXT_RESTART_ISO = "",   // e.g. "2025-08-10T12:00:00Z"
  NEXT_RESTART_SEC = "",   // e.g. "3600" (seconds)

  // Optional: path to latest.log (not strictly required in this file)
  SERVER_LOG = "",

  // Queue pacing (ms) to avoid RCON floods
  RCON_MIN_GAP_MS = "900",
} = process.env;

// ---- RCON client (5.x) -----------------------------------------------------
const { Rcon } = require("rcon-client");

// Shared RCON instance + simple queue so we don't hammer the server.
let rcon = null;
let rconConnecting = false;
let lastSentAt = 0;
const queue = [];
let processing = false;

async function ensureRcon() {
  if (rcon && rcon.connected) return rcon;
  if (rconConnecting) {
    // wait until connection finishes
    await new Promise((res) => setTimeout(res, 200));
    return ensureRcon();
  }
  rconConnecting = true;
  try {
    const client = new Rcon({
      host: RCON_HOST,
      port: Number(RCON_PORT),
      password: RCON_PASS,
      // keepAlive: true is default; we’ll also handle errors
    });
    client.on("end", () => {
      // allow reconnect on demand
      rcon = null;
    });
    client.on("error", (e) => {
      // don’t spam console; brief note is fine
      console.error("[RCON] error:", String(e && e.message || e));
    });
    await client.connect();
    rcon = client;
    return rcon;
  } finally {
    rconConnecting = false;
  }
}

function enqueue(cmd) {
  return new Promise((resolve) => {
    queue.push({ cmd, resolve });
    if (!processing) processQueue();
  });
}

async function processQueue() {
  if (processing) return;
  processing = true;
  while (queue.length) {
    const { cmd, resolve } = queue.shift();
    try {
      const now = Date.now();
      const gap = Number(RCON_MIN_GAP_MS) || 900;
      const wait = Math.max(0, gap - (now - lastSentAt));
      if (wait) await new Promise((r) => setTimeout(r, wait));
      const client = await ensureRcon();
      lastSentAt = Date.now();
      const out = await client.send(cmd);
      resolve({ ok: true, out: out || "" });
    } catch (e) {
      resolve({ ok: false, out: String(e && e.message || e) });
    }
  }
  processing = false;
}

// Helper: send one RCON command safely.
async function rconSend(cmd) {
  return enqueue(cmd);
}

// ---- Express app ------------------------------------------------------------
const app = express();
app.use(express.json());

// Basic auth for /api/*
function requireAuth(req, res, next) {
  const creds = basicAuth(req);
  if (!creds || creds.name !== PANEL_USER || creds.pass !== PANEL_PASS) {
    res.set("WWW-Authenticate", 'Basic realm="panel"');
    return res.status(401).send("Authentication required.");
  }
  next();
}

// ---- Parsers ----------------------------------------------------------------
function parseListOutput(text) {
  // typical: "There are 2 of a max of 50 players online: name1, name2"
  // or "There are 0 of a max of 50 players online"
  const line = (text || "").trim();
  let count = 0;
  let names = [];

  const m = line.match(/There\s+are\s+(\d+)\s+of\s+a\s+max\s+of\s+\d+\s+players\s+online(?::\s*(.*))?/i);
  if (m) {
    count = parseInt(m[1], 10);
    if (m[2]) {
      names = m[2].split(",").map(s => s.trim()).filter(Boolean);
    }
  } else if (/There are 0/i.test(line)) {
    count = 0;
  }
  // Ensure players is array of objects: {username, uuid}
  const players = names.map(n => ({ username: n, uuid: null }));
  return { count, players };
}

function cleanBanList(text, type) {
  // Vanilla-ish outputs:
  // "There are X ban(s):"
  // "<name|ip> was banned by <by>: <reason>."
  // Or sometimes without ":" if operator set custom message
  const out = [];
  const lines = (text || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^There are \d+ ban\(s\):/i.test(line)) continue;

    // Try match: "foo was banned by Server: Reason text"
    // Also accept IP targets.
    let m = line.match(/^(.+?)\s+was\s+banned\s+by\s+(.+?)(?::\s*(.*))?$/i);
    if (m) {
      const target = (m[1] || "").trim();
      const by = (m[2] || "").trim();
      const reason = (m[3] || "").trim() || "No reason provided";
      out.push({
        type,
        target,
        username: type === "player" ? target : null,
        uuid: null,
        last_ip: type === "ip" ? target : null,
        by,
        reason,
        banned_at: null
      });
    }
  }
  return out;
}

// ---- API --------------------------------------------------------------------
app.get("/api/status", requireAuth, async (req, res) => {
  // We'll use LIST to infer "online" and latency.
  const t0 = Date.now();
  const resp = await rconSend("list");
  const latency = Date.now() - t0;

  let online = false;
  let player_count = 0;
  if (resp.ok) {
    const parsed = parseListOutput(resp.out);
    online = true;               // If RCON answered, server is up
    player_count = parsed.count;
  }

  // Optional restart data if provided by scheduler elsewhere.
  const next_restart_iso = NEXT_RESTART_ISO || null;
  const next_restart_seconds = NEXT_RESTART_SEC ? Number(NEXT_RESTART_SEC) : null;

  res.json({ online, player_count, rcon_latency_ms: latency, next_restart_iso, next_restart_seconds });
});

app.get("/api/online", requireAuth, async (req, res) => {
  const resp = await rconSend("list");
  if (!resp.ok) return res.json({ count: 0, players: [] });
  const parsed = parseListOutput(resp.out);
  // Make sure we NEVER send “undefined ()”
  const players = parsed.players.map(p => ({
    username: p.username || "(unknown)",
    uuid: p.uuid || null
  }));
  res.json({ count: parsed.count || players.length, players });
});

app.post("/api/command", requireAuth, async (req, res) => {
  const { command } = req.body || {};
  if (!command || typeof command !== "string") {
    return res.status(400).json({ ok: false, out: "Missing command string" });
  }
  const out = await rconSend(command);
  res.json(out);
});

app.get("/api/bans", requireAuth, async (req, res) => {
  const rvPlayers = await rconSend("banlist players");
  const rvIps = await rconSend("banlist ips");
  const players = rvPlayers.ok ? cleanBanList(rvPlayers.out, "player") : [];
  const ips = rvIps.ok ? cleanBanList(rvIps.out, "ip") : [];
  res.json({ players, ips });
});

// ---- Optional DB-backed endpoints ------------------------------------------
const sqlite3 = require("sqlite3").verbose();
const DB_PATH = path.join(__dirname, "webgui.sqlite");

function hasTable(db, table) {
  return new Promise((resolve) => {
    db.get(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      [table],
      (err, row) => resolve(!err && !!row)
    );
  });
}

async function openDbIfAny() {
  try {
    if (!fs.existsSync(DB_PATH)) return null;
    const db = new sqlite3.Database(DB_PATH);
    // We’ll check for a basic “players” table to decide if usable
    const ok = await hasTable(db, "players");
    if (!ok) { db.close(); return null; }
    return db;
  } catch {
    return null;
  }
}

app.get("/api/players", requireAuth, async (req, res) => {
  const db = await openDbIfAny();
  if (!db) return res.json([]);
  db.all(
    `SELECT id, username, uuid, first_seen, last_seen, total_playtime, last_ip
     FROM players
     ORDER BY COALESCE(last_seen, first_seen) DESC NULLS LAST`,
    (err, rows) => {
      if (err) return res.json([]);
      // Hard guard against null username to stop UI “undefined ()”
      rows = (rows || []).map(r => ({
        id: r.id,
        username: r.username || "(unknown)",
        uuid: r.uuid || null,
        first_seen: r.first_seen || null,
        last_seen: r.last_seen || null,
        total_playtime: r.total_playtime || 0,
        last_ip: r.last_ip || null
      }));
      res.json(rows);
    }
  );
});

app.get("/api/player/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const db = await openDbIfAny();
  if (!db || !Number.isFinite(id)) {
    return res.json({ player: null, ips: [], sessions: [], commands: [] });
  }
  db.get(
    "SELECT id, username, uuid, first_seen, last_seen, total_playtime, last_ip FROM players WHERE id=?",
    [id],
    (err, player) => {
      if (err || !player) return res.json({ player: null, ips: [], sessions: [], commands: [] });
      player.username = player.username || "(unknown)";
      player.uuid = player.uuid || null;
      player.first_seen = player.first_seen || null;
      player.last_seen = player.last_seen || null;
      player.total_playtime = player.total_playtime || 0;
      player.last_ip = player.last_ip || null;

      // Collect the three related lists if tables exist; otherwise return empty arrays.
      const out = { player, ips: [], sessions: [], commands: [] };
      const maybe = async (tbl, sql, args) =>
        (await hasTable(db, tbl))
          ? new Promise((resolve) => db.all(sql, args, (_, rows) => resolve(rows || [])))
          : [];

      Promise.all([
        maybe("player_ips", "SELECT ip, seen_at FROM player_ips WHERE player_id=? ORDER BY seen_at DESC LIMIT 200", [id]),
        maybe("sessions", "SELECT login_time, logout_time, duration FROM sessions WHERE player_id=? ORDER BY COALESCE(logout_time, login_time) DESC LIMIT 200", [id]),
        maybe("commands", "SELECT executed_at, command FROM commands WHERE player_id=? ORDER BY executed_at DESC LIMIT 200", [id]),
      ]).then(([ips, sessions, cmds]) => {
        out.ips = ips;
        out.sessions = sessions.map(s => ({
          login_time: s.login_time || null,
          logout_time: s.logout_time || null,
          duration: s.duration || 0
        }));
        out.commands = cmds;
        res.json(out);
        db.close();
      });
    }
  );
});

// ---- Static UI --------------------------------------------------------------
const PUB = path.join(__dirname, "public");
app.use(express.static(PUB, { index: "index.html", extensions: ["html"] }));

// Fallback: serve index if root hit
app.get("/", (req, res) => {
  const f = path.join(PUB, "index.html");
  if (fs.existsSync(f)) return res.sendFile(f);
  res.status(500).send("UI file not found. Place index.html in /opt/mc-rcon-webgui/app/public");
});

// ---- Start ------------------------------------------------------------------
const server = http.createServer(app);
server.listen(Number(PORT), HOST, () => {
  console.log(`Panel on http://${HOST}:${PORT}`);
});
