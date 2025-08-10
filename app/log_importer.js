const fs = require('fs');
const zlib = require('zlib');
const readline = require('readline');
const path = require('path');
const db = require('./db');

const LOG_DIR = path.dirname(process.env.MC_SERVER_PATH ? path.join(process.env.MC_SERVER_PATH, 'logs/latest.log') : '/root/mc-server-backup/logs/latest.log');
const LATEST_LOG = process.env.MC_SERVER_PATH ? path.join(process.env.MC_SERVER_PATH, 'logs/latest.log') : '/root/mc-server-backup/logs/latest.log';

const RX_JOIN = /\]:\s*([A-Za-z0-9_]{3,16})\[\/(\d+\.\d+\.\d+\.\d+):\d+\]\s+logged in/;
const RX_LEAVE = /\]:\s*([A-Za-z0-9_]{3,16}) lost connection/;
const RX_CMD = /\]:\s*([A-Za-z0-9_]{3,16}) issued server command:\s*(.*)$/;
const RX_UUID = /UUID of player ([A-Za-z0-9_]{3,16}) is ([0-9a-f-]{32,36})/i;

async function lineHandler(line) {
  let m;
  if ((m = RX_UUID.exec(line))) {
    // Optional: store UUID mapping if you want to enrich later
  } else if ((m = RX_JOIN.exec(line))) {
    const username = m[1], ip = m[2];
    const now = new Date().toISOString();
    await new Promise((res, rej) => {
      db.get('SELECT * FROM players WHERE username=?', [username], (e, p) => {
        if (e) return rej(e);
        if (!p) {
          db.run('INSERT INTO players(username, first_seen, last_seen, last_ip) VALUES(?,?,?,?)', [username, now, now, ip], function (e2) {
            if (e2) return rej(e2);
            const pid = this.lastID;
            db.run('INSERT INTO player_ips(player_id, ip, seen_at) VALUES(?,?,?)', [pid, ip, now], err => err ? rej(err) : res());
            db.run('INSERT INTO sessions(player_id, login_time) VALUES(?,?)', [pid, now], ()=>{});
          });
        } else {
          db.run('UPDATE players SET last_seen=?, last_ip=? WHERE id=?', [now, ip, p.id], ()=>{});
          db.run('INSERT INTO player_ips(player_id, ip, seen_at) VALUES(?,?,?)', [p.id, ip, now], ()=>{});
          db.run('INSERT INTO sessions(player_id, login_time) VALUES(?,?)', [p.id, now], err => err ? rej(err) : res());
        }
      });
    });
  } else if ((m = RX_LEAVE.exec(line))) {
    const username = m[1];
    const now = new Date().toISOString();
    await new Promise((res, rej) => {
      db.get('SELECT * FROM players WHERE username=?', [username], (e, p) => {
        if (e || !p) return res();
        db.get('SELECT * FROM sessions WHERE player_id=? AND logout_time IS NULL ORDER BY id DESC', [p.id], (e2, s) => {
          if (e2 || !s) return res();
          const dur = Math.max(0, Math.floor((Date.parse(now) - Date.parse(s.login_time)) / 1000));
          db.run('UPDATE sessions SET logout_time=?, duration=? WHERE id=?', [now, dur, s.id], ()=>{});
          db.run('UPDATE players SET total_playtime=total_playtime+? WHERE id=?', [dur, p.id], err => err ? rej(err) : res());
        });
      });
    });
  } else if ((m = RX_CMD.exec(line))) {
    const username = m[1], command = m[2];
    const now = new Date().toISOString();
    await new Promise((res) => {
      db.get('SELECT * FROM players WHERE username=?', [username], (e, p) => {
        if (e || !p) return res();
        db.run('INSERT INTO commands(player_id, command, executed_at) VALUES(?,?,?)', [p.id, command, now], ()=>res());
      });
    });
  }
}

async function importFile(filePath, isGz) {
  return new Promise((resolve, reject) => {
    const stream = isGz ? fs.createReadStream(filePath).pipe(zlib.createGunzip()) : fs.createReadStream(filePath, 'utf8');
    const rl = readline.createInterface({ input: stream });
    rl.on('line', (line) => { lineHandler(line).catch(()=>{}); });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
}

async function importLogs() {
  if (fs.existsSync(LATEST_LOG)) await importFile(LATEST_LOG, false);
  if (fs.existsSync(LOG_DIR)) {
    const files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith('.log.gz'));
    for (const f of files) await importFile(path.join(LOG_DIR, f), true);
  }
}

module.exports = { importLogs };
