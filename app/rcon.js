const { Rcon } = require('rcon-client');

async function sendRconCommand(cmd) {
    const rcon = await Rcon.connect({
        host: process.env.RCON_HOST,
        port: parseInt(process.env.RCON_PORT),
        password: process.env.RCON_PASSWORD
    });
    const response = await rcon.send(cmd);
    await rcon.end();
    return response;
}

module.exports = { sendRconCommand };

