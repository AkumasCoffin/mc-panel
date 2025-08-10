# MC Panel - Bug Fixes and Update Script

## 🎉 Summary

I've analyzed your MC Panel repository and implemented comprehensive bug fixes along with an automated update script for your running server.

## 🐛 Critical Bugs Fixed

### 1. Security Vulnerabilities ⚠️ **HIGH PRIORITY**
- **Hardcoded passwords** in install.sh replaced with auto-generated secure ones
- **Command injection** vulnerabilities fixed with input validation on all API endpoints
- **Information disclosure** prevented by sanitizing error messages

### 2. Stability Issues
- **RCON connection handling** improved with proper timeouts and error recovery
- **File path issues** in database initialization fixed
- **Log parsing** enhanced to support multiple Minecraft server formats
- **Service dependencies** made configurable instead of hardcoded

### 3. Operational Improvements
- **Database directory creation** automated if missing
- **Error handling** enhanced throughout the application
- **Log file watching** improved with better error recovery

## 🚀 New Update Script

The main deliverable is `update.sh` - a production-ready update script for your running server:

### Quick Usage:
```bash
# Set your repository URL
export REPO_URL=https://github.com/AkumasCoffin/mc-panel.git

# Run the update
sudo bash update.sh
```

### Features:
- ✅ **Smart updates** - Only updates when changes are detected
- ✅ **Automatic backup** - Creates full backup before updating  
- ✅ **Configuration preservation** - Keeps your current `.env` settings
- ✅ **Rollback on failure** - Automatically restores if update fails
- ✅ **Service management** - Handles stopping/starting the service
- ✅ **Dependency updates** - Updates npm packages if needed
- ✅ **System file updates** - Updates helper scripts and systemd files
- ✅ **Startup testing** - Verifies application works before completing

### Options:
```bash
sudo bash update.sh --force      # Force update even if no changes
sudo bash update.sh --backup-db  # Create additional database backup
```

## 🔧 Configuration Enhancements

### New environment variables you can set:
```bash
# In your .env file:
MC_SERVICE_NAME=minecraft.service    # Customize your Minecraft service name
RCON_HOST=127.0.0.1                 # RCON server host
RCON_PORT=25575                     # RCON server port
```

## 🧪 Tested Features

I've created and run comprehensive tests to verify:
- ✅ All API endpoints work correctly
- ✅ Input validation prevents malicious inputs
- ✅ Error handling works as expected
- ✅ Application starts and runs properly

## 📋 What You Need To Do

### For your running server:

1. **Set your repository URL:**
   ```bash
   export REPO_URL=https://github.com/AkumasCoffin/mc-panel.git
   ```

2. **Run the update script:**
   ```bash
   sudo bash update.sh
   ```

3. **Verify the update:**
   - Check the service is running: `sudo systemctl status rcon-webgui`
   - Check the web interface is accessible
   - Review the logs: `sudo journalctl -u rcon-webgui -f`

### For future updates:
- Simply run `sudo bash update.sh` whenever you want to update
- The script will automatically detect if updates are available
- Your configuration and data will be preserved

## 🔒 Security Improvements

**Important:** After updating, your install script will now generate secure random passwords instead of using defaults like "changeme". For existing installations, consider updating your passwords in the `.env` file.

## 📞 Troubleshooting

If something goes wrong:
1. **Check the logs:** `sudo journalctl -u rcon-webgui -f`
2. **Rollback if needed:** The script creates backups at `/opt/mc-rcon-webgui-backup-*`
3. **Manual rollback:** `sudo systemctl stop rcon-webgui && sudo mv /opt/mc-rcon-webgui-backup-YYYYMMDD_HHMMSS /opt/mc-rcon-webgui`

## 📚 Documentation

- See `UPDATE.md` for comprehensive update documentation
- The update script includes `--help` for quick reference
- All changes maintain backward compatibility with existing installations

Your MC Panel is now more secure, stable, and easier to maintain! 🎯