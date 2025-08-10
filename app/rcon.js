// rcon.js - RCON wrapper; works with ESM (v5) or CJS (v4) rcon-client
const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch {}

function rconEnabled() {
  const pass = process.env.RCON_PASSWORD || process.env.RCON_PASS || '';
  return !!pass;
}

async function loadRconModule() {
  // Try CJS first (v4), then fall back to ESM dynamic import (v5)
  try {
    return require('rcon-client');
  } catch (e) {
    const mod = await import('rcon-client');
    return mod.default || mod; // some ESM packages export default
  }
}

async function sendRconCommand(cmd) {
  const pass = process.env.RCON_PASSWORD || process.env.RCON_PASS || '';
  if (!pass) throw new Error('RCON not configured');

  const host = process.env.RCON_HOST || '127.0.0.1';
  const port = Number(process.env.RCON_PORT || 25575);

  const mod = await loadRconModule();
  const Rcon = mod.Rcon || mod; // v5 exports { Rcon }, v4 exports class directly or as property
  const r = await Rcon.connect({ host, port, password: pass });
  try {
    return await r.send(cmd);
  } finally {
    r.end();
  }
}

module.exports = { sendRconCommand, rconEnabled };
