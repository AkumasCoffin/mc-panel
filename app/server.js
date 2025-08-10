// server.js
const express = require('express');
const path = require('path');
const basicAuth = require('express-basic-auth');
const bodyParser = require('body-parser');
const fs = require('fs');
const Rcon = require('rcon-client').Rcon;

const app = express();

// ==== CONFIG ====
const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'changeme';
const RCON_HOST = process.env.RCON_HOST || '127.0.0.1';
const RCON_PORT = parseInt(process.env.RCON_PORT || '25575', 10);
const RCON_PASS = process.env.RCON_PASS || '';
const SERVER_LOG = process.env.SERVER_LOG || '/opt/minecraft/server/logs/latest.log';
const METRICS_POLL_SEC = parseInt(process.env.METRICS_POLL_SEC || '10', 10);

// ==== AUTH ====
app.use(basicAuth({
    users: { [PANEL_USER]: PANEL_PASS },
    challenge: true
}));

app.use(bodyParser.json());

// ==== Serve UI ====
app.use(express.static(path.join(__dirname, 'public')));

// ==== Connect to RCON ====
async function runRconCommand(cmd) {
    try {
        const rcon = await Rcon.connect({
            host: RCON_HOST,
            port: RCON_PORT,
            password: RCON_PASS
        });
        const res = await rcon.send(cmd);
        await rcon.end();
        return res;
    } catch (err) {
        console.error("RCON error:", err);
        return null;
    }
}

// ==== API: Server status ====
app.get('/api/status', async (req, res) => {
    const list = await runRconCommand('list');
    if (!list) return res.json({ ok: false });

    const match = list.match(/There are (\d+) of a max of (\d+) players online: ?(.*)?/);
    if (match) {
        const online = parseInt(match[1], 10);
        const max = parseInt(match[2], 10);
        const players = match[3] ? match[3].split(',').map(p => p.trim()) : [];
        return res.json({ ok: true, online, max, players });
    }
    res.json({ ok: false });
});

// ==== API: Online players only ====
app.get('/api/online', async (req, res) => {
    const list = await runRconCommand('list');
    if (!list) return res.json({ ok: false });

    const match = list.match(/There are (\d+) of a max of (\d+) players online: ?(.*)?/);
    if (match) {
        const players = match[3] ? match[3].split(',').map(p => p.trim()) : [];
        return res.json({ ok: true, players });
    }
    res.json({ ok: false });
});

// ==== API: Players info from log ====
app.get('/api/players', (req, res) => {
    if (!fs.existsSync(SERVER_LOG)) {
        return res.status(404).json([]);
    }
    const log = fs.readFileSync(SERVER_LOG, 'utf8');
    const players = [];
    const seen = {};

    const joinRegex = /\]: (\w+)\[\/([\d\.]+):\d+\] logged in/;
    const lines = log.split('\n');
    for (const line of lines) {
        const joinMatch = line.match(joinRegex);
        if (joinMatch) {
            const username = joinMatch[1];
            const ip = joinMatch[2];
            if (!seen[username]) {
                seen[username] = { username, last_ip: ip };
                players.push({
                    id: players.length + 1,
                    username,
                    uuid: null,
                    first_seen: null,
                    last_seen: null,
                    total_playtime: 0,
                    last_ip: ip
                });
            }
        }
    }
    res.json(players);
});

// ==== API: Player detail ====
app.get('/api/player/:id', (req, res) => {
    const pid = parseInt(req.params.id, 10);
    if (!fs.existsSync(SERVER_LOG)) {
        return res.status(404).json({});
    }
    const log = fs.readFileSync(SERVER_LOG, 'utf8');
    const players = [];
    const seen = {};
    const joinRegex = /\]: (\w+)\[\/([\d\.]+):\d+\] logged in/;

    const lines = log.split('\n');
    for (const line of lines) {
        const joinMatch = line.match(joinRegex);
        if (joinMatch) {
            const username = joinMatch[1];
            const ip = joinMatch[2];
            if (!seen[username]) {
                seen[username] = { username, last_ip: ip };
                players.push({
                    id: players.length + 1,
                    username,
                    uuid: null,
                    first_seen: null,
                    last_seen: null,
                    total_playtime: 0,
                    last_ip: ip
                });
            }
        }
    }
    const player = players.find(p => p.id === pid);
    if (!player) return res.status(404).json({});
    res.json({
        player,
        ips: [player.last_ip],
        sessions: [],
        commands: []
    });
});

// ==== Start server ====
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Panel running on http://0.0.0.0:${PORT}`);
});
