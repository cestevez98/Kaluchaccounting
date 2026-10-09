#!/usr/bin/env bash
# Instala (o reinstala) la actualización automática: temporizador de systemd que ejecuta auto-update.sh
# cada 10 minutos sobre la rama indicada. Uso: bash docker/install-auto-update.sh [rama]
set -euo pipefail
DIR=/opt/kaluch
BRANCH="${1:-$(git -C "$DIR" rev-parse --abbrev-ref HEAD)}"
echo "$BRANCH" > /etc/kaluch-branch
cat > /etc/systemd/system/kaluch-update.service <<UNIT
[Unit]
Description=Kaluch ERP - actualización automática
After=docker.service
[Service]
Type=oneshot
ExecStart=/usr/bin/bash $DIR/docker/auto-update.sh
UNIT
cat > /etc/systemd/system/kaluch-update.timer <<UNIT
[Unit]
Description=Kaluch ERP - comprobar actualizaciones cada 10 minutos
[Timer]
OnBootSec=5min
OnUnitActiveSec=10min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now kaluch-update.timer >/dev/null 2>&1
echo "Actualización automática activada (rama $BRANCH). Registro: journalctl -u kaluch-update"
