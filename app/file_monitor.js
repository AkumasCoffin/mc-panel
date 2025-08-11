// file_monitor.js - Enhanced file monitoring for MC server files
const fs = require('fs');
const path = require('path');
const { run, get, all } = require('./db');

class FileMonitor {
  constructor(mcServerPath) {
    this.mcServerPath = mcServerPath || process.env.MC_SERVER_PATH || '/root/mc-server-backup';
    this.watchers = new Map();
    this.lastModified = new Map();
    
    // File paths to monitor
    this.filePaths = {
      bannedPlayers: path.join(this.mcServerPath, 'banned-players.json'),
      bannedIps: path.join(this.mcServerPath, 'banned-ips.json'),
      whitelist: path.join(this.mcServerPath, 'whitelist.json'),
      ops: path.join(this.mcServerPath, 'ops.json'),
      serverProperties: path.join(this.mcServerPath, 'server.properties'),
      userCache: path.join(this.mcServerPath, 'usercache.json')
    };
  }

  // Safely read and parse JSON file
  readJsonFile(filepath) {
    try {
      if (!fs.existsSync(filepath)) return null;
      const content = fs.readFileSync(filepath, 'utf8');
      return JSON.parse(content);
    } catch (e) {
      console.warn('[file_monitor] Failed to read/parse file:', filepath, e.message);
      return null;
    }
  }

  // Read server.properties file
  readServerProperties(filepath) {
    try {
      if (!fs.existsSync(filepath)) return {};
      const content = fs.readFileSync(filepath, 'utf8');
      const properties = {};
      
      content.split('\n').forEach(line => {
        line = line.trim();
        if (line && !line.startsWith('#')) {
          const [key, ...valueParts] = line.split('=');
          if (key && valueParts.length > 0) {
            properties[key.trim()] = valueParts.join('=').trim();
          }
        }
      });
      
      return properties;
    } catch (e) {
      console.warn('[file_monitor] Failed to read server properties:', filepath, e.message);
      return {};
    }
  }

  // Store file change in database
  async logFileChange(filename, changeType, data = null) {
    try {
      await run(
        'INSERT INTO file_changes (filename, change_type, data, changed_at) VALUES (?, ?, ?, ?)',
        [filename, changeType, data ? JSON.stringify(data) : null, new Date().toISOString()]
      );
    } catch (e) {
      console.warn('[file_monitor] Failed to log file change:', e.message);
    }
  }

  // Monitor banned players file
  async processBannedPlayers() {
    const data = this.readJsonFile(this.filePaths.bannedPlayers);
    if (!data) return;

    try {
      // Clear existing banned players and reinsert
      await run('DELETE FROM banned_players');
      
      for (const ban of data) {
        const username = ban.name || ban.user || '';
        const uuid = ban.uuid || null;
        const reason = ban.reason || 'No reason provided';
        const bannedBy = ban.source || ban.by || 'Server';
        const bannedAt = ban.created || ban.banned_at || new Date().toISOString();
        
        await run(
          'INSERT INTO banned_players (username, uuid, reason, banned_by, banned_at) VALUES (?, ?, ?, ?, ?)',
          [username, uuid, reason, bannedBy, bannedAt]
        );
      }
      
      await this.logFileChange('banned-players.json', 'updated', { count: data.length });
      console.log(`[file_monitor] Updated ${data.length} banned players`);
    } catch (e) {
      console.warn('[file_monitor] Failed to process banned players:', e.message);
    }
  }

  // Monitor banned IPs file
  async processBannedIps() {
    const data = this.readJsonFile(this.filePaths.bannedIps);
    if (!data) return;

    try {
      // Clear existing banned IPs and reinsert
      await run('DELETE FROM banned_ips');
      
      for (const ban of data) {
        const ip = ban.ip || ban.target || '';
        const reason = ban.reason || 'No reason provided';
        const bannedBy = ban.source || ban.by || 'Server';
        const bannedAt = ban.created || ban.banned_at || new Date().toISOString();
        
        await run(
          'INSERT INTO banned_ips (ip, reason, banned_by, banned_at) VALUES (?, ?, ?, ?)',
          [ip, reason, bannedBy, bannedAt]
        );
      }
      
      await this.logFileChange('banned-ips.json', 'updated', { count: data.length });
      console.log(`[file_monitor] Updated ${data.length} banned IPs`);
    } catch (e) {
      console.warn('[file_monitor] Failed to process banned IPs:', e.message);
    }
  }

  // Monitor whitelist file
  async processWhitelist() {
    const data = this.readJsonFile(this.filePaths.whitelist);
    if (!data) return;

    try {
      await run('DELETE FROM whitelist');
      
      for (const entry of data) {
        const username = entry.name || '';
        const uuid = entry.uuid || null;
        
        await run(
          'INSERT INTO whitelist (username, uuid) VALUES (?, ?)',
          [username, uuid]
        );
      }
      
      await this.logFileChange('whitelist.json', 'updated', { count: data.length });
      console.log(`[file_monitor] Updated ${data.length} whitelisted players`);
    } catch (e) {
      console.warn('[file_monitor] Failed to process whitelist:', e.message);
    }
  }

