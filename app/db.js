// db.js - SQLite helper with schema + promise API
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const rawFile = process.env.DB_FILE || path.join(__dirname, 'webgui.sqlite');
const DB_FILE = path.isAbsolute(rawFile) ? rawFile : path.join(__dirname, rawFile);

// Ensure directory exists
const dbDir = path.dirname(DB_FILE);
if (!fs.existsSync(dbDir)) {
  try {
    fs.mkdirSync(dbDir, { recursive: true });
  } catch (err) {
    console.error('[db] Failed to create database directory:', err.message);
    process.exit(1);
  }
}

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
  await run('PRAGMA journal_mode = WAL');
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
    CREATE TABLE IF NOT EXISTS panel_audit(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      payload TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

  await run(`
    CREATE TABLE IF NOT EXISTS ban_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT UNIQUE,
      reason TEXT NOT NULL
    )`);

  await run(`
    CREATE TABLE IF NOT EXISTS kick_presets (
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

  // System monitoring tables
  await run(`
    CREATE TABLE IF NOT EXISTS system_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cpu_usage REAL,
      cpu_cores INTEGER,
      memory_used INTEGER,
      memory_total INTEGER,
      memory_usage REAL,
      disk_used INTEGER,
      disk_total INTEGER,
      disk_usage REAL,
      network_rx INTEGER,
      network_tx INTEGER,
      network_rx_rate INTEGER,
      network_tx_rate INTEGER,
      uptime INTEGER,
      load_1 REAL,
      load_5 REAL,
      load_15 REAL,
      recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  await run(`CREATE INDEX IF NOT EXISTS ix_system_metrics_time ON system_metrics(recorded_at)`);

  // File monitoring tables
  await run(`
    CREATE TABLE IF NOT EXISTS banned_players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      uuid TEXT,
      reason TEXT,
      banned_by TEXT,
      banned_at DATETIME
    )`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS ux_banned_players_username ON banned_players(username)`);

  await run(`
    CREATE TABLE IF NOT EXISTS banned_ips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      reason TEXT,
      banned_by TEXT,
      banned_at DATETIME
    )`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS ux_banned_ips_ip ON banned_ips(ip)`);

  await run(`
    CREATE TABLE IF NOT EXISTS whitelist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      uuid TEXT
    )`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS ux_whitelist_username ON whitelist(username)`);

  await run(`
    CREATE TABLE IF NOT EXISTS operators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      uuid TEXT,
      level INTEGER DEFAULT 4,
      bypasses_player_limit INTEGER DEFAULT 0
    )`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS ux_operators_username ON operators(username)`);

  await run(`
    CREATE TABLE IF NOT EXISTS server_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_key TEXT NOT NULL,
      property_value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS ux_server_settings_key ON server_settings(property_key)`);

  await run(`
    CREATE TABLE IF NOT EXISTS file_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      change_type TEXT NOT NULL,
      data TEXT,
      changed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  await run(`CREATE INDEX IF NOT EXISTS ix_file_changes_time ON file_changes(changed_at)`);

  // Player analytics tables
  await run(`
    CREATE TABLE IF NOT EXISTS player_analytics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      unique_players INTEGER DEFAULT 0,
      total_sessions INTEGER DEFAULT 0,
      total_playtime INTEGER DEFAULT 0,
      peak_online INTEGER DEFAULT 0,
      avg_session_duration REAL DEFAULT 0
    )`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS ux_player_analytics_date ON player_analytics(date)`);

  // Online player count tracking for performance history
  await run(`
    CREATE TABLE IF NOT EXISTS metrics_online (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      online_count INTEGER DEFAULT 0,
      at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  await run(`CREATE INDEX IF NOT EXISTS ix_metrics_online_time ON metrics_online(at)`);
}

module.exports = { db, run, get, all, initSchema };
