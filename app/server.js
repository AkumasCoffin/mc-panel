// app/server.js
const express = require('express');
const basicAuth = require('express-basic-auth');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const { Rcon } = require('rcon-client');
const readline = require('readline');

// ====== Config ======
const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'password';
const RCON_HOST = process.env.RCON_HOST || '127.0.0.1';
const RCON_PORT = parseInt(process.env.RCON_PORT) || 25575;
const RCON_PASS = process.env.RCON_PASS || '';
const SERVER_LOG = process.env.SERVER_LOG || '/opt/minecraft/server/logs/latest.log';
const METRICS_POLL_SEC = parseInt(process.env.METRICS_POLL_SEC) || 10;
const DB_FILE = path.join(__dirname, 'webgui.sqlite');
const HOST = process.env.HOST || '0.0.0.0';
const PORT = parseInt(process.env.PORT) || 8080;

// ====== Database ======
const db = new sqlite3.Database(DB_FILE);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    uuid TEXT,
    last_ip TEXT,
    first_seen TEXT,
    last_seen TEXT,
    total_playtime INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS ips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER,
    ip TEXT,
    seen_at TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER,
    login_time TEXT,
    logout_time TEXT,
    duration INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER,
    command TEXT,
    executed_at TEXT
  )`);
});

// ====== RCON Connection ======
let rcon;
async function connectRcon() {
  try {
    rcon = await Rcon.connect({
      host: RCON_HOST,
      port: RCON_PORT,
      password: RCON_PASS
    });
    console.log('RCON connected');
  } catch (e) {
    console.error('RCON connection failed:', e);
    setTimeout(connectRcon, 5000);
  }
}
connectRcon();

// ====== Express App ======
const app = express();
app.use(express.json());
app.use(basicAuth({
  users: { [PANEL_USER]: PANEL_PASS },
  challenge: true
}));
app.use(express.static(path.join(__dirname, 'public')));

// ====== API ======
app.get('/api/players', (req, res) => {
  db.all(`SELECT * FROM players`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/player/:id', (req, res) => {
  const id = req.params.id;
  db.get(`SELECT * FROM players WHERE id = ?`, [id], (err, player) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!player) return res.status(404).json({ error: 'Not found' });

    db.all(`SELECT * FROM ips WHERE player_id = ? ORDER BY seen_at DESC`, [id], (err, ips) => {
      if (err) return res.status(500).json({ error: err.message });
      db.all(`SELECT * FROM sessions WHERE player_id = ? ORDER BY login_time DESC`, [id], (err, sessions) => {
        if (err) return res.status(500).json({ error: err.message });
        db.all(`SELECT * FROM commands WHERE player_id = ? ORDER BY executed_at DESC`, [id], (err, commands) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ player, ips, sessions, commands });
        });
      });
    });
  });
});

app.post('/api/command', async (req, res) => {
  const cmd = req.body.command;
  if (!cmd) return res.status(400).json({ error: 'No command' });
  try {
    const out = await rcon.send(cmd);
    res.json({ out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ====== Log Parsing ======
function watchLogs() {
  if (!fs.existsSync(SERVER_LOG)) {
    console.error(`Log file not found: ${SERVER_LOG}`);
    return;
  }
  const stream = fs.createReadStream(SERVER_LOG, { encoding: 'utf8', flags: 'r' });
  const rl = readline.createInterface({ input: stream });

  rl.on('line', line => {
    parseLogLine(line);
  });

  fs.watchFile(SERVER_LOG, () => {
    const s = fs.createReadStream(SERVER_LOG, { encoding: 'utf8' });
    const rl2 = readline.createInterface({ input: s });
    rl2.on('line', line => parseLogLine(line));
  });
}

function parseLogLine(line) {
  // Player join
  let m = line.match(/\[Server thread\/INFO\]: (\w+) joined the game/);
  if (m) {
    const username = m[1];
    const ipMatch = line.match(/\(([\d\.]+):\d+\)/);
    const ip = ipMatch ? ipMatch[1] : null;
    const now = new Date().toISOString();

    db.get(`SELECT * FROM players WHERE username = ?`, [username], (err, row) => {
      if (!row) {
        db.run(`INSERT INTO players (username, last_ip, first_seen, last_seen) VALUES (?, ?, ?, ?)`,
          [username, ip, now, now]);
      } else {
        db.run(`UPDATE players SET last_ip = ?, last_seen = ? WHERE id = ?`, [ip, now, row.id]);
      }
    });

    if (ip) {
      db.run(`INSERT INTO ips (player_id, ip, seen_at)
              SELECT id, ?, ? FROM players WHERE username = ?`,
        [ip, now, username]);
    }

    db.run(`INSERT INTO sessions (player_id, login_time)
            SELECT id, ? FROM players WHERE username = ?`, [now, username]);
  }

  // Player leave
  m = line.match(/\[Server thread\/INFO\]: (\w+) left the game/);
  if (m) {
    const username = m[1];
    const now = new Date();
    db.get(`SELECT id FROM players WHERE username = ?`, [username], (err, row) => {
      if (!row) return;
      db.get(`SELECT * FROM sessions WHERE player_id = ? AND logout_time IS NULL ORDER BY login_time DESC LIMIT 1`, [row.id], (err, sess) => {
        if (sess) {
          const dur = Math.floor((now - new Date(sess.login_time)) / 1000);
          db.run(`UPDATE sessions SET logout_time = ?, duration = ? WHERE id = ?`,
            [now.toISOString(), dur, sess.id]);
          db.run(`UPDATE players SET total_playtime = total_playtime + ? WHERE id = ?`, [dur, row.id]);
        }
      });
    });
  }

  // Commands
  m = line.match(/\[Server thread\/INFO\]: (\w+) issued server command: (.+)/);
  if (m) {
    const username = m[1];
    const cmd = m[2];
    const now = new Date().toISOString();
    db.run(`INSERT INTO commands (player_id, command, executed_at)
            SELECT id, ?, ? FROM players WHERE username = ?`, [cmd, now, username]);
  }
}

watchLogs();

// ====== Start Server ======
app.listen(PORT, HOST, () => {
  console.log(`Panel running on http://${HOST}:${PORT}`);
});
