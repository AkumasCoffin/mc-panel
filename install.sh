#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-}"
APP_DIR="/opt/mc-rcon-webgui"

if [ -z "$REPO_URL" ]; then
  echo "Set REPO_URL to your GitHub repo URL, e.g.:"
  echo "  export REPO_URL=https://github.com/<you>/<repo>.git"
  echo "Then run: bash install.sh"
  exit 1
fi

apt update
apt install -y curl git sqlite3

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
fi

systemctl stop rcon-webgui 2>/dev/null || true
rm -rf "$APP_DIR"
git clone "$REPO_URL" "$APP_DIR"

cd "$APP_DIR/app"
cat > .env <<EOF
RCON_HOST=${RCON_HOST:-127.0.0.1}
RCON_PORT=${RCON_PORT:-25575}
RCON_PASSWORD=${RCON_PASSWORD:-$(openssl rand -hex 16)}
PANEL_USER=${PANEL_USER:-admin}
PANEL_PASS=${PANEL_PASS:-$(openssl rand -base64 16)}
MC_SERVER_PATH=${MC_SERVER_PATH:-/root/mc-server-backup}
DB_FILE=${DB_FILE:-./mc_data.sqlite3}
PORT=${PORT:-8080}
EOF

npm install --omit=dev
if ! install -o root -g root -m 755 "$APP_DIR/helpers/start_minecraft.sh" /usr/local/bin/mc-start; then
  echo "Warning: Failed to install mc-start helper script"
fi
if ! install -o root -g root -m 755 "$APP_DIR/helpers/restart_minecraft.sh" /usr/local/bin/mc-restart; then
  echo "Warning: Failed to install mc-restart helper script"
fi
install -o root -g root -m 644 "$APP_DIR/systemd/rcon-webgui.service" /etc/systemd/system/rcon-webgui.service
install -o root -g root -m 440 "$APP_DIR/sudoers.d/rcon-webgui-sudo" /etc/sudoers.d/rcon-webgui-sudo

systemctl daemon-reload
systemctl enable rcon-webgui
systemctl restart rcon-webgui

echo "Done. Visit http://127.0.0.1:8080"
echo "Auth is HTTP Basic (browser prompt):"
echo "  User: ${PANEL_USER:-admin}"
echo "  Pass: ${PANEL_PASS:-[randomly generated]}"
echo "Check the generated credentials in $APP_DIR/app/.env"
echo "Change these by editing $APP_DIR/app/.env and restarting: systemctl restart rcon-webgui"
