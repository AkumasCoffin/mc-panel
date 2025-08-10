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

  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error('Invalid RCON port');
  }

  const mod = await loadRconModule();
  const Rcon = mod.Rcon || mod;
  let r = null;
  
  try {
    r = await Rcon.connect({ host, port, password: pass });
    return await r.send(cmd);
  } catch (err) {
    // Don't expose sensitive connection details
    if (err.message.includes('password')) {
      throw new Error('RCON authentication failed');
    } else if (err.message.includes('ECONNREFUSED') || err.message.includes('ECONNRESET')) {
      throw new Error('RCON server unavailable');
    } else if (err.message.includes('timeout')) {
      throw new Error('RCON connection timeout');
    }
    throw new Error('RCON command failed');
  } finally {
    if (r && typeof r.end === 'function') {
      try {
        r.end();
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }
}

module.exports = { sendRconCommand, rconEnabled };
