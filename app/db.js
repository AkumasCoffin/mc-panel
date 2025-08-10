const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database(process.env.DB_FILE || './mc_data.sqlite3');

// Create tables if they don't exist
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS players (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        uuid TEXT,
        first_seen DATETIME,
        last_seen DATETIME,
        total_playtime INTEGER DEFAULT 0,
        last_ip TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS player_ips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER,
        ip TEXT,
        seen_at DATETIME,
        FOREIGN KEY(player_id) REFERENCES players(id)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER,
        login_time DATETIME,
        logout_time DATETIME,
        duration INTEGER,
        FOREIGN KEY(player_id) REFERENCES players(id)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id INTEGER,
        command TEXT,
        executed_at DATETIME,
        FOREIGN KEY(player_id) REFERENCES players(id)
    )`);
});

module.exports = db;