  // Monitor ops file
  async processOps() {
    const data = this.readJsonFile(this.filePaths.ops);
    if (!data) return;

    try {
      await run('DELETE FROM operators');
      
      for (const op of data) {
        const username = op.name || '';
        const uuid = op.uuid || null;
        const level = op.level || 4;
        const bypassesPlayerLimit = op.bypassesPlayerLimit || false;
        
        await run(
          'INSERT INTO operators (username, uuid, level, bypasses_player_limit) VALUES (?, ?, ?, ?)',
          [username, uuid, level, bypassesPlayerLimit ? 1 : 0]
        );
      }
      
      await this.logFileChange('ops.json', 'updated', { count: data.length });
      console.log(`[file_monitor] Updated ${data.length} operators`);
    } catch (e) {
      console.warn('[file_monitor] Failed to process operators:', e.message);
    }
  }

  // Monitor server properties
  async processServerProperties() {
    const data = this.readServerProperties(this.filePaths.serverProperties);
    if (!data || Object.keys(data).length === 0) return;

    try {
      await run('DELETE FROM server_settings');
      
      for (const [key, value] of Object.entries(data)) {
        await run(
          'INSERT INTO server_settings (property_key, property_value) VALUES (?, ?)',
          [key, value]
        );
      }
      
      await this.logFileChange('server.properties', 'updated', { count: Object.keys(data).length });
      console.log(`[file_monitor] Updated ${Object.keys(data).length} server properties`);
    } catch (e) {
      console.warn('[file_monitor] Failed to process server properties:', e.message);
    }
  }

  // Check if file has been modified
  isFileModified(filepath) {
    try {
      if (!fs.existsSync(filepath)) return false;
      
      const stats = fs.statSync(filepath);
      const lastMod = this.lastModified.get(filepath);
      
      if (!lastMod || stats.mtime > lastMod) {
        this.lastModified.set(filepath, stats.mtime);
        return true;
      }
      
      return false;
    } catch (e) {
      return false;
    }
  }

  // Start monitoring all files
  start() {
    console.log('[file_monitor] Starting file monitoring for MC server files');
    
    // Initial processing
    this.processAllFiles();
    
    // Set up file watchers
    Object.entries(this.filePaths).forEach(([name, filepath]) => {
      if (fs.existsSync(filepath)) {
        try {
          const watcher = fs.watch(filepath, { persistent: true }, (eventType) => {
            if (eventType === 'change') {
              setTimeout(() => this.handleFileChange(name, filepath), 100); // Debounce
            }
          });
          this.watchers.set(name, watcher);
          console.log(`[file_monitor] Watching ${name}: ${filepath}`);
        } catch (e) {
          console.warn(`[file_monitor] Failed to watch ${name}:`, e.message);
        }
      } else {
        console.warn(`[file_monitor] File does not exist: ${filepath}`);
      }
    });

    // Periodic check for files that might not trigger watch events
    this.intervalId = setInterval(() => {
      this.checkForModifications();
    }, 30000); // Check every 30 seconds
  }

  // Stop monitoring
  stop() {
    console.log('[file_monitor] Stopping file monitoring');
    
    this.watchers.forEach((watcher, name) => {
      try {
        watcher.close();
      } catch (e) {
        console.warn(`[file_monitor] Error closing watcher for ${name}:`, e.message);
      }
    });
    this.watchers.clear();
    
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  // Handle file change events
  async handleFileChange(name, filepath) {
    try {
      console.log(`[file_monitor] File changed: ${name}`);
      
      switch (name) {
        case 'bannedPlayers':
          await this.processBannedPlayers();
          break;
        case 'bannedIps':
          await this.processBannedIps();
          break;
        case 'whitelist':
          await this.processWhitelist();
          break;
        case 'ops':
          await this.processOps();
          break;
        case 'serverProperties':
          await this.processServerProperties();
          break;
      }
    } catch (e) {
      console.warn(`[file_monitor] Error processing ${name}:`, e.message);
    }
  }

  // Check for modifications manually
  async checkForModifications() {
    for (const [name, filepath] of Object.entries(this.filePaths)) {
      if (this.isFileModified(filepath)) {
        await this.handleFileChange(name, filepath);
      }
    }
  }

  // Process all files initially
  async processAllFiles() {
    await this.processBannedPlayers();
    await this.processBannedIps();
    await this.processWhitelist();
    await this.processOps();
    await this.processServerProperties();
  }

  // Get file monitoring stats
  async getStats() {
    try {
      const bannedPlayersCount = await get('SELECT COUNT(*) as count FROM banned_players');
      const bannedIpsCount = await get('SELECT COUNT(*) as count FROM banned_ips');
      const whitelistCount = await get('SELECT COUNT(*) as count FROM whitelist');
      const opsCount = await get('SELECT COUNT(*) as count FROM operators');
      const settingsCount = await get('SELECT COUNT(*) as count FROM server_settings');
      
      return {
        banned_players: bannedPlayersCount?.count || 0,
        banned_ips: bannedIpsCount?.count || 0,
        whitelist: whitelistCount?.count || 0,
        operators: opsCount?.count || 0,
        server_settings: settingsCount?.count || 0,
        monitored_files: Object.keys(this.filePaths).length,
        active_watchers: this.watchers.size
      };
    } catch (e) {
      console.warn('[file_monitor] Error getting stats:', e.message);
      return {};
    }
  }
}

module.exports = FileMonitor;