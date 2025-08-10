// db.js - SQLite helper with schema + promise API
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_FILE = path.join(__dirname, 'webgui.sqlite');
const db = new sqlite3.Database(DB_FILE);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

async function initSchema() {
  await run('PRAGMA foreign_keys = ON');
  await run(`
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      uuid TEXT,
      first_seen DATETIME,
      last_seen DATETIME,
      last_ip TEXT,
      total_playtime INTEGER DEFAULT 0
    )`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS ux_players_username ON players(username)`);

  await run(`
    CREATE TABLE IF NOT EXISTS player_ips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      ip TEXT NOT NULL,
      seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  await run(`CREATE INDEX IF NOT EXISTS ix_player_ips_player ON player_ips(player_id, ip)`);

  await run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      login_time DATETIME NOT NULL,
      logout_time DATETIME,
      duration INTEGER
    )`);
  await run(`CREATE INDEX IF NOT EXISTS ix_sessions_open ON sessions(player_id, logout_time)`);

  await run(`
    CREATE TABLE IF NOT EXISTS commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      command TEXT NOT NULL,
      executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

  await run(`
    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cron TEXT NOT NULL,
      label TEXT,
      enabled INTEGER DEFAULT 1
    )`);

  await run(`
    CREATE TABLE IF NOT EXISTS ban_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT UNIQUE,
      reason TEXT NOT NULL
    )`);

  await run(`
    CREATE TABLE IF NOT EXISTS broadcast_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT UNIQUE,
      message TEXT NOT NULL
    )`);
}

module.exports = { db, run, get, all, initSchema };
