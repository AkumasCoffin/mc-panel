// rcon.js - tiny RCON wrapper
const { Rcon } = require('rcon-client');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const RCON_HOST = process.env.RCON_HOST || '127.0.0.1';
const RCON_PORT = Number(process.env.RCON_PORT || 25575);
const RCON_PASSWORD = process.env.RCON_PASSWORD || '';

async function sendRconCommand(cmd) {
  const r = await Rcon.connect({ host: RCON_HOST, port: RCON_PORT, password: RCON_PASSWORD });
  try {
    return await r.send(cmd);
  } finally {
    r.end();
  }
}

module.exports = { sendRconCommand };
