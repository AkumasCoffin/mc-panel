# MC Panel Update Guide

This guide explains how to update your running MC Panel installation safely.

## 🚀 Quick Update

For most cases, you can use the automated update script:

```bash
# Set your repository URL
export REPO_URL=https://github.com/AkumasCoffin/mc-panel.git

# Run the update script
sudo bash update.sh
```

## 📋 Update Script Options

```bash
sudo bash update.sh [OPTIONS]

Options:
  --force       Force update even if no changes detected
  --backup-db   Create additional database backup before update
  --help        Show help message
```

## 🔧 What the Update Script Does

1. **Checks for updates** - Compares your current version with the latest
2. **Creates backup** - Backs up your entire installation
3. **Stops service** - Gracefully stops the panel service if running
4. **Preserves config** - Keeps your current `.env` configuration
5. **Updates code** - Pulls latest changes from repository
6. **Updates dependencies** - Installs any new or updated npm packages
7. **Updates system files** - Updates helper scripts, systemd service, sudoers
8. **Tests startup** - Verifies the application starts correctly
9. **Restarts service** - Starts the service if it was running before
10. **Cleanup** - Removes old backups (keeps last 5)

## 🔒 Security Improvements in Latest Version

- **Strong default passwords** - Auto-generated secure passwords instead of hardcoded ones
- **Input validation** - All API endpoints now validate input to prevent abuse
- **Better error handling** - Improved RCON connection error handling
- **Configurable service name** - Support for custom Minecraft service names

## ⚙️ New Configuration Options

Add these to your `.env` file if needed:

```bash
# Minecraft service name (default: minecraft.service)
MC_SERVICE_NAME=minecraft.service

# Additional RCON validation
RCON_HOST=127.0.0.1
RCON_PORT=25575
```

## 🔍 Manual Update Process

If you prefer to update manually:

1. **Backup your installation:**
   ```bash
   sudo cp -r /opt/mc-rcon-webgui /opt/mc-rcon-webgui-backup-$(date +%Y%m%d)
   ```

2. **Stop the service:**
   ```bash
   sudo systemctl stop rcon-webgui
   ```

3. **Update the code:**
   ```bash
   cd /opt/mc-rcon-webgui
   git pull origin main
   ```

4. **Update dependencies:**
   ```bash
   cd /opt/mc-rcon-webgui/app
   npm ci --omit=dev
   ```

5. **Update system files:**
   ```bash
   sudo install -m 755 /opt/mc-rcon-webgui/helpers/*.sh /usr/local/bin/
   sudo install -m 644 /opt/mc-rcon-webgui/systemd/rcon-webgui.service /etc/systemd/system/
   sudo install -m 440 /opt/mc-rcon-webgui/sudoers.d/rcon-webgui-sudo /etc/sudoers.d/
   sudo systemctl daemon-reload
   ```

6. **Start the service:**
   ```bash
   sudo systemctl start rcon-webgui
   ```

## 🩺 Troubleshooting

### Update fails with "Application failed to start"

The update script automatically rolls back if the new version fails to start. Check the backup directory mentioned in the error message.

### Service won't start after update

Check the logs:
```bash
sudo journalctl -u rcon-webgui -f
```

Common issues:
- **Configuration errors** - Check your `.env` file
- **Permission issues** - Ensure files have correct ownership
- **Port conflicts** - Make sure port 8080 (or your configured port) is available

### Database issues

If you encounter database problems:
1. Stop the service: `sudo systemctl stop rcon-webgui`
2. Restore from backup: `sudo cp /opt/mc-panel-db-backups/webgui_backup_*.sqlite /opt/mc-rcon-webgui/app/webgui.sqlite`
3. Start the service: `sudo systemctl start rcon-webgui`

### Rollback to previous version

If you need to completely rollback:
```bash
sudo systemctl stop rcon-webgui
sudo rm -rf /opt/mc-rcon-webgui
sudo mv /opt/mc-rcon-webgui-backup-YYYYMMDD_HHMMSS /opt/mc-rcon-webgui
sudo systemctl start rcon-webgui
```

## 📊 Checking Current Version

To see your current version:
```bash
cd /opt/mc-rcon-webgui
git log --oneline -1
```

## 🔄 Automatic Updates

For automatic updates, you can set up a cron job:

```bash
# Edit crontab
sudo crontab -e

# Add this line to check for updates daily at 3 AM
0 3 * * * REPO_URL=https://github.com/AkumasCoffin/mc-panel.git /opt/mc-rcon-webgui/update.sh
```

## 📞 Support

If you encounter issues:
1. Check the logs: `sudo journalctl -u rcon-webgui -f`
2. Verify configuration: `cat /opt/mc-rcon-webgui/app/.env`
3. Test manually: `cd /opt/mc-rcon-webgui/app && node server.js`

For additional help, check the repository issues or create a new one with:
- Your error logs
- Your configuration (remove sensitive data)
- Steps to reproduce the issue