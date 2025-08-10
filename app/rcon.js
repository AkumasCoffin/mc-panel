// rcon.js - RCON wrapper; gracefully disabled if not configured
const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch {}

function rconEnabled() {
  const pass = process.env.RCON_PASSWORD || process.env.RCON_PASS || '';
  return !!pass;
}

async function sendRconCommand(cmd) {
  const pass = process.env.RCON_PASSWORD || process.env.RCON_PASS || '';
  if (!pass) throw new Error('RCON not configured');

  const host = process.env.RCON_HOST || '127.0.0.1';
  const port = Number(process.env.RCON_PORT || 25575);

  // lazy-load to avoid requiring if disabled
  const { Rcon } = require('rcon-client');
  const r = await Rcon.connect({ host, port, password: pass });
  try {
    return await r.send(cmd);
  } finally {
    r.end();
  }
}

module.exports = { sendRconCommand, rconEnabled };
