// rcon.js - RCON wrapper; works with CJS (v4) and ESM (v5+) packages
const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch {}

function rconEnabled() {
  const pass = process.env.RCON_PASSWORD || process.env.RCON_PASS || '';
  return !!pass;
}

async function loadRconModule() {
  try {
    return require('rcon-client'); // v4 CJS path
  } catch {
    const mod = await import('rcon-client'); // v5+ ESM path
    return mod.default || mod;
  }
}

async function sendRconCommand(cmd) {
  const pass = process.env.RCON_PASSWORD || process.env.RCON_PASS || '';
  if (!pass) throw new Error('RCON not configured');

  const host = process.env.RCON_HOST || '127.0.0.1';
  const port = Number(process.env.RCON_PORT || 25575);

  const mod = await loadRconModule();
  const Rcon = mod.Rcon || mod;
  const r = await Rcon.connect({ host, port, password: pass });
  try {
    return await r.send(cmd);
  } finally {
    r.end();
  }
}

module.exports = { sendRconCommand, rconEnabled };
