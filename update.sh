#!/usr/bin/env bash
set -euo pipefail

# MC Panel Update Script
# Usage: ./update.sh [--force] [--backup-db]

REPO_URL="${REPO_URL:-}"
APP_DIR="/opt/mc-rcon-webgui"
BACKUP_DIR="/opt/mc-rcon-webgui-backup-$(date +%Y%m%d_%H%M%S)"
FORCE_UPDATE=false
BACKUP_DB=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --force)
      FORCE_UPDATE=true
      shift
      ;;
    --backup-db)
      BACKUP_DB=true
      shift
      ;;
    --help)
      echo "Usage: $0 [--force] [--backup-db]"
      echo "  --force      Force update even if no changes detected"
      echo "  --backup-db  Create backup of database before update"
      exit 0
      ;;
    *)
      echo "Unknown option $1"
      exit 1
      ;;
  esac
done

if [ -z "$REPO_URL" ]; then
  echo "Set REPO_URL to your GitHub repo URL, e.g.:"
  echo "  export REPO_URL=https://github.com/<you>/<repo>.git"
  echo "Then run: bash update.sh"
  exit 1
fi

if [ ! -d "$APP_DIR" ]; then
  echo "Error: Application directory $APP_DIR does not exist."
  echo "Please run the initial installation first."
  exit 1
fi

if [ "$(id -u)" != "0" ]; then
  echo "This script must be run as root"
  exit 1
fi

echo "🔄 Starting MC Panel update..."

# Check if service is running
SERVICE_RUNNING=false
if systemctl is-active --quiet rcon-webgui; then
  SERVICE_RUNNING=true
  echo "📋 Service is currently running"
else
  echo "📋 Service is not running"
fi

# Backup current installation
echo "💾 Creating backup of current installation..."
cp -r "$APP_DIR" "$BACKUP_DIR"
echo "✅ Backup created at: $BACKUP_DIR"

# Additional database backup if requested
if [ "$BACKUP_DB" = true ]; then
  DB_BACKUP_DIR="/opt/mc-panel-db-backups"
  mkdir -p "$DB_BACKUP_DIR"
  if [ -f "$APP_DIR/app/webgui.sqlite" ]; then
    cp "$APP_DIR/app/webgui.sqlite" "$DB_BACKUP_DIR/webgui_backup_$(date +%Y%m%d_%H%M%S).sqlite"
    echo "✅ Database backed up to $DB_BACKUP_DIR"
  fi
fi

# Change to app directory and check for updates
cd "$APP_DIR"

# Fetch latest changes
echo "🔍 Checking for updates..."
git fetch origin

# Check if there are any changes
CURRENT_COMMIT=$(git rev-parse HEAD)
LATEST_COMMIT=$(git rev-parse origin/$(git branch --show-current))

if [ "$CURRENT_COMMIT" = "$LATEST_COMMIT" ] && [ "$FORCE_UPDATE" = false ]; then
  echo "✅ Already up to date! No update needed."
  echo "Use --force to update anyway."
  exit 0
fi

echo "📥 Updates available. Proceeding with update..."

# Stop the service if running
if [ "$SERVICE_RUNNING" = true ]; then
  echo "🛑 Stopping rcon-webgui service..."
  systemctl stop rcon-webgui
fi

# Preserve current .env file
if [ -f "$APP_DIR/app/.env" ]; then
  echo "💾 Preserving current configuration..."
  cp "$APP_DIR/app/.env" "/tmp/mc-panel-env-backup"
fi

# Pull latest changes
echo "⬇️  Pulling latest code..."
git pull origin $(git branch --show-current)

# Restore .env file
if [ -f "/tmp/mc-panel-env-backup" ]; then
  echo "🔧 Restoring configuration..."
  cp "/tmp/mc-panel-env-backup" "$APP_DIR/app/.env"
  rm "/tmp/mc-panel-env-backup"
fi

# Update dependencies
echo "📦 Updating dependencies..."
cd "$APP_DIR/app"
npm ci --omit=dev

# Update helper scripts (they might have changed)
echo "🔧 Updating helper scripts..."
if ! install -o root -g root -m 755 "$APP_DIR/helpers/start_minecraft.sh" /usr/local/bin/mc-start; then
  echo "⚠️  Warning: Failed to install mc-start helper script"
fi
if ! install -o root -g root -m 755 "$APP_DIR/helpers/restart_minecraft.sh" /usr/local/bin/mc-restart; then
  echo "⚠️  Warning: Failed to install mc-restart helper script"
fi

# Update systemd service file
echo "🔧 Updating systemd service..."
install -o root -g root -m 644 "$APP_DIR/systemd/rcon-webgui.service" /etc/systemd/system/rcon-webgui.service

# Update sudoers file
echo "🔧 Updating sudoers configuration..."
install -o root -g root -m 440 "$APP_DIR/sudoers.d/rcon-webgui-sudo" /etc/sudoers.d/rcon-webgui-sudo

# Reload systemd
systemctl daemon-reload

# Test the application starts correctly
echo "🧪 Testing application startup..."
cd "$APP_DIR/app"
timeout 10s node server.js >/dev/null 2>&1 || {
  echo "❌ Application failed to start! Rolling back..."
  systemctl stop rcon-webgui 2>/dev/null || true
  rm -rf "$APP_DIR"
  mv "$BACKUP_DIR" "$APP_DIR"
  if [ "$SERVICE_RUNNING" = true ]; then
    systemctl start rcon-webgui
  fi
  echo "🔄 Rollback completed. Check the error logs and try again."
  exit 1
}

echo "✅ Application test passed!"

# Start the service if it was running before
if [ "$SERVICE_RUNNING" = true ]; then
  echo "🚀 Starting rcon-webgui service..."
  systemctl start rcon-webgui
  
  # Wait a moment and check if it's running
  sleep 3
  if systemctl is-active --quiet rcon-webgui; then
    echo "✅ Service started successfully!"
  else
    echo "❌ Service failed to start! Check logs with: journalctl -u rcon-webgui -f"
    exit 1
  fi
else
  echo "📋 Service was not running before update, not starting it automatically."
  echo "To start the service: systemctl start rcon-webgui"
fi

# Show update summary
echo ""
echo "🎉 Update completed successfully!"
echo "📋 Updated from commit: ${CURRENT_COMMIT:0:8}"
echo "📋 Updated to commit:   ${LATEST_COMMIT:0:8}"
echo "💾 Backup location:     $BACKUP_DIR"
echo ""
echo "🌐 Panel should be available at: http://$(hostname -I | awk '{print $1}'):${PORT:-8080}"
echo ""
echo "📝 To view logs: journalctl -u rcon-webgui -f"
echo "🗑️  To remove backup: rm -rf $BACKUP_DIR"

# Cleanup old backups (keep last 5)
echo "🧹 Cleaning up old backups..."
ls -1t /opt/mc-rcon-webgui-backup-* 2>/dev/null | tail -n +6 | xargs -r rm -rf
echo "✅ Update process complete!"