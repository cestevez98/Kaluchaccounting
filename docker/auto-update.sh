#!/usr/bin/env bash
# Actualización automática de Kaluch ERP: si hay commits nuevos en la rama desplegada, los descarga,
# reconstruye y reinicia. La ejecuta un temporizador de systemd cada 10 minutos (ver bootstrap-vps.sh).
# Registro: journalctl -u kaluch-update
set -euo pipefail
DIR=/opt/kaluch
cd "$DIR"
BRANCH="$(cat /etc/kaluch-branch 2>/dev/null || git rev-parse --abbrev-ref HEAD)"
export GIT_SSH_COMMAND="ssh -i /root/.ssh/kaluch_deploy -o IdentitiesOnly=yes"
C="docker compose -f docker/compose.prod.yml --env-file docker/.env.prod"

git fetch -q origin "$BRANCH"
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"
[ "$LOCAL" = "$REMOTE" ] && exit 0

# No interrumpir una importación del Excel en curso.
if $C top api 2>/dev/null | grep -q "etl/dist/cli.js"; then
  echo "Hay una importación en curso; se actualizará en la próxima pasada"
  exit 0
fi

echo "Actualizando ${LOCAL:0:7} → ${REMOTE:0:7}"
git reset -q --hard "origin/$BRANCH"
$C up -d --build --remove-orphans
docker image prune -f >/dev/null
echo "Actualizado a ${REMOTE:0:7}"
